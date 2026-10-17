/**
 * Smoke test for the storage and scoring layers — no DSH runtime involved.
 *
 * Run with: node test/smoke.mjs
 */

import { openDatabase } from '../lib/db.js';
import {
  recordEpisode,
  hasEpisodeForMessage,
  unconsolidatedEpisodes,
  addFact,
  similarFacts,
  liveFacts,
  invalidateFact,
  recall,
  recordReview,
  reviewHistory,
  gradeMemory,
  openLoops,
  addOpenLoop,
  closeOpenLoop,
  pendingClarifications,
  resolveClarification,
  ensureRelationship,
  recomputeRelationship,
  chargeBudget,
  spentToday,
  userId,
} from '../lib/store.js';
import { retrievability, review, initialStability, initialDifficulty, intervalFor } from '../lib/fsrs.js';
import { shouldExtract, detectAffect, asksForRecall } from '../lib/gate.js';
import { renderResident, renderRecall } from '../lib/prompt.js';
import { decide, parseFacts, objectSimilarity } from '../lib/extract.js';

let failures = 0;
/**
 * Assert one condition.
 * @param {boolean} condition - must be true.
 * @param {string} label - what is being checked.
 */
function check(condition, label) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

const db = await openDatabase(':memory:');
const owner = userId(db);
ensureRelationship(db, owner);

console.log('episodes');
const e1 = recordEpisode(db, { sessionId: 's1', actor: 'user', text: '我最近加班很多，年糕也不怎么理我', messageId: 'm1' });
const e2 = recordEpisode(db, { sessionId: 's1', actor: 'agent', text: '听起来很累，年糕可能是感觉到了', messageId: 'm2' });
check(e1 !== '' && e2 !== '', 'two episodes stored');
check(hasEpisodeForMessage(db, 's1', 'm1'), 'message dedup hit');
check(recordEpisode(db, { sessionId: 's1', actor: 'user', text: 'dup', messageId: 'm1' }) === '', 'duplicate message rejected');
check(unconsolidatedEpisodes(db, 10).length === 2, 'two unconsolidated');

console.log('retrieval');
const r1 = recall(db, { cue: '加班', userId: owner });
check(r1.episodes.length === 1, `chinese cue "加班" matched ${r1.episodes.length} episode`);
const r2 = recall(db, { cue: '年糕', userId: owner });
check(r2.episodes.length >= 1, `chinese cue "年糕" matched ${r2.episodes.length}`);
const r3 = recall(db, { cue: 'zzzz', userId: owner });
check(r3.episodes.length === 0, 'unrelated cue matched nothing');

console.log('facts');
const f1 = addFact(db, { subject: owner, predicate: 'likes', object: '咖啡', confidence: 0.8, evidence: [e1] });
const f2 = addFact(db, { subject: owner, predicate: 'works_as', object: '后端工程师', confidence: 0.7, evidence: [e1] });
check(liveFacts(db, { subject: owner }).length === 2, 'two live facts');
const similar = similarFacts(db, { subject: owner, predicate: 'likes', object: '咖啡' });
check(similar.length >= 1, 'similar fact found for exact object');
check(decide(similar, { subject: owner, predicate: 'likes', object: '咖啡', confidence: 0.9 }).action === 'noop', 'same object → noop');
check(decide(similar, { subject: owner, predicate: 'likes', object: '美式咖啡', confidence: 0.9 }).action === 'update', 'near object → update');
check(decide(similar, { subject: owner, predicate: 'likes', object: '爬山', confidence: 0.9 }).action === 'add', 'multi-valued predicate keeps both');
check(
  decide([{ id: 'x', object: '上海' }], { subject: owner, predicate: 'lives_in', object: '北京', confidence: 0.9 }).action === 'invalidate',
  'single-valued predicate retires the old value',
);
check(objectSimilarity('咖啡', '咖啡因') > 0 && objectSimilarity('咖啡', '咖啡因') < 1, 'object similarity in (0,1)');
invalidateFact(db, f2, { reason: 'changed jobs' });
check(liveFacts(db, { subject: owner }).length === 1, 'invalidate drops from live set');
check(db.prepare('SELECT COUNT(*) AS n FROM facts').get().n === 2, 'invalidated fact still stored');

console.log('clarifications');
const f3 = addFact(db, { subject: owner, predicate: 'lives_in', object: '上海', confidence: 0.5, needsClarification: true });
check(pendingClarifications(db).length === 1, 'one pending clarification');
resolveClarification(db, f3, true);
check(pendingClarifications(db).length === 0, 'clarification resolved');
check(Number(liveFacts(db, { subject: owner }).find((f) => String(f.id) === f3)?.confidence) > 0.5, 'keeping raised confidence');

console.log('fsrs');
const st = initialStability(3);
const df = initialDifficulty(3);
check(st > 0, `initial stability ${st.toFixed(3)}`);
check(df >= 1 && df <= 10, `initial difficulty ${df.toFixed(2)}`);
const next = review({ stability: st, difficulty: df, lastReviewAt: Date.now() - 3 * 86400000, reviewCount: 1 }, 3, Date.now());
check(next.stability > 0, `reviewed stability ${next.stability.toFixed(3)}`);
check(retrievability(0, st) === 1, 'R=1 at zero elapsed');
check(retrievability(30, 30) < 0.95 && retrievability(30, 30) > 0.5, `R(30d,S=30)=${retrievability(30, 30).toFixed(3)}`);
check(intervalFor(30) > 1, `interval for S=30 is ${intervalFor(30).toFixed(1)}d`);

console.log('reviews');
recordReview(db, e1, 'episode', Date.now());
recordReview(db, e1, 'episode', Date.now() - 1000);
check(reviewHistory(db, e1, 'episode').length === 2, 'two reviews recorded');
gradeMemory(db, e1, 'episode', 4);
check(Number(db.prepare('SELECT review_count FROM episodes WHERE id = ?').get(e1).review_count) === 1, 'grade writes review_count');

console.log('loops');
const l1 = addOpenLoop(db, { userId: owner, text: '答应帮他看简历' });
check(openLoops(db, owner).length === 1, 'loop opened');
closeOpenLoop(db, l1);
check(openLoops(db, owner).length === 0, 'loop closed');

console.log('budget');
chargeBudget(db, 1200);
check(spentToday(db) === 1200, 'budget charged');

console.log('gate');
check(shouldExtract('记住我喜欢喝美式').explicit === true, 'explicit remember detected');
check(shouldExtract('今天天气不错').extract === false, 'casual line not extracted');
const affect = detectAffect('今天真的太开心了');
check(affect !== null && affect.valence > 0, 'positive affect detected');
check(asksForRecall('你还记得我之前说过的那个事吗') === true, 'recall request detected');

console.log('prompt');
const resident = renderResident(db, { userId: owner, language: 'zh' });
check(resident.includes('咖啡'), 'resident profile mentions coffee');
check(!resident.includes('{{'), 'resident text is template-safe');
check(resident.length > 0, `resident length ${resident.length}`);

console.log('extraction parse');
const batch = [{ id: 'e1', actor: 'user', text: '我在上海做后端' }];
const parsed = parseFacts(
  '```json\n{"facts":[{"subject":"user","predicate":"lives_in","object":"上海","confidence":0.9,"sensitivity":"personal","episode":0}]}\n```',
  batch,
);
check(parsed.length === 1 && parsed[0].object === '上海', 'fenced JSON parsed');
check(parsed[0].subject === owner, 'subject normalised to owner id');
check(parseFacts('not json', batch).length === 0, 'garbage yields nothing');

console.log('relationship');
const rel = recomputeRelationship(db, owner);
check(Number(rel.familiarity) > 0, `familiarity ${Number(rel.familiarity).toFixed(4)}`);

db.close();
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
