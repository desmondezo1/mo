// Hosted Mo in a real (headless) Chrome: the panel asks for sign-in, signs in with an email
// code, runs a task with the user's token, shows usage, and signs out. A small fake Supabase
// (email code + token endpoints) issues real HS256 tokens, so no Supabase project is needed.
//   node --test tests/signin-e2e.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const SECRET = 'signin-test-secret-0123456789abcdef';
let supa, supaUrl, server, base, context, worker, extId;
const sentCodes = [];

function jwt(sub, email) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b({ alg: 'HS256', typ: 'JWT' });
  const body = b({ sub, email, aud: 'authenticated', iss: `${supaUrl}/auth/v1`, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

before(async () => {
  // Fake Supabase Auth: POST /auth/v1/otp "emails" a code; POST /auth/v1/verify swaps it for a session.
  supa = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); res.end(JSON.stringify(data)); };
    if (req.method === 'OPTIONS') return json(204, {});
    if (!req.headers.apikey) return json(401, { msg: 'no apikey' });
    if (req.url === '/auth/v1/otp') { sentCodes.push({ email: body.email, code: '424242' }); return json(200, {}); }
    if (req.url === '/auth/v1/verify') {
      if (body.token !== '424242') return json(400, { msg: 'Token has expired or is invalid' });
      return json(200, { access_token: jwt('user-sarah', body.email), refresh_token: 'r1', expires_in: 3600, user: { email: body.email } });
    }
    if (req.url === '/auth/v1/logout') return json(204, {});
    json(404, {});
  });
  await new Promise(r => supa.listen(0, r));
  supaUrl = `http://127.0.0.1:${supa.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-signin-'));
  Object.assign(process.env, { SHOWME_DATA_DIR: dataDir, SHOWME_MOCK: '1', SUPABASE_URL: supaUrl, SUPABASE_JWT_SECRET: SECRET, SUPABASE_ANON_KEY: 'anon', MONTHLY_DECISION_CAP: '50', SIGN_IN_METHODS: 'google,email' });
  const { createServer } = await import('../server/index.js');
  server = createServer();
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  const ext = path.join(root, 'extension');
  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'mo-signin-profile-')), {
    channel: 'chromium', headless: process.env.HEADED !== '1', args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extId = new URL(worker.url()).host;
  await worker.evaluate(s => chrome.storage.local.set({ server: s, goal: '' }), base);
});
after(async () => { await context?.close(); server?.close(); supa?.close(); });

test('hosted: sign in with an email code, run with the token, see usage, sign out', { timeout: 90_000 }, async () => {
  const site = await context.newPage();
  await site.goto(`${base}/demo/helpdesk/`);
  const tabId = await worker.evaluate(async u => (await chrome.tabs.query({})).filter(t => t.url.startsWith(u)).pop()?.id, `${base}/demo/helpdesk/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html?tabId=${tabId}`);

  // 1. Signed out: the sign-in screen covers the panel.
  await panel.waitForSelector('#signin:not([hidden])', { timeout: 10_000 });
  assert.equal(await panel.isVisible('#signin-google'), true);

  // 2. A wrong code is refused in plain words; the right one signs in.
  await panel.fill('#signin-email', 'sarah@acme.example');
  await panel.click('#signin-send');
  await panel.waitForSelector('#signin-code-step:not([hidden])');
  assert.deepEqual(sentCodes.map(c => c.email), ['sarah@acme.example']);
  await panel.fill('#signin-code', '111111');
  await panel.click('#signin-verify');
  await panel.waitForFunction(() => /didn|invalid|expired/i.test(document.querySelector('#signin-error').textContent));
  await panel.fill('#signin-code', '424242');
  await panel.click('#signin-verify');
  await panel.waitForSelector('#signin', { state: 'hidden', timeout: 10_000 });
  assert.match(await panel.textContent('#account-email'), /sarah@acme\.example/);
  await panel.waitForFunction(() => /0 of 50 decisions this month/.test(document.querySelector('#usage').textContent));

  // 3. A run uses her token; usage goes up.
  await panel.fill('#goal', 'Create the account');
  await panel.click('#run');
  await panel.waitForSelector('#verdict:not([hidden])', { timeout: 30_000 });
  await panel.waitForFunction(() => !/^0 of/.test(document.querySelector('#usage').textContent), null, { timeout: 10_000 });
  console.log('signin usage after a run:', await panel.textContent('#usage'));

  // 4. Without a token the server refuses; signing out brings the sign-in back.
  assert.equal((await fetch(`${base}/api/skills`)).status, 401);
  await panel.click('#more');
  await panel.click('#sign-out');
  await panel.waitForSelector('#signin:not([hidden])', { timeout: 10_000 });
  assert.equal(await worker.evaluate(() => chrome.storage.local.get('moSession').then(s => s.moSession || null)), null);
  await panel.screenshot({ path: path.join(root, 'test-results', 'sidepanel-signin.png') });
});
