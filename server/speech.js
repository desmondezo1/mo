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
// Spoken details stay short: the first sentence, at most ~160 characters.
const brief = (s, max = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); const first = t.match(/^.*?[.?!](\s|$)/)?.[0]?.trim() || t; return first.length > max ? `${first.slice(0, max - 1).trim()}…` : first; };

// Two or three versions per moment, so repeated runs don't sound canned.
const LINES = {
  done: () => ['[pleased] All done!', '[pleased] Done!', '[pleased] All done. [break] That worked.'],
  doneWithLesson: () => ['[warm] Done, the way you showed me.', '[pleased] All done, just like you taught me.'],
  failed: () => ['[apologetic] I got stuck on this one. [break] Can you show me how?', '[apologetic] I couldn\'t finish this. [break] Can you show me how you\'d do it?'],
  asked: ({ question }) => [`[curious] Quick question. [break] ${brief(question)}`, `[apologetic] I need a hand. [break] ${brief(question)}`],
  answer: ({ answer }) => [`[warm] Found it. [break] ${brief(answer, 200)}`, `[pleased] Here it is. [break] ${brief(answer, 200)}`],
  watching: () => ['[warm] I\'m watching. [break] Show me how.', '[curious] Okay, I\'m watching. [break] Go ahead.'],
  learned: ({ skill }) => (skill ? [`[pleased] Got it. [break] I've learned how to ${String(skill).replace(/^\w/, c => c.toLowerCase())}.`, `[pleased] Thanks! [break] I'll remember ${brief(skill, 60)}.`] : ['[pleased] Got it. [break] I\'ll do it your way from now on.']),
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

export async function synthesize(text, { signal } = {}) {
  const { enabled, voice, model } = voiceConfig();
  if (!enabled) return null;
  const dir = path.join(userDataDir(), 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.createHash('sha1').update(`${voice}|${model}|${text}`).digest('hex').slice(0, 16)}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 500) return fs.readFileSync(file);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.FISH_TIMEOUT_MS || 10000));
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
  } finally {
    clearTimeout(timer);
  }
}
