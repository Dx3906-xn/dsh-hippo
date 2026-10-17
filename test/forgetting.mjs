/**
 * Tests for forgetting, both kinds.
 *
 * Two different things share the word "forget" and conflating them is the classic
 * mistake:
 *
 *   - **Decay** — the system deciding a memory stopped mattering. Slow, partial,
 *     reversible, driven by retrievability.
 *   - **Redaction** — the person deciding. Immediate, complete in everything the
 *     model can see, and not something the agent may decline.
 *
 * The tests below keep them apart, because a system that only implements the
 * first will confidently remember something a person asked it to drop.
 *
 * Run with `node test/forgetting.mjs`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, ensureSchema } from '../lib/db.js';
import {
  recordEpisode,
  ensureRelationship,
  addFact,
  liveFacts,
  recall,
  redactEpisode,
  redactRecent,
  addLink,
} from '../lib/store.js';
import { asksToForget } from '../lib/gate.js';
import { demoteWeakFacts } from '../lib/consolidate.js';

const dir = mkdtempSync(join(tmpdir(), 'hippo-forget-'));
const db = await openDatabase(join(dir, 'memory.db'));
ensureSchema(db);
ensureRelationship(db, 'user');

let failures = 0;
let checks = 0;
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

console.log('request detection');
check('a forget request is recognised', () => {
  assert.equal(asksToForget('忘掉刚才那句'), true);
  assert.equal(asksToForget('别记这个'), true);
  assert.equal(asksToForget('forget this'), true);
});

check('ordinary talk is not a forget request', () => {
  assert.equal(asksToForget('我最近在学做饭'), false);
});

console.log('redaction');
const episode = recordEpisode(db, {
  sessionId: 's1',
  actor: 'user',
  text: '我的银行卡密码是 123456，别告诉别人。',
});
const fact = addFact(db, {
  subject: 'user',
  predicate: 'contact',
  object: '银行卡密码 123456',
  confidence: 0.9,
  evidence: [episode],
  source: 'extracted',
});
addLink(db, { from: fact, to: episode, kind: 'supports', weight: 0.7 });

check('the episode is recallable first', () => {
  const result = recall(db, { cue: '银行卡密码', userId: 'user', limit: 10 });
  assert.ok(result.episodes.length > 0, 'expected a hit before redaction');
});

const result = redactEpisode(db, episode, { reason: 'requested' });

check('redaction reports what it did', () => {
  assert.equal(result.redacted, true);
  assert.equal(result.factsRetired, 1);
});

check('the redacted episode is no longer recallable', () => {
  const after = recall(db, { cue: '银行卡密码', userId: 'user', limit: 10 });
  assert.equal(
    after.episodes.some((row) => String(row.id) === episode),
    false,
    'a redacted episode must not come back through search',
  );
});

check('the row survives, with its text gone', () => {
  const row = db.prepare('SELECT text, redacted_at, redacted_reason FROM episodes WHERE id = ?').get(episode);
  assert.equal(row.text, '');
  assert.notEqual(row.redacted_at, null);
  assert.equal(row.redacted_reason, 'requested');
});

check('facts supported only by it are retired', () => {
  const live = liveFacts(db, { subject: 'user', limit: 50 });
  assert.equal(live.some((row) => String(row.id) === fact), false);
});

check('evidence rows are removed', () => {
  const rows = db.prepare('SELECT * FROM evidence WHERE episode_id = ?').all(episode);
  assert.equal(rows.length, 0);
});

check('redacting twice is a no-op', () => {
  const again = redactEpisode(db, episode, { reason: 'requested' });
  assert.equal(again.redacted, false);
});

console.log('recent redaction');
recordEpisode(db, { sessionId: 's2', actor: 'user', text: '第一句：我叫林晚。' });
recordEpisode(db, { sessionId: 's2', actor: 'user', text: '第二句：我住在杭州。' });
recordEpisode(db, { sessionId: 's2', actor: 'user', text: '第三句：这个别记，我瞎说的。' });

check('one recent episode is forgotten', () => {
  const outcome = redactRecent(db, { sessionId: 's2', count: 1 });
  assert.equal(outcome.redacted, 1);
  const left = db.prepare("SELECT text FROM episodes WHERE session_id = 's2' AND redacted_at IS NULL ORDER BY at ASC").all();
  assert.equal(left.length, 2);
  assert.equal(left.some((row) => row.text.includes('瞎说')), false);
});

console.log('decay');
const stale = addFact(db, {
  subject: 'user',
  predicate: 'likes',
  object: '某部老电影',
  confidence: 0.7,
  source: 'consolidated',
});
const pinned = addFact(db, {
  subject: 'user',
  predicate: 'name',
  object: '林晚',
  confidence: 0.9,
  source: 'explicit',
  pinned: true,
});

check('a fresh fact is not demoted', () => {
  const outcome = demoteWeakFacts(db, 'user', Date.now());
  assert.equal(outcome.demoted, 0);
  assert.equal(outcome.retired, 0);
});

check('an old, never-recalled fact is demoted', () => {
  // Move both rows far enough into the past to clear the age floor.
  const longAgo = Date.now() - 200 * 86_400_000;
  db.prepare('UPDATE facts SET valid_at = ?, created_at = ?, last_review_at = NULL WHERE id IN (?, ?)')
    .run(longAgo, longAgo, stale, pinned);
  const outcome = demoteWeakFacts(db, 'user', Date.now());
  assert.ok(outcome.demoted + outcome.retired > 0, 'expected something to fade');
  const row = db.prepare('SELECT confidence, invalid_at FROM facts WHERE id = ?').get(stale);
  assert.ok(Number(row.confidence) < 0.7, 'confidence should drop');
});

check('a pinned fact is never demoted', () => {
  const row = db.prepare('SELECT confidence, invalid_at FROM facts WHERE id = ?').get(pinned);
  assert.equal(row.invalid_at, null);
  assert.equal(Number(row.confidence), 0.9);
});

check('demotion keeps the row', () => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM facts WHERE id = ?').get(stale);
  assert.equal(Number(row.n), 1);
});

db.close();
rmSync(dir, { recursive: true, force: true });

if (failures === 0) {
  console.log('\nall checks passed');
} else {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exitCode = 1;
}
