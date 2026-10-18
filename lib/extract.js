/**
 * Gate 2/3: turn an episode into semantic facts, then decide what to do with
 * them.
 *
 * This module is the only place that spends LLM tokens, and it is written to
 * spend as few as possible: one call per batch, a hard JSON contract, and a
 * local four-action decision that never needs a second call unless a
 * contradiction appears.
 *
 * @module dsh-hippo/extract
 */

import { tokenize } from './tokenize.js';

/**
 * The extraction contract handed to the model. Kept terse on purpose: prompt
 * tokens dominate the cost of this module, and every example here buys
 * compliance that a longer instruction would not.
 */
const EXTRACTION_SYSTEM = [
  'You extract durable facts about a person from chat messages.',
  'Output ONLY a JSON object, no prose, no code fence.',
  'Shape: {"facts":[{"subject":"user","predicate":"...","object":"...","confidence":0.0,"sensitivity":"personal","episode":"<index>"}]}',
  'Rules:',
  '- Only include facts likely to matter weeks later: identity, preferences, relationships, recurring habits, plans, ongoing situations, strong feelings about something.',
  '- Skip small talk, one-off questions, and anything true only for a moment.',
  '- subject is "user" for the person, "agent" for yourself, or a stable entity name.',
  '- predicate is exactly one of: name, nickname, birthday, age, lives_in, works_as, works_at, studies_at, relationship_status, has_pet, likes, dislikes, goal, plan, habit, health, dietary, personality, language, contact.',
  '  Use the closest one even if imperfect. Never invent a new predicate, never use a bare verb such as "is" or "是", and never describe the sentence instead of the attribute.',
  '- object is a short phrase copied in the message\'s own language. Never invent details. Record the attribute value only, not the sentence around it.',
  '- when the message corrects something said earlier, extract the corrected value under the same predicate so it replaces the old one.',
  '- confidence: 0.9 explicit statement, 0.7 strong implication, 0.5 guess. Omit anything below 0.5.',
  '- sensitivity: "public" | "personal" | "sensitive" (health, money, sexuality, family conflict, anything the person would not want repeated).',
  '- episode is the index of the message the fact came from.',
  '- If nothing qualifies, return {"facts":[]}.',
].join('\n');

/**
 * Map a model-supplied predicate onto the closed vocabulary above.
 *
 * Models drift towards whatever verb the sentence used, and a drifting key
 * breaks the one thing the key is for: deciding whether two statements are
 * about the same attribute. Unknown predicates are kept rather than dropped --
 * a new attribute is still worth remembering -- but the well-known ones are
 * pinned so that "养了" and "has_pet" cannot coexist as separate truths.
 */
const PREDICATE_SYNONYMS = new Map(Object.entries({
  '养了': 'has_pet', '养着': 'has_pet', '养宠物': 'has_pet', '有宠物': 'has_pet',
  '有一只': 'has_pet', '宠物': 'has_pet', 'pet': 'has_pet',
  '正在学': 'goal', '在学': 'goal', '学': 'goal', '想学': 'goal',
  '最喜欢': 'likes', '喜欢': 'likes', '爱': 'likes', '爱好': 'likes', '偏好': 'likes',
  '不喜欢': 'dislikes', '讨厌': 'dislikes', '反感': 'dislikes',
  '习惯': 'habit', '作息': 'habit',
  '住在': 'lives_in', '家住': 'lives_in', '定居': 'lives_in',
  '工作': 'works_as', '职业': 'works_as', '做': 'works_as',
  '忌口': 'dietary', '饮食忌口': 'dietary', '饮食': 'dietary',
  '名字': 'name', '叫': 'name', '叫做': 'name',
  '生日': 'birthday', '年龄': 'age',
  '感情状况': 'relationship_status', '关系': 'relationship_status',
  '身体': 'health', '健康': 'health',
  '计划': 'plan', '打算': 'plan',
}));

/**
 * Canonicalize one predicate.
 *
 * A single CJK character carries no attribute information ("是" says nothing),
 * so those are rejected outright rather than stored as a meaningless key.
 *
 * @param {string} predicate - raw predicate from the model.
 * @returns {string | null} a canonical key, or null when unusable.
 */
function canonicalPredicate(predicate) {
  const raw = String(predicate ?? '').trim().toLowerCase().replace(/\s+/g, '_');
  if (raw === '') return null;
  const mapped = PREDICATE_SYNONYMS.get(raw) ?? PREDICATE_SYNONYMS.get(raw.replace(/_/g, ''));
  if (mapped !== undefined) return mapped;
  if (/^[\u3400-\u9fff]$/.test(raw)) return null;
  // Negative predicates are their own attribute: "does not have a cat" is not
  // a value of has_pet, or it would overwrite the pet it contradicts.
  const negated = /^(不|没|没有|无|别)/.test(raw) ? `not_${raw.replace(/^(不|没|没有|无|别)/, '')}` : raw;
  return NEGATIVE_ALIASES.get(negated) ?? negated;
}

/**
 * Common negations the model reaches for, so a correction of a known attribute
 * lands on the same key instead of inventing one.
 */
const NEGATIVE_ALIASES = new Map(Object.entries({
  not_养: 'not_has_pet', not_养了: 'not_has_pet', not_有宠物: 'not_has_pet', not_has_pet: 'not_has_pet',
  not_like: 'dislikes', not_likes: 'dislikes',
  not_住在: 'not_lives_in', not_lives_in: 'not_lives_in',
}));

/**
 * Canonicalize a predicate for callers outside this module.
 *
 * Exposed so that the explicit memory tool routes through the same vocabulary
 * as extraction: a fact written by hand and a fact inferred from a message must
 * share a key, or the pair can never be compared.
 *
 * @param {string} predicate - raw predicate.
 * @returns {string | null} a canonical key, or null when unusable.
 */
export function canonicalize(predicate) {
  return canonicalPredicate(predicate);
}

/**
 * Cap on how much text one extraction call sees. Batching is cheap; sending a
 * whole day of chat is not, and the model degrades on long noisy inputs.
 */
const MAX_BATCH_CHARS = 6000;

/**
 * Ask the model to extract facts from a batch of messages.
 *
 * The caller is responsible for charging the budget; this function returns the
 * usage estimate so the caller can.
 *
 * @param {{
 *   complete: (request: { system: string, prompt: string, maxTokens: number, signal?: AbortSignal }) => Promise<{ text: string, usage?: { inputTokens?: number, outputTokens?: number } }>,
 * }} llm - adapter bound to the agent's own route.
 * @param {Array<{ id: string, actor: string, text: string }>} episodes - the batch.
 * @param {{ signal?: AbortSignal }} [options] - cancellation.
 * @returns {Promise<{ facts: Array<Record<string, unknown>>, usage: { inputTokens: number, outputTokens: number } }>}
 *   candidate facts with the source episode id resolved.
 */
export async function extractFacts(llm, episodes, options = {}) {
  const usable = episodes.filter((episode) => String(episode.text ?? '').trim().length > 0);
  if (usable.length === 0) return { facts: [], usage: { inputTokens: 0, outputTokens: 0 } };

  const batch = [];
  let chars = 0;
  for (const episode of usable) {
    const text = String(episode.text).trim().slice(0, 1200);
    if (chars + text.length > MAX_BATCH_CHARS && batch.length > 0) break;
    batch.push({ episode, text });
    chars += text.length;
  }

  const prompt = batch
    .map(({ episode, text }, index) => `[${index}] ${episode.actor}: ${text}`)
    .join('\n');

  const response = await llm.complete({
    system: EXTRACTION_SYSTEM,
    prompt,
    maxTokens: 800,
    signal: options.signal,
  });

  const parsed = parseFacts(response.text, batch);
  return {
    facts: parsed,
    usage: {
      inputTokens: response.usage?.inputTokens ?? Math.ceil((prompt.length + EXTRACTION_SYSTEM.length) / 3),
      outputTokens: response.usage?.outputTokens ?? Math.ceil(String(response.text ?? '').length / 3),
    },
  };
}

/**
 * Parse a model response into validated candidate facts.
 *
 * Models wrap JSON in fences, prepend "Here is the JSON", and occasionally emit
 * trailing commentary. Rather than retrying on a parse failure (which doubles
 * the cost), this recovers the outermost JSON object and drops individual
 * malformed entries.
 *
 * @param {string} text - raw model output.
 * @param {Array<{ episode: { id: string } }>} batch - the batch the indices refer to.
 * @returns {Array<Record<string, unknown>>} validated candidates.
 */
export function parseFacts(text, batch) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return [];
  const json = extractJsonObject(raw);
  if (json === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.facts) ? parsed.facts : [];
  const facts = [];
  for (const entry of list) {
    const fact = validateFact(entry, batch);
    if (fact !== null) facts.push(fact);
  }
  return facts;
}

/**
 * Recover the outermost balanced JSON object from noisy model output.
 * @param {string} text - raw text.
 * @returns {string | null} the JSON substring, or null.
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  let from = start;
  if (from === -1) from = arrayStart;
  else if (arrayStart !== -1 && arrayStart < from) from = arrayStart;
  if (from === -1) return null;
  const open = text[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

/** Sensitivity values the schema accepts. */
const SENSITIVITIES = new Set(['public', 'personal', 'sensitive']);

/**
 * Validate and normalize one candidate fact.
 * @param {unknown} entry - one element of the model's `facts` array.
 * @param {Array<{ episode: { id: string } }>} batch - index source.
 * @returns {Record<string, unknown> | null} a clean candidate, or null when unusable.
 */
function validateFact(entry, batch) {
  if (entry === null || typeof entry !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (entry);
  const subject = cleanText(record.subject, 64);
  const predicate = canonicalPredicate(cleanText(record.predicate, 64) ?? '');
  const object = cleanText(record.object, 400);
  if (subject === null || predicate === null || object === null) return null;

  const rawConfidence = Number(record.confidence);
  const confidence = Number.isFinite(rawConfidence) ? clamp(rawConfidence, 0, 1) : 0.5;
  if (confidence < 0.5) return null;

  const sensitivity = SENSITIVITIES.has(String(record.sensitivity))
    ? String(record.sensitivity)
    : 'personal';

  const index = Number(record.episode);
  const episodeId = Number.isInteger(index) && batch[index] !== undefined
    ? batch[index].id
    : batch[0]?.id;

  return {
    subject: subject.toLowerCase() === 'user' ? 'user' : subject,
    predicate,
    object,
    confidence,
    sensitivity,
    source: 'inferred',
    evidence: episodeId === undefined ? [] : [episodeId],
  };
}

/**
 * Trim and length-bound a model-supplied string.
 * @param {unknown} value - raw value.
 * @param {number} max - maximum length.
 * @returns {string | null} the cleaned string, or null when empty.
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/**
 * Clamp a number into a range.
 * @param {number} value - raw value.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped value.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Overlap of the informative tokens in two phrasings of one statement.
 *
 * Character Dice is scale-sensitive in the wrong direction: two sentences about
 * one event drift apart as soon as either side adds a clause ("猫绘本稿已于今天
 * 交稿，出版社下周给反馈" vs "绘本稿已交，出版社下周给反馈" scores 0.69, and
 * against "等出版社下周给稿子的反馈" it drops to 0.43). Different events, by
 * contrast, share almost nothing — 0.17 at most across the pairs measured — so
 * the gap between bands is wide but the Dice value straddles the update cutoff.
 *
 * Tokens are length-filtered because bigrams of function words ("的下", "稿子")
 * appear in everything; what identifies the topic is the content bigrams that
 * both sides keep regardless of word order.
 *
 * @param {string} a - stored object.
 * @param {string} b - candidate object.
 * @returns {{ shared: number, containment: number }} overlap counts.
 */
function tokenOverlap(a, b) {
  const tokensOf = (text) => tokenize(text).filter((token) => token.length >= 2);
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (left.length === 0 || right.length === 0) return { shared: 0, containment: 0 };
  const leftSet = new Set(left);
  const shared = right.filter((token) => leftSet.has(token)).length;
  return { shared, containment: shared / Math.min(left.length, right.length) };
}

/**
 * Predicates that hold exactly one value at a time.
 *
 * Without this distinction "likes coffee" and "likes hiking" would retire each
 * other, while "lives_in Shanghai" and "lives_in Beijing" would both stay live.
 * Cardinality is a property of the predicate, not of the sentence, so it is
 * declared here rather than inferred per candidate.
 *
 * Exported because the invariant it encodes is checkable: a live pair under one
 * of these predicates is a store-level contradiction, and the resident prompt
 * hides it (it renders only the best-ranked line), so only a query can see it.
 * `test/consistency.mjs` asserts no write path leaves one behind.
 */
export const SINGLE_VALUED = new Set([
  'lives_in', 'works_as', 'works_at', 'studies', 'studies_at', 'born_in', 'born_on',
  'birthday', 'age', 'relationship_status', 'name', 'nickname',
  'height', 'weight', 'blood_type', 'mbti', 'zodiac',
  '住在', '住在哪里', '工作', '职业', '学校', '生日', '年龄', '感情状况', '名字',
]);

/**
 * Decide what to do with one candidate fact against the live knowledge base.
 *
 * ADD / UPDATE / INVALIDATE+ADD / NOOP — the mem0 shape, except that a
 * contradiction retires the old fact instead of deleting it, and that the pair
 * is queued for a later clarification question rather than silently resolved.
 *
 * The decision is lexical on purpose: running a second model call per candidate
 * would cost more than the extraction itself, and the failure mode of a lexical
 * miss is a duplicate fact, which consolidation later merges.
 *
 * @param {Array<Record<string, unknown>>} existing - live facts sharing the key.
 * @param {{ subject: string, predicate: string, object: string, confidence?: number }} candidate - the candidate.
 * @returns {{ action: 'add'|'update'|'invalidate'|'noop', factId?: string, objectChanged?: boolean }}
 *   the decision.
 */
export function decide(existing, candidate) {
  if (existing.length === 0) return { action: 'add' };

  // A candidate that says strictly less than a value already stored adds no
  // information. "血糖" arriving after "上个月查出糖尿病，目前在控糖；血糖这周
  // 稳定了，她松了一口气" is the same fact with the detail dropped: overwriting
  // loses the detail, inserting duplicates the row, and both are wrong.
  //
  // This runs before the similarity search because character overlap cannot see
  // containment once the lengths diverge — the pair above scored 0.077, nowhere
  // near the update band, so the subset test has to be structural rather than
  // numerical. Direction matters: a candidate that *contains* the stored value
  // is a detail being added and belongs in the update band, not here.
  const candidateText = normalizePhrase(candidate.object);
  if (candidateText.length >= 2) {
    for (const row of existing) {
      const stored = normalizePhrase(String(row.object));
      if (stored.length > candidateText.length && stored.includes(candidateText)) {
        return { action: 'noop', factId: String(row.id) };
      }
    }
  }

  // Seed with the first row rather than with null: an unrelated object scores
  // exactly 0, and a null seed would make that case indistinguishable from
  // "nothing to compare against" and skip the single-valued check below.
  let best = existing[0];
  let bestScore = objectSimilarity(String(best.object), candidate.object);
  let bestOverlap = tokenOverlap(String(best.object), candidate.object);
  for (let index = 1; index < existing.length; index++) {
    const row = existing[index];
    const score = objectSimilarity(String(row.object), candidate.object);
    if (score > bestScore) {
      bestScore = score;
      best = row;
      bestOverlap = tokenOverlap(String(row.object), candidate.object);
    }
  }
  if (bestScore >= 0.85) return { action: 'noop', factId: String(best.id) };
  if (bestScore >= 0.45) {
    return {
      action: 'update',
      factId: String(best.id),
      objectChanged: String(best.object).trim() !== String(candidate.object).trim(),
    };
  }
  // Second chance at the update band: character Dice collapses when one side is
  // longer, but the content tokens survive rephrasing. Measured across one
  // person's plans, restatements of the same plan share 5–10 tokens with 0.63+
  // containment, while unrelated plans share at most 1. Requiring both a floor
  // and a ratio keeps "想养猫，但房东不让" from merging into "一直想养猫" (one
  // shared token) as well as from being retired as a contradiction.
  if (bestOverlap.shared >= 3 && bestOverlap.containment >= 0.5) {
    return {
      action: 'update',
      factId: String(best.id),
      objectChanged: String(best.object).trim() !== String(candidate.object).trim(),
    };
  }
  // A topic change, not a contradiction: "likes coffee" and "likes hiking"
  // coexist. Only a single-valued predicate means the old value is now wrong.
  if (!SINGLE_VALUED.has(normalizePredicate(candidate.predicate))) {
    // …except when the candidate announces that one of them is over. "下周要交
    // 一本猫的绘本稿" and "猫绘本稿已于今天交稿" are two live plans about one
    // manuscript, and rendering both states the future and the past in the same
    // tense. Plans and habits are multi-valued because a person really can be
    // doing six things at once — but a completed thing is not one of them.
    if (announcesCompletion(candidate.object)) {
      const done = existing.find((row) => !announcesCompletion(row.object)
        && tokenOverlap(String(row.object), candidate.object).shared >= 2);
      if (done !== undefined) return { action: 'invalidate', factId: String(done.id) };
    }
    return { action: 'add' };
  }
  // Same single-valued predicate, unrelated object: the person changed their
  // mind or the earlier inference was wrong. Retire rather than overwrite.
  return { action: 'invalidate', factId: String(best.id) };
}

/**
 * Does this object describe something that has already happened?
 *
 * Deliberately narrow. "已经想好了" is a decision, not the completion of a plan,
 * and "还没交" is the opposite of one; the patterns below all name a finished
 * action. The point is not to understand tense in general — it is to catch the
 * one case where a multi-valued predicate stops being multi-valued, which is when
 * one of its values is over.
 *
 * @param {string | null | undefined} object - a fact object.
 * @returns {boolean} whether it reads as completed.
 */
function announcesCompletion(object) {
  const text = String(object ?? '');
  if (text.trim().length === 0) return false;
  // A negated completion is not a completion: "稿子还没交" keeps the plan alive.
  if (/(没|不|未|还没|尚未)(有)?(交|做|写|画|去|完成|结束|参加)/.test(text)) return false;
  // "已…于今天交稿" puts a date between the marker and the verb, so the gap is
  // allowed — but only a short one, and never across a clause boundary, or
  // "已经想好了，下周再交" would read as finished.
  return /已(经)?(于|在|是)?[^，。！？]{0,5}(交|交稿|完成|做完|写好|画完|结束|去过|参加|搞定|办完)|已交|交了|交稿了|做完了|写完了|画完了|搞定了|结束了|去过了|参加了|办完了/.test(text);
}

/**
 * Normalize a predicate for cardinality lookup.
 * @param {string} predicate - raw predicate.
 * @returns {string} lower-cased, underscore-joined predicate.
 */
function normalizePredicate(predicate) {
  return String(predicate ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Character-level similarity between two short phrases.
 *
 * Dice coefficient over bigrams: cheap, language-agnostic, and good enough to
 * separate "likes coffee" from "likes tea" while treating "likes coffee" and
 * "really likes coffee" as the same fact.
 *
 * @param {string} a - first phrase.
 * @param {string} b - second phrase.
 * @returns {number} similarity in [0, 1].
 */
export function objectSimilarity(a, b) {
  const left = normalizePhrase(a);
  const right = normalizePhrase(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  // Containment means the same thing said at two levels of detail, not a
  // contradiction: "插画师" and "插画师，主要接商业稿件" are one job, and
  // "年糕" and "一只叫年糕的橘猫" are one cat. Scored into the update band so
  // the richer phrasing wins instead of retiring the plainer one.
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length >= 2 && longer.includes(shorter)) {
    const ratio = shorter.length / longer.length;
    // Below this the shorter side is a fragment that happens to appear inside a
    // longer phrase, which is a coincidence rather than a description.
    if (ratio >= 0.25) return 0.6;
  }
  const grams = (s) => {
    const out = new Map();
    if (s.length === 1) {
      out.set(s, 1);
      return out;
    }
    for (let i = 0; i + 1 < s.length; i++) {
      const gram = s.slice(i, i + 2);
      out.set(gram, (out.get(gram) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(left);
  const gb = grams(right);
  let overlap = 0;
  for (const [gram, count] of ga) {
    const other = gb.get(gram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  const total = [...ga.values()].reduce((sum, n) => sum + n, 0)
    + [...gb.values()].reduce((sum, n) => sum + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

/**
 * Normalize a phrase for comparison: strip whitespace and punctuation, fold
 * case. Chinese text keeps its characters.
 *
 * Parenthesised asides are dropped first: extraction routinely annotates an
 * object with context the speaker supplied once ("北京（2026年10月刚搬过去）"),
 * and that annotation must not make the bare value look like a different fact.
 * @param {string} text - raw phrase.
 * @returns {string} normalized phrase.
 */
function normalizePhrase(text) {
  return String(text ?? '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}
