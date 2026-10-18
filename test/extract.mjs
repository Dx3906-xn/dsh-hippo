// Predicate canonicalization and contradiction routing.
import { decide, objectSimilarity, parseFacts } from '../lib/extract.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const batch = [{ id: 'e1' }];

console.log('predicate canonicalization');
const cases = [
  { subject: 'user', predicate: '养了', object: '一只三花猫', confidence: 0.9 },
  { subject: 'user', predicate: '饮食忌口', object: '不吃辣', confidence: 0.9 },
  { subject: 'user', predicate: '正在学', object: '做咖啡', confidence: 0.9 },
  { subject: 'user', predicate: '最喜欢', object: '手冲咖啡', confidence: 0.9 },
  { subject: 'user', predicate: '住在', object: '北京', confidence: 0.9 },
  { subject: 'user', predicate: '是', object: '随便什么', confidence: 0.9 },
  { subject: 'user', predicate: 'likes', object: '咖啡', confidence: 0.9 },
];
const parsed = parseFacts(JSON.stringify({ facts: cases }), batch);
const byObject = new Map(parsed.map((fact) => [fact.object, fact.predicate]));
check(byObject.get('一只三花猫') === 'has_pet', '养了 → has_pet');
check(byObject.get('不吃辣') === 'dietary', '饮食忌口 → dietary');
check(byObject.get('做咖啡') === 'goal', '正在学 → goal');
check(byObject.get('手冲咖啡') === 'likes', '最喜欢 → likes');
check(byObject.get('北京') === 'lives_in', '住在 → lives_in');
check(!byObject.has('随便什么'), 'a bare 是 is rejected');
check(byObject.get('咖啡') === 'likes', 'an English predicate passes through');

console.log('contradiction routing');
// Pets are not single-valued: a second cat is an addition, not a correction.
const oldPet = { id: 'f1', predicate: 'has_pet', object: '一只叫年糕的橘猫' };
const secondPet = { subject: 'user', predicate: 'has_pet', object: '一只叫豆沙的三花猫' };
check(decide([oldPet], secondPet).action === 'add', 'a second pet coexists');

// Richer wording of the same pet updates rather than retiring.
const richerPet = { subject: 'user', predicate: 'has_pet', object: '年糕，一只橘猫' };
check(decide([oldPet], richerPet).action === 'update', 'a fuller description of the same pet updates');

const oldCity = { id: 'f2', predicate: 'lives_in', object: '北京（2026年10月刚搬过去）' };
const newCity = { subject: 'user', predicate: 'lives_in', object: '北京' };
check(decide([oldCity], newCity).action === 'noop', 'the same city with an aside is a no-op');

const oldLike = { id: 'f3', predicate: 'likes', object: '咖啡' };
const newLike = { subject: 'user', predicate: 'likes', object: '爬山' };
check(decide([oldLike], newLike).action === 'add', 'a second like coexists');

console.log('similarity');
check(objectSimilarity('北京（2026年10月刚搬过去）', '北京') === 1, 'parenthesised aside is ignored');
check(objectSimilarity('咖啡', '爬山') === 0, 'unrelated objects score zero');
check(objectSimilarity('咖啡', '美式咖啡') >= 0.45, 'a longer version of the same object is near');

console.log('rephrasings of one statement');
// Character Dice is scale-sensitive: restatements of one plan score 0.31-0.69,
// and the update band starts at 0.45, so a third of them fell through and were
// stored again. Content-token overlap separates them cleanly: restatements share
// five or more tokens with 0.5+ containment, unrelated plans share at most one.
const storedPlan = { id: 'f9', predicate: 'plan', object: '猫绘本稿已于今天交稿，出版社下周给反馈' };
check(decide([storedPlan], { subject: 'user', predicate: 'plan', object: '绘本稿已交，出版社下周给反馈' }).action === 'update',
  'the same news reworded is the same fact');
check(decide([storedPlan], { subject: 'user', predicate: 'plan', object: '等出版社下周给稿子的反馈' }).action === 'update',
  'the same news from another angle is the same fact');
check(decide([storedPlan], { subject: 'user', predicate: 'plan', object: '下周三（10月21日）去医院复查，复查完打算休息两天' }).action === 'add',
  'a different plan is a new fact');
check(decide([storedPlan], { subject: 'user', predicate: 'plan', object: '最近在考虑换工作，还没想好' }).action === 'add',
  'another different plan is still a new fact');
// One shared token is a coincidence: "想养猫" appears in both, and merging them
// would lose the constraint that actually matters (the landlord says no).
check(decide([{ id: 'f10', predicate: 'goal', object: '一直想养只猫' }],
  { subject: 'user', predicate: 'goal', object: '想养猫，但现在租的房子房东不让养' }).action !== 'invalidate',
  'one shared token is not a restatement');

console.log('a finished plan retires the pending one');
// Plans are multi-valued — a person can be doing six things at once — so an
// unrelated plan must never retire another. But "下周要交一本猫的绘本稿" and
// "猫绘本稿已于今天交稿" are two live statements about one manuscript, and a
// profile that renders both says the future and the past in the same tense.
const pendingPlan = { id: 'f11', predicate: 'plan', object: '下周要交一本关于猫的绘本稿，目前有点紧张' };
check(decide([pendingPlan], { subject: 'user', predicate: 'plan', object: '猫绘本稿已于今天交稿，出版社下周给反馈' }).action === 'invalidate',
  'a completion retires the plan it completes');
check(decide([pendingPlan], { subject: 'user', predicate: 'plan', object: '绘本稿已交，出版社下周给反馈' }).action === 'invalidate',
  'the shorter completion is still a completion');
check(decide([pendingPlan], { subject: 'user', predicate: 'plan', object: '稿子还没交，下周继续赶' }).action === 'add',
  'a negated completion is not a completion');
check(decide([pendingPlan], { subject: 'user', predicate: 'plan', object: '下下周一去参加婚礼，要提前准备礼物' }).action === 'add',
  'an unrelated completion-shaped plan does not touch it');
check(decide([pendingPlan], { subject: 'user', predicate: 'plan', object: '这周末去苏州看妈妈，顺便问出版社绘本稿的反馈' }).action === 'add',
  'a plan that merely mentions the same publisher is still a different plan');

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
