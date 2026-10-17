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
import {
  liveFacts,
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
  const lines = [];
  let used = 0;

  const header = language === 'zh' ? '## 你记得的事' : '## What you remember';
  lines.push(header);
  used += estimateTokens(header);

  const profileLine = language === 'zh'
    ? `你和这个人已经聊过 ${Math.max(1, Math.round(Number(relationship.familiarity) * 12))} 个阶段，关系熟悉度 ${(Number(relationship.familiarity) * 100).toFixed(0)}%。`
    : `You have known this person for a while now; familiarity ${(Number(relationship.familiarity) * 100).toFixed(0)}%.`;
  lines.push(profileLine);
  used += estimateTokens(profileLine);

  for (const fact of ranked) {
    if (used >= maxTokens * 0.75) break;
    const line = `- ${describeFact(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
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

  if (used <= estimateTokens(header) + estimateTokens(profileLine)) {
    // Only the boilerplate made it in; that is not worth a prompt section.
    const hasFact = lines.length > 2;
    if (!hasFact) return '';
  }

  return lines.join('\n');
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
      age: `is ${object}`,
      lives_in: `lives in ${object}`,
      hometown: `is from ${object}`,
      works_as: `works as ${object}`,
      studies: `studies ${object}`,
      relationship_status: `relationship status: ${object}`,
      has_pet: `has ${object}`,
      likes: `likes ${object}`,
      dislikes: `dislikes ${object}`,
      goal: `is working toward ${object}`,
    };
    return english[predicate] ?? `${predicate.replace(/_/g, ' ')}: ${object}`;
  }
  const chinese = {
    name: `名字是${object}`,
    nickname: `希望被叫${object}`,
    birthday: `生日是${object}`,
    age: `${object}岁`,
    lives_in: `住在${object}`,
    hometown: `老家在${object}`,
    works_as: `做${object}`,
    studies: `在学${object}`,
    relationship_status: `感情状况：${object}`,
    has_pet: `养了${object}`,
    likes: `喜欢${object}`,
    dislikes: `不喜欢${object}`,
    goal: `正在往${object}努力`,
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
    const line = `- ${String(fact.predicate).replace(/_/g, ' ')}: ${String(fact.object)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens * 0.5) break;
    lines.push(line);
    used += cost;
  }

  for (const episode of recalled.episodes ?? []) {
    if (used + estimateTokens(String(episode.text)) > maxTokens) break;
    const when = formatWhen(Number(episode.at), language);
    const line = `- ${when}${String(episode.actor) === 'user' ? '对方' : '你'}说过：${String(episode.text).slice(0, 200)}`;
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
