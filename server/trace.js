// Run traces, for evaluating how Mo behaves: every model call (what it was sent, what it
// answered, its thinking summary) and every run's own record of what it did (each decision,
// what happened, each check of a done's proof), one JSON line each in
// <data>/traces/<day>.jsonl. Read them with `node scripts/trace.js`.
//
// On in local mode; MO_TRACE=off turns it off, and hosted mode needs MO_TRACE=on. Pages the
// person visits end up in here (on their own machine), so this is for evaluation, not for
// keeping: files older than TRACE_DAYS (default 14) are deleted.

import fs from 'node:fs';
import path from 'node:path';
import { authRequired, userDataDir } from './account.js';

export const traceEnabled = () => process.env.MO_TRACE === 'on' || (process.env.MO_TRACE !== 'off' && !authRequired());

const dirOf = () => path.join(userDataDir(), 'traces');
let pruned = '';

export function trace(kind, data) {
  if (!traceEnabled()) return;
  try {
    const dir = dirOf();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`);
    if (pruned !== day) { pruned = day; prune(dir); }
  } catch (err) {
    console.error(`[mo] trace: ${err.message}`); // a trace must never break a run
  }
}

function prune(dir) {
  const keep = Number(process.env.TRACE_DAYS || 14) * 86400_000;
  for (const f of fs.readdirSync(dir)) {
    const day = Date.parse(f.slice(0, 10));
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && Date.now() - day > keep) fs.rmSync(path.join(dir, f), { force: true });
  }
}

// Every trace line from the last `days` days, oldest first.
export function readTraces({ days = 2, dir = dirOf() } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days)
    .flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
