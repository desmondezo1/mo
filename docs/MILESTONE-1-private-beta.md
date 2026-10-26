# Milestone 1: private beta

**Goal:** ten real people who do repetitive browser work (customer success, support ops, rev ops, HR ops) install Mo
from the Chrome Web Store, sign in, teach it one real weekly task (spreadsheet → form first), and run it on their
own work two Mondays in a row.

**Length:** three weeks. **Done when** the exit criteria at the end are met.

## Where we start

Mo works end to end on one laptop, and only there:

| Today | Why it blocks strangers |
| --- | --- |
| The extension talks to `http://localhost:8787` | A stranger has no server and no key, so nothing works |
| The server keeps everything in shared files (`data/demos.json`, the call log, runs, settings) | No users: everyone would see everyone's skills |
| No sign-in; the API accepts requests from any website (`access-control-allow-origin: *`) | Anyone could spend our model budget or read lessons |
| The Mubit key sits in the server's `.env` | Fine: the key must stay on a server, never in the extension |
| Hackathon parts in the extension: the Judges tab, the Mubit console reader (`mubit-bridge.js`), demo examples, Mo's New Tab page | Confusing for users, and extra permissions slow down the Chrome Web Store review |
| 23 API endpoints, including developer-only ones (clear the log, settings, the judges' overview) | Must not be public |

## Decision 1: hosted backend with sign-in, not bring-your-own-key

**Recommendation: hosted.** The people Mo is for (Sarah) don't have an Anthropic or Mubit key and won't get one; asking
for a key would stop most of them at the door. A key pasted into an extension is also easy to leak. We pay for the
model during the beta, with a monthly cap per user.

Bring-your-own-key stays possible later as a setting for developers, using the same backend.

## The backend (week 1)

| Piece | Choice | Notes |
| --- | --- | --- |
| Hosting | Fly.io or Render (one small Node service) | The existing `server/` runs as is; add a Dockerfile and health check |
| Database | Postgres via **Supabase** | Tables: `users`, `skills`, `lessons`, `runs`, `calls`. Replaces the JSON files; every row has a `user_id` |
| Sign-in | **Supabase Auth**: Google sign-in and email magic link | In the extension: `chrome.identity.launchWebAuthFlow` opens the sign-in page; the session token goes in `chrome.storage.session` |
| API security | Every `/api/*` call needs `Authorization: Bearer <token>`; the server checks it and scopes all reads and writes to that user | CORS only for our extension's ID; remove `*` |
| Budget | A cap per user per month (e.g. 3,000 decisions in the beta), a rate limit per minute, and a global daily spend cap | Show "N of 3,000 used this month" in the panel |
| Model route | Keep the server's provider setting: Mubit (Claude through Mubit, trains adapters) or Anthropic direct as a fallback | Don't depend on one route; Mubit sessions get the user's ID so their runs can be traced |
| Endpoints removed or locked to admins | `DELETE /api/ledger`, `POST /api/settings`, `GET /api/overview`, `GET /api/calls` (admin only) | Users get `GET /api/usage` instead |
| Stored data | Skills and lessons (steps, labels, notes); runs (outcome, counts); calls (task, timing, cost, never page text) | Logs of runs and calls kept 30 days; a user can delete everything from the panel |
| Monitoring | Sentry for errors; a simple dashboard of signups, runs and spend | No analytics on page content, ever |

**Moving the files to Postgres** touches `server/memory.js` (skills, lessons, recall), `server/ledger.js` (calls, runs,
settings) and the Guard memory. The functions keep the same shape (`addDemo`, `recallDemo`, `listSkills`, `addRun`…),
so `server/index.js` changes little: each handler gets `req.user.id` and passes it through.

## The extension (weeks 1 to 2)

**Remove:**
- The Judges tab, the Mubit tab's developer views, `mubit-bridge.js` and its content script on `app.mubit.ai`
- Mo's New Tab page (`chrome_url_overrides`); Chrome reviewers and users both dislike New Tab takeovers
- The demo example goals, and the backend address field (it becomes a hidden setting for development)
- The `search` permission, unless we keep a feature that needs it

**Keep:** My skills, Teach (Show me how / Not what you wanted?), notes, **+ From a sheet**, the batch runner, the safety
check before risky clicks, push-to-talk.

**Add:**
- **Sign in** on first open, and a short welcome: what Mo does, what it sends to the AI (the text of the page it's
  working on, never passwords), and a 60-second try-it using our hosted sample (the Sales email, the CSV and the
  Helpdesk form, served from the backend's domain).
- **Usage:** "N of 3,000 decisions this month", plus the run history per skill.
- **Safety settings:** sites Mo must never act on; "pause Mo on this site"; never type into password fields (already
  true for recording, enforce it for actions too); stop on sign-in pages and ask.
- **Mo Guard off by default.** It sends every link on every page to the server: a cost and a privacy question we don't
  need in this beta. It can come back as an opt-in.
- **Error states** a non-technical user understands: signed out, over the monthly limit, server unreachable.
- A build script that writes `dist/mo-<version>.zip` for the store, and the version number in the panel.

## Chrome Web Store (week 2, submit at the end of week 2)

| Item | What's needed |
| --- | --- |
| Developer account | One-time $5 fee, verified email, publisher name |
| Listing | Name ("Mo: teach it once"), short description (132 characters max), long description built on Sarah's story, 128 px icon, 3 to 5 screenshots at 1280×800, a 440×280 promo tile, the film (`video/out/sarah-and-mo.mp4`) as the YouTube video |
| Single purpose | "Learns a repetitive task in the browser from one demonstration and repeats it for the user." |
| Permission justifications | `sidePanel` (Mo's panel), `tabs` (follow the user's task across tabs), `scripting` (read the page and act on it), `storage` (settings and sign-in), `offscreen` (microphone for push-to-talk), host permission for all sites (Mo works on whichever site the user's task is on) |
| Data disclosure | Website content and user activity (recorded steps) are collected to do the task; not sold, not used for anything else; the Limited Use certification |
| Privacy policy and terms | Public pages on the landing site, plus a support email |
| Remote code | None: everything ships in the package (already true; check before submitting) |
| Visibility | **Unlisted** for the beta (only people with the link can install), public later |
| Review time | Plan for 1 to 2 weeks: an extension that can read all sites gets an in-depth review |

## Quality before anyone outside sees it (week 2)

- Fix the one flaky end-to-end test (email → CSV → Helpdesk passes alone and live, fails after the full suite).
- **Real-site test bench:** the spreadsheet → form skill on 8 to 10 real web forms (HubSpot, Salesforce, Zendesk,
  Airtable and Google Forms sandboxes, a Notion database, a Typeform). For each, measure rows done without a
  correction, over at least 20 rows. Target: 90% or better.
- Measure the real cost of one run of 47 rows on Claude, to set the monthly cap and later pricing.

## Recruiting and support (week 3)

- **Who:** customer success, support ops, rev ops and HR ops people with a weekly copy-paste job. Places: LinkedIn,
  Gain Grow Retain, CS Insider, RevOps Co-op, ops Slack groups, our own networks.
- **Offer:** "Send me your most boring weekly copy-paste job. I'll set Mo up on it with you, free, and you tell me
  what breaks." The first run with each person happens on a call.
- **Support:** one shared channel (Slack Connect or a small Discord), and a "Report a problem" button in the panel that
  sends the last run's steps (never page text) to us.

## Exit criteria

1. Mo is installable from the Chrome Web Store (unlisted) and works for a new user with nothing but a sign-in.
2. Ten people outside the team have installed it and signed in.
3. Five of them have run a skill on their real work; three have run it again the next week.
4. On their tasks, 90% of rows or more finish without a correction.
5. We know the real cost per run, and no user has gone over the monthly cap without seeing a clear message.

## Open decisions

| Decision | Default if nobody decides |
| --- | --- |
| Sign-in and database: Supabase, or Clerk plus Neon | Supabase (one vendor, both pieces) |
| Model route: Mubit or Anthropic direct | Mubit, with Anthropic direct as the fallback setting |
| Push-to-talk in v1 | Keep it (it works, and the `offscreen` permission is easy to justify) |
| Mo Guard in v1 | Off by default, opt-in |
| Beta price | Free, with a monthly cap |
| Name in the store | "Mo: teach it once" (check the name is free) |

## After this milestone

The full-desktop version: a native Mac helper that reuses the same workflow format and runner, for Excel, Outlook
and legacy apps. Only once browser users ask for it.

Why browser first: "teach it once" desktop agents already exist (Simular's task recording, Cyberdesk, OpenAdapt, and
UiPath and Power Automate for enterprise IT), and the big AI labs ship general browser and computer agents. Our edge
isn't being on the desktop. It's being reliable and cheap on the *same* task every week (rules you can check, notes
for judgement calls, "needs a look" instead of guessing, and a smaller model trained on the repetition), sold to the
person who does the work, not to IT. Sarah's tools (Salesforce, HubSpot, Zendesk, Google Sheets, Gmail) are in the
browser, so we prove that there first.
