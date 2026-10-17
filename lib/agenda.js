/**
 * What the agent owes the person.
 *
 * Two kinds of unfinished business accumulate, and both are useless if they stay
 * in a table:
 *
 *   - **Open loops** — things said in passing that imply a later follow-up
 *     ("我在戒烟", "下周要交稿", "我妈住院了"). A companion that never mentions
 *     them again is not remembering, it is storing.
 *   - **Clarifications** — contradictions the extractor was not confident about.
 *     A stored contradiction that is never asked about is worse than no memory,
 *     because both values stay live and the agent will eventually state one of
 *     them with equal confidence.
 *
 * Both are surfaced the same way: as one dated question the agent may ask. The
 * agent decides whether to actually raise it — a memory system that forces a
 * question every turn is as bad as one that never asks.
 *
 * @module dsh-hippo/agenda
 */

import { estimateTokens } from './tokenize.js';

/** Budget for the whole agenda block. */
export const AGENDA_BUDGET = 400;

/** How long a loop sits before it is worth raising, in milliseconds. */
export const LOOP_SILENCE_MS = 6 * 60 * 60 * 1000;

/** A clarification older than this is stale enough to drop rather than ask. */
export const CLARIFY_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/** Phrases that introduce something the person will want followed up. */
const LOOP_PATTERNS = [
  { re: /(?:我)?(?:正在|在|已经开始)(戒烟|减肥|健身|学[\u4e00-\u9fff]{1,4}|准备[\u4e00-\u9fff]{1,6})/, why: '正在进行的事' },
  { re: /(下周|明天|后天|下个?月|月底|年底|这几天|过几天)[^。！？]{0,20}(要|得|准备|打算)/, why: '有期限的事' },
  { re: /(?:我妈|我爸|我妈|家里|朋友|对象|他|她)[^。！？]{0,10}(住院|生病|手术|去世|分手|吵架|离职|失业)/, why: '对方身边的事' },
  { re: /(?:有点|挺|特别|很|超级)(紧张|害怕|慌|焦虑|难受|低落|累|烦)/, why: '当下的情绪' },
  { re: /(?:等|等到)[^。！？]{0,12}(再说|再说吧|再看|看看)/, why: '悬着的事' },
  { re: /(?:还没|没有)(?:决定|想好|定下来|确定)/, why: '还没定的事' },
];

/**
 * Resolutions, each tied to the topic it actually resolves.
 *
 * Matching a resolution phrase on its own is not enough: "稿子终于交了" and "我终于
 * 戒掉了" share the same shape, so a shared-substring test either closes the
 * smoking when the drawing was handed in, or — the earlier bug — closes nothing
 * at all because "戒烟" and "戒掉" have only one character in common.
 *
 * Pairing each phrase with its own topic is what a person does when they hear
 * it: the verb says the thing finished, the object says what finished.
 */
const RESOLUTIONS = [
  { phrase: /(?:已经|终于)戒(?:了|掉|成)/, topic: /戒烟|戒酒|戒赌|抽烟|喝酒|烟/ },
  { phrase: /(?:已经|终于)(?:减下来|瘦下来|掉秤)/, topic: /减肥|减重|体重|瘦/ },
  { phrase: /(?:已经|终于)(?:交了|交上去|做完|画完|写完|发了)/, topic: /稿|作业|项目|论文|画|方案|报告/ },
  { phrase: /(?:已经|终于)(?:好了|出院|痊愈|恢复)/, topic: /病|手术|住院|身体|伤|感冒/ },
  { phrase: /(?:已经|终于)(?:考过|通过|拿到|上岸)/, topic: /考试|面试|证|offer|考|申请/i },
  { phrase: /(?:已经|终于)(?:解决|处理好|搞定)/, topic: /问题|麻烦|纠纷|事/ },
  { phrase: /(?:我)(?:已经)?(?:好多了|没事了|放下了|缓过来了)/, topic: /.*/ },
  // A general "we can stop worrying about that" — the loop it closes is whichever
  // one the person was talking about, so any stored loop may match.
  { phrase: /(?:不用|不需要)(?:再)?(?:担心|管|提)/, topic: /.*/ },
  { phrase: /(?:那件|这个)事(?:已经)?(?:过去|结束|完)了/, topic: /.*/ },
];

/**
 * Detect statements that open a loop worth following up.
 *
 * This is deliberately narrow. A pattern that fires on every message produces an
 * agenda that is always full, and an always-full agenda is one the model learns
 * to ignore. Each pattern here names a *specific* kind of follow-up: something
 * in progress, something with a deadline, something happening to someone close,
 * or a feeling worth asking about later.
 *
 * Loops may also be opened by the model through `memory_loop`, and those arrive
 * as instructions ("问问她戒烟进展，别催") rather than as quoted speech. Both
 * kinds coexist, which is why deduplication compares content words rather than
 * exact text.
 *
 * @param {string} text - one user message.
 * @returns {{ text: string, why: string, followAfter: number } | null} a loop, or null.
 */
export function detectLoop(text) {
  const source = String(text ?? '').trim();
  if (source.length < 6) return null;
  // Questions are not disclosures: "你最近怎么样" is not something to follow up on.
  if (/[？?]/.test(source) && !/我/.test(source)) return null;

  for (const pattern of LOOP_PATTERNS) {
    const match = pattern.re.exec(source);
    if (match === null) continue;
    return {
      // Keep the sentence the pattern fired in, not the whole message: the model
      // needs something it can raise naturally, not a paragraph.
      text: firstSentenceWith(source, match[0]),
      why: pattern.why,
      // A deadline mentioned today should be raised later the same day; a mood
      // should be raised tomorrow, not in the same conversation.
      followAfter: pattern.why === '当下的情绪' ? 18 * 60 * 60 * 1000 : LOOP_SILENCE_MS,
    };
  }
  return null;
}

/**
 * Detect that a previously open loop has been resolved.
 *
 * @param {string} text - one user message.
 * @returns {boolean} true when the message reads as a resolution of something.
 */
export function detectResolution(text) {
  const source = String(text ?? '');
  return RESOLUTIONS.some(({ phrase }) => phrase.test(source));
}

/**
 * Decide whether an open loop has been superseded by a newer message.
 *
 * Two conditions, both required:
 *
 *   1. the incoming message carries a resolution verb — see {@link RESOLUTIONS},
 *      where each verb is paired with the topic it can resolve;
 *   2. the *stored loop* is about that topic. This is the direction that matters
 *      and the one that is easy to get backwards: "我终于戒掉了" has no word in
 *      common with "我在戒烟", so nothing about the new message alone can say
 *      what it resolved. The loop is what supplies the subject.
 *
 * Negation is checked last: "我没戒掉" is a relapse, not a resolution.
 *
 * The earlier version asked for a shared substring and failed both ways —
 * "稿子终于交了。" closed the smoking loop on a shared full stop, while
 * "我终于戒掉了。" closed nothing.
 *
 * @param {string} loopText - the stored loop.
 * @param {string} newText - the incoming message.
 * @returns {boolean} true when the loop should close.
 */
export function loopResolvedBy(loopText, newText) {
  const loop = String(loopText ?? '');
  const next = String(newText ?? '');
  if (loop.length === 0 || next.length === 0) return false;

  const resolved = RESOLUTIONS.some(
    ({ phrase, topic }) => phrase.test(next) && topic.test(loop),
  );
  if (!resolved) return false;

  // A negated resolution is a relapse: "没戒掉" / "还没交" / "没通过".
  return !/(没|不|未|尚未)(?:有)?(?:戒|减|交|做|写|画|好|通过|考过|拿到|解决)/.test(next);
}

/**
 * Render the agenda block for injection into the model context.
 *
 * Questions are phrased as things the agent *could* raise, not as instructions
 * to raise them. The distinction matters: a block that says "ask about the
 * smoking" produces an interrogation every turn, while one that says "you could
 * ask how it is going" produces a companion who remembers.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   userId?: string,
 *   now?: number,
 *   language?: 'zh'|'en',
 *   maxTokens?: number,
 * }} [options] - rendering options.
 * @returns {string} the block text, or '' when nothing is pending.
 */
export function renderAgenda(db, options = {}) {
  const userId = options.userId ?? 'user';
  const now = options.now ?? Date.now();
  const language = options.language ?? 'zh';
  const maxTokens = options.maxTokens ?? AGENDA_BUDGET;

  // The due filter lives in the query rather than in the loop below.
  //
  // Both forms select the same rows — the sort key is the same expression the
  // filter uses, so a row that is due always sorts ahead of one that is not, and
  // `LIMIT 3` can never starve an overdue loop. Pushing the predicate down keeps
  // that reasoning local to one place instead of requiring the reader to verify
  // that a loop-level `continue` and a `LIMIT` commute.
  const loops = db.prepare(`
    SELECT id, text, created_at, follow_after FROM open_loops
    WHERE user_id = ? AND closed_at IS NULL
      AND COALESCE(follow_after, created_at) <= ?
    ORDER BY COALESCE(follow_after, created_at) ASC LIMIT 3
  `).all(userId, now);

  // Two ways to find the value a contradiction replaced: the explicit link that
  // consolidation writes, and — because model-written facts and older rows may
  // not carry that link — the most recent earlier row for the same attribute.
  // The fallback deliberately does not require `invalid_at`: a model can flag a
  // contradiction without retiring the old row, and asking "which is right?"
  // with only one of the two answers visible is the worst possible question.
  const clarifications = db.prepare(`
    SELECT f.id, f.subject, f.predicate, f.object, f.created_at,
           COALESCE(
             (SELECT p.object FROM facts p WHERE p.superseded_by = f.id
              ORDER BY p.invalid_at DESC LIMIT 1),
             (SELECT q.object FROM facts q
              WHERE q.subject = f.subject AND q.predicate = f.predicate
                AND q.id <> f.id AND q.created_at <= f.created_at
                AND q.object <> f.object
              ORDER BY q.created_at DESC LIMIT 1)
           ) AS previous
    FROM facts f
    WHERE f.needs_clarification = 1 AND f.invalid_at IS NULL
    ORDER BY f.created_at ASC LIMIT 2
  `).all();

  if (loops.length === 0 && clarifications.length === 0) return '';

  const lines = [];
  let used = 0;
  const push = (line) => {
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  push(language === 'zh' ? '## 你手上还记着的事' : '## What you are still holding');

  for (const loop of loops) {
    const age = agePhrase(loop.created_at, now, language);
    const line = language === 'zh'
      ? `- ${loop.text}（${age}说过，可以问问后来怎么样）`
      : `- ${loop.text} (mentioned ${age}; you could ask how it went)`;
    if (!push(line)) break;
  }

  for (const row of clarifications) {
    const age = now - Number(row.created_at);
    if (age > CLARIFY_EXPIRY_MS) continue;
    const term = describeTerm(String(row.predicate), language);
    const previous = row.previous === null || row.previous === undefined
      ? ''
      : String(row.previous);
    // A contradiction with no recorded old value still needs raising: the model
    // wrote a second answer for an attribute it already had one for, and only the
    // person can say which is true.
    const line = previous === ''
      ? (language === 'zh'
        ? `- 关于「${term}」，你记下的新说法是「${row.object}」，但之前有过别的说法，还没确认。合适的时候问一句。`
        : `- You now have "${row.object}" for ${term}, but there was an earlier answer you never confirmed. Worth asking.`)
      : (language === 'zh'
        ? `- 关于「${term}」，你先后记下了「${previous}」和「${row.object}」，还没确认哪个对。合适的时候问一句。`
        : `- You have "${previous}" and then "${row.object}" for ${term}, and never confirmed which. Worth asking.`);
    if (!push(line)) break;
  }

  return lines.length <= 1 ? '' : lines.join('\n');
}

/**
 * Expire clarification rows that have gone stale.
 *
 * A question worth asking this week is not worth asking a month later, and a row
 * that stays flagged forever keeps two contradictory values live. Expiry keeps
 * the newer value and clears the flag, which is the least-bad resolution when
 * nobody was asked.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} [now] - epoch milliseconds.
 * @returns {number} how many rows expired.
 */
export function expireClarifications(db, now = Date.now()) {
  const cutoff = now - CLARIFY_EXPIRY_MS;
  const result = db.prepare(`
    UPDATE facts SET needs_clarification = 0
    WHERE needs_clarification = 1 AND invalid_at IS NULL AND created_at < ?
  `).run(cutoff);
  return Number(result.changes ?? 0);
}

/**
 * Human-readable name for a predicate key.
 *
 * The label goes inside a sentence, so it has to be prose in the reader's
 * language: "关于「lives_in」，你先后记下了…" is a template that never got finished,
 * and a model reading it writes the same half-finished sentence back.
 *
 * @param {string} predicate - attribute key.
 * @param {'zh'|'en'} [language] - output language.
 * @returns {string} a phrase safe to put in a sentence.
 */
export function describeTerm(predicate, language = 'zh') {
  if (language === 'en') {
    const english = {
      lives_in: 'where they live',
      works_as: 'what they do',
      works_at: 'where they work',
      studies_at: 'where they study',
      relationship_status: 'their relationship status',
      has_pet: 'their pets',
      age: 'their age',
      birthday: 'their birthday',
      name: 'their name',
      nickname: 'what they want to be called',
      health: 'their health',
      habit: 'their habits',
      plan: 'their plans',
    };
    return english[predicate] ?? predicate.replace(/_/g, ' ');
  }
  const names = {
    lives_in: '住在哪里',
    works_as: '做什么工作',
    works_at: '在哪上班',
    studies_at: '在哪上学',
    relationship_status: '感情状况',
    has_pet: '养了什么',
    age: '年龄',
    birthday: '生日',
    name: '名字',
    nickname: '怎么称呼',
    health: '身体',
    habit: '习惯',
    plan: '计划',
  };
  return names[predicate] ?? predicate.replace(/_/g, ' ');
}

/**
 * One sentence of the source that contains the matched phrase.
 * @param {string} source - full message.
 * @param {string} needle - phrase that fired the pattern.
 * @returns {string} a bounded sentence.
 */
function firstSentenceWith(source, needle) {
  const at = source.indexOf(needle);
  if (at === -1) return source.slice(0, 80);
  const start = Math.max(0, source.lastIndexOf('。', at) + 1, source.lastIndexOf('，', at) + 1);
  const endings = ['。', '！', '？', ';', '\n'].map((mark) => source.indexOf(mark, at)).filter((index) => index !== -1);
  const end = endings.length === 0 ? source.length : Math.min(...endings);
  return source.slice(start, Math.max(at + needle.length, end)).trim().slice(0, 120);
}

/**
 * Coarse age phrase for an agenda line.
 * @param {number} at - epoch milliseconds.
 * @param {number} now - epoch milliseconds.
 * @param {'zh'|'en'} language - rendering language.
 * @returns {string} e.g. "三天前".
 */
function agePhrase(at, now, language) {
  const hours = Math.max(0, (now - Number(at)) / 3_600_000);
  if (language === 'en') {
    if (hours < 24) return 'earlier today';
    const days = Math.floor(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }
  if (hours < 24) return '今天';
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return `${Math.floor(days / 30)} 个月前`;
}
