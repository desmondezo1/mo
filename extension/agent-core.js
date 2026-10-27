// The agent loop and its browser plumbing, shared by the side panel (runs you can watch)
// and the background worker (voice runs while the panel is closed). Everything here uses
// only chrome.tabs / chrome.scripting / fetch, which both places have.

import { accessToken } from './auth-core.js';

export const MAX_STEPS = 30;
export const RISKY = /pay|purchase|buy now|place order|delete|remove|transfer|send|submit|confirm|reserve|book/i;

// Errors from the backend, Mubit or the provider. They are not the agent's mistakes,
// so they never trigger "show me".
export class InfraError extends Error {}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const isOwnPage = url => !url || url.startsWith(chrome.runtime.getURL(''));
export const isWebPage = url => /^(https?|file):/.test(url || '');

export async function getServer() {
  const { server } = await chrome.storage.local.get('server');
  return (server || 'http://localhost:8787').replace(/\/$/, '');
}

// Every call carries the user's sign-in when the server needs one (see auth-core.js).
export function createApi(serverOf) {
  return async function api(path, { method = 'GET', body, signal } = {}) {
    const server = await serverOf();
    const token = await accessToken(server);
    let res;
    try {
      res = await fetch(`${server}${path}`, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new InfraError(`Backend offline at ${server}. Start it with: npm start`);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.code === 'signed_out') {
      await chrome.storage.local.remove('moSession');
      chrome.runtime.sendMessage({ type: 'mo:signed-out' }).catch(() => {});
      throw Object.assign(new InfraError('Sign in to Mo to continue.'), { signedOut: true });
    }
    if (!res.ok && data.agentError) throw new Error(`I gave an answer I couldn't act on (${data.error.slice(0, 120)}…)`);
    if (!res.ok) throw new InfraError(data.error || `${res.status} ${res.statusText}`);
    return data;
  };
}

export async function waitForLoad(tabId, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await sleep(150);
  }
  throw new InfraError('The page took too long to load');
}

export async function send(tabId, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await chrome.tabs.sendMessage(tabId, message);
      if (reply) return reply;
    } catch {
      // No content script yet (page opened before the extension loaded, or mid-navigation).
      await waitForLoad(tabId).catch(() => {});
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js', 'mascot.js', 'guard.js'] }).catch(() => {});
      await sleep(150);
    }
  }
  throw new InfraError('Mo cannot read this page (try reloading it; chrome:// pages are off limits)');
}

export async function snapshot(tabId) {
  const tab = await waitForLoad(tabId);
  // A new tab or chrome:// page can't be read, but the agent can still open a site from it.
  if (!isWebPage(tab.url)) {
    return { url: tab.url || 'about:blank', title: tab.title || 'New tab', headings: [], elements: [], text: '',
      note: 'none (browser start page: use open_url to go to a site)' };
  }
  const reply = await send(tabId, { type: 'showme:snapshot' });
  if (!reply.ok) throw new Error(reply.error);
  return reply.page;
}

export function shortUrl(url) {
  try { const u = new URL(url); return (u.host + u.pathname + u.search).replace(/\/$/, '').slice(0, 60); } catch { return String(url).slice(0, 60); }
}

export function describeAction(a) {
  const target = a.label ? `“${a.label}”` : (a.element_id || 'the page');
  switch (a.action) {
    case 'type': return `type “${a.value}” into ${target}${a.submit ? ' + Enter' : ''}`;
    case 'select': return `select “${a.value}” in ${target}`;
    case 'press': return `press ${a.value}${a.label ? ` on ${target}` : ''}`;
    case 'open_url': return `open ${shortUrl(a.value)}`;
    case 'back': return 'go back';
    case 'scroll': return `scroll ${a.value || 'down'}`;
    case 'wait': return 'wait for the page';
    case 'ask_human': return `ask you: “${a.value}”`;
    case 'highlight': return `point out “${a.value}”`;
    case 'new_tab': return 'open a new tab';
    case 'switch_tab': return `switch to ${a.label || shortUrl(a.value)}`;
    case 'done': return 'finish';
    default: return `click ${target}`;
  }
}

// Mo on the page shows what the agent is doing.
export function mo(tabId, state, extra = {}) {
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'showme:mo', state, ...extra }).catch(() => {});
}

// Sites people name by brand ("Do I have WhatsApp messages?"), and where each one lives.
export const SITES = {
  whatsapp: 'https://web.whatsapp.com/', gmail: 'https://mail.google.com/', outlook: 'https://outlook.live.com/mail/',
  slack: 'https://app.slack.com/', linkedin: 'https://www.linkedin.com/', twitter: 'https://x.com/', facebook: 'https://www.facebook.com/',
  instagram: 'https://www.instagram.com/', youtube: 'https://www.youtube.com/', github: 'https://github.com/', notion: 'https://www.notion.so/',
  telegram: 'https://web.telegram.org/', messenger: 'https://www.messenger.com/', discord: 'https://discord.com/app',
};
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export function sameSite(a, b) {
  const x = hostOf(a), y = hostOf(b);
  return !!x && !!y && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}
// The site a goal names, with a test for "this tab is on it" (any WhatsApp or Outlook host counts).
export function siteInGoal(goal) {
  const name = String(goal).toLowerCase().match(new RegExp(`\\b(${Object.keys(SITES).join('|')})\\b`))?.[1];
  if (!name) return null;
  const url = SITES[name];
  return { name, url, matches: tab => hostOf(tab?.url).includes(name) || sameSite(tab?.url, url) };
}

// The other web pages open in the tab's window, newest first: what the agent can switch to.
export async function otherTabs(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return (await chrome.tabs.query({ windowId: tab.windowId }))
    .filter(t => t.id !== tabId && isWebPage(t.url) && !t.url.startsWith(chrome.runtime.getURL('')))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
}

// Going to a site the way a person would: if it's already open in another tab, switch to that
// tab (keeping their place in it); from a blank tab, open it there; otherwise open it in a new
// tab beside the page they're on, so that page stays as it was.
export async function goTo(tabId, url, matches = t => sameSite(t.url, url)) {
  const current = await chrome.tabs.get(tabId);
  if (!sameSite(current.url, url)) {
    const open = (await otherTabs(tabId)).find(matches);
    if (open) {
      await chrome.tabs.update(open.id, { active: true });
      const u = new URL(url);
      if ((u.pathname.length > 1 || u.search || u.hash) && !open.url.startsWith(url)) await chrome.tabs.update(open.id, { url });
      await sleep(400);
      await waitForLoad(open.id, 30000);
      return { ok: true, tabId: open.id, how: 'switched', title: open.title };
    }
    if (isWebPage(current.url)) {
      const tab = await chrome.tabs.create({ url, windowId: current.windowId, index: current.index + 1, active: true });
      await sleep(400);
      await waitForLoad(tab.id, 30000);
      return { ok: true, tabId: tab.id, how: 'opened' };
    }
  }
  await chrome.tabs.update(tabId, { url });
  await sleep(400);
  await waitForLoad(tabId, 30000);
  return { ok: true, tabId, how: 'here' };
}

// ---- A look at the screen when Mo is stuck ------------------------------------------
// Mo reads pages as text. When that isn't enough (it picked an element that isn't there,
// keeps repeating itself, is about to ask for help, or the page has almost nothing to read),
// it takes one look: the visible part of the tab, at most 1280 px wide (about 1,200 image
// tokens, a hundredth of a cent on Haiku), with each listed element's id drawn on it, so the
// model still answers "click e14". At most MAX_LOOKS a run.
export const MAX_LOOKS = 3;
const LOOK_WIDTH = 1280;
// Chats are private: Mo reads their text when asked about them, but doesn't photograph them.
const NO_LOOKS = /(^|\.)(web\.whatsapp\.com|web\.telegram\.org|messenger\.com|discord\.com|slack\.com)$/;

export async function canLook(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !!tab?.active && isWebPage(tab.url) && !NO_LOOKS.test(hostOf(tab.url));
}

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export async function screenshot(tabId, page) {
  if (!(await canLook(tabId))) return null;
  const tab = await chrome.tabs.get(tabId);
  const [shot, where] = await Promise.all([
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 }),
    send(tabId, { type: 'showme:marks', ids: (page.elements || []).map(e => e.id) }).catch(() => null),
  ]);
  const img = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = Math.min(1, LOOK_WIDTH / img.width);
  const canvas = new OffscreenCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const k = where?.width ? canvas.width / where.width : 1; // page pixels → image pixels
  ctx.font = 'bold 12px sans-serif';
  ctx.lineWidth = 2;
  for (const m of where?.marks || []) {
    const x = m.x * k, y = m.y * k, top = Math.max(0, y - 15);
    ctx.strokeStyle = '#e0006b';
    ctx.strokeRect(x, y, m.w * k, m.h * k);
    ctx.fillStyle = '#e0006b';
    ctx.fillRect(x, top, ctx.measureText(m.id).width + 6, 15);
    ctx.fillStyle = '#fff';
    ctx.fillText(m.id, x + 3, top + 12);
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return { data: base64(await blob.arrayBuffer()), mime: 'image/jpeg', width: canvas.width, height: canvas.height };
}

// Actions the browser does itself; the rest happen inside the page.
export async function perform(tabId, action) {
  if (action.action === 'open_url') {
    await chrome.tabs.update(tabId, { url: action.value });
    await sleep(400);
    await waitForLoad(tabId, 30000);
    return { ok: true };
  }
  if (action.action === 'back') {
    await chrome.tabs.goBack(tabId).catch(() => {});
    await sleep(400);
    await waitForLoad(tabId);
    return { ok: true };
  }
  if (action.action === 'wait') return { ok: true };
  return send(tabId, { type: 'showme:act', action });
}

// Privacy floor, in code, before anything the model picks: on a cookie banner, an
// "accept" click becomes the banner's reject / necessary-only button when there is one.
const ACCEPT = /\b(accept|agree|allow)( all)?\b/i;
const REJECT = /\b(reject|decline|refuse)( all| additional)?\b|necessary only|only necessary|essential only|only essential/i;
export function privacyFloor(next, page) {
  if (next.action !== 'click' || !ACCEPT.test(next.label || '') || !/cookie/i.test(page.text || '')) return next;
  const reject = (page.elements || []).find(e => (e.role === 'button' || e.role === 'link') && REJECT.test(e.label));
  if (!reject) return next;
  return { ...next, element_id: reject.id, label: reject.label, role: reject.role, reason: 'Chose the privacy-friendly option on the cookie banner' };
}

// "Let me show you", "watch me", "that's not the right way": the person wants to teach, so
// Mo starts watching instead of running anything.
export function isTeachRequest(text) {
  const t = String(text).toLowerCase().replace(/[\u2018\u2019]/g, "'");
  return /\b(let me|i'?ll|i will|i can|i want to|allow me to) (show|teach) you\b/.test(t)
    || /\b(watch|observe) (me|how i|what i)\b/.test(t)
    || /\b(that'?s|this is|it'?s|you'?re doing it) (not|the wrong way)\b.*\b(way|right|how)\b/.test(t)
    || /\bnot the right way\b|\bwrong way\b/.test(t);
}

// Questions and "show me where…" requests get an answer highlighted on the page instead
// of (or after) clicking around.
// Spoken goals start with filler ("so what's my…", "hey Mo, do I have…") and have no "?".
const FILLER = /^(?:(?:so|ok|okay|hey|hi|hello|um+|uh+|erm|well|and|but|please|now|alright|right|mo|emo)\b[\s,.!]*)+/;
export function isQuestion(goal) {
  const g = String(goal).trim().toLowerCase().replace(FILLER, '');
  return /\?$/.test(g)
    || /^(what|when|where|who|whom|which|why|how|is|are|was|were|does|do|did|can|could|should|will|would|has|have)\b/.test(g)
    || /^(show|tell) me (where|what|when|how|which|who|if)\b/.test(g)
    || /^(tell me|let me know)\b/.test(g)
    || /^(highlight|point (me )?(to|at)|locate)\b/.test(g)
    || /^find\b.*\b(on|in) (this|the) page\b/.test(g)
    || /\b(check|see|find out|know|tell me) (if|whether)\b/.test(g);
}

// The proof a done carries, checked against the page in code: the quoted words (any of the
// page's text, a block, or an element's label, such as a headline) must be there, allowing
// for "…" between quoted pieces and small differences in punctuation. Returns { ok, quote,
// id: the block or element to box } or { ok: false, why }.
const norm = s => String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
export function checkProof(next, page, question) {
  if (question && !String(next.value || '').trim()) return { ok: false, why: next.reason || 'there was no answer' };
  const quote = norm(next.evidence).replace(/^["'\s]+|["'.\u2026\s]+$/g, '');
  if (quote.length < 3) return { ok: false, why: next.reason || 'no words from the page were quoted to show it' };
  const items = [...(page.blocks || []).map(b => ({ id: b.id, text: norm(b.text) })), ...(page.elements || []).map(e => ({ id: e.id, text: norm(`${e.label || ''} ${e.value || ''}`) }))];
  const hay = [norm(page.title), norm(page.screenText), norm(page.text), ...items.map(i => i.text)].join('\n');
  const parts = quote.split(/\s*(?:\u2026|\.\.\.|\|)\s*/).filter(p => p.length >= 3);
  const words = quote.split(/[^\p{L}\p{N}']+/u).filter(w => w.length > 2);
  const have = new Set(hay.split(/[^\p{L}\p{N}']+/u));
  const found = parts.every(p => hay.includes(p)) || (words.length >= 4 && words.filter(w => have.has(w)).length / words.length >= 0.85);
  if (!found) return { ok: false, why: `“${String(next.evidence).slice(0, 80)}” isn't on the page` };
  const id = items.find(i => parts.some(p => i.text.includes(p)))?.id || '';
  return { ok: true, quote: String(next.evidence).slice(0, 120), id };
}

// Where a run should happen: { where: 'here' | 'tab' | 'open', url, plan, matches(tab) }.
// The model decides from the request, this page and the open tabs; if it can't be asked, a
// site the request names ("my WhatsApp") still goes to that site.
async function planRun(goal, tabId, api, signal, r, call) {
  const page = await snapshot(tabId).catch(() => ({ url: '', title: '' }));
  const tabs = (await otherTabs(tabId)).slice(0, 15).map(t => ({ title: t.title, url: new URL(t.url).origin }));
  let plan = null;
  try {
    plan = await api('/api/plan', { method: 'POST', body: { goal, page: { url: page.url, title: page.title, headings: page.headings, text: page.text, screenText: page.screenText }, tabs, sessionId: r.sessionId }, signal });
    call('usage', plan.usage, plan.ms);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  const site = siteInGoal(goal);
  if (!plan && site) plan = { where: 'open', url: site.url, plan: '' };
  if (!plan) return null;
  r.plan = plan.plan || '';
  if (plan.where === 'here') {
    // Already there? Then a site the request names is this one (the model said so).
    return plan;
  }
  const url = plan.url;
  const named = site && sameSite(site.url, url) ? site.matches : null;
  const matches = t => sameSite(t.url, url) || !!named?.(t);
  if (matches(await chrome.tabs.get(tabId))) return { ...plan, where: 'here' };
  return { ...plan, matches };
}

// One run of the agent on a tab. `ui` callbacks let the caller show progress
// (the panel draws a timeline; the background lets Mo narrate):
//   step(next) → handle, failedStep(handle), navigated(handle, url), check(check), error(message), usage(usage, ms)
// skill: run that taught skill (its newest lesson guides every step). approved: labels of
// risky buttons the user already approved for this run (one approval for a whole batch).
// looks: take a screenshot when stuck (off: text only).
export async function runAgent({ goal, tabId, api, signal, isStopped = () => false, ui = {}, skill = null, approved = null, row = null, looks = true }) {
  const r = {
    goal, tabId, sessionId: `run-${Date.now()}`, history: [], runSteps: [],
    failure: null, infra: false, finished: false, asked: false, usedLesson: false, decisions: 0, invalid: 0, looks: 0,
  };
  // Stuck: decide the same step again, this time with a look at the screen. Once per moment
  // (a decision that already had a look is final) and only where a look is allowed.
  let lookNext = false;
  const mayLookAgain = async looked => looks && !looked && r.looks < MAX_LOOKS && await canLook(tabId);
  const call = (fn, ...args) => (ui[fn] ? ui[fn](...args) : undefined);
  const question = isQuestion(goal);
  // Going somewhere can move the run to another tab; from then on it works there.
  const moveTo = async (url, matches) => {
    const went = await goTo(tabId, url, matches);
    tabId = r.tabId = went.tabId;
    return went;
  };
  try {
    await send(tabId, { type: 'showme:act', action: { action: 'clear_highlight' } }).catch(() => {});
    // Plan first: is this the right place for the request, another open tab, or a site to
    // open? ("Do I have WhatsApp messages?" asked on Gmail means WhatsApp, not a Gmail search.)
    // A taught skill or a sheet row knows where it works, so it skips this.
    const where = skill || row ? null : await planRun(goal, tabId, api, signal, r, call);
    if (where && where.where !== 'here') {
      const went = await moveTo(where.url, where.matches);
      const entry = went.how === 'switched'
        ? { action: 'switch_tab', value: (await chrome.tabs.get(tabId)).url, label: went.title || '' }
        : { action: 'open_url', value: where.url, label: '' };
      const handle = call('step', { ...entry, valid: true, reason: where.plan || (went.how === 'switched' ? 'It was already open in another tab' : 'It wasn\'t open, so I opened it') });
      r.history.push(entry);
      r.runSteps.push({ ...entry, handle });
    }
    for (let step = 1; step <= MAX_STEPS && !isStopped(); step++) {
      const page = await snapshot(tabId);
      mo(tabId, 'thinking');
      // A page with almost nothing to read (a canvas app, a page still drawing) gets a look too.
      const sparse = isWebPage(page.url) && (page.elements?.length || 0) < 3 && (page.text || '').length < 200;
      const looked = looks && r.looks < MAX_LOOKS && (lookNext || sparse);
      const why = lookNext;
      lookNext = false;
      const shot = looked ? await screenshot(tabId, page).catch(() => null) : null;
      if (shot) { r.looks++; call('looked', shot, why ? 'stuck' : 'sparse'); }
      const tabs = (await otherTabs(tabId)).slice(0, 15).map(t => ({ title: t.title, url: new URL(t.url).origin }));
      const body = { goal, page, tabs, plan: r.plan, question, history: r.history, sessionId: r.sessionId, skill, ...(shot ? { screenshot: { data: shot.data, mime: shot.mime } } : {}) };
      const next = privacyFloor(await api('/api/next-action', { method: 'POST', body, signal }), page);
      call('usage', next.usage, next.ms);
      r.decisions++;
      if (!next.valid) r.invalid++;
      if (next.demoUsed) r.usedLesson = true;
      const handle = call('step', next);

      // Done needs proof, checked here against the page: the words it quotes must be on it (and
      // a question needs its answer). A done without proof isn't the end: the model is told why
      // and keeps going, with a look at the screen the second time. Three in a row, and it stops.
      if (next.action === 'done') {
        const proof = checkProof(next, page, question);
        if (proof.ok) {
          r.finished = true;
          if (question) {
            r.answer = next.value;
            if (proof.id) await send(tabId, { type: 'showme:act', action: { action: 'highlight', element_id: proof.id, value: next.value } }).catch(() => {});
            call('answer', { answer: next.value, demoUsed: next.demoUsed });
          } else call('check', { done: true, reason: `The page shows “${proof.quote}”` });
          break;
        }
        r.rejected = (r.rejected || 0) + 1;
        call('failedStep', handle);
        call('check', { done: false, reason: `Not done yet: ${proof.why}` });
        if (r.rejected >= 3) { r.failure = `I think it's done, but I can't show it on the page: ${proof.why}.`; break; }
        r.history.push({ action: 'done', rejected: true, why: proof.why, value: next.value });
        if (r.rejected >= 2 && await mayLookAgain(looked)) lookNext = true;
        continue;
      }
      if ((!next.valid || next.action === 'ask_human') && await mayLookAgain(looked)) { call('failedStep', handle); lookNext = true; continue; }
      if (!next.valid) { r.failure = next.action === 'open_url' ? 'I tried to open an address that is not a web URL.' : 'I picked an element that is not on the page.'; break; }
      if (next.action === 'ask_human') { r.failure = `I need help: ${next.value || next.reason}`; r.asked = true; break; }

      const same = h => h.action === next.action && h.label === next.label && h.value === next.value;
      const limit = next.action === 'scroll' || next.action === 'wait' ? 4 : 2;
      if (r.history.filter(same).length >= limit && await mayLookAgain(looked)) { call('failedStep', handle); lookNext = true; continue; }
      if (r.history.filter(same).length >= limit) { r.failure = `I kept repeating “${describeAction(next)}”.`; break; }

      if ((next.role === 'button' || next.role === 'link') && RISKY.test(next.label || '') && !approved?.has(next.label)) {
        const gate = await api('/api/safety-gate', { method: 'POST', body: { goal, action: next, element: { label: next.label, role: next.role }, evidence: page.text, sessionId: r.sessionId }, signal });
        call('usage', gate.usage, gate.ms);
        if (!gate.allow) { r.failure = `Safety gate blocked “${next.label}”: ${gate.reason}`; break; }
      }

      const before = (await chrome.tabs.get(tabId)).url;
      mo(tabId, 'acting', { targetId: next.element_id, text: describeAction(next) });
      const result = next.action === 'open_url' ? await moveTo(next.value) : await perform(tabId, next);
      if (!result.ok) { r.failure = result.error; call('failedStep', handle); break; }
      // A click on a checkbox says which way it went, as Ada's recorded steps do.
      const box = next.action === 'click' && next.role === 'checkbox' ? page.elements.find(e => e.id === next.element_id) : null;
      const value = box ? (box.checked ? 'untick' : 'tick') : next.value;
      const entry = { action: next.action, label: next.label, role: next.role, value, submit: next.submit, element_id: next.element_id };
      r.history.push(entry);
      r.runSteps.push({ ...entry, handle });
      // Waits grow (1.5 s, 3 s, 4.5 s, 6 s): a slow app like WhatsApp Web can take 15 s to load.
      await sleep(next.action === 'wait' ? 1500 * Math.min(4, r.history.filter(h => h.action === 'wait').length) : 600);
      const after = await waitForLoad(tabId).catch(() => null);
      if (after && after.url !== before) call('navigated', handle, after.url);
    }

    if (isStopped()) r.failure = 'Stopped.';
    else if (!r.failure && !r.finished) r.failure = `I ran out of steps (${MAX_STEPS}).`;

  } catch (err) {
    if (err.name === 'AbortError' || isStopped()) {
      r.failure = 'Stopped.';
    } else {
      r.failure = err.message;
      r.infra = err instanceof InfraError;
      call('error', err.message);
    }
  }
  r.outcome = !r.failure ? 'done' : r.failure === 'Stopped.' ? 'stopped' : r.infra ? 'error' : r.asked ? 'asked' : 'failed';
  const finalTab = await chrome.tabs.get(tabId).catch(() => null);
  r.finalUrl = finalTab?.url || null;
  // Every run is recorded for the Mubit tab's "failures that became fixes".
  api('/api/runs', { method: 'POST', body: {
    goal, outcome: r.outcome, usedLesson: r.usedLesson, steps: r.history.length, decisions: r.decisions, invalid: r.invalid,
    tools: [...new Set(r.history.map(h => h.action).concat(r.finished ? ['done'] : [], r.answer ? ['highlight'] : []))], url: r.finalUrl,
    skill, row,
  } }).catch(() => {});
  return r;
}
