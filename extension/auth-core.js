// Signing in to a hosted Mo server, with Supabase Auth. Shared by the side panel and the
// background worker. The server says whether sign-in is needed (GET /api/config); a local
// server (no Supabase) needs none, and then every function here is a no-op.
//
// Two ways in, both without leaving the panel for long:
//   Google: chrome.identity.launchWebAuthFlow → Supabase → back to https://<id>.chromiumapp.org/
//   Email:  Supabase emails a 6-digit code; the user types it into the panel.
// The session (access + refresh token) lives in chrome.storage.local and is refreshed before
// it expires. The anon key comes from the server and is public by design.

const SESSION = 'moSession';
const CONFIG = 'moAuthConfig';

export async function authConfig(server, { fresh = false } = {}) {
  const cached = (await chrome.storage.local.get(CONFIG))[CONFIG];
  if (cached && cached.server === server && !fresh && Date.now() - cached.at < 10 * 60 * 1000) return cached;
  try {
    const res = await fetch(`${server}/api/config`);
    if (!res.ok) throw new Error(String(res.status));
    const cfg = { ...(await res.json()), server, at: Date.now() };
    await chrome.storage.local.set({ [CONFIG]: cfg });
    return cfg;
  } catch {
    return cached?.server === server ? cached : { authRequired: false, server };
  }
}

export async function getSession() {
  return (await chrome.storage.local.get(SESSION))[SESSION] || null;
}
async function saveSession(s, email) {
  const session = { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: Date.now() + (Number(s.expires_in) || 3600) * 1000, email: email ?? s.user?.email ?? null };
  await chrome.storage.local.set({ [SESSION]: session });
  return session;
}
export async function signOut(server) {
  const s = await getSession();
  await chrome.storage.local.remove(SESSION);
  const cfg = server ? await authConfig(server) : null;
  if (s && cfg?.supabaseUrl) fetch(`${cfg.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: cfg.supabaseAnonKey, authorization: `Bearer ${s.access_token}` } }).catch(() => {});
}

const supa = (cfg, pathAndQuery, body, token) => fetch(`${cfg.supabaseUrl}/auth/v1/${pathAndQuery}`, {
  method: body ? 'POST' : 'GET',
  headers: { apikey: cfg.supabaseAnonKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

// The token for the next request: null when the server needs no sign-in or nobody is signed in.
export async function accessToken(server) {
  const cfg = await authConfig(server);
  if (!cfg.authRequired) return null;
  const s = await getSession();
  if (!s) return null;
  if (s.expires_at - Date.now() > 60_000) return s.access_token;
  try {
    const res = await supa(cfg, 'token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    if (!res.ok) throw new Error(String(res.status));
    return (await saveSession(await res.json(), s.email)).access_token;
  } catch {
    await chrome.storage.local.remove(SESSION);
    return null;
  }
}

export async function signInWithGoogle(server) {
  const cfg = await authConfig(server, { fresh: true });
  const redirect = chrome.identity.getRedirectURL();
  const url = `${cfg.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirect)}`;
  const back = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const params = new URLSearchParams(new URL(back).hash.slice(1));
  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error'));
  const token = params.get('access_token');
  if (!token) throw new Error('Google sign-in was cancelled.');
  const user = await (await supa(cfg, 'user', null, token)).json().catch(() => ({}));
  return saveSession({ access_token: token, refresh_token: params.get('refresh_token'), expires_in: params.get('expires_in') }, user.email);
}

export async function sendEmailCode(server, email) {
  const cfg = await authConfig(server, { fresh: true });
  const res = await supa(cfg, 'otp', { email, create_user: true });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).msg || 'Could not send the code. Check the email address.');
}

export async function verifyEmailCode(server, email, code) {
  const cfg = await authConfig(server);
  const res = await supa(cfg, 'verify', { type: 'email', email, token: String(code).trim() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.msg || 'That code didn\'t work. Check it, or ask for a new one.');
  return saveSession(data, email);
}
