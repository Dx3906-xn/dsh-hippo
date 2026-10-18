/**
 * The block that was shown last turn has to survive the process that showed it.
 *
 * Grading needs two messages and the memory that sat between them. The plugin's
 * most common call shape is one message per process (`dsh --profile call "..."`
 * answers, then exits), so anything held in a Map is gone before the reply that
 * would have judged it. These tests exercise the table that replaced the Map,
 * including the expiry rules, because a stale row graded against an unrelated
 * sentence is worse than no grading at all.
 */

import assert from 'node:assert/strict';
import { openDatabase, ensureSchema, SCHEMA_VERSION } from '../lib/db.js';
import {
  ensureRelationship,
  addFact,
  savePendingRecall,
  takePendingRecall,
} from '../lib/store.js';

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

console.log('the snapshot outlives the writer');
check('a saved block is readable by a later read', () => {
  // No shared object between the write and the read: everything that matters has
  // to come back out of the table.
  savePendingRecall(db, 'owner-a', [{ id: fact, kind: 'fact', needle: '杭州' }]);
  const taken = takePendingRecall(db, 'owner-a');
  assert.equal(taken.length, 1);
  assert.equal(taken[0].id, fact);
  assert.equal(taken[0].kind, 'fact');
  assert.equal(taken[0].needle, '杭州');
});

check('reading consumes the block', () => {
  // Grading twice would apply a correction to rows that are no longer on screen.
  assert.equal(takePendingRecall(db, 'owner-a').length, 0);
});

check('owners do not see each other', () => {
  savePendingRecall(db, 'owner-b', [{ id: fact, kind: 'fact', needle: '杭州' }]);
  assert.equal(takePendingRecall(db, 'owner-c').length, 0);
  assert.equal(takePendingRecall(db, 'owner-b').length, 1);
});

check('the same row shown twice is stored once', () => {
  savePendingRecall(db, 'owner-d', [{ id: fact, kind: 'fact', needle: '杭州' }]);
  savePendingRecall(db, 'owner-d', [{ id: fact, kind: 'fact', needle: '杭州' }]);
  const taken = takePendingRecall(db, 'owner-d');
  assert.equal(taken.length, 1, 'the primary key makes a repeat a no-op');
});

check('an empty block or owner is not written', () => {
  savePendingRecall(db, '', [{ id: fact, kind: 'fact', needle: 'x' }]);
  savePendingRecall(db, 'owner-e', []);
  assert.equal(takePendingRecall(db, 'owner-e').length, 0);
  assert.equal(takePendingRecall(db, '').length, 0);
});

console.log('stale blocks are not graded');
check('a block older than the window is dropped', () => {
  const long = 60 * 60_000;
  savePendingRecall(db, 'owner-f', [{ id: fact, kind: 'fact', needle: '杭州' }], Date.now() - 2 * long);
  assert.equal(takePendingRecall(db, 'owner-f', Date.now(), long).length, 0,
    'a reply an hour later is a new conversation, not a verdict');
});

check('expiry sweeps other owners too', () => {
  // The sweep is global, not per-session: a process that exits never runs a
  // timer, so old rows would otherwise wait forever to be mis-graded.
  savePendingRecall(db, 'owner-g', [{ id: fact, kind: 'fact', needle: '杭州' }], Date.now() - 5 * 60 * 60_000);
  savePendingRecall(db, 'owner-h', [{ id: fact, kind: 'fact', needle: '杭州' }]);
  takePendingRecall(db, 'owner-h');
  const left = db.prepare('SELECT count(*) AS n FROM pending_recall').get();
  assert.equal(Number(left.n), 0, 'the stale row was swept while reading another session');
});

check('a schema bump is not needed for the table to exist', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pending_recall'").all();
  assert.equal(tables.length, 1);
  assert.ok(SCHEMA_VERSION >= 13, 'the table ships with the current schema, not a later one');
});

db.close();

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
