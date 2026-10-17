/**
 * Expand a cue into the attribute keys it probably means.
 *
 * Lexical recall alone fails on the most natural question a person can ask. "我
 * 的工作怎么样" shares no character with the stored fact `works_as=插画师`, so it
 * retrieves nothing — even though the fact is exactly what was asked about. The
 * gap is not vocabulary size, it is that people ask about *topics* while the
 * store keys by *attribute*.
 *
 * This table bridges the two: a topic word maps to the predicates that answer
 * it, and recall widens the MATCH expression with those predicate names. It is
 * a fixed table rather than an embedding lookup on purpose — it is inspectable,
 * costs nothing, and a wrong entry is a one-line fix instead of a retraining
 * run.
 *
 * @module dsh-hippo/topics
 */

/**
 * Topic word → attribute keys.
 *
 * Keys are the canonical predicates from `extract.js`. Values are matched
 * against the normalized cue text with `includes`, so shorter entries are
 * deliberately rarer words.
 */
const TOPIC_PREDICATES = new Map([
  // Chinese topics
  ['工作', ['works_as', 'works_at']],
  ['职业', ['works_as', 'works_at']],
  ['上班', ['works_as', 'works_at']],
  ['公司', ['works_at']],
  ['做什么', ['works_as']],
  ['干什么', ['works_as']],
  ['住', ['lives_in']],
  ['老家', ['born_in', 'born_on']],
  ['哪里人', ['born_in']],
  ['生日', ['birthday', 'born_on']],
  ['多大', ['age']],
  ['几岁', ['age']],
  ['年龄', ['age']],
  ['名字', ['name', 'nickname']],
  ['怎么称呼', ['name', 'nickname']],
  ['叫我', ['nickname', 'name']],
  ['猫', ['has_pet']],
  ['狗', ['has_pet']],
  ['宠物', ['has_pet']],
  ['养', ['has_pet']],
  ['感情', ['relationship_status']],
  ['对象', ['relationship_status']],
  ['单身', ['relationship_status']],
  ['恋爱', ['relationship_status']],
  ['喜欢', ['likes', 'dislikes']],
  ['不喜欢', ['dislikes']],
  ['讨厌', ['dislikes']],
  ['吃', ['dietary', 'dislikes', 'likes']],
  ['忌口', ['dietary']],
  ['过敏', ['dietary', 'health']],
  ['身体', ['health']],
  ['健康', ['health']],
  ['病', ['health']],
  ['戒烟', ['habit', 'health']],
  ['习惯', ['habit']],
  ['计划', ['plan', 'goal']],
  ['打算', ['plan', 'goal']],
  ['目标', ['goal', 'plan']],
  ['性格', ['personality']],
  ['脾气', ['personality']],
  ['语言', ['language']],
  ['联系', ['contact']],

  // English topics
  ['job', ['works_as', 'works_at']],
  ['work', ['works_as', 'works_at']],
  ['live', ['lives_in']],
  ['lives', ['lives_in']],
  ['birthday', ['birthday', 'born_on']],
  ['age', ['age']],
  ['old', ['age']],
  ['name', ['name', 'nickname']],
  ['pet', ['has_pet']],
  ['pets', ['has_pet']],
  ['cat', ['has_pet']],
  ['dog', ['has_pet']],
  ['like', ['likes', 'dislikes']],
  ['likes', ['likes']],
  ['hate', ['dislikes']],
  ['hates', ['dislikes']],
  ['allergy', ['dietary', 'health']],
  ['health', ['health']],
  ['habit', ['habit']],
  ['plan', ['plan', 'goal']],
  ['plans', ['plan', 'goal']],
  ['goal', ['goal', 'plan']],
  ['personality', ['personality']],
]);

/**
 * Attribute keys the cue is probably asking about.
 *
 * @param {string} cue - the normalized or raw cue text.
 * @returns {string[]} matching predicate names, deduplicated.
 */
export function topicsFor(cue) {
  const text = String(cue ?? '').toLowerCase();
  if (text.length === 0) return [];
  const hits = new Set();
  for (const [topic, predicates] of TOPIC_PREDICATES) {
    if (!text.includes(topic)) continue;
    for (const predicate of predicates) hits.add(predicate);
  }
  return [...hits];
}
