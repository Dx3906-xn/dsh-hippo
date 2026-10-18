/**
 * Tests for the agenda: open loops and unresolved contradictions.
 *
 * The agenda is the only part of the system that changes what the agent *says*
 * rather than what it knows, so the failure modes are social rather than
 * technical: an agenda that never empties produces an interrogator, and one that
 * never closes anything produces a companion who keeps asking about the smoking
 * three years after it stopped.
 *
 * Run with `node test/agenda.mjs`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, ensureSchema, relationshipRevision } from '../lib/db.js';
import {
  recordEpisode,
  ensureRelationship,
  addOpenLoop,
  closeOpenLoop,
  openLoops,
  addFact,
  setLoopDue,
} from '../lib/store.js';
import {
  detectLoop,
  detectResolution,
  loopResolvedBy,
  renderAgenda,
  expireClarifications,
  LOOP_SILENCE_MS,
} from '../lib/agenda.js';

const dir = mkdtempSync(join(tmpdir(), 'hippo-agenda-'));
const path = join(dir, 'memory.db');
const db = await openDatabase(path);
ensureSchema(db);
ensureRelationship(db, 'user');

let failures = 0;
let checks = 0;
function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}: ${error.message}`);
  }
}

console.log('detection');
check('smoking is a loop', () => {
  const loop = detectLoop('我最近在戒烟，已经两周了。');
  assert.notEqual(loop, null);
  assert.equal(loop.text.includes('戒烟'), true);
});

check('a deadline is a loop', () => {
  const loop = detectLoop('下周要交稿了，还有点没画完。');
  assert.notEqual(loop, null);
});

check('a deadline without an obligation word is still a deadline', () => {
  // 「我下周交稿」 carries no 要/得 — which is exactly how it reads when the date
  // is already settled. The 要/得 requirement used to drop it, and a dropped
  // deadline is invisible: nothing fails, the agenda is just shorter.
  assert.notEqual(detectLoop('我下周交稿，还差三张。'), null);
});

check('short statements are read, not skipped for being short', () => {
  // The length floor exists to keep two-character replies out of the patterns,
  // not to filter real ones. 「月底搬家」 is four characters and a plan.
  assert.notEqual(detectLoop('月底搬家'), null);
});

check('a date followed by a remark is not a plan', () => {
  assert.equal(detectLoop('下周天气不错，出去走走。'), null);
});

check('a feeling is a loop, but raised later than a task', () => {
  const loop = detectLoop('这两天有点慌，睡不着。');
  assert.notEqual(loop, null);
  // A mood raised in the same conversation is an interrogation; the point of
  // asking is that the person has had time to move on from it.
  assert.ok(loop.followAfter >= LOOP_SILENCE_MS, 'mood loops should not come back immediately');
});

check('a question is not a loop', () => {
  assert.equal(detectLoop('你最近怎么样？'), null);
});

check('small talk is not a loop', () => {
  assert.equal(detectLoop('嗯嗯'), null);
});

check('chit chat about weather is not a loop', () => {
  assert.equal(detectLoop('今天天气不错，出去走了走。'), null);
});

console.log('resolution');
check('explicit resolution is detected', () => {
  assert.equal(detectResolution('我终于戒掉了，三个月了。'), true);
});

check('a resolution closes the matching loop', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '我终于戒掉了。'), true);
});

check('a relapse does not close it', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '我没戒掉，又抽上了。'), false);
});

check('an unrelated resolution does not close it', () => {
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '稿子终于交了。'), false);
});

// The adverb is not what makes a completion: people say "我今天把稿子交了",
// and an earlier version required "已经/终于" and so never closed the loop.
check('a completion phrased without an adverb still closes its loop', () => {
  assert.equal(loopResolvedBy('明天就要交稿了。', '我今天把稿子交了，出版社说下周给反馈。'), true);
});

check('a topic-bearing verb closes it without the subject being repeated', () => {
  assert.equal(loopResolvedBy('我下周三要去医院复查，有点紧张。', '复查完了，没什么事。'), true);
});

// "好了" is the generic half of this list and attaches to anything. The loop
// supplies "医院", the message supplies "买好了", and the two were joined into
// a resolution of a hospital appointment that had not happened yet.
check('a generic verb cannot borrow its subject from the loop', () => {
  assert.equal(loopResolvedBy('我下周三要去医院复查，有点紧张。', '婚礼的礼物买好了。'), false);
  assert.equal(loopResolvedBy('我最近在戒烟，已经两周了。', '晚饭好了。'), false);
});

// English is not selected by config: the render language and the language the
// person types in are independent, so both pattern sets are always live. An
// earlier version had the whole detection half in Chinese only, which left an
// English deployment with a rendering path that read a table nothing ever wrote.
console.log('english');
check('english loops are opened', () => {
  assert.equal(detectLoop("I'm trying to quit smoking, two weeks now.")?.why, '正在进行的事');
  assert.equal(detectLoop('I have to hand in the draft next week.')?.why, '有期限的事');
  assert.equal(detectLoop('My mom is in the hospital again.')?.why, '对方身边的事');
  assert.equal(detectLoop("I haven't decided whether to go back for Christmas.")?.why, '还没定的事');
  assert.equal(detectLoop("Let's wait and see how it goes.")?.why, '悬着的事');
});

check('english small talk is still not a loop', () => {
  assert.equal(detectLoop('I had a nice walk today, the weather was lovely.'), null);
  assert.equal(detectLoop('How are you doing?'), null);
});

check('an english deadline knows its weekdays', () => {
  // The date vocabulary has to be the same on both sides of the verb, because
  // English puts the deadline on either one. Listing `next week` and
  // `next month` but not `next Wednesday` opened nothing for a sentence with a
  // deadline, an obligation and a date in it — and nothing failed, because
  // "no loop" is the absence of a row, not an error.
  assert.equal(detectLoop('I have to hand the illustrations in next Wednesday.')?.why, '有期限的事');
  assert.equal(detectLoop('Next Wednesday I have to hand them in.')?.why, '有期限的事');
  assert.equal(detectLoop('I have a deadline next Wednesday.')?.why, '有期限的事');
});

check('a scary film is not a feeling about the person', () => {
  // The mood pattern is the loosest of the set. It takes the intensifier, so
  // "I'm really nervous" is caught and "the film was really scary" is not —
  // which only works as long as the adjective list stays a list of feelings
  // someone has, not a list of things something can be.
  assert.equal(detectLoop('The film was really scary.'), null);
});

check('an english resolution closes the loop it is about', () => {
  assert.equal(loopResolvedBy('I am trying to quit smoking.', 'I finally quit.'), true);
  assert.equal(loopResolvedBy('I have to hand in the draft next week.', 'I handed it in this morning.'), true);
  assert.equal(loopResolvedBy('My mom is in the hospital.', 'She is out of hospital now.'), true);
});

check('an english relapse does not close it', () => {
  assert.equal(loopResolvedBy('I am trying to quit smoking.', "I didn't quit, I started again."), false);
});

check('an unrelated english completion does not close it', () => {
  assert.equal(loopResolvedBy('I have to hand in the draft next week.', 'I handed the wedding gift over.'), false);
  assert.equal(loopResolvedBy('I have to hand in the draft next week.', 'The gift is ready.'), false);
});

check('a quote from an english message is a sentence, not a paragraph', () => {
  const loop = detectLoop("Anyway, I'm trying to quit smoking, it's been two weeks. Other stuff happened too.");
  assert.equal(loop?.text, "I'm trying to quit smoking, it's been two weeks.");
});

console.log('rendering');
check('empty agenda renders nothing', () => {
  assert.equal(renderAgenda(db, { now: Date.now() }), '');
});

const loopId = addOpenLoop(db, {
  userId: 'user',
  text: '我最近在戒烟，已经两周了。',
  followAfter: Date.now() - 1000,
});

check('a due loop appears', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(text.includes('戒烟'), 'expected the smoking loop');
  assert.ok(text.includes('问问'), 'expected an invitation to ask, not an order');
});

check('a loop that is not due yet stays hidden', () => {
  const fresh = addOpenLoop(db, {
    userId: 'user',
    text: '等忙完这阵再想换工作的事。',
    followAfter: Date.now() + 60 * 60 * 1000,
  });
  const text = renderAgenda(db, { now: Date.now() });
  assert.equal(text.includes('换工作'), false);
  closeOpenLoop(db, fresh, 'test');
});

check('a closed loop disappears', () => {
  closeOpenLoop(db, loopId, 'test');
  assert.equal(renderAgenda(db, { now: Date.now() }).includes('戒烟'), false);
});

console.log('clarification surfacing');
const older = addFact(db, {
  subject: 'user',
  predicate: 'lives_in',
  object: '上海',
  confidence: 0.7,
  source: 'extracted',
});
const newer = addFact(db, {
  subject: 'user',
  predicate: 'lives_in',
  object: '北京',
  confidence: 0.7,
  source: 'extracted',
});
db.prepare('UPDATE facts SET needs_clarification = 1 WHERE id = ?').run(newer);

check('a pending contradiction is raised as a question', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(text.includes('北京'), 'expected the newer value');
  assert.ok(text.includes('上海'), 'expected the older value');
  assert.ok(text.includes('还没确认'), 'expected it phrased as unresolved');
});

check('stale contradictions expire instead of asking forever', () => {
  db.prepare('UPDATE facts SET created_at = ? WHERE id = ?').run(Date.now() - 30 * 86_400_000, newer);
  const expired = expireClarifications(db, Date.now());
  assert.equal(expired, 1);
  const after = renderAgenda(db, { now: Date.now() });
  assert.equal(after.includes('北京'), false);
});

check('the newer value survives expiry', () => {
  const row = db.prepare('SELECT needs_clarification, invalid_at FROM facts WHERE id = ?').get(newer);
  assert.equal(Number(row.needs_clarification), 0);
  assert.equal(row.invalid_at, null);
});

// ---- a loop that named a date ------------------------------------------

// The words in a loop are quotable but they expire: a date phrase like "下周三"
// is false a week later. The stored instant is what still resolves, so the agenda
// restates it rather than repeating the phrase back.
const DAY = 24 * 60 * 60 * 1000;
addOpenLoop(db, {
  userId: 'user',
  text: '要去医院复查，有点紧张',
  followAfter: Date.now() - 1000,
  dueAt: Date.now() + 2 * DAY,
  duePhrase: '下周三',
});
addOpenLoop(db, {
  userId: 'user',
  text: '最近在戒烟',
  followAfter: Date.now() - 1000,
});

check('a dated loop restates the date instead of the stale phrase', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(text.includes('要去医院复查'), 'expected the loop');
  assert.ok(text.includes('指的是'), 'expected the resolved date to be restated');
});

check('a loop that still names its own day is not padded', () => {
  // "明天交稿（指的是明天）" says the same thing twice. The parenthetical has to be
  // reserved for loops whose words no longer resolve, or the model learns to skim
  // all of them.
  addOpenLoop(db, {
    userId: 'user',
    text: '明天要交稿了',
    followAfter: Date.now() - 1000,
    dueAt: Date.now() + DAY,
    duePhrase: '明天',
  });
  const text = renderAgenda(db, { now: Date.now() });
  const line = text.split('\n').find((row) => row.includes('明天要交稿了')) ?? '';
  assert.ok(line !== '', 'expected the loop');
  assert.equal(line.includes('指的是'), false, 'no restated date on a self-explanatory line');
});

check('an undated loop keeps the plain form', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.ok(/最近在戒烟（[^）]*说过/.test(text), `expected the plain form, got: ${text}`);
});

check('a loop stored before dates were parsed still renders', () => {
  // `due_at` is null on every row written before schema 12. Those must not lose
  // their line, or upgrading the plugin would silently empty the agenda.
  const row = db.prepare('SELECT id FROM open_loops WHERE text = ?').get('最近在戒烟');
  const stored = db.prepare('SELECT due_at FROM open_loops WHERE id = ?').get(String(row.id));
  assert.equal(stored.due_at, null);
  assert.ok(renderAgenda(db, { now: Date.now() }).includes('最近在戒烟'));
});

check('agenda text never contains a bare mustache', () => {
  const text = renderAgenda(db, { now: Date.now() });
  assert.equal(text.includes('{{'), false);
});

console.log('filling a date into a loop that already existed');
check('an undated loop can acquire a date later', () => {
  // Loops are deduplicated by surface overlap, so the second mention of a worry
  // keeps the first row. Rows written before dates were parsed have no instant,
  // and dropping the duplicate used to discard the only copy that resolved.
  const id = addOpenLoop(db, { userId: 'user', text: '下个月要搬去杭州', followAfter: Date.now() + 1000 });
  const changed = setLoopDue(db, id, { dueAt: Date.now() + 20 * DAY, duePhrase: '下个月', followAfter: Date.now() + 20 * DAY });
  assert.equal(changed, true);
  const row = db.prepare('SELECT due_at, due_phrase FROM open_loops WHERE id = ?').get(id);
  assert.notEqual(row.due_at, null);
  assert.equal(row.due_phrase, '下个月');
});

check('a resolved date is never moved by a later mention', () => {
  // "下个月搬去杭州" said twice is one move. Re-resolving the second mention would
  // push the date forward every time the person brought it up.
  const row = db.prepare("SELECT id, due_at FROM open_loops WHERE text = '下个月要搬去杭州'").get();
  const changed = setLoopDue(db, String(row.id), { dueAt: Date.now(), duePhrase: '今天', followAfter: Date.now() });
  assert.equal(changed, false);
  const after = db.prepare('SELECT due_at FROM open_loops WHERE id = ?').get(String(row.id));
  assert.equal(after.due_at, row.due_at);
});

db.close();
rmSync(dir, { recursive: true, force: true });

if (failures === 0) {
  console.log('\nall checks passed');
} else {
  console.log(`\n${failures} of ${checks} check(s) failed`);
  process.exitCode = 1;
}
