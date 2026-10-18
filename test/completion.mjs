/**
 * A completion retires the plan it completes, and only that one.
 *
 * Plans and habits became multi-valued because a person really can be doing six
 * things at once, and the profile was showing one plan out of six. That fix has
 * an obvious failure mode: once several plans coexist, a plan that finishes no
 * longer has anything to replace it, so the library keeps both the intention and
 * the completion and the model reads them as two live commitments.
 *
 * The pair below is lifted from a real database: the same manuscript, one week
 * apart, both still live.
 */

import assert from 'node:assert/strict';
import { decide } from '../lib/extract.js';

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

const before = { id: 'plan-before', predicate: 'plan', object: '下周要交一本关于猫的绘本稿，目前有点紧张' };

console.log('the completion replaces the intention');
check('the same manuscript finished retires the intent', () => {
  const decision = decide([before], {
    subject: 'user',
    predicate: 'plan',
    object: '猫绘本稿已于今天交稿，出版社下周给反馈',
  });
  assert.equal(decision.action, 'invalidate');
  assert.equal(decision.factId, 'plan-before');
});

check('the follow-up about the same manuscript is not a new plan', () => {
  // "等出版社下周给稿子的反馈" is the same thread of events; storing it beside the
  // completion would double the line without adding anything.
  const settled = { id: 'plan-done', predicate: 'plan', object: '猫绘本稿已于今天交稿，出版社下周给反馈' };
  const decision = decide([settled], {
    subject: 'user',
    predicate: 'plan',
    object: '等出版社下周给稿子的反馈',
  });
  assert.equal(decision.action, 'update');
});

console.log('unrelated plans are untouched');
check('a wedding does not retire a manuscript', () => {
  const decision = decide([before], {
    subject: 'user',
    predicate: 'plan',
    object: '下下周一去参加婚礼，要提前准备礼物',
  });
  assert.equal(decision.action, 'add');
});

check('an intention does not retire anything', () => {
  // The reverse direction has to stay additive, or every restated plan would
  // knock out the previous one.
  const decision = decide([before], {
    subject: 'user',
    predicate: 'plan',
    object: '这周末去苏州看妈妈，顺便问出版社绘本稿的反馈',
  });
  assert.equal(decision.action, 'add');
});

check('a negated completion does not retire anything', () => {
  const decision = decide([before], {
    subject: 'user',
    predicate: 'plan',
    object: '绘本稿还没交，下周继续赶',
  });
  assert.equal(decision.action, 'add', '"还没交" is the plan being alive, not finished');
});

console.log('the profile stops contradicting itself');
// The rendering side already collapses near-identical objects at 0.28; this pair
// scores well below that, which is why the write path has to handle it.
import { objectSimilarity } from '../lib/extract.js';
check('the two statements are not similar enough to merge by rendering alone', () => {
  const score = objectSimilarity(before.object, '猫绘本稿已于今天交稿，出版社下周给反馈');
  assert.ok(score < 0.28, `expected the pair below the render threshold, got ${score}`);
});

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
