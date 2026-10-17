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
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {number} limit - maximum rows.
 * @returns {Array<Record<string, unknown>>} fact rows.
 */
export function pendingClarifications(db, limit = 5) {
  return db.prepare(`
    SELECT * FROM facts WHERE needs_clarification = 1
    ORDER BY updated_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Resolve a clarification once the user has answered.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} factId - the fact under question.
 * @param {boolean} keep - whether the fact survives.
 */
export function resolveClarification(db, factId, keep) {
  const now = Date.now();
  if (keep) {
    db.prepare('UPDATE facts SET needs_clarification = 0, confidence = MIN(0.98, confidence + 0.2), updated_at = ? WHERE id = ?')
      .run(now, factId);
  } else {
    invalidateFact(db, factId, { at: now });
    db.prepare('UPDATE facts SET needs_clarification = 0 WHERE id = ?').run(factId);
  }
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
      `).all(expr, limit * 4);
    } catch {
      factRows = [];
    }
  }

  const scoreRows = (rows) => {
    const fan = rows.length > FAN_LIMIT ? Math.pow(rows.length / FAN_LIMIT, -0.5) : 1;
    return rows.map((row) => {
      const reviews = reviewHistory(db, String(row.id), 'episode');
      const activation = baseLevelActivation(reviews.length > 0 ? reviews : [Number(row.at ?? row.created_at ?? now)], now);
      const ageDays = msToDays(now - Number(row.at ?? row.created_at ?? now));
      const recency = Math.exp(-ageDays / 14);
      const r = retrievability(ageDays, Number(row.stability ?? 1));
      const relevance = 1 / (1 + Math.max(0, Number(row.rank ?? 0)));
      const salience = String(row.sensitivity ?? '') === 'sensitive' ? 0.9 : Number(row.confidence ?? 0.5);
      const score = (0.5 * activation + 1.0 * relevance + 0.4 * salience + 0.3 * recency) * r * fan;
      return { ...row, score, activation, recency };
    }).sort((a, b) => b.score - a.score);
  };

  return {
    episodes: scoreRows(episodeRows).slice(0, limit),
    facts: scoreRows(factRows).slice(0, limit),
    terms: expr.split(' OR ').length,
  };
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
