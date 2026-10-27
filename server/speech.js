// What Mo says out loud, and how it's spoken. Every line is written once with Fish Audio cues
// ([pleased], [break]…), then split: the cued version is spoken, the clean version is shown.
// The rules for writing lines are in .claude/skills/mo-voice/SKILL.md.
//
// Fish Audio is called from here only (the key never reaches the extension). Audio is cached
// by voice and text, so a common line ("All done!") plays instantly after the first time.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './account.js';

// Cues are [square brackets] (Fish Audio s2). Remove them, and the spaces they leave, for the screen.
export function stripCues(text) {
  return String(text).replace(/\[[^\]]*\]\s*/g, '').replace(/\s+([,.!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
export const spokenAndShown = line => ({ say: line.trim(), show: stripCues(line) });

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const say = n => (Number.isInteger(n) && n >= 0 && n <= 20 ? WORDS[n] : String(n));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
// What Mo shows is what it says: a detail is spoken in full (up to ~400 characters, a few
// sentences), ending as a sentence, with no stray brackets that Fish would read as a cue.
const full = (s, max = 400) => {
  let t = String(s || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length > max) t = `${(t.slice(0, max).match(/^.*[.?!](?=\s)/)?.[0] || t.slice(0, max - 1)).trim()}…`;
  return t && !/[.?!…]$/.test(t) ? `${t}.` : t;
};
// "Click me" when the bubble on the page starts teaching (runs started by voice, panel closed).
const showMe = teach => (teach ? 'Click me to show me how.' : 'Can you show me how?');

// Two or three versions per moment, so repeated runs don't sound canned.
const LINES = {
  done: () => ['[pleased] All done!', '[pleased] Done!', '[pleased] All done. [break] That worked.'],
  doneWithLesson: () => ['[warm] Done, the way you showed me.', '[pleased] All done, just like you taught me.'],
  failed: ({ reason, teach }) => (reason
    ? [`[apologetic] I couldn't finish this. [break] ${full(reason)} [break] ${showMe(teach)}`]
    : [`[apologetic] I got stuck on this one. [break] ${showMe(teach)}`, `[apologetic] I couldn't finish this. [break] ${showMe(teach)}`]),
  asked: ({ question, teach }) => [`[curious] Quick question. [break] ${full(question)}${teach ? ` [break] ${showMe(teach)}` : ''}`,
    `[apologetic] I need a hand. [break] ${full(question)}${teach ? ` [break] ${showMe(teach)}` : ''}`],
  answer: ({ answer }) => [`[warm] Found it. [break] ${full(answer)}`, `[pleased] Here it is. [break] ${full(answer)}`],
  error: ({ message }) => [`[apologetic] Something went wrong. [break] ${full(message || 'Check my panel.')}`],
  busy: () => ['[gentle] I\'m still working on the last one.'],
  showMe: () => ['[warm] Okay. [break] Click me, and I\'ll watch how you do it.', '[pleased] Sure. [break] Click me and show me how.'],
  watching: () => ['[warm] I\'m watching. [break] Show me how.', '[curious] Okay, I\'m watching. [break] Go ahead.'],
  learned: ({ skill }) => (skill ? [`[pleased] Got it. [break] I've learned how to ${String(skill).replace(/^\w/, c => c.toLowerCase())}.`, `[pleased] Thanks! [break] I'll remember ${full(skill, 60).replace(/\.$/, '')}.`] : ['[pleased] Got it. [break] I\'ll do it your way from now on.']),
  batch: ({ ok = 0, failed = 0 }) => (failed
    ? [`[pleased] ${cap(say(ok))} done. [break] [gentle] ${cap(say(failed))} ${failed === 1 ? 'needs' : 'need'} a look.`]
    : [`[excited] All ${say(ok)} done!`, `[excited] That's all ${say(ok)} done!`]),
  stopped: () => ['[gentle] Okay, I\'ve stopped.', '[gentle] Stopped.'],
  signedIn: () => ['[warm] Hi! [break] Show me a task, and I\'ll take it from there.'],
};
export const EVENTS = Object.keys(LINES);

// The line for a moment: { say: with cues, show: without }. pick chooses a version (tests pass 0).
export function lineFor(event, data = {}, pick = Math.random) {
  const options = LINES[event]?.(data);
  if (!options?.length) throw Object.assign(new Error(`Unknown speech event "${event}"`), { status: 400 });
  return spokenAndShown(options[Math.floor(pick() * options.length) % options.length]);
}

// ---- Fish Audio -------------------------------------------------------------------------
export const voiceConfig = () => ({
  enabled: !!process.env.FISH_API_KEY && process.env.MO_VOICE !== 'off',
  voice: process.env.FISH_VOICE_ID || '1b1286fcf2f44d8ba1405e0b71abca22', // "Friendly Young Female": warm, conversational
  model: process.env.FISH_MODEL || 's2.1-pro-free',
});

// A long line is split into pieces of a sentence or two, voiced at the same time (three at
// once) and joined: MP3 frames play back to back, so the whole line takes about as long as
// its longest piece instead of timing out. Any piece failing means no audio (the computer's
// voice says the line), never half a line in each voice.
export function pieces(text, max = 160) {
  const sentences = String(text).split(/(?<=[.?!…])\s+(?=\S)/);
  const out = [];
  for (const s of sentences) {
    if (out.length && (out[out.length - 1] + ' ' + s).length <= max) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out.filter(p => stripCues(p));
}

export async function synthesizeLine(text, { signal } = {}) {
  const parts = pieces(text);
  if (parts.length <= 1) return synthesize(text, { signal });
  const clips = new Array(parts.length);
  let next = 0;
  const worker = async () => { while (next < parts.length) { const i = next++; clips[i] = await synthesize(parts[i], { signal }); } };
  await Promise.all([worker(), worker(), worker()]);
  return clips.every(Boolean) ? Buffer.concat(clips) : null;
}

export async function synthesize(text, { signal } = {}) {
  const { enabled, voice, model } = voiceConfig();
  if (!enabled) return null;
  const dir = path.join(userDataDir(), 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash('sha1').update(`${voice}|${model}|${text}`).digest('hex').slice(0, 16)}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 500) return fs.readFileSync(file);
  const limit = Number(process.env.FISH_TIMEOUT_MS || 20000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), limit);
  signal?.addEventListener('abort', () => ctrl.abort());
  try {
    const res = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${process.env.FISH_API_KEY}`, 'content-type': 'application/json', model },
      body: JSON.stringify({ text, reference_id: voice, format: 'mp3', mp3_bitrate: 128, latency: 'balanced', normalize: true }),
    });
    if (!res.ok) throw new Error(`Fish Audio ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(file, audio);
    return audio;
  } catch (err) {
    if (err.name === 'AbortError' && !signal?.aborted) throw new Error(`Fish Audio took more than ${Math.round(limit / 1000)} s for "${stripCues(text).slice(0, 60)}"`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
