/**
 * The store must never hold two live answers to a single-valued question.
 *
 * The prompt hides the duplicate: `renderResident` collapses a single-valued
 * predicate to its best-ranked line, so a second live value is invisible in the
 * one place a human would notice it, while `memory_recall` (and therefore the
 * model) can still find it. That is how a broken e2e seed left 「住在杭州」live
 * next to 「住在苏州」 for a whole run without a single assertion noticing.
 *
 * The two write paths that displace a single-valued fact must each leave exactly
 * one live row: consolidation (applyFacts -> invalidate, which also queues the
 * question) and an explicit overwrite through memory_remember. Resolution then
 * has to keep it that way: keep_new leaves the new one live, keep_old revives
 * the old one AND retires the new one.
 *
 * Usage: node test/consistency.mjs [db-path]
 *   With no argument it runs the fixtures. With a path it also reports every
 *   live single-valued contradiction in that database (an observation, not a
 *   pass/fail: an old库 can legitimately still hold one).
 */

import { openDatabase } from '../lib/db.js';
import { recordEpisode, addFact, transact, liveFacts, liveContradictions, resolveClarification } from '../lib/store.js';
import { applyFacts } from '../lib/consolidate.js';

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/** The invariant under test lives with the store: `liveContradictions(db)`. */
const db = await openDatabase(':memory:');

const first = recordEpisode(db, { sessionId: 's', actor: 'user', text: '我住在杭州' });
addFact(db, { subject: 'user', predicate: 'lives_in', object: '杭州', evidence: [first], confidence: 0.9 });
const liveBefore = liveFacts(db, { subject: 'user' }).filter((row) => row.predicate === 'lives_in');
check('one live value to start with', () => {
  if (liveBefore.length !== 1) throw new Error(`expected 1 live lives_in, got ${liveBefore.length}`);
});

// Path 1: consolidation guesses, so it must ask — and it may not leave both sides
// live while it waits.
const applied = applyFacts(db, [
  { subject: 'user', predicate: 'lives_in', object: '苏州', confidence: 0.8, sensitivity: 'personal', evidence: [first] },
], 'user');
check('consolidation displaced exactly one fact', () => {
  if (applied.invalidated !== 1) throw new Error(`expected invalidated=1, got ${JSON.stringify(applied)}`);
});
check('consolidation left one live lives_in', () => {
  const live = liveFacts(db, { subject: 'user' }).filter((row) => row.predicate === 'lives_in');
  const objects = live.map((row) => row.object).join(',');
  if (live.length !== 1 || objects !== '苏州') throw new Error(`live=${objects || '(none)'}`);
});
check('consolidation queued a clarification', () => {
  const pending = db.prepare('SELECT id FROM facts WHERE needs_clarification = 1').all();
  if (pending.length !== 1) throw new Error(`expected 1 pending, got ${pending.length}`);
});
check('consolidation did not queue a duplicate question about the same object', () => {
  // Same candidate again: similarity 1 against the live row is a noop, not a
  // second question. A seed that ignores this leaves a stray live fact behind.
  const again = applyFacts(db, [
    { subject: 'user', predicate: 'lives_in', object: '苏州', confidence: 0.8, sensitivity: 'personal', evidence: [first] },
  ], 'user');
  if (again.added !== 0 || again.invalidated !== 0 || again.updated !== 0) {
    throw new Error(`expected a noop, got ${JSON.stringify(again)}`);
  }
  if (liveContradictions(db).length !== 0) throw new Error('a noop created a contradiction');
});

// keep_old: the old value comes back and the new one goes.
transact(db, () => resolveClarification(db, String(db.prepare('SELECT id FROM facts WHERE needs_clarification = 1').get().id), 'keep_old'));
check('keep_old revives the old value and retires the new one', () => {
  const live = liveFacts(db, { subject: 'user' }).filter((row) => row.predicate === 'lives_in');
  if (live.length !== 1 || live[0].object !== '杭州') throw new Error(`live=${live.map((row) => row.object).join(',') || '(none)'}`);
});
check('no contradiction after keep_old', () => {
  if (liveContradictions(db).length !== 0) throw new Error('contradiction survived keep_old');
});

// keep_new again, from a fresh displacement, then resolve the other way.
const applied2 = applyFacts(db, [
  { subject: 'user', predicate: 'lives_in', object: '苏州', confidence: 0.8, sensitivity: 'personal', evidence: [first] },
], 'user');
check('second displacement invalidated the revived row', () => {
  if (applied2.invalidated !== 1) throw new Error(`expected invalidated=1, got ${JSON.stringify(applied2)}`);
});
transact(db, () => resolveClarification(db, String(db.prepare('SELECT id FROM facts WHERE needs_clarification = 1').get().id), 'keep_new'));
check('keep_new keeps exactly one live value', () => {
  const live = liveFacts(db, { subject: 'user' }).filter((row) => row.predicate === 'lives_in');
  if (live.length !== 1 || live[0].object !== '苏州') throw new Error(`live=${live.map((row) => row.object).join(',') || '(none)'}`);
});
check('no contradiction after keep_new', () => {
  if (liveContradictions(db).length !== 0) throw new Error('contradiction survived keep_new');
});
check('a rejection and a displacement retire differently, and no pointer dangles', () => {
  // Two reasons a row stops being live, and they must not be conflated:
  //   displaced  — something newer took its place, so `superseded_by` names it
  //   rejected   — keep_old said the row was simply wrong; nothing superseded it
  // A `superseded_by` that points at a row which is itself not live is neither:
  // it is a dangling pointer, and it is what a half-applied migration looks like.
  const rejected = db.prepare(`
    SELECT count(*) AS n FROM facts
    WHERE invalid_at IS NOT NULL AND superseded_by IS NULL AND predicate = 'lives_in'
  `).get();
  if (Number(rejected.n) !== 1) throw new Error(`expected exactly 1 rejected row, got ${rejected.n}`);
  const dangling = db.prepare(`
    SELECT count(*) AS n FROM facts f
    WHERE f.superseded_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM facts g WHERE g.id = f.superseded_by AND g.invalid_at IS NULL)
  `).get();
  if (Number(dangling.n) !== 0) throw new Error(`${dangling.n} superseded_by pointers do not point at a live row`);
});

db.close();

const path = process.argv[2];
if (path !== undefined) {
  const real = await openDatabase(path);
  const found = liveContradictions(real);
  console.log(`\nlive single-valued contradictions in ${path}: ${found.length}`);
  for (const row of found) {
    const rows = real.prepare('SELECT object, confidence, source FROM facts WHERE subject = ? AND predicate = ? AND invalid_at IS NULL ORDER BY confidence DESC')
      .all(row.subject, row.predicate);
    console.log(`  ${row.subject} / ${row.predicate}: ${rows.map((r) => `${r.object} (${r.confidence}, ${r.source})`).join(' | ')}`);
  }
  real.close();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;