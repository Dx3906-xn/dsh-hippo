/**
 * What the profile does when the store holds several versions of one fact.
 *
 * The store's job is to keep every version that was once true - that is what
 * the bi-temporal columns are for - but the resident section is a snapshot of
 * who the person is *now*, and a snapshot that states two conflicting versions
 * of one attribute on adjacent lines is worse than one that states the current
 * version and drops the rest. This is the test that pins that distinction: the
 * rows must remain, only the rendering collapses.
 *
 * Run with: node test/profile.mjs
 */

import { openDatabase } from '../lib/db.js';
import { addFact, liveFacts, userId } from '../lib/store.js';
import { renderResident } from '../lib/prompt.js';

let failures = 0;
function check(ok, label) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

const db = await openDatabase(':memory:');
const owner = userId(db);

console.log('several phrasings of one single-valued fact');
addFact(db, { subject: owner, predicate: 'lives_in', object: '杭州', confidence: 0.9 });
addFact(db, { subject: owner, predicate: 'lives_in', object: '苏州（上个月从杭州搬来）', confidence: 0.95 });
addFact(db, { subject: owner, predicate: 'lives_in', object: '合肥（上上个月搬来）', confidence: 0.98 });
// All three are live in the store: invalidating them is the extraction decision's
// business, not the renderer's, and this fixture deliberately bypasses it.
check(liveFacts(db, { subject: owner }).filter((f) => f.predicate === 'lives_in').length === 3, 'three versions stored');
const profile = renderResident(db, { userId: owner, language: 'zh' });
const cityLines = profile.split('\n').filter((line) => line.includes('住在'));
check(cityLines.length === 1, `one city line rendered (${cityLines.length})`);
check(cityLines[0].includes('合肥'), 'and it is the newest one');

console.log('a multi-valued predicate keeps several');
addFact(db, { subject: owner, predicate: 'likes', object: '海獭', confidence: 0.9 });
addFact(db, { subject: owner, predicate: 'likes', object: '手冲咖啡', confidence: 0.8 });
addFact(db, { subject: owner, predicate: 'likes', object: '下雨天', confidence: 0.7 });
addFact(db, { subject: owner, predicate: 'likes', object: '旧书店', confidence: 0.6 });
const likes = renderResident(db, { userId: owner, language: 'zh' })
  .split('\n').filter((line) => line.includes('喜欢') && !line.includes('不喜欢'));
check(likes.length >= 2, `likes keep more than one line (${likes.length})`);
check(likes.length <= 3, `but the list is capped (${likes.length})`);
// Which three survive the cap is decided by rank, so the top-ranked one is not
// negotiable even though the fourth is. Fixtures pin confidence for exactly this
// reason: four rows at the same confidence let an arbitrary tie-break decide, and
// a test that asserts on an arbitrary choice fails one run in four.
check(likes[0].includes('海獭'), 'the best-ranked value survives the cap');

console.log('a subset of an existing value is not a new line');
addFact(db, { subject: owner, predicate: 'health', object: '上个月查出糖尿病，目前在控糖，这周血糖稳了', confidence: 0.8 });
addFact(db, { subject: owner, predicate: 'health', object: '糖尿病', confidence: 0.6 });
const health = renderResident(db, { userId: owner, language: 'zh' }).split('\n').filter((line) => line.includes('糖尿病'));
check(health.length === 1, `one line for one condition (${health.length})`);
check(health[0].includes('控糖'), 'and the fuller phrasing won');

console.log('a predicate cap does not leak across predicates');
const text = renderResident(db, { userId: owner, language: 'zh' });
check(text.includes('海獭') && text.includes('住在合肥'), 'unrelated predicates still both render');

console.log('the snapshot never states two versions at once');
const conflicting = text.split('\n').filter((line) => line.includes('杭州') && line.includes('合肥'));
check(conflicting.length === 0, `no line carries two cities (${conflicting.length})`);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
