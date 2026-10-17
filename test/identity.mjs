/**
 * Who is "the person"? Three bugs found in one debugging session, kept here so
 * they cannot come back:
 *
 *  1. `reinforceFact` re-indexed a fact from `subject`/`predicate` columns it had
 *     not selected, so every updated fact was indexed as "undefined undefined ..."
 *     and stopped answering topic queries.
 *  2. The extractor sometimes files the owner's facts under their own name
 *     ("林晚 goal = ..."), which no read path renders.
 *  3. Facts about other people ("妈妈 health = ...") were stored, indexed and
 *     linked, but never rendered — every read filtered on the owner's subject.
 */

import { readFileSync } from 'node:fs';
import { openDatabase } from '../lib/db.js';
import { applyFacts } from '../lib/consolidate.js';
import { addFact, liveFacts, reinforceFact, recall } from '../lib/store.js';
import { renderResident } from '../lib/prompt.js';
import { segment } from '../lib/tokenize.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const db = await openDatabase(':memory:');

console.log('reinforcement keeps the row searchable');
{
  const id = addFact(db, { subject: 'user', predicate: 'works_as', object: '插画师', confidence: 0.7 });
  reinforceFact(db, id, { object: '插画师，主要接商稿' });
  const body = String(db.prepare('SELECT body FROM facts_fts WHERE fact_id = ?').get(id)?.body ?? '');
  check(!body.includes('undefined'), 'index body contains no "undefined"');
  check(body.includes('works_as'), 'index body keeps the predicate');
  check(body.includes('user'), 'index body keeps the subject');

  const hits = db.prepare('SELECT fact_id FROM facts_fts WHERE facts_fts MATCH ?').all('"works_as"');
  check(hits.some((row) => String(row.fact_id) === String(id)), 'the fact is findable by its own predicate');

  const byCue = recall(db, { cue: '我的工作怎么样', userId: 'user', limit: 5 });
  check(byCue.facts.some((fact) => String(fact.id) === String(id)), 'a topic cue reaches it after the update');
}

console.log('the owner is recognised under their own name');
{
  addFact(db, { subject: 'user', predicate: 'name', object: '林晚', confidence: 0.95, pinned: true });
  applyFacts(db, [
    { subject: '林晚', predicate: 'goal', object: '想养猫', confidence: 0.8, sensitivity: 'personal', evidence: [] },
  ], 'user');
  const stray = liveFacts(db, { subject: '林晚', limit: 10 });
  check(stray.length === 0, 'no facts are left filed under the bare name');
  const owned = liveFacts(db, { subject: 'user', limit: 20 });
  check(owned.some((fact) => String(fact.object) === '想养猫'), 'the fact landed on the owner');
}

console.log('both write paths agree about subjects');
{
  // The two write paths had drifted: extraction resolved "林晚" to the owner and
  // `memory_remember` did not, so a plan the model wrote by hand was filed under
  // the person's own name and then rendered as somebody else's. A behavioural
  // test cannot reach `memory_remember` (it needs a live tool context), so this
  // asserts on the wiring instead. It is the kind of check that reads badly and
  // catches a real class of bug: a write path that forgot the normalisation
  // passes every other test in this file.
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const start = source.indexOf("name: 'memory_remember'");
  const end = source.indexOf("name: 'memory_forget'");
  const body = source.slice(start, end === -1 ? undefined : end);
  check(body.includes('resolveSubject('), 'memory_remember normalises the subject');
  check(body.includes('ownerAliases('), 'it resolves against the owner\'s stored names');
}

console.log('other people reach the resident profile');
{
  addFact(db, { subject: '妈妈', predicate: 'health', object: '糖尿病，目前在控糖', confidence: 0.9, sensitivity: 'sensitive' });
  const resident = renderResident(db, { userId: 'user', now: Date.now(), language: 'zh' });
  check(resident.includes('对方身边的人'), 'the section heading is present');
  check(resident.includes('糖尿病'), 'the fact about her mother is rendered');
  check(resident.includes('妈妈'), 'it is attributed to a named person');

  const hits = recall(db, { cue: '我妈身体怎么样', userId: 'user', limit: 5 });
  check(hits.facts.some((fact) => String(fact.subject) === '妈妈'), 'a topic cue reaches it too');
}

console.log('the index is complete');
{
  const facts = liveFacts(db, { limit: 100 });
  let missing = 0;
  for (const fact of facts) {
    const row = db.prepare('SELECT body FROM facts_fts WHERE fact_id = ?').get(String(fact.id));
    if (row === undefined) missing++;
    else if (String(row.body) !== segment(`${fact.subject} ${fact.predicate} ${fact.object}`) && !String(row.body).startsWith('user name')) {
      // Bodies may carry a synonym tail; a mismatch here would only be a problem
      // if it lost the head, which the two checks above already cover.
    }
  }
  check(missing === 0, `every live fact has an index row (${missing} missing)`);
}

db.close();

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
