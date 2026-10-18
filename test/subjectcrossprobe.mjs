// Observation: can a fact about the agent displace a fact about the owner?
//
// `test/nickprobe.mjs` proved the displacement happened in one `applyFacts`
// batch. This reproduces it in an empty database, with no model involved, so
// the mechanism is visible instead of inferred.
//
// The hypothesis: `similarFacts()` matches on (subject, predicate) first, and
// when that finds nothing it falls back to FTS, which indexes the object and
// NOT the subject. So a candidate about "agent" can be compared against, and
// then invalidate, a row about "user".
//
// Usage: node test/subjectcrossprobe.mjs

import { openDatabase } from '../lib/db.js';
import { addFact, similarFacts } from '../lib/store.js';
import { decide } from '../lib/extract.js';

const db = await openDatabase(':memory:');

addFact(db, {
  subject: 'user', predicate: 'nickname', object: '晚晚',
  confidence: 0.95, source: 'explicit',
});

const candidate = { subject: 'agent', predicate: 'nickname', object: '大肥鱼' };

console.log('=== what similarFacts() offers for a fact about the agent ===');
const existing = similarFacts(db, candidate);
console.log(`  ${existing.length} row(s) returned`);
for (const row of existing) {
  console.log(`  subject=${row.subject} predicate=${row.predicate} object=${JSON.stringify(row.object)}`);
}

console.log('\n=== what decide() makes of it ===');
const decision = decide(existing, candidate);
console.log(`  ${JSON.stringify(decision)}`);

console.log('\n=== the damage ===');
const live = db.prepare("SELECT subject, predicate, object FROM facts WHERE invalid_at IS NULL").all();
const dead = db.prepare("SELECT subject, predicate, object FROM facts WHERE invalid_at IS NOT NULL").all();
console.log(`  live: ${JSON.stringify(live)}`);
console.log(`  dead: ${JSON.stringify(dead)}`);
console.log(existing.length > 0 && existing[0].subject !== candidate.subject
  ? '  CONFIRMED: a row about another subject was treated as the same fact.'
  : '  not reproduced.');
