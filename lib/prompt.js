/**
 * The resident memory section: what the agent always knows, without searching.
 *
 * Two things go here and nothing else:
 *   1. a compact profile of the person, rebuilt from live facts;
 *   2. the state of the relationship itself — how long we have been talking,
 *      what is unresolved, what they are currently going through.
 *
 * The section is materialized on write, not computed per request, because
 * building it per turn would add latency to the first token for no benefit.
 *
 * @module dsh-hippo/prompt
 */

import { estimateTokens } from './tokenize.js';
import { objectSimilarity } from './extract.js';
import {
  liveFacts,
  liveReflections,
  ensureRelationship,
  openLoops,
  dueLoops,
  localDay,
} from './store.js';

/** Hard budget for the resident section, in estimated tokens. */
export const RESIDENT_BUDGET = 1200;

/** Budget for one recalled block inside the prompt. */
export const RECALL_BUDGET = 1200;

/** Predicates promoted to the top of the profile regardless of confidence. */
const CORE_PREDICATES = [
  'name', 'nickname', 'birthday', 'age', 'lives_in', 'hometown',
  'works_as', 'studies', 'relationship_status', 'has_pet',
  'likes', 'dislikes', 'goal',
];

/**
 * Predicates that hold more than one value at a time.
 *
 * Everything else is treated as single-valued in the profile: only its
 * best-ranked line is rendered, so the snapshot never states two conflicting
 * versions of the same attribute side by side.
 *
 * `goal` is deliberately absent. A person can hold several goals, but they say
 * them one at a time and the extraction re-states the current one every time it
 * comes up, so what ends up stored is usually three phrasings of one wish rather
 * than three wishes. Showing the best-ranked one is closer to the truth than
 * showing all of them; the others stay one `memory_recall` away.
 */
const MULTI_VALUED = new Set([
  'likes', 'dislikes', 'has_pet', 'not_has_pet', 'personality', 'language',
]);

/**
 * Materialize the resident section text.
 *
 * Returns an empty string when there is nothing worth saying — an agent with no
 * memories should not open with a paragraph explaining that it has none.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   userId?: string,
 *   now?: number,
 *   language?: 'zh'|'en',
 *   maxTokens?: number,
 * }} [options] - rendering options.
 * @returns {string} the section text, possibly empty.
 */
export function renderResident(db, options = {}) {
  const userId = options.userId ?? 'user';
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? RESIDENT_BUDGET;
  const language = options.language ?? 'zh';

  const facts = liveFacts(db, { subject: userId, limit: 200 });
  if (facts.length === 0) return '';

  const relationship = ensureRelationship(db, userId);
  const loops = openLoops(db, userId, 8);
  const due = dueLoops(db, userId, now, 3);

  const ranked = rankFacts(facts, now);
  const rendered = [];
  const lines = [];
  let used = 0;

  // The clock goes first because every other line is read relative to it.
  //
  // Without it, "明天就要交稿了" said on Friday is indistinguishable from the
  // same sentence said three weeks ago, and the resident block cannot say how
  // long it has been since the last conversation. The DSH runtime ships a
  // `dsh-time-context` plugin, but a companion profile does not mount it, and
  // the model is otherwise told nothing about the current date at all.
  const clockLine = renderTimeContext(now, language);
  lines.push(clockLine);
  used += estimateTokens(clockLine);

  const header = language === 'zh' ? '## 你记得的事' : '## What you remember';
  lines.push(header);
  used += estimateTokens(header);

  const profileLine = language === 'zh'
    ? describeRelationship(relationship, now)
    : describeRelationshipEn(relationship);
  lines.push(profileLine);
  used += estimateTokens(profileLine);

  for (const fact of ranked) {
    if (used >= maxTokens * 0.75) break;
    const predicate = String(fact.predicate);
    // The profile is a snapshot of who this person is now, not a change log.
    //
    // The store deliberately keeps every version that was once true — that is
    // what the bi-temporal columns are for — and the extraction decision keeps
    // several values for predicates that genuinely take several ("likes").
    // Rendering them all produces a profile that argues with itself: "下周要交
    // 一本猫的绘本稿" and "猫绘本稿已于今天交稿" sitting two lines apart, both
    // stated in the present tense, and the model has no way to tell which one
    // superseded the other. So a predicate that can only hold one current value
    // contributes its best-ranked line and nothing else.
    if (!MULTI_VALUED.has(predicate) && rendered.some((seen) => String(seen.predicate) === predicate)) continue;
    // Within a multi-valued predicate, near-identical objects still collapse.
    const duplicate = rendered.some((seen) => String(seen.predicate) === predicate
      && objectSimilarity(String(seen.object), String(fact.object)) >= 0.35);
    if (duplicate) continue;
    // …and the count is capped. "likes" can legitimately hold twenty things, but
    // a profile that lists twenty of them is a database dump, and the ones past
    // the top of the ranking are the ones the extraction was least sure about.
    const already = rendered.filter((seen) => String(seen.predicate) === predicate).length;
    if (MULTI_VALUED.has(predicate) && already >= MULTI_VALUE_CAP) continue;
    const line = `- ${describeFact(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    rendered.push(fact);
    used += cost;
  }


  // Facts about other people are a separate paragraph, not more profile lines.
  //
  // They were previously dropped entirely: the query filtered `subject = userId`,
  // so "妈妈 health = 糖尿病" was extracted, stored, linked and indexed — and then
  // never shown to the model unless the person happened to ask about it. In a
  // companion these are among the most load-bearing memories there are: the thing
  // you are supposed to remember about a friend is often their mother's illness,
  // not their own blood type.
  const others = rankOthers(db, userId, now);
  if (others.length > 0 && used < maxTokens * 0.85) {
    const heading = language === 'zh' ? '对方身边的人' : 'People around them';
    lines.push(heading);
    used += estimateTokens(heading);
    const seenPeople = new Map();
    for (const fact of others) {
      const who = String(fact.subject);
      const already = seenPeople.get(who) ?? new Set();
      if (already.has(String(fact.predicate))) continue;
      const body = describeFact(fact, language);
      const line = language === 'en' ? `- ${who}: ${body}` : `- ${who}：${body}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      already.add(String(fact.predicate));
      seenPeople.set(who, already);
      lines.push(line);
      used += cost;
    }
  }

  if (due.length > 0 || loops.length > 0) {
    const pending = (due.length > 0 ? due : loops).slice(0, 3);
    const heading = language === 'zh' ? '还没聊完的事' : 'Things left open';
    lines.push(heading);
    used += estimateTokens(heading);
    for (const loop of pending) {
      const line = `- ${String(loop.text).slice(0, 120)}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      lines.push(line);
      used += cost;
    }
  }

  // Consolidated batches leave an index entry each. Three of them is enough to
  // carry the shape of the last few conversations — what the person has been
  // occupied with — without restating the facts that are already above.
  if (used < maxTokens * 0.9) {
    const recent = liveReflections(db, 3)
      .filter((row) => String(row.text ?? '').trim() !== '');
    if (recent.length > 0) {
      const heading = language === 'zh' ? '最近聊过的' : 'Recently talked about';
      lines.push(heading);
      used += estimateTokens(heading);
      for (const row of recent) {
        const line = `- ${String(row.text).slice(0, 100)}`;
        const cost = estimateTokens(line);
        if (used + cost > maxTokens) break;
        lines.push(line);
        used += cost;
      }
    }
  }

  if (used <= estimateTokens(header) + estimateTokens(profileLine)) {
    // Only the boilerplate made it in; that is not worth a prompt section.
    const hasFact = lines.length > 2;
    if (!hasFact) return '';
  }

  return lines.join('\n');
}

/**
 * Describe the relationship itself, not a count of messages.
 *
 * The number of turns is not information the model can act on — "familiarity
 * 37%" tells it nothing it could say. What it can act on is a stance: how close
 * this is, whether it has been a while, and whether the person's baseline has
 * been low. Those are the things a person would actually sense about a friend.
 *
 * Trust and mood are rendered as words rather than percentages for the same
 * reason: a model handed "0.62" will either ignore it or narrate it.
 *
 * @param {Record<string, unknown>} relationship - relationship row.
 * @param {number} now - epoch milliseconds.
 * @returns {string} one clause of Chinese prose.
 */
function describeRelationship(relationship, now) {
  const familiarity = Number(relationship.familiarity ?? 0);
  const trust = Number(relationship.trust ?? 0.5);
  const mood = Number(relationship.mood_baseline ?? 0);

  const closeness = familiarity < 0.08
    ? '你们认识不算久'
    : familiarity < 0.25
      ? '你们已经聊过一阵子'
      : familiarity < 0.5
        ? '你们算熟了'
        : '你们已经很熟';

  const trustWord = trust < 0.3
    ? '对方对你还有些戒备'
    : trust < 0.55
      ? '对方还在观察你'
      : trust < 0.75
        ? '对方愿意跟你说一些私事'
        : '对方很信任你';

  let moodWord = '';
  if (mood <= -0.25) moodWord = '；最近这段时间对方的状态偏低';
  else if (mood >= 0.25) moodWord = '；最近对方的心情不错';

  let gap = '';
  const lastUpdated = Number(relationship.last_updated ?? now);
  const days = (now - lastUpdated) / 86_400_000;
  if (days >= 7) gap = `；你们有 ${Math.floor(days)} 天没说话了`;

  return `${closeness}，${trustWord}${moodWord}${gap}。`;
}

/**
 * English counterpart of {@link describeRelationship}.
 * @param {Record<string, unknown>} relationship - relationship row.
 * @returns {string} one clause of English prose.
 */
function describeRelationshipEn(relationship) {
  const familiarity = Number(relationship.familiarity ?? 0);
  const trust = Number(relationship.trust ?? 0.5);
  const closeness = familiarity < 0.08 ? 'You have not known each other long'
    : familiarity < 0.25 ? 'You have been talking for a while'
      : familiarity < 0.5 ? 'You know each other fairly well'
        : 'You know each other well';
  const trustWord = trust < 0.3 ? 'they are still guarded'
    : trust < 0.55 ? 'they are still sizing you up'
      : trust < 0.75 ? 'they are willing to tell you private things'
        : 'they trust you';
  return `${closeness}; ${trustWord}.`;
}

/**
 * Order facts for the resident section: pinned first, then core predicates,
 * then by a blend of confidence and recency.
 * @param {Array<Record<string, unknown>>} facts - live facts.
 * @param {number} now - epoch milliseconds.
 * @returns {Array<Record<string, unknown>>} ordered facts.
 */
function rankFacts(facts, now) {
  const score = (fact) => {
    const predicate = String(fact.predicate);
    const coreBoost = CORE_PREDICATES.includes(predicate) ? 0.35 : 0;
    const pinBoost = Number(fact.pinned) === 1 ? 10 : 0;
    const ageDays = Math.max(0, (now - Number(fact.updated_at)) / 86_400_000);
    const recency = Math.exp(-ageDays / 90);
    return pinBoost + coreBoost + Number(fact.confidence) * 0.5 + recency * 0.3;
  };
  return [...facts].sort((a, b) => score(b) - score(a));
}

/**
 * Facts whose subject is someone other than the owner, ranked for the profile.
 *
 * Health and family conflict outrank hobbies here, which is the opposite of the
 * owner's own profile: nobody needs to be reminded that their friend's mother has
 * diabetes less often than that the friend likes coffee.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} now - epoch milliseconds.
 * @returns {Array<Record<string, unknown>>} ordered facts.
 */
function rankOthers(db, userId, now) {
  const facts = liveFacts(db, { exceptSubject: userId, limit: 20 });
  const weight = (fact) => {
    const predicate = String(fact.predicate);
    const serious = predicate === 'health' || predicate === 'relationship_status' ? 0.5 : 0;
    const ageDays = Math.max(0, (now - Number(fact.updated_at)) / 86_400_000);
    return serious + Number(fact.confidence) * 0.4 + Math.exp(-ageDays / 60) * 0.3;
  };
  return facts.sort((a, b) => weight(b) - weight(a)).slice(0, 5);
}

/**
 * How many values a multi-valued predicate may contribute to the profile.
 *
 * Two for most of them: a person who likes five things will say so again, and
 * the profile's job is to carry enough to start a conversation, not the whole
 * list. Pets get three because a house with three cats is a different fact from
 * a house with one, and leaving the third out is the kind of error that gets
 * noticed immediately.
 */
const MULTI_VALUE_CAP = 3;

/**
 * Render one fact as a sentence fragment in the agent's voice.
 *
 * The predicate vocabulary is deliberately small and explicit; anything the
 * extractor invents falls back to a generic `predicate: object` rendering,
 * which reads acceptably rather than breaking the prompt.
 * @param {Record<string, unknown>} fact - the fact row.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} one line of the profile.
 */
function describeFact(fact, language) {
  const predicate = String(fact.predicate);
  const object = String(fact.object);
  if (language === 'en') {
    const english = {
      name: `name is ${object}`,
      nickname: `goes by ${object}`,
      birthday: `birthday is ${object}`,
      born_on: `birthday is ${object}`,
      born_in: `is from ${object}`,
      age: `is ${object}`,
      lives_in: `lives in ${object}`,
      works_as: `works as ${object}`,
      works_at: `works at ${object}`,
      studies: `studies ${object}`,
      studies_at: `studies at ${object}`,
      relationship_status: `relationship status: ${object}`,
      has_pet: `has ${object}`,
      not_has_pet: `does not have ${object}`,
      not_lives_in: `does not live in ${object}`,
      likes: `likes ${object}`,
      dislikes: `dislikes ${object}`,
      goal: `wants ${object}`,
      plan: `current plan: ${object}`,
      habit: `habit: ${object}`,
      health: `health: ${object}`,
      dietary: `diet: ${object}`,
      personality: `personality: ${object}`,
      language: `speaks ${object}`,
      contact: `contact: ${object}`,
    };
    return english[predicate] ?? `${predicate.replace(/_/g, ' ')}: ${object}`;
  }
  const chinese = {
    name: `名字是${object}`,
    nickname: `希望被叫${object}`,
    birthday: `生日是${object}`,
    born_on: `生日是${object}`,
    born_in: `老家在${object}`,
    age: `${object}岁`,
    lives_in: `住在${object}`,
    works_as: `做${object}`,
    works_at: `在${object}上班`,
    studies: `在学${object}`,
    studies_at: `在${object}读书`,
    relationship_status: `感情状况：${object}`,
    has_pet: `养了${object}`,
    not_has_pet: `不养${object}`,
    not_lives_in: `不住在${object}`,
    likes: `喜欢${object}`,
    dislikes: `不喜欢${object}`,
    goal: `想要的：${object}`,
    plan: `手头的计划：${object}`,
    habit: `习惯：${object}`,
    health: `身体状况：${object}`,
    dietary: `吃上面：${object}`,
    personality: `性格：${object}`,
    language: `说${object}`,
    contact: `联系方式：${object}`,
    height: `身高${object}`,
    weight: `体重${object}`,
    blood_type: `血型${object}`,
    mbti: `MBTI 是${object}`,
    zodiac: `星座是${object}`,
  };
  return chinese[predicate] ?? `${predicate.replace(/_/g, ' ')}：${object}`;
}

/**
 * Render recalled memories as an injected context block.
 *
 * Recalled content goes in as a *context*, not as a system-prompt section, so
 * it is re-materialized per turn and never poisons the cached prompt prefix.
 *
 * @param {{
 *   episodes: Array<Record<string, unknown>>,
 *   facts: Array<Record<string, unknown>>,
 * }} recalled - output of {@link import('./store.js').recall}.
 * @param {{ language?: 'zh'|'en', maxTokens?: number, now?: number }} [options] - rendering options.
 * @returns {string} the block text, or '' when nothing was recalled.
 */
export function renderRecall(recalled, options = {}) {
  const maxTokens = options.maxTokens ?? RECALL_BUDGET;
  const language = options.language ?? 'zh';
  const lines = [];
  let used = 0;

  const header = language === 'zh' ? '（你想起了这些，不必复述，自然用上就好）' : '(You recall the following; use it naturally, do not recite it)';

  for (const fact of recalled.facts ?? []) {
    // Same sentence builder as the resident profile: a recall block that says
    // "has pet: 年糕" while the profile above it says "养了年糕" reads like two
    // different systems wrote it, and the model mirrors the worse one.
    const line = `- ${describeFact(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens * 0.5) break;
    lines.push(line);
    used += cost;
  }

  // The person's own words are the ground truth; the agent's replies are already
  // reflected in how it talks. Interleaving them by score let long replies eat
  // the budget and push the actual statements out, so the two kinds are laid out
  // separately and the echoes get a smaller slice.
  const episodes = recalled.episodes ?? [];
  const statements = episodes.filter((episode) => String(episode.actor) === 'user');
  // The agent's own replies are the weaker half of a recall: whatever it said was
  // already grounded in the person's words, and a long warm paragraph can crowd
  // out the three short sentences that actually carry the facts. So the echoes are
  // capped at two and quoted at half the length of a statement.
  const echoes = episodes.filter((episode) => String(episode.actor) !== 'user').slice(0, 2);

  // The same sentence gets stored more than once — a resumed session replays it,
  // or the person simply repeats themselves a week later. Two identical lines in
  // one recall block cost budget and teach the model nothing, so the seen-set is
  // keyed on the normalized text rather than the row id.
  const seen = new Set();

  for (const episode of [...statements, ...echoes]) {
    const text = String(episode.text ?? '').replace(/\s+/g, ' ').trim();
    const isUser = String(episode.actor) === 'user';
    const key = `${isUser ? 'u' : 'a'}:${text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Budget against what is actually rendered, not the stored length: episodes
    // keep up to 4000 characters, and charging the whole reply for a 120
    // character excerpt dropped every row after the first long answer.
    const excerpt = text.slice(0, isUser ? 240 : 100);
    const when = formatWhen(Number(episode.at), language);
    // Both halves are language-dependent: the earlier version kept the Chinese
    // "对方说过" regardless, so an English agent read "- today, 对方说过: ...".
    const who = language === 'en' ? (isUser ? 'they said' : 'you said') : (isUser ? '对方说过' : '你说过');
    const line = language === 'en'
      ? `- ${when}${who}: ${excerpt}${text.length > excerpt.length ? '…' : ''}`
      : `- ${when}${who}：${excerpt}${text.length > excerpt.length ? '…' : ''}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}

/**
 * Human-readable relative time for recalled episodes.
 * @param {number} at - epoch milliseconds.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} a short prefix like `3 天前` or `3 days ago, `.
 */
function formatWhen(at, language) {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (language === 'en') {
    if (days <= 0) return 'today, ';
    if (days === 1) return 'yesterday, ';
    if (days < 30) return `${days} days ago, `;
    if (days < 365) return `${Math.floor(days / 30)} months ago, `;
    return `${Math.floor(days / 365)} years ago, `;
  }
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/**
 * Render the time-of-day cue used to make greetings and follow-ups feel
 * situated rather than random.
 * @param {number} [now] - epoch milliseconds.
 * @param {'zh'|'en'} [language] - output language.
 * @returns {string} a one-line time context.
 */
export function renderTimeContext(now = Date.now(), language = 'zh') {
  const date = new Date(now);
  const hour = date.getHours();
  const period = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  const day = localDay();
  if (language === 'en') {
    const englishPeriod = hour < 5 ? 'late night' : hour < 11 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : 'evening';
    return `Now: ${day}, ${englishPeriod}.`;
  }
  return `现在是 ${day} ${period}。`;
}
