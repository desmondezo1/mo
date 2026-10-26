// Background worker.
// - Toolbar icon opens the side panel. Nothing else opens it on its own.
// - Push to talk: Mo (on the page) reports when ⌥Space or Mo is held and released.
//   If the side panel is open it listens and runs the goal where you can watch;
//   otherwise a hidden offscreen page listens and the agent runs here, with Mo narrating.

import { runAgent, createApi, getServer, mo } from './agent-core.js';

const api = createApi(getServer);
const panels = new Set();     // open side panels (each keeps a port to us)
let voice = null;             // { host: 'panel' | 'offscreen', tabId }
let headless = null;          // a voice run in progress while the panel is closed

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  self.injectIntoOpenTabs();
});

// Chrome only runs manifest content scripts in tabs opened after the extension loads.
// On install and on every reload, add them to the tabs that are already open, so Mo and
// the agent work there without refreshing each page.
self.injectIntoOpenTabs = async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({});
  const results = await Promise.all(tabs.filter(t => /^(https?|file):/.test(t.url || '')).map(tab =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js', 'mascot.js', 'guard.js'] }).then(() => true, () => false)));
  return results.filter(Boolean).length;
};

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') return;
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
});

// The offscreen page says when its script is listening; a message sent before that is lost.
let offscreenReady = null;
let markOffscreenReady = () => {};

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length && offscreenReady) return offscreenReady;
  offscreenReady = new Promise(resolve => { markOffscreenReady = resolve; setTimeout(resolve, 3000); });
  if (!existing.length) {
    await chrome.offscreen.createDocument({
      url: 'voice.html',
      reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Listen to a spoken instruction while the talk key or Mo is held, and say Mo\'s reply',
    });
  } else {
    markOffscreenReady();
  }
  return offscreenReady;
}

function toPanels(message) { for (const port of panels) port.postMessage(message); }

async function voiceStart(tabId) {
  if (panels.size) {
    voice = { host: 'panel', tabId, starting: Promise.resolve() };
    toPanels({ type: 'voice-start', tabId });
    return;
  }
  // Creating the offscreen page the first time takes a moment: a release that comes in
  // meanwhile must wait for the start to land, or listening would never stop.
  const v = { host: 'offscreen', tabId };
  voice = v;
  v.starting = (async () => {
    try {
      await ensureOffscreen();
      const { voiceTestScript } = await chrome.storage.local.get('voiceTestScript'); // tests only
      await chrome.runtime.sendMessage({ target: 'offscreen', type: 'voice-start', tabId, testScript: voiceTestScript });
    } catch (err) {
      mo(tabId, 'idle', { text: `I can't listen right now: ${err.message}`, hold: 5000 });
      if (voice === v) voice = null;
    }
  })();
}

function voiceEnd(kind) {
  const v = voice;
  if (!v) return;
  v.starting.then(() => {
    if (v.host === 'panel') toPanels({ type: `voice-${kind}` });
    else chrome.runtime.sendMessage({ target: 'offscreen', type: `voice-${kind}` }).catch(() => {});
  });
}

// Mo's reply when the panel is closed: shown in its bubble on the page and, with Talk back on,
// said out loud, the same words. A service worker can't play sound, so the offscreen page does.
async function respond(tabId, event, data, moState, { fallbackText = '', ...extra } = {}) {
  const talk = (await chrome.storage.local.get('speak')).speak !== false;
  const line = await api('/api/speak', { method: 'POST', body: { event, data, voice: talk } }).catch(() => null);
  const show = line?.show || fallbackText;
  mo(tabId, moState, { ...extra, text: show });
  if (talk && show) sayAloud({ audio: line?.audio || null, mime: line?.mime, text: show });
}

// Every spoken reply plays in the offscreen page, which Chrome lets play sound at any time;
// the side panel sends its lines here too, so a reply that comes after a long run isn't
// blocked as autoplay. The page reports how it went ("fish", "system" or "failed").
async function sayAloud({ audio, mime, text }) {
  await ensureOffscreen();
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'say', audio, mime, text }).catch(() => {});
}

// A voice goal while the side panel is closed: run it here; Mo shows each step.
async function runHeadless(tabId, goal) {
  if (headless) return respond(tabId, 'busy', {}, 'idle', { hold: 3000, fallbackText: 'I\'m still working on the last one.' });
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  headless = { tabId, goal, startUrl: tab.url };
  try {
    const r = await runAgent({ goal, tabId, api, looks: (await chrome.storage.local.get('looks')).looks !== false });
    tabId = r.tabId || tabId; // the run may have moved to another tab ("check my WhatsApp")
    if (r.outcome === 'done') {
      if (r.answer) respond(tabId, 'answer', { answer: r.answer }, 'success', { hold: 10000, fallbackText: r.answer });
      else respond(tabId, r.usedLesson ? 'doneWithLesson' : 'done', {}, 'success', { fallbackText: 'Done!' });
    } else if (r.outcome === 'failed' || r.outcome === 'asked') {
      // Teaching needs the panel: keep what's needed so it can pick up from here.
      await chrome.storage.session.set({ pendingTeach: { goal, tabId, startUrl: headless.startUrl, failure: r.failure, at: Date.now() } });
      const question = r.failure.replace(/^I need help: /, '');
      respond(tabId, r.asked ? 'asked' : 'failed', r.asked ? { question, teach: true } : { reason: r.failure, teach: true }, 'stuck',
        { action: 'teach', fallbackText: `${r.asked ? question : `I couldn't finish: ${r.failure}`} Click me to show me how.` });
    } else if (r.outcome === 'error') {
      respond(tabId, 'error', { message: r.failure }, 'idle', { hold: 6000, fallbackText: `Something went wrong: ${r.failure}` });
    }
  } finally {
    headless = null;
  }
}

async function shouldAutorun() {
  const { autorun } = await chrome.storage.local.get('autorun');
  return autorun !== false;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id ?? msg.tabId;
  switch (msg.type) {
    // From Mo on the page.
    case 'showme:voice-start': voiceStart(tabId); break;
    case 'showme:voice-stop': voiceEnd('stop'); break;
    case 'showme:voice-cancel': voiceEnd('cancel'); break;
    case 'showme:bubble':
      if (msg.action === 'mic') chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
      else {
        // Try to open the panel (allowed when Chrome counts the click as a user action);
        // an open panel picks up the pending lesson either way.
        chrome.sidePanel.open({ tabId }).catch(() => mo(tabId, 'idle', { text: 'Click Mo\'s icon in the toolbar to teach me.', hold: 5000 }));
        chrome.runtime.sendMessage({ type: 'showme:teach-request' }).catch(() => {});
      }
      break;
    // Mo Guard, from the page.
    case 'guard:check':
      api('/api/guard/check', { method: 'POST', body: { pageUrl: msg.pageUrl, links: msg.links, hasPassword: msg.hasPassword } })
        .then(r => reply({ ok: true, results: r.results }), err => reply({ ok: false, error: err.message }));
      return true;
    case 'guard:feedback':
      api('/api/guard/feedback', { method: 'POST', body: { url: msg.url, verdict: msg.verdict, text: msg.text, pageUrl: msg.pageUrl } })
        .then(r => reply({ ok: true, ...r }), err => reply({ ok: false, error: err.message }));
      return true;
    case 'guard:mo': {
      const { type, ...rest } = msg;
      mo(tabId, rest.state, rest);
      break;
    }
    // Mo's voice: the panel's lines, and how the offscreen page played them.
    case 'mo:say': sayAloud(msg); break;
    case 'mo:hush': chrome.runtime.sendMessage({ target: 'offscreen', type: 'hush' }).catch(() => {}); break;
    case 'voice:said': chrome.storage.session.set({ lastSaid: { text: msg.text, how: msg.how, error: msg.error || null, at: Date.now() } }); break;
    case 'guard:report': chrome.tabs.sendMessage(tabId, { type: 'guard:report-page' }).catch(() => {}); break;

    case 'showme:open-panel':
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(() => reply({ ok: true }), err => reply({ ok: false, error: err.message }));
      return true;

    // From the offscreen voice page.
    case 'voice:ready': markOffscreenReady(); break;
    case 'voice:levels':
      chrome.tabs.sendMessage(msg.tabId, { type: 'showme:voice', state: 'listening', id: msg.id, levels: msg.levels, text: msg.text }).catch(() => {});
      break;
    case 'voice:error':
      if (msg.error === 'not-allowed' || msg.error === 'service-not-allowed') {
        mo(msg.tabId, 'stuck', { action: 'mic', text: 'I need the microphone once. Click here to allow it.' });
      } else {
        mo(msg.tabId, 'idle', { text: `I couldn't listen: ${msg.error}.`, hold: 4000 });
      }
      break;
    case 'voice:result': {
      const heard = !msg.cancelled && msg.text;
      chrome.tabs.sendMessage(msg.tabId, { type: 'showme:voice', state: heard ? 'heard' : (msg.cancelled ? 'cancelled' : 'off'), id: msg.id, text: msg.text }).catch(() => {});
      voice = null;
      if (heard) shouldAutorun().then(go => go ? runHeadless(msg.tabId, msg.text) : mo(msg.tabId, 'idle', { text: `“${msg.text}”. Open the panel and press Run.`, hold: 5000 }));
      break;
    }
  }
  return false;
});
