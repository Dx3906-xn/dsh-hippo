/**
 * Dates have to survive being stored.
 *
 * The failure this test file exists for is subtle: "下周三要去复查" is a perfectly
 * good sentence to keep, and it is also a sentence that stops being true. Every
 * assertion below is about the difference between storing what was said and
 * storing what it meant.
 *
 * Fixed reference point: Monday 2026-10-19, 10:00 local. A fixed `now` is not
 * laziness — a week boundary test that runs on a real clock passes six days out
 * of seven and fails on the seventh, which is the worst kind of test.
 */

import assert from 'node:assert/strict';
import { parseRelativeDate, describeDate, followUpAfter } from '../lib/when.js';

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/** Monday 2026-10-19 at 10:00, local time. */
const MONDAY = new Date(2026, 9, 19, 10, 0, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

/** Local midnight of the day `at` falls on. */
function midnight(at) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Days from `MONDAY` to `at`, in whole local days. */
function daysFromMonday(at) {
  return Math.round((midnight(at) - midnight(MONDAY)) / DAY);
}

// ---- named days ---------------------------------------------------------

check('明天 is one day out', () => {
  const when = parseRelativeDate('明天要去复查', MONDAY);
  assert.notEqual(when, null);
  assert.equal(daysFromMonday(when.at), 1);
});

check('后天 is two days out', () => {
  assert.equal(daysFromMonday(parseRelativeDate('后天交稿', MONDAY).at), 2);
});

check('大后天 is three days out', () => {
  // 大后天 has to be tested before 后天, or the shorter pattern wins and every
  // "the day after the day after tomorrow" becomes one day too early.
  assert.equal(daysFromMonday(parseRelativeDate('大后天出发', MONDAY).at), 3);
});

check('今天 is today', () => {
  assert.equal(daysFromMonday(parseRelativeDate('今天下午开会', MONDAY).at), 0);
});

// ---- weekdays -----------------------------------------------------------

check('下周三 from Monday is nine days out, not two', () => {
  // The subtle one. "下周三" names a day in *next week*, so the whole week
  // shifts: from Monday it is Wednesday of the following week. Treating the
  // qualifier as "+3 days" puts the appointment in the current week, which is
  // exactly the bug this assertion is here to prevent.
  const when = parseRelativeDate('我下周三要去医院复查', MONDAY);
  assert.notEqual(when, null);
  assert.equal(daysFromMonday(when.at), 9);
});

check('下周三 from Sunday is still next week', () => {
  // Sunday 2026-10-25 is six days after the reference Monday. "下周" starts the
  // next day, so 下周三 is 2026-10-28 — nine days from the reference, not the
  // three a "+3 days" reading would give.
  const sunday = new Date(2026, 9, 25, 10, 0, 0, 0).getTime();
  const when = parseRelativeDate('下周三复查', sunday);
  assert.equal(daysFromMonday(when.at), 9);
});

check('下下周一 is a fortnight on', () => {
  assert.equal(daysFromMonday(parseRelativeDate('下下周一再说', MONDAY).at), 14);
});

check('这周五 is this week', () => {
  assert.equal(daysFromMonday(parseRelativeDate('这周五有面试', MONDAY).at), 4);
});

check('a bare 周四 that already passed means next week', () => {
  // Friday 2026-10-23 is four days after the reference Monday. A bare "周四"
  // there is the coming Thursday — ten days from the reference — not the one
  // that was yesterday.
  const friday = new Date(2026, 9, 23, 10, 0, 0, 0).getTime();
  const when = parseRelativeDate('周四交', friday);
  assert.equal(daysFromMonday(when.at), 10);
});

// ---- clock times --------------------------------------------------------

check('a clock time lands on that day', () => {
  const when = parseRelativeDate('明天下午三点复查', MONDAY);
  const date = new Date(when.at);
  assert.equal(date.getDate(), 20);
  assert.equal(date.getHours(), 15);
});

check('下午 one o\'clock is thirteen hundred', () => {
  const when = parseRelativeDate('明天下午1点', MONDAY);
  assert.equal(new Date(when.at).getHours(), 13);
});

check('a date with no clock time resolves to the end of that day', () => {
  // Asking about a Wednesday appointment at 00:00 Wednesday gets "not yet".
  const when = parseRelativeDate('明天去复查', MONDAY);
  assert.equal(new Date(when.at).getHours(), 23);
});

// ---- coarse buckets -----------------------------------------------------

check('月底 is the end of this month', () => {
  const when = parseRelativeDate('月底之前交', MONDAY);
  const date = new Date(when.at);
  assert.equal(date.getMonth(), 9);
  assert.equal(date.getDate(), 31);
});

check('年底 is the last day of the year', () => {
  const date = new Date(parseRelativeDate('年底前有结果', MONDAY).at);
  assert.equal(date.getMonth(), 11);
  assert.equal(date.getDate(), 31);
});

check('过几天 is a few days out', () => {
  const when = parseRelativeDate('过几天再说', MONDAY);
  assert.equal(daysFromMonday(when.at), 3);
});

check('a calendar date already past rolls to next year', () => {
  // Spoken in October about "1月5日", the person means January of next year.
  const when = parseRelativeDate('1月5日要去一趟', MONDAY);
  assert.equal(new Date(when.at).getFullYear(), 2027);
});

// ---- refusal ------------------------------------------------------------

check('a sentence with no date returns null', () => {
  assert.equal(parseRelativeDate('我最近在戒烟，已经两周了', MONDAY), null);
});

check('a duration is not a date', () => {
  // "两周了" is how long something has been true. Resolving it to a date would
  // put a follow-up two weeks in the past.
  assert.equal(parseRelativeDate('已经两周了', MONDAY), null);
});

check('empty text returns null', () => {
  assert.equal(parseRelativeDate('', MONDAY), null);
});

// ---- describing a stored date -------------------------------------------

check('a stored date is described relative to today', () => {
  assert.equal(describeDate(MONDAY, MONDAY, 'zh'), '今天');
  assert.equal(describeDate(MONDAY + DAY, MONDAY, 'zh'), '明天');
  assert.equal(describeDate(MONDAY - DAY, MONDAY, 'zh'), '昨天');
});

check('a stored date a month out keeps its month and day', () => {
  const later = new Date(2026, 10, 21, 12, 0, 0, 0).getTime();
  assert.equal(describeDate(later, MONDAY, 'zh'), '11 月 21 日');
});

check('a stored date in another year spells the year out', () => {
  const later = new Date(2027, 0, 5, 12, 0, 0, 0).getTime();
  assert.equal(describeDate(later, MONDAY, 'zh'), '2027 年 1 月 5 日');
});

// ---- follow-up timing ---------------------------------------------------

check('a future event is followed up after it, not in six hours', () => {
  // This is the actual defect: "下周三复查" stored with a six-hour delay asks
  // that same evening.
  const event = MONDAY + 9 * DAY;
  const floor = 6 * 60 * 60 * 1000;
  const delay = followUpAfter(event, MONDAY, floor);
  assert.ok(delay > 9 * DAY, `expected more than nine days, got ${delay}`);
});

check('an event already past is followed up at the floor', () => {
  // "昨天做了手术" should be askable soon, not in a day and a half.
  const event = MONDAY - DAY;
  const floor = 6 * 60 * 60 * 1000;
  assert.equal(followUpAfter(event, MONDAY, floor), floor);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
