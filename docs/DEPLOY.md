# Hosting Mo's backend (milestone 1, week 1)

Mo's server runs in two modes:

| Mode | When | Who can use it |
| --- | --- | --- |
| **Local** | No `SUPABASE_URL` set (as during the hackathon) | One user, no sign-in, data in `data/` |
| **Hosted** | `SUPABASE_URL` set | Anyone who signs in. Every request carries a Supabase token; each user's skills, runs, calls, settings and usage live in `data/users/<user id>/`; a monthly cap per user, a daily spend cap for the service, a rate limit, and CORS only for the extension |

Everything below is for hosted mode. It needs three accounts: **Supabase** (sign-in), **Google Cloud** (for "Continue
with Google"; optional, email codes work without it) and **Fly.io** (hosting). Each step says where to click.

## 1. Supabase: sign-in

1. Create a project at <https://supabase.com/dashboard> (any name; region close to your users).
2. **Settings → API**: copy the **Project URL** (`SUPABASE_URL`) and the **anon public** key (`SUPABASE_ANON_KEY`).
   - New projects sign tokens with asymmetric keys; the server fetches them from the project's JWKS automatically.
   - Older projects use a shared **JWT secret** (Settings → API → JWT Settings): copy it as `SUPABASE_JWT_SECRET`.
3. **Authentication → Sign In / Providers → Email**: keep it enabled.
4. **Authentication → Email Templates → Magic Link**: make the email show the code, so people can type it into Mo's
   panel. Replace the body with, for example:
   ```html
   <h2>Your Mo sign-in code</h2>
   <p>Enter this code in Mo's panel: <strong>{{ .Token }}</strong></p>
   <p>It expires in an hour. If you didn't ask for it, ignore this email.</p>
   ```
5. For real email volume, set up your own SMTP under **Authentication → Emails → SMTP Settings** (Supabase's built-in
   sender is rate-limited and meant for testing).

## 2. Google sign-in (optional)

1. In <https://console.cloud.google.com>: **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Web application**.
2. **Authorized redirect URI:** `https://<your-project>.supabase.co/auth/v1/callback`.
3. In Supabase: **Authentication → Sign In / Providers → Google**: paste the client ID and secret, enable it.
4. In Supabase: **Authentication → URL Configuration → Redirect URLs**: add `https://<extension-id>.chromiumapp.org/**`.
   - The extension ID is in `chrome://extensions` (Developer mode). An unpacked extension gets a new ID on each
     machine; once Mo is uploaded to the Chrome Web Store, it has a fixed ID. Use that one for the beta.
5. Without Google, set `SIGN_IN_METHODS=email` and the panel shows only the email code.

## 3. Fly.io: the server

```bash
brew install flyctl && fly auth login
fly launch --no-deploy --copy-config      # uses fly.toml; choose an app name
fly volumes create mo_data --size 1       # each user's data lives here (/data)
fly secrets set \
  SUPABASE_URL=https://<your-project>.supabase.co \
  SUPABASE_ANON_KEY=<anon key> \
  MUBIT_API_KEY=<your Mubit key> \
  ALLOWED_ORIGINS=chrome-extension://<extension-id>
# only for projects on the legacy secret:  fly secrets set SUPABASE_JWT_SECRET=<secret>
fly deploy
curl https://<app>.fly.dev/api/health     # {"ok":true,…}
curl https://<app>.fly.dev/api/config     # {"authRequired":true,…}
```

Limits are in `fly.toml` (`MONTHLY_DECISION_CAP`, `DAILY_SPEND_CAP_USD`, `RATE_PER_MINUTE`); change and redeploy.
Model settings are the same as local (`MUBIT_PROVIDER`, `MUBIT_MODEL`; see `.env.example`).

One machine with one volume is right for the beta (tens of users). The storage functions (`server/memory.js`,
`server/ledger.js`, `server/account.js`) are the only place that touches files, so moving to Supabase Postgres later
means changing those three, not the rest of the server.

## 4. Point the extension at it

Until the store build sets it by default: open Mo's panel → **Mubit** tab → **Connection** → **Backend address**, and
enter `https://<app>.fly.dev`. The panel then shows **Sign in to Mo**.

## 5. Check it

- Sign in with an email code, run any task, and see "N of 3,000 decisions this month" under My skills.
- `curl https://<app>.fly.dev/api/skills` with no token returns `401 {"code":"signed_out"}`.
- Two different accounts don't see each other's skills.

These are also covered by tests that need no Supabase: `node --test tests/accounts.test.js` (the server) and
`node --test tests/signin-e2e.test.js` (the extension in a real Chrome, with a fake Supabase that issues real tokens).
