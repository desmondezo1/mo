// Hosted mode: sign-in, per-user data, the monthly cap and CORS. Tokens are signed here the
// way Supabase signs them (HS256 with the project's JWT secret), so no Supabase is needed.
//   node --test tests/accounts.test.js

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-accounts-'));
Object.assign(process.env, {
  SHOWME_DATA_DIR: dataDir, SHOWME_MOCK: '1', MUBIT_API_KEY: '',
  SUPABASE_URL: 'https://example-project.supabase.co', SUPABASE_JWT_SECRET: 'test-secret-that-is-long-enough-123', SUPABASE_ANON_KEY: 'anon-public-key',
  MONTHLY_DECISION_CAP: '3', ALLOWED_ORIGINS: 'chrome-extension://moextensionid', RATE_PER_MINUTE: '1000',
});
const { createServer } = await import('../server/index.js');

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(sub, { exp = Math.floor(Date.now() / 1000) + 3600, secret = process.env.SUPABASE_JWT_SECRET, iss = 'https://example-project.supabase.co/auth/v1' } = {}) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, email: `${sub}@example.com`, aud: 'authenticated', iss, exp });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

let server, base;
before(async () => { server = createServer(); await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const call = (p, { as, method = 'GET', body, origin = 'chrome-extension://moextensionid' } = {}) => fetch(base + p, {
  method,
  headers: { ...(as ? { authorization: `Bearer ${as}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const lesson = goal => ({
  goal, url: 'https://crm.example/new', skill: goal,
  steps: [{ action: 'type', label: 'Company', role: 'textbox', value: 'Northwind', page: { url: 'https://crm.example/new', title: 'New', elements: [{ id: 'e1', role: 'textbox', label: 'Company' }] } }],
});

test('health and config are public; config says how to sign in, with no secrets', async () => {
  assert.equal((await call('/api/health')).status, 200);
  const cfg = await (await call('/api/config')).json();
  assert.deepEqual(cfg, { authRequired: true, supabaseUrl: 'https://example-project.supabase.co', supabaseAnonKey: 'anon-public-key', signIn: ['google', 'email'] });
  assert.ok(!JSON.stringify(cfg).includes('test-secret'));
});

test('everything else needs a valid, unexpired token for this project', async () => {
  for (const [as, why] of [[undefined, 'no token'], ['not-a-jwt', 'garbage'], [token('a', { secret: 'wrong' }), 'wrong signature'],
    [token('a', { exp: 1000 }), 'expired'], [token('a', { iss: 'https://other.supabase.co/auth/v1' }), 'another project']]) {
    const r = await call('/api/skills', { as });
    assert.equal(r.status, 401, why);
    assert.equal((await r.json()).code, 'signed_out', why);
  }
  const me = await (await call('/api/me', { as: token('alice') })).json();
  assert.equal(me.user.id, 'alice');
  assert.equal(me.user.email, 'alice@example.com');
});

test('each user sees only their own skills', async () => {
  const alice = token('alice'), bob = token('bob');
  assert.equal((await call('/api/demonstrations', { as: alice, method: 'POST', body: lesson('Add a customer account') })).status, 200);
  const aliceSkills = (await (await call('/api/skills', { as: alice })).json()).skills.map(s => s.name);
  const bobSkills = (await (await call('/api/skills', { as: bob })).json()).skills.map(s => s.name);
  assert.deepEqual(aliceSkills, ['Add a customer account']);
  assert.deepEqual(bobSkills, []);
  // Forgetting is per user too.
  await call('/api/demonstrations', { as: bob, method: 'DELETE' });
  assert.equal((await (await call('/api/skills', { as: alice })).json()).skills.length, 1);
  // A user id can't reach outside the data folder.
  const sneaky = token('../../etc');
  await call('/api/skills', { as: sneaky });
  assert.ok(fs.existsSync(path.join(dataDir, 'users', '______etc')));
});

test('the monthly cap stops new decisions with a clear message, per user', async () => {
  const carol = token('carol');
  const page = { url: 'https://crm.example/new', title: 'New', elements: [{ id: 'e1', role: 'button', label: 'Save' }] };
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/next-action', { as: carol, method: 'POST', body: { goal: 'Save it', page, sessionId: 's' } })).status, 200);
  const r = await call('/api/next-action', { as: carol, method: 'POST', body: { goal: 'Save it', page, sessionId: 's' } });
  const j = await r.json();
  assert.equal(r.status, 429);
  assert.equal(j.code, 'monthly_limit');
  assert.match(j.error, /all 3 of this month's decisions/);
  const u = await (await call('/api/usage', { as: carol })).json();
  assert.equal(u.used, 3); assert.equal(u.cap, 3); assert.equal(u.remaining, 0);
  assert.ok(new Date(u.resetsAt) > new Date());
  // Someone else still has their whole month.
  assert.equal((await call('/api/next-action', { as: token('dave'), method: 'POST', body: { goal: 'Save it', page, sessionId: 's' } })).status, 200);
});

test('CORS: only the extension may call the server from a browser', async () => {
  const ok = await call('/api/health', { origin: 'chrome-extension://moextensionid' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'chrome-extension://moextensionid');
  const evil = await call('/api/health', { origin: 'https://evil.example' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.match((await call('/api/health')).headers.get('access-control-allow-headers') || '', /authorization/);
});

test('the live event stream needs a token too, given as ?token=', async () => {
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
  const ctrl = new AbortController();
  const r = await fetch(`${base}/api/events?token=${token('alice')}`, { signal: ctrl.signal });
  assert.equal(r.status, 200);
  ctrl.abort();
});
