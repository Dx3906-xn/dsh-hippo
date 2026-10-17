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
 * Predicates that hold exactly one value at a time.
 *
 * Without this distinction "likes coffee" and "likes hiking" would retire each
 * other, while "lives_in Shanghai" and "lives_in Beijing" would both stay live.
 * Cardinality is a property of the predicate, not of the sentence, so it is
 * declared here rather than inferred per candidate.
 */
const SINGLE_VALUED = new Set([
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

  // Seed with the first row rather than with null: an unrelated object scores
  // exactly 0, and a null seed would make that case indistinguishable from
  // "nothing to compare against" and skip the single-valued check below.
  let best = existing[0];
  let bestScore = objectSimilarity(String(best.object), candidate.object);
  for (let index = 1; index < existing.length; index++) {
    const row = existing[index];
    const score = objectSimilarity(String(row.object), candidate.object);
    if (score > bestScore) {
      bestScore = score;
      best = row;
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
  // A topic change, not a contradiction: "likes coffee" and "likes hiking"
  // coexist. Only a single-valued predicate means the old value is now wrong.
  if (!SINGLE_VALUED.has(normalizePredicate(candidate.predicate))) return { action: 'add' };
  // Same single-valued predicate, unrelated object: the person changed their
  // mind or the earlier inference was wrong. Retire rather than overwrite.
  return { action: 'invalidate', factId: String(best.id) };
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

/**
 * Detect an explicit self-correction in a message and produce the fact that
 * supersedes the old one.
 *
 * This exists because "我改主意了" is the single most common way a remembered
 * profile goes stale, and catching it from the user's own words is both cheaper
 * and more accurate than inferring drift from behaviour.
 *
 * @param {string} text - the user's message.
 * @returns {{ contradicts: boolean, statement: string | null }} the signal.
 */
export function detectCorrection(text) {
  const normalized = String(text ?? '').toLowerCase();
  const marked = [
    '其实不是', '搞错了', '记错了', '说错了', '更正', '改一下',
    '不是这样', '我改主意', '现在不喜欢', '不再', '已经不',
    'actually not', 'i was wrong', 'correction', 'no longer',
  ].some((phrase) => normalized.includes(phrase));
  return { contradicts: marked, statement: marked ? String(text).trim().slice(0, 400) : null };
}

/**
 * Build the extraction prompt for a single message, used only when the caller
 * wants an immediate answer (explicit "记住…" requests).
 * @param {string} text - the message.
 * @returns {string} the prompt body.
 */
export function singleMessagePrompt(text) {
  return `[0] user: ${String(text).trim().slice(0, MAX_BATCH_CHARS)}`;
}
