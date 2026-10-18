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
import { describeDate, namesItsOwnDay } from './when.js';

/** Budget for the whole agenda block. */
export const AGENDA_BUDGET = 400;

/** How long a loop sits before it is worth raising, in milliseconds. */
export const LOOP_SILENCE_MS = 6 * 60 * 60 * 1000;

/** A clarification older than this is stale enough to drop rather than ask. */
export const CLARIFY_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;

/** Phrases that introduce something the person will want followed up.
 *
 * Both languages are matched unconditionally rather than picked by the
 * configured `language`. The configured language is what the *prompt* is
 * rendered in; it is not a claim about what the person types. Selecting the
 * pattern set from config would silently stop opening loops the moment someone
 * asks for an English UI and writes in Chinese — and the two halves cannot
 * collide, because they are disjoint alphabets.
 */
const LOOP_PATTERNS = [
  { re: /(?:我)?(?:正在|在|已经开始)(戒烟|减肥|健身|学[\u4e00-\u9fff]{1,4}|准备[\u4e00-\u9fff]{1,6})/, why: '正在进行的事' },
  { re: /(?:下周|明天|后天|下个?月|月底|年底|这几天|过几天)[^。！？]{0,20}(要|得|准备|打算)/, why: '有期限的事' },
  { re: /(?:我妈|我爸|我妈|家里|朋友|对象|他|她)[^。！？]{0,10}(住院|生病|手术|去世|分手|吵架|离职|失业)/, why: '对方身边的事' },
  { re: /(?:有点|挺|特别|很|超级)(紧张|害怕|慌|焦虑|难受|低落|累|烦)/, why: '当下的情绪' },
  { re: /(?:等|等到)[^。！？]{0,12}(再说|再说吧|再看|看看)/, why: '悬着的事' },
  { re: /(?:还没|没有)(?:决定|想好|定下来|确定)/, why: '还没定的事' },

  // --- English. A regex guard was needed where the Chinese set leans on 我:
  // the mood pattern is bare, so "I'm really nervous about the interview" is
  // caught, but so would "that film was really scary" be. Same trade the
  // Chinese side already makes.
  { re: /\bI(?:'m| am|'ve been| have been)\s+(?:trying to\s+|still\s+)?(?:quit|quitting|diet|dieting|lose weight|losing weight|work out|exercise|learn|learning|study|studying|train|training for|prepare|preparing)/i, why: '正在进行的事' },
  { re: /\b(?:next week|next month|tomorrow|the day after tomorrow|this weekend|in a few days|end of (?:the )?(?:month|year)|these days)\b[^.!?]{0,40}\b(?:have to|need to|gotta|got to|must|going to|gonna|plan to|supposed to)\b/i, why: '有期限的事' },
  // Deferred, not dropped: English puts the deadline on either side of the verb.
  { re: /\b(?:have to|need to|gotta|got to|must|supposed to)\b[^.!?]{0,40}\b(?:by|before|tomorrow|tonight|next week|next month|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i, why: '有期限的事' },
  { re: /\b(?:my (?:mom|mum|mother|dad|father|family|friend|boyfriend|girlfriend|partner|husband|wife)|he|she)\b[^.!?]{0,25}\b(?:is (?:in|at) (?:the )?hospital|is (?:sick|ill|unwell)|had surgery|passed away|died|broke up|is breaking up|got laid off|lost (?:his|her|their) job|is getting divorced)\b/i, why: '对方身边的事' },
  { re: /\b(?:a bit|a little|pretty|really|very|so|super|quite)\s+(?:nervous|scared|anxious|upset|down|depressed|stressed|exhausted|worried|overwhelmed|lonely)\b/i, why: '当下的情绪' },
  { re: /\b(?:wait and see|see how it goes|see how things go|we'll see|will see|let's see)\b/i, why: '悬着的事' },
  { re: /\b(?:haven't|have not|hasn't|has not|still haven't|not yet)\s+(?:decided|made up my mind|figured out|settled on|chosen)\b/i, why: '还没定的事' },
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
 *
 * `selfSufficient` marks the verbs that name their own object. "我终于戒掉了"
 * carries no word in common with "我在戒烟", so the stored loop is the only
 * place the subject can come from — the verb *is* the topic. "买好了" is the
 * opposite: it attaches to anything, and an earlier version let it close a
 * hospital follow-up because the loop said "复查" and the message said "好了".
 * Every non-self-sufficient verb must therefore find its topic in the incoming
 * message as well, which is what the stored loop cannot supply for it.
 */
const RESOLUTIONS = [
  { phrase: /(?:已经|终于)?戒(?:了|掉|成)/, topic: /戒烟|戒酒|戒赌|抽烟|喝酒|烟/, selfSufficient: true },
  { phrase: /(?:已经|终于)?(?:减下来|瘦下来|掉秤)/, topic: /减肥|减重|体重|瘦/, selfSufficient: true },
  // People rarely say "已经交了". They say "我今天把稿子交了" and "终于交了", and
  // the earlier version required the adverb, so the most common phrasing of a
  // completion resolved nothing and the loop it belonged to stayed open forever.
  // What keeps this from over-firing is the topic half, not the adverb: the verb
  // only says something finished, the stored loop says what.
  { phrase: /(?:已经|终于)?(?:交了|交上去|交稿了|做完|画完|写完|发了)/, topic: /稿|作业|项目|论文|画|方案|报告/ },
  { phrase: /(?:已经|终于)?(?:好了|出院|痊愈|恢复|查完了|复查完了|检查完了|看完了)/, topic: /病|手术|住院|出院|身体|伤|感冒|复查|医院|检查|体检/ },
  { phrase: /(?:已经|终于)?(?:考过|通过|拿到|上岸)/, topic: /考试|面试|证|offer|考|申请/i, selfSufficient: true },
  { phrase: /(?:已经|终于)?(?:解决|处理好|搞定)/, topic: /问题|麻烦|纠纷|事/, selfSufficient: true },
  // Decisions, not accomplishments: "我跟我妈说了，不回去了" closes the question of
  // whether they were going back, and nothing in that sentence says "finished".
  { phrase: /(?:说好了|说过了|跟[^。！？]{1,6}说了|定了|决定了|想好了|不去了|不回了|回去|回家)/, topic: /回|过年|决定|商量|商量好|想/ },
  { phrase: /(?:我)(?:已经)?(?:好多了|没事了|放下了|缓过来了)/, topic: /.*/ },
  // A general "we can stop worrying about that" — the loop it closes is whichever
  // one the person was talking about, so any stored loop may match.
  { phrase: /(?:不用|不需要)(?:再)?(?:担心|管|提)/, topic: /.*/ },
  { phrase: /(?:那件|这个)事(?:已经)?(?:过去|结束|完)了/, topic: /.*/ },

  // --- English. Same two groups: "I finally quit" names its own object and the
  // loop must supply "smoking"; "feeling better" attaches to anything and so
  // has to find a hospital word in the sentence itself.
  { phrase: /\b(?:finally\s+|already\s+)?(?:quit|gave (?:it|up)|stopped|kicked)\b/i, topic: /\b(?:smok|drink|alcohol|vap|cigarette|nicotine|sugar|caffeine)/i, selfSufficient: true },
  { phrase: /\b(?:lost|dropped)\s+(?:the\s+|some\s+)?(?:weight|pounds|kilos)\b|\bslimmed down\b/i, topic: /\b(?:diet|weight|slim|lose|losing)/i, selfSufficient: true },
  // Self-sufficient, unlike its Chinese counterpart: English replaces the object
  // with a pronoun rather than dropping it, and "handed it in" / "submitted" is
  // specific enough to be a completion on its own. "交了" is not — 我发了 can be
  // a message, a payment or a parcel — which is why the two halves disagree here.
  { phrase: /\b(?:handed (?:it|them|the \w+) in|turned (?:it|them|the \w+) in|submitted|finished (?:it|the \w+)|sent (?:it|them) (?:off|in)|done with (?:it|the \w+))\b/i, topic: /\b(?:draft|paper|essay|assignment|project|report|drawing|illustration|manuscript|deadline|piece)/i, selfSufficient: true },
  { phrase: /\b(?:all clear|results? (?:are|is|came) back|got the results|recovered|out of (?:the )?hospital|check[- ]?up(?:'s| is| was)? done|scan(?:'s| is| was)? done|feeling better|feeling much better)\b/i, topic: /\b(?:hospital|surgery|check[- ]?up|appointment|scan|results?|test|ill|sick|recovery|treatment|doctor)/i },
  { phrase: /\b(?:passed|got (?:the|my|an) (?:offer|job)|got in|accepted)\b/i, topic: /\b(?:exam|interview|test|offer|application|certification|admission)/i, selfSufficient: true },
  { phrase: /\b(?:sorted (?:it )?out|fixed it|taken care of|handled it|resolved|worked it out)\b/i, topic: /\b(?:problem|issue|trouble|dispute|matter|argument)/i, selfSufficient: true },
  { phrase: /\b(?:decided|made up my mind|told (?:my )?(?:mom|mum|mother|dad|father|them|him|her)|not going|not going back|going back|heading home|going home)\b/i, topic: /\b(?:go(?:ing)? back|home|visit|holiday|christmas|new year|decide|decided|plan)/i },
  { phrase: /\b(?:I(?:'m| am) (?:fine|ok(?:ay)?) now|doing better|over it|let it go|moved on)\b/i, topic: /.*/ },
  { phrase: /\b(?:don'?t worry about it|no need to worry|not worth worrying about|nothing to worry about)\b/i, topic: /.*/ },
  { phrase: /\b(?:it'?s over|that'?s (?:over|done) now|put it behind me)\b/i, topic: /.*/ },
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
  // The exemption is for a question that is *about the person* ("我这样正常吗"),
  // so the marker list has to carry English as well — otherwise "Am I overreacting?"
  // is dropped for lacking 我.
  if (/[？?]/.test(source) && !/(?:我|\bI\b|\bmy\b|\bme\b)/i.test(source)) return null;

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
 *      what it resolved. The loop is what supplies the subject;
 *
 *   3. unless the verb names its own object (`selfSufficient`), the topic has to
 *      appear in the *incoming message* too. Otherwise a generic "好了" rides on
 *      a subject the loop happens to mention: "婚礼的礼物买好了" was closing
 *      "我下周三要去医院复查" because "买好了" matched "好了" and the loop
 *      supplied "医院".
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
    ({ phrase, topic, selfSufficient = false }) =>
      phrase.test(next) && topic.test(loop) && (selfSufficient || topic.test(next)),
  );
  if (!resolved) return false;

  // A negated resolution is a relapse: "没戒掉" / "还没交" / "没通过" /
  // "I didn't quit". Only achievement verbs are negated here: "not going back"
  // is a decision *made*, and treating it as a relapse would leave a settled
  // question open forever.
  return !/(没|不|未|尚未)(?:有)?(?:戒|减|交|做|写|画|好|通过|考过|拿到|解决)/.test(next)
    && !/\b(?:did ?n[o']t|do ?n[o']t|have ?n[o']t|has ?n[o']t|had ?n[o']t|never)\s+(?:\w+\s+){0,2}(?:quit|stop(?:ped)?|finish(?:ed)?|hand(?:ed)?|submit(?:ted)?|pass(?:ed)?|recover(?:ed)?|sort(?:ed)?|fix(?:ed)?|lose|lost)\b/i.test(next);
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
    SELECT id, text, created_at, follow_after, due_at, due_phrase FROM open_loops
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
    // A loop that named a date gets that date restated. The person's own words
    // ("下周三") stopped being true after a week, so an agent that repeats them
    // back is quoting something it can no longer resolve — and a loop stored
    // before dates were parsed has nothing to restate, which is why this is
    // conditional rather than assumed.
    //
    // A sentence that still explains itself is left alone: "明天要交稿（指的是
    // 明天）" is the same phrase twice, and the model learns to skim parentheticals
    // that repeat themselves, including the ones that do not.
    const due = loop.due_at === null || loop.due_at === undefined || namesItsOwnDay(loop.text)
      ? ''
      : describeDate(Number(loop.due_at), now, language);
    const line = language === 'zh'
      ? (due === ''
        ? `- ${loop.text}（${age}说过，可以问问后来怎么样）`
        : `- ${loop.text}（${age}说的，指的是${due}；可以问问后来怎么样）`)
      : (due === ''
        ? `- ${loop.text} (mentioned ${age}; you could ask how it went)`
        : `- ${loop.text} (mentioned ${age}, about ${due}; you could ask how it went)`);
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
 *
 * The boundaries have to be both languages' — only the full-width period and
 * comma were listed at first, so an English message yielded everything from the
 * start of the paragraph up to the first semicolon, and the line the agent read
 * back was a paragraph rather than a sentence.
 *
 * @param {string} source - full message.
 * @param {string} needle - phrase that fired the pattern.
 * @returns {string} a bounded sentence.
 */
function firstSentenceWith(source, needle) {
  const at = source.indexOf(needle);
  if (at === -1) return source.slice(0, 80);

  // A comma only ends a clause, but keeping it in the "start" scan is what makes
  // "I'm trying to quit smoking, it's hard" quote the second half rather than
  // the whole message. English needs the trailing space, or the comma inside
  // "1,000" would cut a sentence in half.
  const BREAK = /[。！？，；\n]|[.!?;]\s|,\s/g;
  let start = 0;
  for (const match of source.slice(0, at).matchAll(BREAK)) start = match.index + match[0].length;

  let end = source.length;
  const stop = source.slice(at).match(/[。！？；\n]|[.!?;](?=\s|$)/);
  if (stop !== null) end = at + stop.index + stop[0].length;

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
