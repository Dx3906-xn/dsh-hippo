/**
 * Tests for the agenda: open loops and unresolved contradictions.
 *
 * The agenda is the only part of the system that changes what the agent *says*
 * rather than what it knows, so the failure modes are social rather than
 * technical: an agenda that never empties produces an interrogator, and one that
 * never closes anything produces a companion who keeps asking about the smoking
 * three years after it stopped.
 *
 * Run with `node test/agenda.mjs`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, ensureSchema, relationshipRevision } from '../lib/db.js';
import {
  recordEpisode,
  ensureRelationship,
  addOpenLoop,
  closeOpenLoop,
  openLoops,
  addFact,
} from '../lib/store.js';
import {
  detectLoop,
  detectResolution,
  loopResolvedBy,
  renderAgenda,
  expireClarifications,
  LOOP_SILENCE_MS,
} from '../lib/agenda.js';

const dir = mkdtempSync(join(tmpdir(), 'hippo-agenda-'));
const path = join(dir, 'memory.db');
const db = await openDatabase(path);
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

console.log('detection');
check('smoking is a loop', () => {
  const loop = detectLoop('我最近在戒烟，已经两周了。');
  assert.notEqual(loop, null);
  assert.equal(loop.text.includes('戒烟'), true);
});

check('a deadline is a loop', () => {
  const loop = detectLoop('下周要交稿了，还有点没画完。');
  assert.notEqual(loop, null);
});

check('a feeling is a loop, but raised later than a task', () => {
  const loop = detectLoop('这两天有点慌，睡不着。');
  assert.notEqual(loop, null);
  // A mood raised in the same conversation is an interrogation; the point of
  // asking is that the person has had time to move on from it.
  assert.ok(loop.followAfter >= LOOP_SILENCE_MS, 'mood loops should not come back immediately');
});

check('a question is not a loop', () => {
  assert.equal(detectLoop('你最近怎么样？'), null);
});

check('small talk is not a loop', () => {
  assert.equal(detectLoop('嗯嗯'), null);
});

check('chit chat about weather is not a loop', () => {
  assert.equal(detectLoop('今天天气不错，出去走了走。'), null);
});

console.log('resolution');
check('explicit resolution is detected', () => {
  assert.equal(detectResolution('我终于戒掉了，三个月了。'), true);
});

check('a resolution closes the matching loop', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '我终于戒掉了。'), true);
});

check('a relapse does not close it', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '我没戒掉，又抽上了。'), false);
});

check('an unrelated resolution does not close it', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '稿子终于交了。'), false);
});

console.log('rendering');
check('empty agenda renders nothing', () => {
  assert.equal(renderAgenda(db, { now: Date.now() }), '');
});

const loopId = addOpenLoop(db, {
  userId: 'user',
  text: '我最近在戒烟，已经两周了。',
  followAfter: Date.now() - 1000,
});

check('a due loop appears', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(text.includes('戒烟'), 'expected the smoking loop');
  assert.ok(text.includes('问问'), 'expected an invitation to ask, not an order');
});

check('a loop that is not due yet stays hidden', () => {
  const fresh = addOpenLoop(db, {
    userId: 'user',
    text: '等忙完这阵再想换工作的事。',
    followAfter: Date.now() + 60 * 60 * 1000,
  });
  const text = renderAgenda(db, { now: Date.now() });
  assert.equal(text.includes('换工作'), false);
  closeOpenLoop(db, fresh, 'test');
});

check('a closed loop disappears', () => {
  closeOpenLoop(db, loopId, 'test');
  assert.equal(renderAgenda(db, { now: Date.now() }).includes('戒烟'), false);
});

console.log('clarification surfacing');
const older = addFact(db, {
  subject: 'user',
  predicate: 'lives_in',
  object: '上海',
  confidence: 0.7,
  source: 'extracted',
});
const newer = addFact(db, {
  subject: 'user',
  predicate: 'lives_in',
  object: '北京',
  confidence: 0.7,
  source: 'extracted',
});
db.prepare('UPDATE facts SET needs_clarification = 1 WHERE id = ?').run(newer);

check('a pending contradiction is raised as a question', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(text.includes('北京'), 'expected the newer value');
  assert.ok(text.includes('上海'), 'expected the older value');
  assert.ok(text.includes('还没确认'), 'expected it phrased as unresolved');
});

check('stale contradictions expire instead of asking forever', () => {
  db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(Date.now() - 30 * 86_400_000, newer);
  const expired = expireClarifications(db, Date.now());
  assert.equal(expired, 1);
  const after = renderAgenda(db, { now: Date.now() });
  assert.equal(after.includes('北京'), false);
});

check('the newer value survives expiry', () => {
  const row = db.prepare('SELECT needs_clarification, invalid_at FROM facts WHERE id = ?').get(newer);
  assert.equal(Number(row.needs_clarification), 0);
  assert.equal(row.invalid_at, null);
});

check('agenda text never contains a bare mustache', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.equal(text.includes('{{'), false);
});

db.close();
rmSync(dir, { recursive: true, force: true });

if (failures === 0) {
  console.log('\nall checks passed');
} else {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exitCode = 1;
}
