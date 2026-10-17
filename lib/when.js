/**
 * Turning what a person said into a date.
 *
 * Everything else in this plugin stores time as an absolute instant and is right
 * to do so. Speech is not like that. "下周三要去复查" is true for exactly one week,
 * and then the same sentence means a different day or no day at all — so a store
 * that keeps the words and re-reads them later is keeping something that quietly
 * turns false.
 *
 * The fix is not to normalise the words away on the way in: a companion that says
 * "10 月 21 日复查" when the person said "下周三复查" sounds like a calendar. The
 * fix is to resolve the phrase *once*, next to the sentence, and keep both. The
 * sentence stays quotable; the resolved instant stays correct.
 *
 * This parser is deliberately small. It knows the shapes people use when they
 * are telling you about their week, and it returns `null` for everything else
 * rather than guessing — a wrong deadline is worse than no deadline, because the
 * agent would then ask about the surgery on the wrong day and sound like it had
 * not listened.
 *
 * @module dsh-hippo/when
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Weekday characters, Monday-first, the way Chinese counts them. */
const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/**
 * Midnight of the day containing `at`, in local time.
 * @param {number} at - epoch milliseconds.
 * @returns {number} epoch milliseconds at local midnight.
 */
function startOfDay(at) {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * ISO weekday of a local date, Monday = 1 … Sunday = 7.
 * @param {number} at - epoch milliseconds.
 * @returns {number} weekday number.
 */
function isoWeekday(at) {
  const day = new Date(at).getDay();
  return day === 0 ? 7 : day;
}

/**
 * Resolve a relative date phrase to an instant.
 *
 * Returns the *day* the phrase names, at local midnight, plus the phrase it read
 * so a caller can quote it back. `timeOfDay` is honoured when the text carries a
 * clock time ("下周三下午三点"), because "after the appointment" is a different
 * moment from "on that day".
 *
 * @param {string} text - the sentence to read.
 * @param {number} [now] - epoch milliseconds treated as "today".
 * @returns {{ at: number, phrase: string, kind: string } | null} the resolved day.
 */
export function parseRelativeDate(text, now = Date.now()) {
  const source = String(text ?? '');
  if (source.length === 0) return null;

  const clock = parseClock(source);
  const base = startOfDay(now);
  const today = isoWeekday(base);

  // ---- explicit calendar dates: 10月21日 / 10-21 / 21号 --------------------
  const calendar = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(source);
  if (calendar !== null) {
    const month = Number(calendar[1]);
    const day = Number(calendar[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = new Date(base).getFullYear();
      let at = new Date(year, month - 1, day).getTime();
      // A date already behind us is next year's: people talk about the future.
      if (at < base - DAY_MS) at = new Date(year + 1, month - 1, day).getTime();
      return { at: withClock(at, clock), phrase: calendar[0], kind: 'calendar' };
    }
  }

  // ---- named days --------------------------------------------------------
  const named = [
    { re: /大后天/, offset: 3, kind: 'day' },
    { re: /后天/, offset: 2, kind: 'day' },
    { re: /明天|明日/, offset: 1, kind: 'day' },
    { re: /今天|今日|今晚/, offset: 0, kind: 'day' },
    { re: /昨天|昨日/, offset: -1, kind: 'day' },
  ];
  for (const entry of named) {
    const match = entry.re.exec(source);
    if (match === null) continue;
    return {
      at: withClock(base + entry.offset * DAY_MS, clock),
      phrase: match[0],
      kind: entry.kind,
    };
  }

  // ---- weekdays: 下周三 / 下下周一 / 这周五 / 周三 ------------------------
  const weekday = /(下下|下个?|这个?|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(source);
  if (weekday !== null) {
    const qualifier = weekday[1] ?? '';
    const target = WEEKDAYS[weekday[2]];
    let offset = target - today;
    if (qualifier.startsWith('下下')) {
      offset += 14;
    } else if (qualifier.startsWith('下')) {
      // "下周三" said on Monday is nine days out, not two: the whole week shifts.
      offset += 7;
    } else if (qualifier === '' && offset < 0) {
      // A bare "周三" that already passed means the coming one.
      offset += 7;
    }
    return { at: withClock(base + offset * DAY_MS, clock), phrase: weekday[0], kind: 'weekday' };
  }

  // ---- coarse buckets ----------------------------------------------------
  const month = /下个?月/.exec(source);
  if (month !== null) {
    const date = new Date(base);
    date.setMonth(date.getMonth() + 1, 1);
    return { at: date.getTime(), phrase: month[0], kind: 'month' };
  }
  const monthEnd = /月底/.exec(source);
  if (monthEnd !== null) {
    const date = new Date(base);
    date.setMonth(date.getMonth() + 1, 0);
    return { at: date.getTime(), phrase: monthEnd[0], kind: 'month-end' };
  }
  const yearEnd = /年底|年前/.exec(source);
  if (yearEnd !== null) {
    const date = new Date(base);
    return { at: new Date(date.getFullYear(), 11, 31).getTime(), phrase: yearEnd[0], kind: 'year-end' };
  }

  // ---- spans: 这几天 / 过几天 / 过两天 ------------------------------------
  const fewDays = /过几天|过两天|这几天|这两天|最近几天/.exec(source);
  if (fewDays !== null) {
    const days = /两/.test(fewDays[0]) ? 2 : 3;
    return { at: base + days * DAY_MS, phrase: fewDays[0], kind: 'span' };
  }

  return null;
}

/**
 * Read a clock time out of a sentence, if there is one.
 * @param {string} source - the sentence.
 * @returns {number | null} milliseconds after local midnight.
 */
function parseClock(source) {
  const meridiem = /(上午|早上|中午|下午|傍晚|晚上|夜里|凌晨)/.exec(source);
  const digits = /(\d{1,2})\s*[点:：]\s*(半|\d{1,2})?/.exec(source);
  if (digits === null) {
    if (meridiem === null) return null;
    const guesses = { 凌晨: 5, 早上: 8, 上午: 10, 中午: 12, 下午: 15, 傍晚: 18, 晚上: 20, 夜里: 22 };
    const hour = guesses[meridiem[1]];
    return hour === undefined ? null : hour * 3_600_000;
  }
  let hour = Number(digits[1]);
  if (Number.isNaN(hour) || hour > 24) return null;
  const minutes = digits[2] === '半' ? 30 : Number(digits[2] ?? 0);
  if (!Number.isNaN(minutes) && meridiem !== null) {
    const phase = meridiem[1];
    if ((phase === '下午' || phase === '傍晚' || phase === '晚上' || phase === '夜里') && hour < 12) {
      hour += 12;
    }
    if (phase === '中午' && hour < 11) hour += 12;
  }
  return hour * 3_600_000 + (Number.isNaN(minutes) ? 0 : minutes * 60_000);
}

/**
 * Stamp a clock time onto a day.
 * @param {number} day - local midnight of the day.
 * @param {number | null} clock - milliseconds after midnight, or null.
 * @returns {number} the instant.
 */
function withClock(day, clock) {
  // No clock time means "sometime that day", and the useful moment to follow up
  // is the end of it: asking about a Wednesday appointment at 00:00 Wednesday
  // gets an answer of "not yet".
  return clock === null ? day + DAY_MS - 1 : day + clock;
}

/**
 * Whether a sentence already names the day it is about.
 *
 * Used to decide whether restating a stored date adds anything. "明天我得去见
 * 一个客户（指的是明天）" is the same phrase twice, and a block that repeats itself
 * teaches the model that the parenthetical is noise — after which the one that
 * *does* carry information gets ignored with it.
 *
 * @param {string} sentence - the loop text as stored.
 * @returns {boolean} true when the sentence resolves to a date on its own.
 */
export function namesItsOwnDay(sentence) {
  const source = String(sentence ?? '');
  return /(大后天|后天|明天|明日|今天|今日|今晚|昨天|昨日|月底|年底|年前|这周|本周|下周|下个?月|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|过几天|过两天|这几天|这两天)/.test(source);
}

/**
 * Describe an instant the way a person would say it, relative to `now`.
 *
 * Used when the agent raises a stored loop: the loop text is the person's own
 * words ("下周三"), which are no longer true, so the date has to be restated in
 * terms that still resolve.
 *
 * @param {number} at - epoch milliseconds of the event.
 * @param {number} [now] - epoch milliseconds treated as "today".
 * @param {'zh'|'en'} [language] - output language.
 * @returns {string} a phrase such as "明天" / "3 天前" / "10 月 21 日".
 */
export function describeDate(at, now = Date.now(), language = 'zh') {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (language === 'en') {
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days > 1 && days < 7) return `in ${days} days`;
    if (days < -1 && days > -7) return `${-days} days ago`;
    return new Date(at).toISOString().slice(0, 10);
  }
  if (days === 0) return '今天';
  if (days === 1) return '明天';
  if (days === 2) return '后天';
  if (days === -1) return '昨天';
  if (days === -2) return '前天';
  if (days > 2 && days < 7) return `${days} 天后`;
  if (days < -2 && days > -7) return `${-days} 天前`;
  const date = new Date(at);
  const nextYear = new Date(now).getFullYear() + 1;
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return date.getFullYear() === nextYear ? `${nextYear} 年 ${month} 月 ${day} 日` : `${month} 月 ${day} 日`;
}

/**
 * When to raise a loop that names a date.
 *
 * Not when the person said it, and not on a fixed delay: the point of storing
 * "下周三复查" is to ask on Thursday. A fixed six-hour delay asks that evening,
 * which is the one moment the answer is guaranteed to be "it hasn't happened
 * yet".
 *
 * @param {number} resolvedAt - epoch milliseconds of the event.
 * @param {number} now - epoch milliseconds now.
 * @param {number} floor - never sooner than this after the message.
 * @returns {number} delay in milliseconds.
 */
export function followUpAfter(resolvedAt, now, floor) {
  const afterEvent = resolvedAt - now + 12 * 60 * 60 * 1000;
  return Math.max(floor, afterEvent);
}
