/**
 * Read/write layer over the memory schema.
 *
 * Every public function takes the `DatabaseSync` handle explicitly rather than
 * hiding it behind a class, because the plugin has exactly two consumers (the
 * write path and the read path) and a plain module is easier to test than a
 * stateful singleton.
 *
 * Invariants enforced here, not in the caller:
 *   - episodes are never updated except for scheduling columns;
 *   - facts are never deleted, only invalidated (`invalid_at` + `superseded_by`);
 *   - every fact write carries at least one evidence pointer;
 *   - the FTS mirror is written in the same transaction as its source row.
 *
 * @module dsh-hippo/store
 */

import { newId, getMeta } from './db.js';
import { segment, matchExpression, estimateTokens } from './tokenize.js';
import { topicsFor } from './topics.js';
import {
  retrievability,
  msToDays,
  review,
  isFading,
} from './fsrs.js';

/** Default sensitivity for text arriving from an external chat channel. */
const DEFAULT_SENSITIVITY = 'personal';

/**
 * Run a function inside an immediate transaction.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {() => T} fn - work to run.
 * @returns {T} the callback result.
 */
export function transact(db, fn) {
  // Nested callers (applyFacts wraps addFact, which also wants a transaction)
  // join the outer transaction instead of opening a second one, which SQLite
  // rejects outright. Only the outermost frame commits or rolls back.
  if (db.isTransaction === true) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A failed rollback means the transaction already ended; the original
      // error is the one worth surfacing.
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* L2: episodes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Append one episode and index it.
 *
 * This is gate 0 of the write path: unconditional, synchronous, zero LLM cost.
 * It runs for every user message and every agent answer, which is what makes
 * "you can always go back to the original words" true.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   sessionId: string,
 *   actor: 'user'|'agent',
 *   text: string,
 *   at?: number,
 *   messageId?: string,
 *   sensitivity?: string,
 *   source?: string,
 * }} episode - the episode to record.
 * @returns {string} the new episode id, or '' when it was empty or duplicate.
 */
export function recordEpisode(db, episode) {
  const text = String(episode.text ?? '').trim();
  if (text.length === 0) return '';
  const id = newId();
  const at = episode.at ?? Date.now();
  const tokens = estimateTokens(text);
  const messageId = episode.messageId ?? null;
  // The unique partial index is the real guard; checking first only avoids
  // paying for a thrown constraint on the common replay path.
  if (messageId !== null && hasEpisodeForMessage(db, episode.sessionId, messageId)) return '';
  try {
    transact(db, () => {
      db.prepare(`
        INSERT INTO episodes
          (id, session_id, message_id, at, actor, text, tokens, sensitivity, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        episode.sessionId,
        messageId,
        at,
        episode.actor,
        text,
        tokens,
        episode.sensitivity ?? DEFAULT_SENSITIVITY,
        episode.source ?? 'observed',
      );
      db.prepare('INSERT INTO episodes_fts (body, episode_id) VALUES (?, ?)')
        .run(segment(text), id);
    });
  } catch (error) {
    // A concurrent replay can still lose the race; that is a duplicate, not a
    // failure, so it reports the same "nothing stored" answer.
    if (String(error?.message ?? '').includes('UNIQUE constraint')) return '';
    throw error;
  }
  return id;
}

/**
 * Whether an episode already exists for a session message.
 *
 * The harness can deliver the same message again (resume, fork, reconnect), and
 * recording it twice would inflate the activation history of that memory.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} sessionId - session id.
 * @param {string} messageId - message id.
 * @returns {boolean} true when already recorded.
 */
export function hasEpisodeForMessage(db, sessionId, messageId) {
  if (messageId === undefined || messageId === null) return false;
  const row = db.prepare('SELECT 1 AS hit FROM episodes WHERE session_id = ? AND message_id = ? LIMIT 1')
    .get(sessionId, messageId);
  return row !== undefined;
}

/**
 * Most recent episodes, newest first.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ limit?: number, sessionId?: string, sinceAt?: number }} [options] - filters.
 * @returns {Array<Record<string, unknown>>} episode rows.
 */
export function recentEpisodes(db, options = {}) {
  const limit = options.limit ?? 20;
  if (options.sessionId !== undefined && options.sinceAt !== undefined) {
    return db.prepare(`
      SELECT * FROM episodes WHERE session_id = ? AND at >= ?
      ORDER BY at DESC LIMIT ?
    `).all(options.sessionId, options.sinceAt, limit);
  }
  if (options.sessionId !== undefined) {
    return db.prepare('SELECT * FROM episodes WHERE session_id = ? ORDER BY at DESC LIMIT ?')
      .all(options.sessionId, limit);
  }
  if (options.sinceAt !== undefined) {
    return db.prepare('SELECT * FROM episodes WHERE at >= ? ORDER BY at DESC LIMIT ?')
      .all(options.sinceAt, limit);
  }
  return db.prepare('SELECT * FROM episodes ORDER BY at DESC LIMIT ?').all(limit);
}

/**
 * Episodes not yet folded into semantic memory, oldest first.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} limit - maximum count.
 * @returns {Array<Record<string, unknown>>} episode rows.
 */
export function unconsolidatedEpisodes(db, limit) {
  return db.prepare(`
    SELECT * FROM episodes
    WHERE consolidated = 0 AND superseded_by IS NULL
    ORDER BY at ASC LIMIT ?
  `).all(limit);
}

/**
 * Mark episodes as consolidated by a given reflection.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string[]} ids - episode ids.
 * @param {string} reflectionId - the reflection that absorbed them.
 */
export function markConsolidated(db, ids, reflectionId) {
  if (ids.length === 0) return;
  const stmt = db.prepare('UPDATE episodes SET consolidated = 1, superseded_by = ? WHERE id = ?');
  transact(db, () => {
    for (const id of ids) stmt.run(reflectionId, id);
  });
}

/* ------------------------------------------------------------------ */
/* L3: semantic facts                                                  */
/* ------------------------------------------------------------------ */

/**
 * Find the live facts that most plausibly concern the same statement.
 *
 * This is the input to the ADD/UPDATE/INVALIDATE/NOOP decision. It combines a
 * structured match on (subject, predicate) with an FTS match on the object, so
 * "likes coffee" and "likes tea" collide while "likes coffee" and "works at X"
 * do not.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ subject: string, predicate: string, object: string }} candidate - the candidate fact.
 * @param {number} [limit] - maximum rows.
 * @returns {Array<Record<string, unknown>>} live facts, most relevant first.
 */
export function similarFacts(db, candidate, limit = 5) {
  const byKey = db.prepare(`
    SELECT * FROM facts
    WHERE invalid_at IS NULL AND subject = ? AND predicate = ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(candidate.subject, candidate.predicate, limit);
  if (byKey.length > 0) return byKey;

  const expr = matchExpression(`${candidate.predicate} ${candidate.object}`);
  if (expr === null) return [];
  try {
    return db.prepare(`
      SELECT f.* FROM facts_fts x
      JOIN facts f ON f.id = x.fact_id
      WHERE facts_fts MATCH ? AND f.invalid_at IS NULL
      ORDER BY bm25(facts_fts) LIMIT ?
    `).all(expr, limit);
  } catch {
    return [];
  }
}

/**
 * Insert a new live fact with its evidence.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   subject: string, predicate: string, object: string,
 *   confidence?: number, evidence?: string[], sensitivity?: string,
 *   source?: string, needsClarification?: boolean, pinned?: boolean,
 *   costTokens?: number, validAt?: number,
 * }} fact - the fact to insert.
 * @returns {string} the new fact id.
 */
export function addFact(db, fact) {
  const now = Date.now();
  const id = newId();
  const evidence = fact.evidence ?? [];
  transact(db, () => {
    db.prepare(`
      INSERT INTO facts
        (id, subject, predicate, object, confidence, valid_at, sensitivity,
         source, needs_clarification, pinned, cost_tokens, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      fact.subject,
      fact.predicate,
      fact.object,
      fact.confidence ?? 0.6,
      fact.validAt ?? now,
      fact.sensitivity ?? DEFAULT_SENSITIVITY,
      fact.source ?? 'inferred',
      fact.needsClarification === true ? 1 : 0,
      fact.pinned === true ? 1 : 0,
      fact.costTokens ?? 0,
      now,
      now,
    );
    db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)')
      .run(segment(`${fact.subject} ${fact.predicate} ${fact.object}`), id);
    const stmt = db.prepare('INSERT OR IGNORE INTO evidence (fact_id, episode_id, added_at) VALUES (?, ?, ?)');
    for (const episodeId of evidence) stmt.run(id, episodeId, now);
  });
  return id;
}

/**
 * Strengthen an existing fact: raise confidence and attach new evidence.
 *
 * Confidence rises sub-linearly so a fact repeated ten times does not become
 * certain — repetition is evidence of habit, not of truth.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} factId - the fact to update.
 * @param {{ evidence?: string[], object?: string, confidenceDelta?: number, costTokens?: number }} patch
 *   - what the new observation adds.
 */
export function reinforceFact(db, factId, patch = {}) {
  const now = Date.now();
  const row = db.prepare('SELECT confidence, object, cost_tokens FROM facts WHERE id = ?').get(factId);
  if (row === undefined) return;
  const delta = patch.confidenceDelta ?? 0.05;
  const confidence = Math.min(0.98, Number(row.confidence) + delta * (1 - Number(row.confidence)));
  const object = patch.object ?? String(row.object);
  transact(db, () => {
    db.prepare(`
      UPDATE facts SET confidence = ?, object = ?, cost_tokens = cost_tokens + ?, updated_at = ?
      WHERE id = ?
    `).run(confidence, object, patch.costTokens ?? 0, now, factId);
    db.prepare('DELETE FROM facts_fts WHERE fact_id = ?').run(factId);
    db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)')
      .run(segment(`${String(row.object)} ${object}`), factId);
    const stmt = db.prepare('INSERT OR IGNORE INTO evidence (fact_id, episode_id, added_at) VALUES (?, ?, ?)');
    for (const episodeId of patch.evidence ?? []) stmt.run(factId, episodeId, now);
  });
}

/**
 * Retire a fact without deleting it.
 *
 * The old row keeps its text and evidence so the history of a belief stays
 * inspectable — that is the difference between changing your mind and having
 * no memory of ever thinking otherwise.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} factId - the fact to retire.
 * @param {{ supersededBy?: string, at?: number }} [options] - replacement pointer.
 */
export function invalidateFact(db, factId, options = {}) {
  const at = options.at ?? Date.now();
  db.prepare('UPDATE facts SET invalid_at = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL')
    .run(at, options.supersededBy ?? null, at, factId);
}

/**
 * Live facts, optionally filtered by subject.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ subject?: string, limit?: number }} [options] - filters.
 * @returns {Array<Record<string, unknown>>} fact rows.
 */
export function liveFacts(db, options = {}) {
  const limit = options.limit ?? 100;
  if (options.subject !== undefined) {
    return db.prepare(`
      SELECT * FROM facts WHERE invalid_at IS NULL AND subject = ?
      ORDER BY pinned DESC, confidence DESC, updated_at DESC LIMIT ?
    `).all(options.subject, limit);
  }
  return db.prepare(`
    SELECT * FROM facts WHERE invalid_at IS NULL
    ORDER BY pinned DESC, confidence DESC, updated_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Facts that contradict something the user later changed, awaiting a question.
 *
 * A contradiction is written as a *new* fact flagged for clarification, with the
 * old one retired. This query therefore returns the newer side, and the old side
 * is reachable through `superseded_by` — so a resolution can restore a belief
 * that was retired too eagerly.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} fact rows with their superseded peer attached.
 */
export function pendingClarifications(db, limit = 5) {
  const rows = db.prepare(`
    SELECT * FROM facts WHERE needs_clarification = 1
    ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
  return rows.map((row) => {
    const previous = db.prepare('SELECT * FROM facts WHERE superseded_by = ? ORDER BY invalid_at DESC LIMIT 1')
      .get(String(row.id));
    return { ...row, previous: previous ?? null };
  });
}

/**
 * Resolve a clarification once the user has answered.
 *
 * Three outcomes, and they are genuinely different:
 *
 *   - `keep_new`  — the newer value wins; the old row stays retired. Nothing to
 *                   do beyond clearing the flag, the history already says it.
 *   - `keep_old`  — the change was wrong or misheard. The old fact is revived
 *                   rather than re-inserted, so its evidence and review history
 *                   survive; the newer one is retired instead.
 *   - `both_wrong` — neither version is true. Both are retired and the attribute
 *                   is left empty, which is better than keeping a guess.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} factId - the fact under question (the newer side).
 * @param {'keep_new'|'keep_old'|'both_wrong'} resolution - what the person said.
 * @returns {{ resolved: boolean, revivedId: string|null }} what happened.
 */
export function resolveClarification(db, factId, resolution) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(factId);
  if (row === undefined) return { resolved: false, revivedId: null };
  const previous = db.prepare('SELECT * FROM facts WHERE superseded_by = ? ORDER BY invalid_at DESC LIMIT 1')
    .get(factId);

  transact(db, () => {
    db.prepare('UPDATE facts SET needs_clarification = 0, updated_at = ? WHERE id = ?').run(now, factId);

    if (resolution === 'keep_new') {
      // The newer side is already live and already carries the evidence that
      // displaced the old one; insisting on more confidence is wrong.
      db.prepare('UPDATE facts SET confidence = MIN(0.98, confidence + 0.1), updated_at = ? WHERE id = ?')
        .run(now, factId);
      return;
    }

    if (resolution === 'keep_old') {
      invalidateFact(db, factId, { at: now });
      if (previous !== undefined) {
        db.prepare('UPDATE facts SET invalid_at = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?')
          .run(now, String(previous.id));
        db.prepare('UPDATE facts SET confidence = MIN(0.98, confidence + 0.15) WHERE id = ?')
          .run(String(previous.id));
      }
      return;
    }

    // both_wrong
    invalidateFact(db, factId, { at: now });
    if (previous !== undefined) invalidateFact(db, String(previous.id), { at: now });
  });

  return {
    resolved: true,
    revivedId: resolution === 'keep_old' && previous !== undefined ? String(previous.id) : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reflections                                                         */
/* ------------------------------------------------------------------ */

/**
 * Store a consolidation product, which must cite what it was built from.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   kind: 'summary'|'insight'|'pattern', text: string, level?: number,
 *   confidence?: number, evidenceEpisodes?: string[], evidenceFacts?: string[],
 * }} reflection - the reflection to store.
 * @returns {string} the new reflection id.
 */
export function addReflection(db, reflection) {
  const now = Date.now();
  const id = newId();
  transact(db, () => {
    db.prepare(`
      INSERT INTO reflections (id, kind, text, level, confidence, valid_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      reflection.kind,
      reflection.text,
      reflection.level ?? 0,
      reflection.confidence ?? 0.6,
      now,
      now,
    );
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO reflection_evidence (reflection_id, fact_id, episode_id)
      VALUES (?, ?, ?)
    `);
    for (const factId of reflection.evidenceFacts ?? []) stmt.run(id, factId, null);
    for (const episodeId of reflection.evidenceEpisodes ?? []) stmt.run(id, null, episodeId);
  });
  return id;
}

/**
 * Live reflections, newest first.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} reflection rows.
 */
export function liveReflections(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM reflections WHERE invalid_at IS NULL
    ORDER BY level DESC, created_at DESC LIMIT ?
  `).all(limit);
}

/* ------------------------------------------------------------------ */
/* Links                                                               */
/* ------------------------------------------------------------------ */

/**
 * Record an edge between two memories.
 *
 * Links are undirected in meaning, so both directions are written: SQLite has no
 * cheap way to query "either column", and the graph is small enough that the
 * duplication is free.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   from: string, to: string, kind: 'shared_subject'|'temporal'|'semantic'|'supports',
 *   weight?: number,
 * }} link - the edge.
 */
export function addLink(db, link) {
  if (link.from === link.to) return;
  const now = Date.now();
  const weight = link.weight ?? 0.5;
  const stmt = db.prepare(`
    INSERT INTO links (from_id, to_id, kind, weight, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (from_id, to_id, kind) DO UPDATE SET weight = MAX(weight, excluded.weight)
  `);
  stmt.run(link.from, link.to, link.kind, weight, now);
  stmt.run(link.to, link.from, link.kind, weight, now);
}

/**
 * Neighbours of one memory.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} id - the memory id.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} link rows, strongest first.
 */
export function linksFrom(db, id, limit = 12) {
  return db.prepare('SELECT * FROM links WHERE from_id = ? ORDER BY weight DESC LIMIT ?').all(id, limit);
}

/**
 * Spread activation one hop from a set of seed ids.
 *
 * This is the difference between a search box and a memory: a cue matches a few
 * things lexically, and those things drag their neighbours in with a decayed
 * score. Without it, "年糕" never reaches the fact that the cat is a calico in
 * a photo from last spring unless that sentence happens to contain the word.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {Array<{ id: string, score: number }>} seeds - already-scored memories.
 * @param {{ decay?: number, limit?: number }} [options] - spread options.
 * @returns {Map<string, number>} bonus score per neighbour id.
 */
export function spreadActivation(db, seeds, options = {}) {
  const decay = options.decay ?? 0.35;
  const limit = options.limit ?? 40;
  /** @type {Map<string, number>} */
  const bonus = new Map();
  for (const seed of seeds.slice(0, 8)) {
    for (const link of linksFrom(db, seed.id, 8)) {
      // Only positive evidence spreads. A negatively-scored seed is already
      // being filtered out, and letting it subtract from a neighbour would make
      // a strong memory disappear because it is related to a weak one.
      const delta = Math.max(0, seed.score) * decay * Number(link.weight);
      if (delta <= 0) continue;
      const id = String(link.to_id);
      bonus.set(id, (bonus.get(id) ?? 0) + delta);
    }
  }
  return new Map([...bonus.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

/* ------------------------------------------------------------------ */
/* Relationship state                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ensure a relationship row exists and return it.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @returns {Record<string, unknown>} the relationship row.
 */
export function ensureRelationship(db, userId) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM relationship WHERE user_id = ?').get(userId);
  if (existing !== undefined) return existing;
  db.prepare(`
    INSERT INTO relationship (user_id, familiarity, trust, mood_baseline, revision, last_updated)
    VALUES (?, 0.0, 0.5, 0.0, 1, ?)
  `).run(userId, now);
  return db.prepare('SELECT * FROM relationship WHERE user_id = ?').get(userId);
}

/**
 * Recompute the derived relational scalars.
 *
 * `familiarity` is a saturating count of distinct lived moments, not of
 * tokens: a thousand messages in one day move it less than fifty days of
 * visits. Trust moves only on explicit signals, because inferring trust from
 * message volume is how companion agents become sycophants.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @returns {Record<string, unknown>} the updated relationship row.
 */
export function recomputeRelationship(db, userId) {
  ensureRelationship(db, userId);
  const episodeCount = Number(db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n);
  const activeDays = Number(db.prepare(`
    SELECT COUNT(DISTINCT date(at / 1000, 'unixepoch', 'localtime')) AS n FROM episodes
  `).get().n);
  const familiarity = 1 - Math.exp(-(activeDays / 12 + episodeCount / 400));
  const moodRow = db.prepare('SELECT AVG(valence) AS v FROM affect WHERE user_id = ?').get(userId);
  const moodBaseline = moodRow === null || moodRow === undefined || moodRow.v === null
    ? 0
    : Number(moodRow.v);
  const now = Date.now();
  db.prepare(`
    UPDATE relationship
    SET familiarity = ?, mood_baseline = ?, revision = revision + 1, last_updated = ?
    WHERE user_id = ?
  `).run(familiarity, moodBaseline, now, userId);
  return db.prepare('SELECT * FROM relationship WHERE user_id = ?').get(userId);
}

/**
 * Move trust by one explicit signal.
 *
 * Deliberately saturating and slow: trust climbs by a few percent per genuine
 * disclosure and falls faster than it rises, because a companion that recovers
 * from a rupture at the same rate it took to build is not tracking anything.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} delta - signed change, in proportion.
 * @param {number} [now] - epoch milliseconds.
 * @returns {number} the new trust value.
 */
export function adjustTrust(db, userId, delta, now = Date.now()) {
  ensureRelationship(db, userId);
  const row = db.prepare('SELECT trust FROM relationship WHERE user_id = ?').get(userId);
  const current = Number(row?.trust ?? 0.5);
  // Asymmetric: a negative signal moves roughly twice as far as a positive one.
  const scaled = delta < 0 ? delta * 2 : delta;
  const next = Math.max(0, Math.min(1, current + scaled));
  db.prepare('UPDATE relationship SET trust = ?, revision = revision + 1, last_updated = ? WHERE user_id = ?')
    .run(next, now, userId);
  return next;
}

/**
 * Open loops that are due (or overdue) for follow-up, newest deadline first.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} now - epoch milliseconds.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} open loop rows.
 */
export function dueLoops(db, userId, now, limit = 5) {
  return db.prepare(`
    SELECT * FROM open_loops
    WHERE user_id = ? AND closed_at IS NULL AND follow_after IS NOT NULL AND follow_after <= ?
    ORDER BY follow_after ASC LIMIT ?
  `).all(userId, now, limit);
}

/**
 * Every still-open loop, for the resident prompt section.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} open loop rows.
 */
export function openLoops(db, userId, limit = 8) {
  return db.prepare(`
    SELECT * FROM open_loops WHERE user_id = ? AND closed_at IS NULL
    ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

/**
 * Track something the user said they would do or that is due later.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId: string, text: string, followAfter?: number | null }} loop - the loop to record.
 * @returns {string} the new loop id.
 */
export function addOpenLoop(db, loop) {
  const id = newId();
  db.prepare(`
    INSERT INTO open_loops (id, user_id, text, created_at, follow_after)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, loop.userId, loop.text, Date.now(), loop.followAfter ?? null);
  return id;
}

/**
 * Close a loop, optionally recording who closed it.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} loopId - the loop to close.
 * @param {string} [closedBy] - 'agent' or 'user'.
 */
export function closeOpenLoop(db, loopId, closedBy = 'agent') {
  db.prepare('UPDATE open_loops SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL')
    .run(Date.now(), closedBy, loopId);
}

/**
 * Record an affect observation.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId: string, valence: number, arousal: number, note?: string }} affect - observation.
 */
export function recordAffect(db, affect) {
  db.prepare('INSERT OR REPLACE INTO affect (user_id, at, valence, arousal, note) VALUES (?, ?, ?, ?, ?)')
    .run(affect.userId, Date.now(), affect.valence, affect.arousal, affect.note ?? null);
}

/* ------------------------------------------------------------------ */
/* Retrieval: ACT-R activation x lexical relevance x salience          */
/* ------------------------------------------------------------------ */

/**
 * ACT-R base-level activation from a memory's review history.
 *
 * `A = ln(sum over reviews of t_k^-0.5)`, where `t_k` is the age in days of
 * each review. This is the piece that makes a memory retrieved last week
 * outrank one retrieved once a year ago, without storing a separate
 * "importance" number.
 *
 * @param {number[]} reviewTimes - epoch ms of each past retrieval, most recent included.
 * @param {number} now - epoch milliseconds.
 * @returns {number} activation; can be negative.
 */
export function baseLevelActivation(reviewTimes, now) {
  if (reviewTimes.length === 0) return -10;
  let sum = 0;
  for (const t of reviewTimes) {
    const days = Math.max(msToDays(now - t), 0.02);
    sum += Math.pow(days, -0.5);
  }
  return Math.log(sum);
}

/**
 * Ranked recall across episodes and facts.
 *
 * The score is deliberately multiplicative, so a memory needs to be *both*
 * relevant and still retrievable. An additive score lets a very old but
 * lexically perfect match win, which is exactly the failure mode that makes
 * retrieved memories feel like a database dump.
 *
 * Fan effect: when the cue matches more than {@link FAN_LIMIT} candidates the
 * whole set is damped, because a cue that matches everything distinguishes
 * nothing.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   cue: string, now?: number, limit?: number,
 *   includeEpisodes?: boolean, includeFacts?: boolean, userId?: string,
 * }} query - the recall request.
 * @returns {{ episodes: Array<Record<string, unknown>>, facts: Array<Record<string, unknown>>, terms: number }}
 *   scored rows, each with a `score` field.
 */
export function recall(db, query) {
  const now = query.now ?? Date.now();
  const limit = query.limit ?? 8;
  const expr = matchExpression(query.cue);
  const wantEpisodes = query.includeEpisodes !== false;
  const wantFacts = query.includeFacts !== false;
  if (expr === null) {
    return { episodes: [], facts: [], terms: 0 };
  }

  // Widen the fact query with the attribute keys the cue is asking about.
  //
  // "我的工作怎么样" contains no character of the stored fact `works_as=插画师`,
  // so the lexical expression alone returns nothing. Episodes are deliberately
  // NOT widened: a conversation log is searched for what was literally said, and
  // adding 职业 to it would pull in every sentence containing the word.
  const topicPredicates = topicsFor(query.cue);
  let factExpr = expr;
  if (topicPredicates.length > 0) {
    const extra = topicPredicates.map((predicate) => `"${predicate.replace(/"/g, '""')}"`);
    factExpr = `${expr} OR ${extra.join(' OR ')}`;
  }

  let episodeRows = [];
  if (wantEpisodes) {
    try {
      episodeRows = db.prepare(`
        SELECT e.*, bm25(episodes_fts) AS rank
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.episode_id
        WHERE episodes_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(expr, limit * 4);
    } catch {
      episodeRows = [];
    }
  }

  let factRows = [];
  if (wantFacts) {
    try {
      factRows = db.prepare(`
        SELECT f.*, bm25(facts_fts) AS rank
        FROM facts_fts
        JOIN facts f ON f.id = facts_fts.fact_id
        WHERE facts_fts MATCH ? AND f.invalid_at IS NULL
        ORDER BY rank LIMIT ?
      `).all(factExpr, limit * 4);
    } catch {
      factRows = [];
    }
  }

  const scoreRows = (rows, kind) => {
    const fan = rows.length > FAN_LIMIT ? Math.pow(rows.length / FAN_LIMIT, -0.5) : 1;
    return rows.map((row) => {
      const reviews = reviewHistory(db, String(row.id), kind);
      const activation = baseLevelActivation(reviews.length > 0 ? reviews : [Number(row.at ?? row.created_at ?? now)], now);
      const ageDays = msToDays(now - Number(row.at ?? row.created_at ?? now));
      const recency = Math.exp(-ageDays / 14);
      const r = retrievability(ageDays, Number(row.stability ?? 1));
      const relevance = 1 / (1 + Math.max(0, Number(row.rank ?? 0)));
      const salience = String(row.sensitivity ?? '') === 'sensitive' ? 0.9 : Number(row.confidence ?? 0.5);
      const score = (0.5 * activation + 1.0 * relevance + 0.4 * salience + 0.3 * recency) * r * fan;
      return { ...row, kind, score, activation, recency };
    }).sort((a, b) => b.score - a.score);
  };

  const scoredEpisodes = scoreRows(episodeRows, 'episode');
  const scoredFacts = scoreRows(factRows, 'fact');

  // One hop of associative spread.
  //
  // The distinction that matters here is boosting versus admitting. A neighbour
  // of a direct hit is *corroborating* evidence: the cue matched "年糕", and the
  // linked fact says the cat is a calico, so that fact can be ranked a little
  // higher than its own lexical score suggests. But a neighbour that was never
  // matched must not be admitted on its own, because every fact about one person
  // is linked to every other fact from the same conversation, and admitting them
  // would make each recall return the whole graph in link order rather than in
  // relevance order.
  //
  // So spread only admits when the lexical side came back thin. A vague cue
  // ("你记得我爱做什么吗") matches almost nothing and needs the graph to find
  // anything at all; a specific cue ("橘猫") already knows what it wants.
  const directCount = scoredFacts.length + scoredEpisodes.length;
  const admitThreshold = Math.max(2, Math.ceil(limit / 2));
  const admit = directCount < admitThreshold;

  const bonus = spreadActivation(db, [...scoredFacts, ...scoredEpisodes], { decay: 0.35 });
  const byId = new Map();
  for (const row of scoredEpisodes) byId.set(String(row.id), row);
  for (const row of scoredFacts) byId.set(String(row.id), row);

  for (const [id, delta] of bonus) {
    const row = byId.get(id);
    if (row !== undefined) {
      row.score += delta;
      continue;
    }
    if (!admit) continue;
    const node = loadNode(db, id, now);
    if (node === null) continue;
    node.score += delta;
    byId.set(id, node);
    if (node.kind === 'episode') scoredEpisodes.push(node);
    else scoredFacts.push(node);
  }

  return {
    episodes: scoredEpisodes.sort((a, b) => b.score - a.score).slice(0, limit),
    facts: scoredFacts.sort((a, b) => b.score - a.score).slice(0, limit),
    terms: expr.split(' OR ').length,
  };
}

/**
 * Fetch one memory by id, whichever table it lives in.
 *
 * Links are stored by id alone, so a neighbour's type has to be discovered. The
 * row is scored as if it had matched weakly, which keeps the final ranking
 * comparable with lexically-retrieved rows.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} id - memory id.
 * @param {number} now - epoch milliseconds.
 * @returns {Record<string, unknown> | null} a scored row, or null when gone.
 */
function loadNode(db, id, now) {
  const fact = db.prepare('SELECT * FROM facts WHERE id = ? AND invalid_at IS NULL').get(id);
  if (fact !== undefined) {
    const ageDays = msToDays(now - Number(fact.updated_at ?? now));
    const r = retrievability(ageDays, Number(fact.stability ?? 1));
    const salience = String(fact.sensitivity ?? '') === 'sensitive' ? 0.9 : Number(fact.confidence ?? 0.5);
    return { ...fact, kind: 'fact', rank: 0.5, score: (0.4 * salience) * r * 0.5, recency: Math.exp(-ageDays / 14) };
  }
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  if (episode !== undefined) {
    const ageDays = msToDays(now - Number(episode.at ?? now));
    const r = retrievability(ageDays, Number(episode.stability ?? 1));
    return { ...episode, kind: 'episode', rank: 0.5, score: 0.2 * r * 0.5, recency: Math.exp(-ageDays / 14) };
  }
  return null;
}

/**
 * How many times the cue matched, before truncation — exposed so the caller can
 * detect "this query is too broad to be meaningful".
 */
export const FAN_LIMIT = 20;

/**
 * Past retrieval timestamps for one memory.
 *
 * M0 stores no separate review log: a memory's own creation time is its first
 * exposure, and later retrievals are appended as they happen. Keeping this in
 * one small table rather than a JSON column means the activation query stays a
 * single indexed read.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} id - episode or fact id.
 * @param {'episode'|'fact'} kind - which table the id belongs to.
 * @returns {number[]} epoch-ms timestamps.
 */
export function reviewHistory(db, id, kind) {
  const rows = db.prepare('SELECT at FROM reviews WHERE target_id = ? AND target_kind = ? ORDER BY at ASC')
    .all(id, kind);
  return rows.map((row) => Number(row.at));
}

/**
 * Record that a memory was retrieved, which is what feeds activation next time.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} id - episode or fact id.
 * @param {'episode'|'fact'} kind - which table the id belongs to.
 * @param {number} [at] - epoch milliseconds.
 */
export function recordReview(db, id, kind, at = Date.now()) {
  // Retrieving twice inside one millisecond is the same observation; the
  // composite key already says so.
  db.prepare('INSERT OR IGNORE INTO reviews (target_id, target_kind, at) VALUES (?, ?, ?)').run(id, kind, at);
}

/**
 * Apply one FSRS grade to a stored memory.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} id - episode or fact id.
 * @param {'episode'|'fact'} kind - which table the id belongs to.
 * @param {1|2|3|4} grade - review grade.
 * @param {number} [now] - epoch milliseconds.
 */
export function gradeMemory(db, id, kind, grade, now = Date.now()) {
  const table = kind === 'episode' ? 'episodes' : 'facts';
  const row = db.prepare(`
    SELECT stability, difficulty, last_review_at, review_count FROM ${table} WHERE id = ?
  `).get(id);
  if (row === undefined) return;
  const state = {
    stability: Number(row.stability),
    difficulty: Number(row.difficulty),
    lastReviewAt: row.last_review_at === null ? null : Number(row.last_review_at),
    reviewCount: Number(row.review_count),
  };
  review(state, grade, now);
  db.prepare(`
    UPDATE ${table}
    SET stability = ?, difficulty = ?, last_review_at = ?, review_count = ?
    WHERE id = ?
  `).run(state.stability, state.difficulty, state.lastReviewAt, state.reviewCount, id);
}

/**
 * Memories whose retrievability has entered the reinforcement window.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} now - epoch milliseconds.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} fact rows.
 */
export function fadingFacts(db, now, limit = 20) {
  const rows = db.prepare(`
    SELECT * FROM facts WHERE invalid_at IS NULL AND last_review_at IS NOT NULL
    ORDER BY last_review_at ASC LIMIT ?
  `).all(limit * 4);
  return rows.filter((row) => isFading({
    stability: Number(row.stability),
    lastReviewAt: Number(row.last_review_at),
  }, now)).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */

/**
 * Today's spent extraction budget.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} [day] - `YYYY-MM-DD`; defaults to today in local time.
 * @returns {number} tokens spent.
 */
export function spentToday(db, day = localDay()) {
  const row = db.prepare('SELECT tokens FROM budget WHERE day = ?').get(day);
  return row === undefined ? 0 : Number(row.tokens);
}

/**
 * Charge the daily budget.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} tokens - tokens to add.
 * @param {string} [day] - `YYYY-MM-DD`.
 */
export function chargeBudget(db, tokens, day = localDay()) {
  db.prepare(`
    INSERT INTO budget (day, tokens) VALUES (?, ?)
    ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens
  `).run(day, tokens);
}

/**
 * Local calendar day key.
 * @returns {string} `YYYY-MM-DD`.
 */
export function localDay() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The configured user id, defaulting to `'user'`.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @returns {string} the user id.
 */
export function userId(db) {
  return getMeta(db, 'user_id') ?? 'user';
}
