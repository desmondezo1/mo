// Read back what Mo did: each run's request, plan, every decision (with the page it was on,
// what the model answered and its thinking summary), what happened in the browser, each
// check of a done's proof, and how it ended. Traces are written by server/trace.js.
//
//   node scripts/trace.js              the last run
//   node scripts/trace.js 5            the last five runs
//   node scripts/trace.js run-1793…    one run by its session id
//   node scripts/trace.js --full       also print the whole message each model call was sent
//   SHOWME_DATA_DIR=… node scripts/trace.js   another data folder (the server's)

import path from 'node:path';
import { readTraces } from '../server/trace.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const pick = args.find(a => !a.startsWith('--'));
const dataDir = process.env.SHOWME_DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
const lines = readTraces({ days: Number(process.env.TRACE_READ_DAYS || 3), dir: path.join(dataDir, 'traces') });

const runs = lines.filter(l => l.kind === 'run' && l.sessionId);
const chosen = pick && !/^\d+$/.test(pick) ? runs.filter(r => r.sessionId === pick) : runs.slice(-(Number(pick) || 1));
if (!chosen.length) {
  console.log(runs.length ? `No run ${pick}. Recent: ${runs.slice(-5).map(r => r.sessionId).join(', ')}` : `No traced runs in ${dataDir}/traces yet.`);
  process.exit(0);
}

const time = t => new Date(t).toISOString().slice(11, 19);
const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const indent = (s, pad = '      ') => String(s).split('\n').map(l => pad + l).join('\n');
// The first lines of what next-action was sent: where it was and what it saw.
const where = sent => String(sent || '').split('\n').filter(l => /^(Goal|Plan|URL|Title|Text|Request):/.test(l)).map(l => short(l, 200)).join('\n');

for (const run of chosen) {
  const calls = lines.filter(l => l.kind === 'call' && l.sessionId === run.sessionId);
  const items = [
    ...calls.map(c => ({ at: Date.parse(c.ts), call: c })),
    ...(run.events || []).map(e => ({ at: e.t, event: e })),
  ].sort((a, b) => a.at - b.at);
  console.log(`\n━━ ${run.sessionId} · ${run.ts.slice(0, 10)} ${time(run.ts)} · “${short(run.goal, 120)}”`);
  console.log(`   ${run.outcome.toUpperCase()}${run.failure ? `: ${short(run.failure, 300)}` : ''}${run.answer ? `\n   answer: ${short(run.answer, 400)}` : ''}`);
  if (run.url) console.log(`   ended on ${run.url}`);
  for (const { call: c, event: e } of items) {
    if (c) {
      const cost = c.inTokens ? ` ${c.inTokens}→${c.outTokens} tok` : '';
      console.log(`\n  [${time(c.ts)}] ${c.task}${c.image ? ' + screenshot' : ''} (${(c.ms / 1000).toFixed(1)} s${cost})`);
      if (c.task === 'next-action' || c.task === 'plan') console.log(indent(full ? c.sent : where(c.sent)));
      else if (full) console.log(indent(c.sent));
      if (c.thinking) console.log(indent(`thinking: ${full ? c.thinking : short(c.thinking, 500)}`));
      console.log(indent(c.error ? `ERROR ${c.error}` : `answered: ${short(c.reply, full ? 4000 : 300)}`));
    } else if (e.type === 'decision') {
      console.log(`   → step ${e.step}: ${e.action}${e.label ? ` “${short(e.label, 60)}”` : ''}${e.value ? ` = ${short(e.value, 100)}` : ''}${e.valid ? '' : ' (INVALID)'}${e.lesson ? ' [from lesson]' : ''} · ${e.elements} elements on ${short(e.url, 80)}`);
      if (e.evidence) console.log(`     evidence: “${short(e.evidence, 200)}”`);
    } else if (e.type === 'proof') {
      console.log(`   ${e.ok ? '✓ proof found on the page' : `✗ done rejected: ${e.why}`}`);
    } else if (e.type === 'result') {
      if (!e.ok || e.how) console.log(`   ${e.ok ? '✓' : '✗'} ${e.how ? `went (${e.how})` : ''}${e.error ? ` ${e.error}` : ''}`);
    } else if (e.type === 'plan') {
      console.log(`   → plan: ${e.where}${e.url ? ` ${e.url}` : ''}: ${short(e.plan, 200)}`);
    } else if (e.type === 'went') {
      console.log(`   → went (${e.how}) to ${short(e.url, 100)}`);
    } else if (e.type === 'looked') {
      console.log(`   👁  looked at the screen (${e.why})`);
    } else if (e.type === 'safety') {
      console.log(`   ${e.allow ? '✓' : '✗'} safety gate on “${e.label}”: ${short(e.reason, 160)}`);
    }
  }
}
