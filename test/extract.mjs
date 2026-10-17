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

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
