// Mo's voice: lines are written once with Fish Audio cues; the spoken version keeps them and
// the shown version drops them. Fish Audio itself isn't called here (no key set).
//   node --test tests/speech.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SHOWME_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mo-speech-'));
process.env.SHOWME_MOCK = '1';
process.env.FISH_API_KEY = ''; // set but empty, so .env doesn't fill it in
const { stripCues, lineFor, EVENTS } = await import('../server/speech.js');
const { createServer } = await import('../server/index.js');

test('cues are spoken, never shown', () => {
  assert.equal(stripCues('[pleased] Ten done. [break] [gentle] One needs a look.'), 'Ten done. One needs a look.');
  assert.equal(stripCues('[warm] Found it. [break] 3 November.'), 'Found it. 3 November.');
  for (const event of EVENTS) {
    for (let i = 0; i < 3; i++) {
      const { say, show } = lineFor(event, { question: 'Which sitting is at eight?', answer: '2 July 1991', skill: 'Add a customer account', ok: 10, failed: 1 }, () => i / 3);
      assert.match(say, /\[[a-z -]+\]/, `${event} has a cue to speak`);
      assert.doesNotMatch(show, /[[\]]/, `${event} shows no cue`);
      assert.ok(show.split(/\s+/).length <= 30, `${event} is short: ${show}`);
    }
  }
});

test('lines read naturally: numbers as words, singular and plural, short details', () => {
  assert.equal(lineFor('batch', { ok: 10, failed: 1 }, () => 0).show, 'Ten done. One needs a look.');
  assert.equal(lineFor('batch', { ok: 3, failed: 2 }, () => 0).show, 'Three done. Two need a look.');
  assert.equal(lineFor('batch', { ok: 47, failed: 0 }, () => 0).show, 'All 47 done!');
  assert.equal(lineFor('learned', { skill: 'Add a customer account' }, () => 0).show, 'Got it. I\'ve learned how to add a customer account.');
  const long = lineFor('asked', { question: 'The Create account click ran, but the list still shows 6 accounts. The page says Enter a valid email. Should I change it?' }, () => 0).show;
  assert.equal(long, 'Quick question. The Create account click ran, but the list still shows 6 accounts.');
  assert.throws(() => lineFor('nope'), /Unknown speech event/);
});

test('/api/speak returns the spoken and shown line; no voice set up means no audio', async () => {
  const server = createServer();
  await new Promise(r => server.listen(0, r));
  const res = await fetch(`http://localhost:${server.address().port}/api/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'done' }) });
  const j = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.match(j.say, /^\[pleased\]|^\[/);
  assert.doesNotMatch(j.show, /\[/);
  assert.equal(j.audio, null);
  assert.equal(j.voice, null);
});
