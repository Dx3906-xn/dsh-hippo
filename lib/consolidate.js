/**
 * Consolidation: the offline pass that turns raw moments into understanding.
 *
 * Three jobs, each behind its own gate, because consolidation is where a
 * companion agent most easily invents a self-consistent fiction:
 *
 *   A. compress — episodes → candidate facts + a summary reflection, staged;
 *   B. audit   — a second look that rejects claims their evidence cannot carry;
 *   C. materialize — recompute the derived relational state, append-only.
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
  transact,
  recomputeRelationship,
  userId as defaultUserId,
} from './store.js';
import { decide, extractFacts } from './extract.js';

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
      text: summarizeEpisodes(batch, deps.language ?? 'zh'),
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

  const reflectionId = addReflection(db, {
    kind: 'summary',
    text: summarizeEpisodes(batch, deps.language ?? 'zh'),
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
  };
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

  transact(db, () => {
    for (const candidate of facts) {
      const subject = String(candidate.subject) === 'user' ? userId : String(candidate.subject);
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
 * This is deliberately extractive: the first user line plus the span, with no
 * model call. A summary that costs money and can hallucinate is worse than one
 * that reads like an index entry, because the full text is always one query
 * away.
 *
 * @param {Array<{ actor: string, text: string }>} batch - the consolidated messages.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} the summary text.
 */
export function summarizeEpisodes(batch, language) {
  const users = batch.filter((episode) => episode.actor === 'user');
  const sample = users[0]?.text ?? batch[0]?.text ?? '';
  const condensed = String(sample).replace(/\s+/g, ' ').slice(0, 160);
  if (language === 'en') {
    return `${batch.length} messages; started with: ${condensed}`;
  }
  return `${batch.length} 条消息，起于：${condensed}`;
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
 * Facts whose confidence has fallen below the point where they should keep
 * occupying the resident prompt. They stay in the database and stay searchable.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} floor - confidence floor.
 * @returns {Array<Record<string, unknown>>} demoted facts.
 */
export function demoteWeakFacts(db, userId, floor = 0.3) {
  return liveFacts(db, { subject: userId, limit: 500 })
    .filter((fact) => Number(fact.pinned) !== 1 && Number(fact.confidence) < floor);
}
