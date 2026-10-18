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
 * English weekday names, Monday-first, with the abbreviations people actually
 * type. Matching is by word boundary and the alternation is built longest-first,
 * so "sun" cannot eat the front of "Sunday" and "sat" cannot eat "Saturday".
 */
const WEEKDAY_NAMES = {
  monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, wed: 3,
  thursday: 4, thurs: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
  sunday: 7, sun: 7,
};

/** English month names. */
const MONTH_NAMES = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

/** Longest-first alternation for the two name tables above. */
function alternation(names) {
  return Object.keys(names).sort((a, b) => b.length - a.length).join('|');
}

const ENGLISH_WEEKDAY = new RegExp(
  `\\b(?:(next|this|coming|last)\\s+)?(?:on\\s+)?(${alternation(WEEKDAY_NAMES)})\\b`,
  'i',
);

const ENGLISH_CALENDAR = new RegExp(
  `\\b(${alternation(MONTH_NAMES)})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`
  + `|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${alternation(MONTH_NAMES)})\\b`,
  'i',
);

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

  // ---- English calendar dates: October 21 / Oct 21st / 21 October --------
  //
  // Month names only. "10/21" is deliberately not read: it means October 21st to
  // an American and the 10th of undecimber to most of the rest of the world, and
  // a wrong deadline is worse than none — the agent would ask about the surgery
  // on a day that was never mentioned and sound like it had not listened.
  const englishCalendar = ENGLISH_CALENDAR.exec(source);
  if (englishCalendar !== null) {
    const monthName = englishCalendar[1] ?? englishCalendar[4];
    const dayNumber = englishCalendar[2] ?? englishCalendar[3];
    const month = MONTH_NAMES[String(monthName).toLowerCase()];
    const day = Number(dayNumber);
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = new Date(base).getFullYear();
      let at = new Date(year, month - 1, day).getTime();
      if (at < base - DAY_MS) at = new Date(year + 1, month - 1, day).getTime();
      return { at: withClock(at, clock), phrase: englishCalendar[0], kind: 'calendar' };
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

  // ---- English named days -------------------------------------------------
  // Longest first for the same reason as the weekday table: "the day after
  // tomorrow" contains "tomorrow", and reading the inner one gives a date one
  // day early — the kind of error that produces a follow-up on the wrong
  // morning and no way to notice.
  const englishNamed = [
    { re: /\bthe day after tomorrow\b/i, offset: 2, kind: 'day' },
    { re: /\bthe day before yesterday\b/i, offset: -2, kind: 'day' },
    { re: /\btomorrow\b/i, offset: 1, kind: 'day' },
    { re: /\b(?:today|tonight)\b/i, offset: 0, kind: 'day' },
    { re: /\b(?:yesterday|last night)\b/i, offset: -1, kind: 'day' },
  ];
  for (const entry of englishNamed) {
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

  // ---- English weekdays: next Tuesday / this Friday / on Monday -----------
  //
  // "next Tuesday" gets the same +7 the Chinese 下 adds, and for the same
  // reason: it names a day in the following week, not the next one to arrive.
  // "last Tuesday" steps back instead, and a bare or "this" weekday means the
  // coming one — rolling forward only when it has already passed today.
  const englishWeekday = ENGLISH_WEEKDAY.exec(source);
  if (englishWeekday !== null) {
    const qualifier = (englishWeekday[1] ?? '').toLowerCase();
    const target = WEEKDAY_NAMES[englishWeekday[2].toLowerCase()];
    let offset = target - today;
    if (qualifier === 'next') offset += 7;
    else if (qualifier === 'last') offset -= 7;
    else if (offset < 0) offset += 7;
    return { at: withClock(base + offset * DAY_MS, clock), phrase: englishWeekday[0], kind: 'weekday' };
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

  // ---- English buckets and spans -----------------------------------------
  const nextWeek = /\bnext week\b/i.exec(source);
  if (nextWeek !== null) {
    // Monday of next week, which from a Sunday is tomorrow, not eight days out.
    return { at: base + (8 - today) * DAY_MS, phrase: nextWeek[0], kind: 'week' };
  }
  const weekend = /\bthis weekend\b/i.exec(source);
  if (weekend !== null) {
    return { at: base + Math.max(0, 6 - today) * DAY_MS, phrase: weekend[0], kind: 'weekend' };
  }
  const nextMonth = /\bnext month\b/i.exec(source);
  if (nextMonth !== null) {
    const date = new Date(base);
    date.setMonth(date.getMonth() + 1, 1);
    return { at: date.getTime(), phrase: nextMonth[0], kind: 'month' };
  }
  const englishMonthEnd = /\b(?:at |by |before )?the end of the month\b/i.exec(source);
  if (englishMonthEnd !== null) {
    const date = new Date(base);
    date.setMonth(date.getMonth() + 1, 0);
    return { at: date.getTime(), phrase: englishMonthEnd[0], kind: 'month-end' };
  }
  const englishYearEnd = /\b(?:at |by |before )?the end of the year\b/i.exec(source);
  if (englishYearEnd !== null) {
    return { at: new Date(new Date(base).getFullYear(), 11, 31).getTime(), phrase: englishYearEnd[0], kind: 'year-end' };
  }
  // A span with "for" in front of it is how long something has been true, not a
  // date — the English shape of 已经两周了, refused for the same reason: resolving
  // a duration puts the follow-up in the past, where it can only fire at once.
  if (/\bfor\s+(?:a few|a couple of|couple of|several|two|three|\d{1,2})\s+(?:days?|weeks?|months?|years?)\b/i.test(source)) {
    return null;
  }

  // "three days ago" is a date, and a past one. Reading it as "+3 days" would
  // have the agent ask about an operation that already happened in three days'
  // time; storing it as a past instant lets the floor schedule the check-in.
  const englishAgo = /\b(\d{1,2}|a few|a couple of|couple of|several|two|three)\s+(days?|weeks?|months?)\s+ago\b/i.exec(source);
  if (englishAgo !== null) {
    const counts = { 'a few': 3, 'a couple of': 2, 'couple of': 2, several: 3, two: 2, three: 3 };
    const count = counts[String(englishAgo[1]).toLowerCase()] ?? Number(englishAgo[1]);
    const unit = englishAgo[2].toLowerCase();
    const days = unit.startsWith('week') ? 7 : unit.startsWith('month') ? 30 : 1;
    if (Number.isFinite(count) && count >= 1) {
      return { at: base - count * days * DAY_MS, phrase: englishAgo[0], kind: 'span' };
    }
  }

  // "in a few days" and "in a couple of days" are the same shape as 过几天, and
  // so is the bare span without a preposition ("a few days from now").
  const englishSpan = /\b(?:in\s+)?(a few|couple of|a couple|several|two|three)\s+(days?|weeks?)\b|\bfortnight\b/i.exec(source);
  if (englishSpan !== null) {
    if (/fortnight/i.test(englishSpan[0])) {
      return { at: base + 14 * DAY_MS, phrase: englishSpan[0], kind: 'span' };
    }
    const count = { 'a few': 3, 'couple of': 2, 'a couple': 2, several: 3, two: 2, three: 3 }[
      String(englishSpan[1]).toLowerCase()
    ] ?? 3;
    const days = /week/i.test(String(englishSpan[2])) ? 7 : 1;
    return { at: base + count * days * DAY_MS, phrase: englishSpan[0], kind: 'span' };
  }
  const englishNumberedSpan = /\bin (\d{1,2}) (day|week|month)s?\b/i.exec(source);
  if (englishNumberedSpan !== null) {
    const count = Number(englishNumberedSpan[1]);
    if (count >= 1 && count <= 60) {
      const unit = englishNumberedSpan[2].toLowerCase();
      const days = unit === 'week' ? 7 : unit === 'month' ? 30 : 1;
      return { at: base + count * days * DAY_MS, phrase: englishNumberedSpan[0], kind: 'span' };
    }
  }

  return null;
}

/**
 * Read a clock time out of a sentence, if there is one.
 * @param {string} source - the sentence.
 * @returns {number | null} milliseconds after local midnight.
 */
function parseClock(source) {
  // English first: "3pm" carries the same information as 下午三点 and is written
  // without the colon or the 点 character the Chinese pattern keys on, so
  // reading it as a bare "3" would put every afternoon appointment at 3am.
  const english = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(source);
  if (english !== null) {
    let hour = Number(english[1]);
    const minutes = Number(english[2] ?? 0);
    if (hour >= 1 && hour <= 12 && minutes < 60) {
      const afternoon = /^p/i.test(english[3]);
      if (afternoon && hour < 12) hour += 12;
      if (!afternoon && hour === 12) hour = 0;
      return hour * 3_600_000 + minutes * 60_000;
    }
  }

  const meridiem = /(上午|早上|中午|下午|傍晚|晚上|夜里|凌晨)/.exec(source);
  const digits = /(\d{1,2})\s*[点:：]\s*(半|\d{1,2})?/.exec(source);
  if (digits === null) {
    if (meridiem === null) {
      // English day parts, which are what a person says when they are not
      // giving a clock time: "tomorrow afternoon", "tonight".
      const part = /\b(morning|afternoon|evening|tonight|noon|midday|night)\b/i.exec(source);
      if (part === null) return null;
      const guesses = { morning: 9, afternoon: 15, evening: 20, tonight: 20, noon: 12, midday: 12, night: 22 };
      const hour = guesses[part[1].toLowerCase()];
      return hour === undefined ? null : hour * 3_600_000;
    }
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
  if (/(大后天|后天|明天|明日|今天|今日|今晚|昨天|昨日|月底|年底|年前|这周|本周|下周|下个?月|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|过几天|过两天|这几天|这两天)/.test(source)) {
    return true;
  }
  // The English half has to be listed here too, or an English loop gets a
  // restatement of the day it already names — the duplication this function
  // exists to prevent.
  if (/\b(?:today|tonight|tomorrow|yesterday|last night|the day after tomorrow|the day before yesterday)\b/i.test(source)) {
    return true;
  }
  if (ENGLISH_WEEKDAY.test(source)) return true;
  if (ENGLISH_CALENDAR.test(source)) return true;
  return /\bnext (?:week|month)\b|\bthis weekend\b|\bthe end of the (?:month|year)\b|\b(?:in )?(?:a few|couple of|a couple|several|two|three|\d{1,2}) (?:days?|weeks?|months?)\b|\bfortnight\b/i.test(source);
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
