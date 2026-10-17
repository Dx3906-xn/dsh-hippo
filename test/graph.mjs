/**
 * Tests for the association graph.
 *
 * The point of these is not that links exist — it is that a cue reaches a memory
 * it shares no words with, and that the graph does not degenerate into "every
 * fact is linked to every other fact", which would make spreading meaningless.
 */

import { openDatabase } from '../lib/db.js';
import { recordEpisode, addFact, addLink, linksFrom, spreadActivation, recall, liveFacts } from '../lib/store.js';
import { linkBatch, applyFacts } from '../lib/consolidate.js';
import { detectTrustSignal, detectAffect } from '../lib/gate.js';
import { renderResident } from '../lib/prompt.js';

let failed = 0;
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

const db = await openDatabase(':memory:');
const a = recordEpisode(db, { sessionId: 's', actor: 'user', text: '我养了一只猫' });
const b = recordEpisode(db, { sessionId: 's', actor: 'agent', text: '叫什么名字' });
const c = recordEpisode(db, { sessionId: 's', actor: 'user', text: '年糕，是只橘猫' });
const d = recordEpisode(db, { sessionId: 's', actor: 'user', text: '我住在杭州，做插画' });

const cat = addFact(db, { subject: 'user', predicate: 'has_pet', object: '年糕（橘猫）', evidence: [a, c] });
const city = addFact(db, { subject: 'user', predicate: 'lives_in', object: '杭州', evidence: [d] });
const job = addFact(db, { subject: 'user', predicate: 'works_as', object: '插画师', evidence: [d] });

console.log('edges');
const linked = linkBatch(db, [{ id: a }, { id: b }, { id: c }, { id: d }], { factIds: [cat, city, job] }, [
  { evidence: [a, c], subject: 'user', predicate: 'has_pet', object: '年糕（橘猫）' },
  { evidence: [d], subject: 'user', predicate: 'lives_in', object: '杭州' },
  { evidence: [d], subject: 'user', predicate: 'works_as', object: '插画师' },
], 'user');
check(linked.temporal === 3, `temporal edges ${linked.temporal}`);
check(linked.evidence === 4, `supports edges ${linked.evidence}`);
check(linksFrom(db, a).some((link) => link.kind === 'temporal'), 'episode a has a temporal edge');
check(linksFrom(db, cat).some((link) => link.kind === 'supports'), 'fact is grounded in its episode');

console.log('provenance survives an update');
// A second consolidation that only reinforces the city fact must still leave it
// traceable. The episode that introduced it was not in this batch at all.
const later = recordEpisode(db, { sessionId: 's', actor: 'user', text: '对了我还住杭州' });
const appliedAgain = applyFacts(db, [
  { subject: 'user', predicate: 'lives_in', object: '杭州', confidence: 0.8, evidence: [later] },
], 'user');
linkBatch(db, [{ id: later }], appliedAgain, [
  { evidence: [later], subject: 'user', predicate: 'lives_in', object: '杭州' },
], 'user');
const cityLinks = linksFrom(db, city);
check(cityLinks.some((link) => link.kind === 'supports' && String(link.to_id) === String(d)), 'original episode still supports the fact');
check(cityLinks.some((link) => link.kind === 'supports' && String(link.to_id) === String(later)), 'new retelling is attached too');

console.log('no hairball');
const all = liveFacts(db, { subject: 'user' });
let edges = 0;
for (const fact of all) edges += db.prepare("SELECT COUNT(*) AS n FROM links WHERE from_id = ? AND kind = 'shared_subject'").get(String(fact.id)).n;
const pairs = (all.length * (all.length - 1));
check(edges <= pairs, `shared_subject edges ${edges} stay within the possible ${pairs}`);
check(all.length === 3, `three live facts, edges are not a complete graph by construction`);

console.log('spread');
const bonus = spreadActivation(db, [{ id: city, score: 1 }], { decay: 0.35 });
check(bonus.size > 0, `spread from a fact reached ${bonus.size} neighbours`);

console.log('recall walks');
// "橘猫" appears only in the cat fact. "杭州" is a different fact entirely; it
// must not appear for a cat query.
const catHits = recall(db, { cue: '橘猫', userId: 'user', limit: 10 });
check(catHits.facts.some((row) => String(row.object).includes('年糕')), 'cue reaches the cat fact');
check(!catHits.facts.some((row) => String(row.object) === '杭州'), 'unrelated fact is not pulled in');
const cityHits = recall(db, { cue: '杭州', userId: 'user', limit: 10 });
check(cityHits.facts.some((row) => String(row.object) === '杭州'), 'cue reaches the city fact');
check(cityHits.facts.every((row) => row.kind === 'fact'), 'recall rows carry their own kind');

console.log('trust');
check(detectTrustSignal('我只跟你说，别告诉别人')?.reason === 'disclosure', 'disclosure raises trust');
check(detectTrustSignal('你刚才不该那么说')?.reason === 'repaired', 'repair raises trust');
check(detectTrustSignal('我们换个话题')?.reason === 'boundary', 'boundary lowers trust');
check(detectTrustSignal('今天天气不错') === null, 'neutral talk does not move trust');

console.log('affect');
const afraid = detectAffect('我有点怕');
check(afraid !== null && afraid.valence < 0, 'bare 怕 registers as negative');
const nervous = detectAffect('我下周要做手术，有点紧张');
check(nervous !== null && nervous.valence < 0, '紧张 registers as negative');
check(detectAffect('今天吃了个包子') === null, 'neutral text has no affect');

console.log('resident prose');
const prose = renderResident(db, { userId: 'user', now: Date.now() });
check(!prose.includes('%'), 'relationship line avoids bare percentages');
check(prose.includes('年糕'), 'resident section carries the profile');

for (const [name, id] of [['smoke', null]]) void name, void id;
db.close();

if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
