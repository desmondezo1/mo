// Accounts: who is calling, where their data lives, and how much they may use.
//
// Hosted (SUPABASE_URL is set): every /api call carries a Supabase access token. We check it
// ourselves (no extra dependency): HS256 with SUPABASE_JWT_SECRET, or the project's signing
// keys from its JWKS. Each user's skills, runs, calls and settings live in their own folder.
// Local (no SUPABASE_URL): one user called "local" and the data folder as before.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
const LOCAL = { id: 'local', email: null };

export const authRequired = () => !!process.env.SUPABASE_URL && process.env.AUTH !== 'off';
export const currentUser = () => context.getStore()?.user || LOCAL;
export const runAs = (user, fn) => context.run({ user }, fn);

function baseDir() {
  return process.env.SHOWME_DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
}
// The data folder for whoever is calling. Ids come from verified tokens; we still keep them
// to safe characters so an id can never point outside the data folder.
export function userDataDir() {
  const user = currentUser();
  const dir = user.id === 'local' ? baseDir() : path.join(baseDir(), 'users', String(user.id).replace(/[^a-zA-Z0-9_-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export const sharedDataDir = () => { fs.mkdirSync(baseDir(), { recursive: true }); return baseDir(); };

// ---- Tokens -----------------------------------------------------------------------------
export class AuthError extends Error { constructor(message) { super(message); this.status = 401; } }

const b64url = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
let jwks = { keys: [], fetchedAt: 0 };
async function signingKey(kid) {
  const fresh = Date.now() - jwks.fetchedAt < 10 * 60 * 1000;
  let jwk = jwks.keys.find(k => k.kid === kid);
  if (!jwk || !fresh) {
    const res = await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`).catch(() => null);
    if (res?.ok) jwks = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
    jwk = jwks.keys.find(k => k.kid === kid);
  }
  return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

export async function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new AuthError('Sign in to use Mo.');
  let header, claims;
  try { header = JSON.parse(b64url(parts[0])); claims = JSON.parse(b64url(parts[1])); } catch { throw new AuthError('Your sign-in is not valid. Sign in again.'); }
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = b64url(parts[2]);
  let ok = false;
  if (header.alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (secret) ok = crypto.timingSafeEqual(crypto.createHmac('sha256', secret).update(data).digest(), sig.length === 32 ? sig : Buffer.alloc(32));
  } else if (header.alg === 'ES256' || header.alg === 'RS256') {
    const key = await signingKey(header.kid);
    if (key) ok = crypto.verify('sha256', data, header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, sig);
  }
  if (!ok) throw new AuthError('Your sign-in is not valid. Sign in again.');
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) throw new AuthError('Your sign-in has expired. Sign in again.');
  if (claims.aud && claims.aud !== 'authenticated') throw new AuthError('Your sign-in is not valid. Sign in again.');
  const iss = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  if (claims.iss && claims.iss !== iss) throw new AuthError('Your sign-in is for a different Mo server.');
  if (!claims.sub) throw new AuthError('Your sign-in is not valid. Sign in again.');
  return { id: claims.sub, email: claims.email || null };
}

// The user behind a request: a Bearer token, or ?token= for the event stream (EventSource
// can't set headers). Local mode needs neither.
export async function userFor(req, url) {
  if (!authRequired()) return LOCAL;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  return verifyToken(token);
}

// ---- Limits -----------------------------------------------------------------------------
export class LimitError extends Error { constructor(message, code) { super(message); this.status = 429; this.code = code; } }

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthlyCap = () => Number(process.env.MONTHLY_DECISION_CAP || (authRequired() ? 3000 : 0)); // 0: no cap
const dailySpendCap = () => Number(process.env.DAILY_SPEND_CAP_USD || 0);
const perMinute = () => Number(process.env.RATE_PER_MINUTE || (authRequired() ? 120 : 0));

// Decisions this month, per user, kept in a small file next to their data.
function usageFile() { return path.join(userDataDir(), 'usage.json'); }
function readUsage() {
  try { const u = JSON.parse(fs.readFileSync(usageFile(), 'utf8')); if (u.month === monthKey()) return u; } catch { /* none yet */ }
  return { month: monthKey(), decisions: 0, usd: 0 };
}
function readSpend() {
  try { const s = JSON.parse(fs.readFileSync(path.join(sharedDataDir(), 'spend.json'), 'utf8')); if (s.day === dayKey()) return s; } catch { /* none yet */ }
  return { day: dayKey(), usd: 0 };
}

export function usage() {
  const u = readUsage(), cap = monthlyCap();
  const now = new Date();
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  return { used: u.decisions, cap, remaining: cap ? Math.max(0, cap - u.decisions) : null, resetsAt, usd: +u.usd.toFixed(4) };
}

// Before a model call: is this user (and the whole service) still within budget?
export function checkBudget() {
  const cap = monthlyCap();
  if (cap && readUsage().decisions >= cap) {
    throw new LimitError(`You've used all ${cap} of this month's decisions. They reset on the 1st.`, 'monthly_limit');
  }
  const spendCap = dailySpendCap();
  if (spendCap && readSpend().usd >= spendCap) {
    throw new LimitError('Mo is very busy today and has paused new work. Please try again tomorrow.', 'daily_spend');
  }
}

// After a model call: count it.
export function recordUsage(costUsd = 0) {
  const u = readUsage();
  u.decisions += 1;
  u.usd += costUsd || 0;
  fs.writeFileSync(usageFile(), JSON.stringify(u));
  if (costUsd) {
    const s = readSpend();
    s.usd += costUsd;
    fs.writeFileSync(path.join(sharedDataDir(), 'spend.json'), JSON.stringify(s));
  }
}

// Requests per minute per user: a simple sliding window, in memory.
const recent = new Map();
export function checkRate() {
  const limit = perMinute();
  if (!limit) return;
  const id = currentUser().id, now = Date.now();
  const times = (recent.get(id) || []).filter(t => now - t < 60_000);
  if (times.length >= limit) throw new LimitError('Too many requests in a minute. Slow down a little.', 'rate_limit');
  times.push(now);
  recent.set(id, times);
}

// ---- CORS -------------------------------------------------------------------------------
// Hosted: only the origins in ALLOWED_ORIGINS (our extension, e.g. chrome-extension://<id>).
// Local: any origin, as before.
export function corsOrigin(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.length) return '*';
  return origin && allowed.includes(origin) ? origin : null;
}
