/**
 * Consolidation: the offline pass that turns raw moments into understanding.
 *
 * Three jobs, each behind its own gate, because consolidation is where a
 * companion agent most easily invents a self-consistent fiction:
 *
 *   A. compress — episodes → candidate facts + a summary reflection, staged;
 *   B. audit   — a second look that rejects claims their evidence cannot carry;
 *   C. apply   — write through the four-action decision, never deleting;
 *   D. link    — build the association graph that makes recall walkable;
 *   E. materialize — recompute the derived relational state, append-only.
 *
 * Nothing here deletes. Everything here can be traced back to the episodes it
 * came from, which is what makes the result auditable at all.
 *
 * @module dsh-hippo/consolidate
 */

import {
  unconsolidatedEpisodes,
  markConsolidated,
  addReflection,
  liveFacts,
  similarFacts,
  addFact,
  reinforceFact,
  invalidateFact,
  reviewHistory,
  transact,
  recomputeRelationship,
  addLink,
  userId as defaultUserId,
} from './store.js';
import { decide, extractFacts } from './extract.js';
import { tokenize } from './tokenize.js';
import { retrievability } from './fsrs.js';

/** Episodes per consolidation pass. */
export const BATCH_SIZE = 40;

/** Minimum episodes before a pass is worth an LLM call. */
export const MIN_BATCH = 4;

/** Below this audit confidence the candidate is dropped rather than downgraded. */
const AUDIT_FLOOR = 0.45;

const AUDIT_SYSTEM = [
  'You review proposed facts about a person against the messages they came from.',
  'Output ONLY JSON: {"approved":[{"index":0,"confidence":0.0}],"rejected":[{"index":1,"reason":"..."}]}',
  'Reject when the fact is not supported by the quoted messages, when it over-interprets, when it turns a momentary state into a trait, or when the same meaning is already covered.',
  'Lower confidence when the support is indirect.',
].join('\n');

/**
 * Run one consolidation pass.
 *
 * Called from a timer, from agent disposal, and from an explicit tool. All
 * three entry points share this function so their behaviour cannot drift.
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   llm: { complete: (request: { system: string, prompt: string, maxTokens: number, signal?: AbortSignal }) => Promise<{ text: string, usage?: unknown }> } | null,
 *   charge?: (tokens: number) => void,
 *   language?: 'zh'|'en',
 * }} deps - dependencies; `llm` may be null for a dry run.
 * @param {{ signal?: AbortSignal, force?: boolean, batchSize?: number }} [options] - pass options.
 * @returns {Promise<{
 *   ran: boolean,
 *   reason: string,
 *   episodes: number,
 *   factsAdded: number,
 *   factsUpdated: number,
 *   factsInvalidated: number,
 *   reflectionId: string | null,
 * }>} a report of what happened.
 */
export async function consolidate(deps, options = {}) {
  const db = deps.db;
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const episodes = unconsolidatedEpisodes(db, batchSize);

  if (episodes.length < MIN_BATCH && options.force !== true) {
    return {
      ran: false,
      reason: `not enough material (${episodes.length}/${MIN_BATCH})`,
      episodes: episodes.length,
      factsAdded: 0,
      factsUpdated: 0,
      factsInvalidated: 0,
      reflectionId: null,
    };
  }
  if (episodes.length === 0) {
    return {
      ran: false,
      reason: 'nothing to consolidate',
      episodes: 0,
      factsAdded: 0,
      factsUpdated: 0,
      factsInvalidated: 0,
      reflectionId: null,
    };
  }
  if (deps.llm === null || deps.llm === undefined) {
    return {
      ran: false,
      reason: 'no model available',
      episodes: episodes.length,
      factsAdded: 0,
      factsUpdated: 0,
      factsInvalidated: 0,
      reflectionId: null,
    };
  }

  const batch = episodes.map((row) => ({
    id: String(row.id),
    actor: String(row.actor),
    text: String(row.text),
  }));

  // ---- A. compress ------------------------------------------------------
  const extraction = await extractFacts(deps.llm, batch, { signal: options.signal });
  deps.charge?.(extraction.usage.inputTokens + extraction.usage.outputTokens);

  if (extraction.facts.length === 0) {
    const reflectionId = addReflection(db, {
      kind: 'summary',
      text: summarizeEpisodes(batch, deps.language ?? 'zh', extraction.facts),
      level: 0,
      confidence: 0.5,
      evidenceEpisodes: batch.map((episode) => episode.id),
    });
    markConsolidated(db, batch.map((episode) => episode.id), reflectionId);
    return {
      ran: true,
      reason: 'no facts extracted',
      episodes: batch.length,
      factsAdded: 0,
      factsUpdated: 0,
      factsInvalidated: 0,
      reflectionId,
    };
  }

  // ---- B. audit ---------------------------------------------------------
  const audited = await auditFacts(deps.llm, batch, extraction.facts, { signal: options.signal });
  deps.charge?.(audited.usage);

  // ---- C. apply ---------------------------------------------------------
  const applied = applyFacts(db, audited.facts, defaultUserId(db));

  // ---- D. link ----------------------------------------------------------
  // A fact that stands alone can only be reached by matching its own words, so
  // it effectively vanishes the moment the person phrases things differently.
  // Linking is what turns a list of statements into something you can walk.
  const linked = linkBatch(db, batch, applied, audited.facts, defaultUserId(db));

  const reflectionId = addReflection(db, {
    kind: 'summary',
    text: summarizeEpisodes(batch, deps.language ?? 'zh', extraction.facts),
    level: 0,
    confidence: 0.6,
    evidenceEpisodes: batch.map((episode) => episode.id),
    evidenceFacts: applied.factIds,
  });
  markConsolidated(db, batch.map((episode) => episode.id), reflectionId);
  recomputeRelationship(db, defaultUserId(db));

  return {
    ran: true,
    reason: 'applied',
    episodes: batch.length,
    factsAdded: applied.added,
    factsUpdated: applied.updated,
    factsInvalidated: applied.invalidated,
    reflectionId,
    links: linked,
  };
}

/**
 * Build the association graph for one consolidation batch.
 *
 * Three edge kinds are inferred from what the batch already knows, with no model
 * call:
 *
 *   - `temporal`: consecutive messages in the same session. Cheap and almost
 *     always meaningful — people stay on a topic across adjacent turns.
 *   - `shared_subject`: facts mined from the same pass, which describes one
 *     moment even when the attributes differ.
 *   - `supports`: a fact and the episode it was extracted from. Grounding, so a
 *     recall can walk from a fact back to what was actually said.
 *   - `semantic`: two facts whose predicate or object share a token. This is
 *     what connects "年糕（橘猫）" to "三花猫豆沙" without either sentence
 *     containing the other's words.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {Array<{ id: string }>} batch - the consolidated episodes.
 * @param {{ factIds: string[] }} applied - facts written or touched.
 * @param {Array<Record<string, unknown>>} candidates - the facts with their evidence.
 * @param {string} userId - relationship owner.
 * @returns {{ temporal: number, subject: number, evidence: number, semantic: number }}
 *   edges written.
 */
export function linkBatch(db, batch, applied, candidates, userId) {
  let temporal = 0;
  let subject = 0;
  let evidence = 0;
  let semantic = 0;

  for (let index = 1; index < batch.length; index++) {
    addLink(db, { from: batch[index - 1].id, to: batch[index].id, kind: 'temporal', weight: 0.4 });
    temporal++;
  }

  // Ground each fact in the messages it came from, so a recall hit can show the
  // source sentence rather than an assertion with no provenance. `applyFacts`
  // pushes one id per candidate in order, including the no-op ones, so the
  // arrays stay index-aligned.
  //
  // The episode does not have to be in *this* batch. A fact first stated three
  // weeks ago and merely reinforced today still points at the sentence that
  // introduced it, so the check is against the episodes table rather than the
  // batch.
  for (let index = 0; index < candidates.length; index++) {
    const factId = String(applied.factIds[index] ?? '');
    if (factId === '') continue;
    const direct = Array.isArray(candidates[index].evidence) ? candidates[index].evidence : [];
    // Fall back to the episodes already recorded against the fact: an `update`
    // decision may have consolidated a new retelling that did not name its
    // original source, and the fact should still be traceable to one.
    const stored = db.prepare('SELECT episode_id FROM evidence WHERE fact_id = ?').all(factId).map((row) => String(row.episode_id));
    const episodeIds = new Set([...direct.map(String), ...stored]);
    for (const episodeId of episodeIds) {
      if (episodeId.length === 0) continue;
      const exists = db.prepare('SELECT 1 AS ok FROM episodes WHERE id = ?').get(episodeId);
      if (exists === undefined) continue;
      addLink(db, { from: factId, to: episodeId, kind: 'supports', weight: 0.7 });
      evidence++;
    }
  }

  // No `shared_subject` edges are written.
  //
  // The tempting move is to link every fact about the same person, since they
  // all describe her. It is also useless: every fact about a person has the same
  // subject, so the edge becomes a complete graph in which nothing is closer to
  // anything, and a recall walks it in insertion order. "She lives in 杭州" and
  // "she is an illustrator" are not associated; they are simply both true.
  //
  // Real association comes from shared vocabulary (`semantic`) and from having
  // been said together (`temporal` on the episodes, `supports` into them).

  // Words shared between two objects. "年糕（橘猫）" and "一只三花猫，名叫豆沙"
  // share the token 猫, which is a real association; "杭州" and "插画师" share
  // nothing and stay unlinked.
  const live = liveFacts(db, { subject: userId, limit: 80 });
  const bags = live.map((fact) => ({ id: String(fact.id), tokens: new Set(tokenize(`${fact.predicate} ${fact.object}`)) }));
  for (let left = 0; left < bags.length; left++) {
    for (let right = left + 1; right < bags.length; right++) {
      const shared = [...bags[left].tokens].filter((token) => bags[right].tokens.has(token));
      if (shared.length === 0) continue;
      addLink(db, {
        from: bags[left].id,
        to: bags[right].id,
        kind: 'semantic',
        weight: Math.min(0.6, 0.2 + shared.length * 0.1),
      });
      semantic++;
    }
  }

  return { temporal, subject, evidence, semantic };
}

/**
 * Second-pass review of candidate facts.
 *
 * When the audit call fails, candidates are kept at reduced confidence rather
 * than dropped: losing a real memory to a flaky review is worse than carrying
 * one soft fact, and the soft fact will decay on its own.
 *
 * @param {{ complete: Function }} llm - model adapter.
 * @param {Array<{ id: string, actor: string, text: string }>} batch - the source messages.
 * @param {Array<Record<string, unknown>>} candidates - facts from extraction.
 * @param {{ signal?: AbortSignal }} [options] - cancellation.
 * @returns {Promise<{ facts: Array<Record<string, unknown>>, usage: number }>} survivors.
 */
export async function auditFacts(llm, batch, candidates, options = {}) {
  const prompt = [
    'MESSAGES:',
    ...batch.map((episode, index) => `[${index}] ${episode.actor}: ${String(episode.text).slice(0, 800)}`),
    '',
    'PROPOSED FACTS:',
    ...candidates.map((fact, index) => `${index}. ${String(fact.subject)} ${String(fact.predicate)} = ${String(fact.object)} (confidence ${String(fact.confidence)})`),
  ].join('\n');

  let text;
  try {
    const response = await llm.complete({
      system: AUDIT_SYSTEM,
      prompt,
      maxTokens: 500,
      signal: options.signal,
    });
    text = String(response.text ?? '');
  } catch {
    return {
      facts: candidates.map((fact) => ({ ...fact, confidence: Number(fact.confidence) * 0.8 })),
      usage: 0,
    };
  }

  const usage = Math.ceil((prompt.length + AUDIT_SYSTEM.length + text.length) / 3);
  const verdicts = parseAudit(text);
  if (verdicts === null) {
    return {
      facts: candidates.map((fact) => ({ ...fact, confidence: Number(fact.confidence) * 0.8 })),
      usage,
    };
  }

  const facts = [];
  for (let index = 0; index < candidates.length; index++) {
    const verdict = verdicts.get(index);
    if (verdict === undefined) {
      // The audit skipped this index; treat silence as approval at reduced
      // confidence rather than as rejection.
      facts.push({ ...candidates[index], confidence: Number(candidates[index].confidence) * 0.85 });
      continue;
    }
    if (verdict.rejected) continue;
    const confidence = Math.min(Number(candidates[index].confidence), verdict.confidence ?? 0.6);
    if (confidence < AUDIT_FLOOR) continue;
    facts.push({ ...candidates[index], confidence });
  }
  return { facts, usage };
}

/**
 * Parse the audit response into per-index verdicts.
 * @param {string} text - raw model output.
 * @returns {Map<number, { rejected: boolean, confidence?: number }> | null} verdicts, or null when unparseable.
 */
function parseAudit(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const verdicts = new Map();
  for (const entry of Array.isArray(parsed.approved) ? parsed.approved : []) {
    const index = Number(entry?.index);
    if (!Number.isInteger(index)) continue;
    const confidence = Number(entry?.confidence);
    verdicts.set(index, {
      rejected: false,
      confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : undefined,
    });
  }
  for (const entry of Array.isArray(parsed.rejected) ? parsed.rejected : []) {
    const index = Number(entry?.index);
    if (!Number.isInteger(index)) continue;
    verdicts.set(index, { rejected: true });
  }
  return verdicts;
}

/**
 * Every name the owner answers to, harvested from their own facts.
 *
 * The name arrives *as a fact* (`name = 林晚`) and is then available to resolve
 * later subjects, which is the right order: the store teaches the extractor who
 * the person is, rather than a config file having to know in advance.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @returns {Set<string>} lowercased aliases.
 */
export function ownerAliases(db, userId) {
  const rows = db.prepare(`
    SELECT object FROM facts
    WHERE invalid_at IS NULL AND subject = ? AND predicate IN ('name', 'nickname')
  `).all(userId);
  const aliases = new Set();
  for (const row of rows) {
    const value = String(row.object ?? '').trim().toLowerCase();
    if (value !== '') aliases.add(value);
  }
  return aliases;
}

/**
 * Map an extractor-supplied subject onto the owner when it is clearly them.
 * @param {string} subject - raw subject from the model.
 * @param {string} userId - relationship owner.
 * @param {Set<string>} aliases - the owner's names.
 * @returns {string} the subject to store under.
 */
export function resolveSubject(subject, userId, aliases) {
  const normalized = subject.trim().toLowerCase();
  if (normalized === '' || normalized === 'user' || normalized === '我' || normalized === userId.toLowerCase()) {
    return userId;
  }
  // "林晚" and "林晚（用户）" both mean the owner; a friend named 林晚 would need
  // the extractor to have written a different subject string entirely.
  for (const alias of aliases) {
    if (normalized === alias || normalized.startsWith(`${alias}（`) || normalized.startsWith(`${alias}(`)) {
      return userId;
    }
  }
  return subject;
}

/**
 * Apply audited facts through the four-action decision, in one transaction.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {Array<Record<string, unknown>>} facts - audited candidates.
 * @param {string} userId - relationship owner.
 * @returns {{ added: number, updated: number, invalidated: number, factIds: string[] }} counts.
 */
export function applyFacts(db, facts, userId) {
  let added = 0;
  let updated = 0;
  let invalidated = 0;
  const factIds = [];
  const aliases = ownerAliases(db, userId);

  transact(db, () => {
    for (const candidate of facts) {
      // The extractor is told to write `subject: "user"` for the person, and it
      // mostly complies — but when the message contains a name it sometimes uses
      // that name instead ("林晚 goal = 想养猫"). Left alone, those rows become a
      // second owner: the resident profile does not render them (it reads the
      // owner's subject), so the fact is stored and then never seen.
      const subject = resolveSubject(String(candidate.subject), userId, aliases);
      const existing = similarFacts(db, {
        subject,
        predicate: String(candidate.predicate),
        object: String(candidate.object),
      });
      const decision = decide(existing, {
        subject,
        predicate: String(candidate.predicate),
        object: String(candidate.object),
        confidence: Number(candidate.confidence),
      });

      if (decision.action === 'add') {
        const id = addFact(db, {
          subject,
          predicate: String(candidate.predicate),
          object: String(candidate.object),
          confidence: Number(candidate.confidence ?? 0.6),
          evidence: /** @type {string[]} */ (candidate.evidence ?? []),
          sensitivity: String(candidate.sensitivity ?? 'personal'),
          source: 'consolidated',
          costTokens: 0,
        });
        factIds.push(id);
        added++;
        continue;
      }

      if (decision.action === 'update') {
        reinforceFact(db, String(decision.factId), {
          evidence: /** @type {string[]} */ (candidate.evidence ?? []),
          object: decision.objectChanged === true ? String(candidate.object) : undefined,
        });
        factIds.push(String(decision.factId));
        updated++;
        continue;
      }

      if (decision.action === 'invalidate') {
        const id = addFact(db, {
          subject,
          predicate: String(candidate.predicate),
          object: String(candidate.object),
          confidence: Number(candidate.confidence ?? 0.6),
          evidence: /** @type {string[]} */ (candidate.evidence ?? []),
          sensitivity: String(candidate.sensitivity ?? 'personal'),
          source: 'consolidated',
          needsClarification: true,
        });
        invalidateFact(db, String(decision.factId), { supersededBy: id });
        factIds.push(id);
        invalidated++;
        continue;
      }

      // noop
      factIds.push(String(decision.factId));
    }
  });

  return { added, updated, invalidated, factIds };
}

/**
 * One-paragraph summary of a batch, stored as the leaf reflection.
 *
 * "12 messages, started with: ..." is not a summary — it is a row count with a
 * quote attached, and it makes a poor index because the quote is whichever
 * sentence happened to come first. What makes a passage findable later is the
 * *subjects* it covered, which the extraction step already identified. So the
 * summary is built from the facts the batch produced, falling back to the
 * longest user line only when nothing was extracted.
 *
 * This stays extractive and model-free on purpose: the full text is one query
 * away, and a second model call to restate what the first one just structured
 * would be the wrong trade.
 *
 * @param {Array<{ actor: string, text: string }>} batch - the consolidated messages.
 * @param {'zh'|'en'} language - output language.
 * @param {Array<{ subject?: string, predicate?: string, object?: string }>} [facts]
 *   - facts extracted from this batch, in order.
 * @returns {string} the summary text.
 */
export function summarizeEpisodes(batch, language, facts = []) {
  const topics = [];
  for (const fact of facts) {
    const object = String(fact.object ?? '').trim();
    if (object === '') continue;
    if (topics.some((topic) => topic.includes(object) || object.includes(topic))) continue;
    topics.push(object);
    if (topics.length >= 6) break;
  }

  if (topics.length > 0) {
    const joined = topics.join(language === 'en' ? ', ' : '、');
    return language === 'en'
      ? `${batch.length} messages about: ${joined}`
      : `${batch.length} 条消息，聊到：${joined}`;
  }

  const users = batch.filter((episode) => episode.actor === 'user');
  const longest = users
    .map((episode) => String(episode.text ?? '').replace(/\s+/g, ' '))
    .sort((left, right) => right.length - left.length)[0] ?? String(batch[0]?.text ?? '');
  const condensed = longest.slice(0, 120);
  if (language === 'en') return `${batch.length} messages; mostly about: ${condensed}`;
  return `${batch.length} 条消息，主要在说：${condensed}`;
}

/**
 * Decide whether the idle-based consolidation timer should fire now.
 *
 * Consolidating while the person is still typing burns a model call on a
 * conversation that is about to change; consolidating too late leaves a day of
 * raw episodes unread. Fifteen minutes of quiet is the compromise.
 *
 * @param {{ lastActivityAt: number, lastConsolidatedAt: number, now: number, idleMs?: number, maxWaitMs?: number }} state
 *   - timing state.
 * @returns {boolean} whether to run.
 */
export function shouldConsolidateOnIdle(state) {
  const idleMs = state.idleMs ?? 15 * 60_000;
  const maxWaitMs = state.maxWaitMs ?? 6 * 60 * 60_000;
  const idleFor = state.now - state.lastActivityAt;
  const sinceLast = state.now - state.lastConsolidatedAt;
  if (idleFor < idleMs) return false;
  return sinceLast >= maxWaitMs || sinceLast >= idleMs;
}

/**
 * Let weak memories fade, and retire the ones that never came back.
 *
 * Forgetting is the part of a memory system that is easiest to fake: a
 * `confidence` column that only ever goes up is not a memory, it is an
 * append-only log with a score next to it. This pass is what makes "you
 * remembered the important things" true, because it is what removes the rest.
 *
 * Two stages, deliberately gentle:
 *
 *   1. **Demote** — a fact that is never retrieved loses confidence slowly. The
 *      rate is driven by FSRS retrievability, so a fact with high stability (it
 *      has been recalled many times over a long period) barely moves, while one
 *      stored once and never touched drops quickly.
 *   2. **Retire** — only when confidence, retrievability *and* age are all past
 *      their floors. Retirement is `invalid_at`, not `DELETE`: the episode that
 *      produced it is still there, and a later statement can bring it back.
 *
 * Pinned facts (everything the person said explicitly) never demote. An agent
 * that quietly forgets a birthday because it was not mentioned for two months is
 * worse than one that remembers too much.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} [now] - epoch milliseconds.
 * @param {{ floor?: number, retireBelow?: number, minAgeDays?: number }} [options]
 *   - thresholds; the defaults are tuned to leave a normal conversation intact.
 * @returns {{ demoted: number, retired: number }} what changed.
 */
export function demoteWeakFacts(db, userId, now = Date.now(), options = {}) {
  const floor = options.floor ?? 0.45;
  const retireBelow = options.retireBelow ?? 0.18;
  const minAgeDays = options.minAgeDays ?? 21;

  const facts = liveFacts(db, { subject: userId, limit: 500 })
    .filter((fact) => Number(fact.pinned) !== 1);

  let demoted = 0;
  let retired = 0;

  for (const fact of facts) {
    const id = String(fact.id);
    const reviews = reviewHistory(db, id, 'fact');
    const lastAt = reviews.length > 0 ? reviews[reviews.length - 1] : Number(fact.valid_at ?? fact.created_at ?? now);
    const ageDays = Math.max(0, (now - lastAt) / 86_400_000);
    if (ageDays < minAgeDays) continue;

    const stability = Math.max(0.1, Number(fact.stability ?? 1));
    const recall = retrievability(ageDays, stability);
    // A fact that is still easy to recall does not get demoted no matter how old
    // it is: high retrievability *is* the evidence that it matters.
    //
    // Note this is the opposite band from FSRS's reinforcement window. The window
    // (R ∈ [0.7, 0.9]) marks memories that are slipping and should be reviewed;
    // demotion is for the ones already below it, where "nobody has needed this in
    // a while" has become true. Gating demotion on the window inverts the intent
    // and leaves genuinely stale rows untouched forever — the test caught exactly
    // that, with a 200-day-old unrecalled fact sitting at R = 0.14 and surviving.
    if (recall >= 0.55) continue;

    const confidence = Number(fact.confidence ?? 0.5);
    if (confidence <= floor) continue;

    if (recall < 0.12 && confidence < retireBelow + 0.2) {
      invalidateFact(db, id);
      retired += 1;
      continue;
    }

    // Half-life shaped decay: the drop is proportional to how far past the
    // demotion floor the fact has drifted, so repeated passes approach the floor
    // instead of falling through it in one night.
    const factor = 0.9 + 0.08 * recall;
    const next = Math.max(retireBelow, confidence * factor);
    db.prepare('UPDATE facts SET confidence = ? WHERE id = ? AND invalid_at IS NULL')
      .run(next, id);
    demoted += 1;
  }

  return { demoted, retired };
}
