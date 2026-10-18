/**
 * The schedule only learns from behaviour it can actually observe.
 *
 * Retrieval is grade 2, and for a long time it was the *only* grade the plugin
 * ever wrote: stability was set at extraction and never moved again, so the
 * forgetting curve was really just a decay curve. Two things are observable on
 * the following message — the person restated the memory, or they corrected it —
 * and both are worth acting on, in opposite directions.
 *
 * The wiring lives inside `apply()` and cannot be reached without a live agent,
 * so half of this file asserts on the source. That is a deliberate trade: a
 * behavioural test would need a running DSH session, and the failure being
 * guarded against (a call site that was never updated) is visible as text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase, ensureSchema } from '../lib/db.js';
import {
  ensureRelationship,
  addFact,
  gradeMemory,
} from '../lib/store.js';
import { detectCorrectionIn } from '../lib/gate.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

console.log('correction detection');
check('a hard negation is a correction', () => {
  assert.equal(detectCorrectionIn('不是杭州，是苏州'), true);
  assert.equal(detectCorrectionIn('你记错了，我养的是狗'), true);
  assert.equal(detectCorrectionIn('搞错了，我不做插画'), true);
});
check('a soft marker needs a negator next to it', () => {
  // "其实" on its own is ordinary discourse, and treating it as a correction
  // would drop the stability of whatever was on screen for no reason.
  assert.equal(detectCorrectionIn('其实我挺喜欢这个工作的'), false);
  assert.equal(detectCorrectionIn('其实不是，我更喜欢那个'), true);
});
check('ordinary talk is not a correction', () => {
  assert.equal(detectCorrectionIn('今天下班早，路上买了点菜'), false);
  assert.equal(detectCorrectionIn(''), false);
  assert.equal(detectCorrectionIn('   '), false);
});

console.log('the grade reaches the row');
const db = await openDatabase(':memory:');
ensureSchema(db);
ensureRelationship(db, 'user');
const fact = addFact(db, {
  subject: 'user',
  predicate: 'lives_in',
  object: '杭州',
  confidence: 0.9,
  source: 'consolidated',
});
const read = () => db.prepare('SELECT stability, review_count FROM facts WHERE id = ?').get(fact);
const before = Number(read().stability);

check('restating a memory makes it harder to forget', () => {
  gradeMemory(db, fact, 'fact', 4);
  const after = read();
  assert.ok(Number(after.stability) > before, `expected stability to rise, ${before} → ${after.stability}`);
  assert.equal(Number(after.review_count), 1);
});
check('correcting a memory makes it easier to forget', () => {
  const peak = Number(read().stability);
  gradeMemory(db, fact, 'fact', 1);
  const after = Number(read().stability);
  // Grade 1 is "I was wrong". FSRS lowers stability but floors it above zero, so
  // the assertion is on direction and on the floor, not on a ratio.
  assert.ok(after < peak, `expected stability to fall, ${peak} → ${after}`);
  assert.ok(after > 0, 'stability must stay positive');
});
db.close();

console.log('the wiring is present');
const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

check('the render remembers what it showed', () => {
  assert.ok(source.includes('reinforceRecalled(recalled, block)'),
    'the automatic recall renders before it grades, so trimmed rows are not graded');
  // The snapshot has to be persisted, not held in a Map: the common call shape is
  // one message per process, so an in-memory map is gone before the reply arrives.
  assert.ok(source.includes('savePendingRecall(db, owner, shown, now)'),
    'the shown block must be written to the table the next turn reads');
});

check('the next message grades the block', () => {
  assert.ok(source.includes('gradeAgainstReply(text)'),
    'captureMessage must grade the previous block against the new message');
  // Order matters: grading reads the message the person just sent, so it has to
  // happen before the dedup guard can return early.
  const gradeAt = source.indexOf('gradeAgainstReply(text)');
  const episodeAt = source.indexOf("actor: 'user'", gradeAt);
  assert.ok(gradeAt !== -1 && episodeAt > gradeAt, 'grading happens before the episode is written');
});

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
