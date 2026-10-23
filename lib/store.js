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
import { topicsFor, synonymsFor } from './topics.js';
import { SINGLE_VALUED } from './extract.js';
import {
  retrievability,
  msToDays,
  review,
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
 *   speakerId?: string,
 *   speakerName?: string,
 *   channel?: 'direct'|'group',
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
          (id, session_id, message_id, at, actor, text, tokens, sensitivity, source, arousal,
           speaker_id, speaker_name, channel)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        Math.max(0, Math.min(1, Number(episode.arousal ?? 0))),
        episode.speakerId ?? '',
        episode.speakerName ?? '',
        episode.channel ?? 'direct',
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
 * Retire an episode because the person asked for it to be forgotten.
 *
 * Forgetting on request is not the same as decay. Decay is the system deciding a
 * memory stopped mattering; this is the person deciding, and it must be immediate
 * and complete in the parts that are visible to the model. The row stays — the
 * log is append-only and deleting it would make "what did it know when" unanswerable
 * — but its text is replaced and its FTS row removed, so it can no longer be
 * recalled or quoted.
 *
 * Episodes are only half of it: any fact whose evidence was the redacted episode
 * has lost its support, so those are retired too. A fact that survives its own
 * evidence is a fact the system invented.
 *
 * Summaries are the other half. A reflection is written out of the messages it
 * covers, so the forgotten sentence sits inside it word for word, and it is
 * rendered into the resident prompt on every turn. There is no per-sentence
 * provenance to cut it out with, so a summary that cited the redacted episode is
 * invalidated and blanked, and the messages it had summarized go back in the
 * queue — a "forget that" that leaves the same words in the prompt, inside a
 * summary, is not a forget.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} episodeId - the episode to redact.
 * @param {{ reason?: string, now?: number }} [options] - why, and when.
 * @returns {{ redacted: boolean, factsRetired: number, reflectionsInvalidated: number }} what changed.
 */
export function redactEpisode(db, episodeId, options = {}) {
  const row = db.prepare('SELECT id, at FROM episodes WHERE id = ? AND redacted_at IS NULL').get(episodeId);
  if (row === undefined) return { redacted: false, factsRetired: 0, reflectionsInvalidated: 0 };

  const now = options.now ?? Date.now();
  let factsRetired = 0;
  let reflectionsInvalidated = 0;
  transact(db, () => {
    db.prepare(`UPDATE episodes SET text = '', redacted_at = ?, redacted_reason = ? WHERE id = ?`)
      .run(now, String(options.reason ?? 'forgotten'), episodeId);
    db.prepare('DELETE FROM episodes_fts WHERE episode_id = ?').run(episodeId);

    const summaries = db.prepare('SELECT DISTINCT reflection_id FROM reflection_evidence WHERE episode_id = ?')
      .all(episodeId);
    for (const link of summaries) {
      const reflectionId = String(link.reflection_id);
      db.prepare('UPDATE reflections SET text = ?, invalid_at = COALESCE(invalid_at, ?) WHERE id = ?')
        .run('', now, reflectionId);
      db.prepare('DELETE FROM reflection_evidence WHERE reflection_id = ?').run(reflectionId);
      db.prepare('UPDATE episodes SET consolidated = 0, superseded_by = NULL WHERE superseded_by = ? AND redacted_at IS NULL')
        .run(reflectionId);
      reflectionsInvalidated += 1;
    }
    // The redacted episode keeps `consolidated` (it must never be read again)
    // but drops the pointer, so a later backfill cannot resurrect the dead
    // summary's evidence trail through it.
    db.prepare('UPDATE episodes SET superseded_by = NULL WHERE id = ?').run(episodeId);

    const supported = db.prepare('SELECT fact_id FROM evidence WHERE episode_id = ?').all(episodeId);
    for (const link of supported) {
      invalidateFact(db, String(link.fact_id), { at: now });
      factsRetired += 1;
    }
    db.prepare('DELETE FROM evidence WHERE episode_id = ?').run(episodeId);
  });
  return { redacted: true, factsRetired, reflectionsInvalidated };
}

/**
 * Redact the most recent episodes of a session, for "forget what I just said".
 *
 * People do not know episode ids. When someone says "忘掉刚才那句", the request
 * is about recency, not identity, so this is the operation they are actually
 * asking for. The cap keeps an ambiguous request from wiping a conversation.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ sessionId: string, count?: number, actor?: 'user'|'agent', reason?: string, now?: number }} request
 *   - which session, how many, and whose.
 * @returns {{ redacted: number, factsRetired: number, reflectionsInvalidated: number }} what changed.
 */
export function redactRecent(db, request) {
  const count = Math.max(1, Math.min(10, request.count ?? 1));
  const actor = request.actor ?? 'user';
  const rows = db.prepare(`
    SELECT id FROM episodes
    WHERE session_id = ? AND actor = ? AND redacted_at IS NULL
    ORDER BY at DESC, rowid DESC LIMIT ?
  `).all(request.sessionId, actor, count);

  let redacted = 0;
  let factsRetired = 0;
  let reflectionsInvalidated = 0;
  for (const row of rows) {
    const result = redactEpisode(db, String(row.id), request);
    if (result.redacted) redacted += 1;
    factsRetired += result.factsRetired;
    reflectionsInvalidated += result.reflectionsInvalidated;
  }
  return { redacted, factsRetired, reflectionsInvalidated };
}

/**
 * Whether an episode already exists for a session message.
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
    WHERE consolidated = 0 AND redacted_at IS NULL
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
 * Attributes that never decay: who someone is, as opposed to how they are lately.
 *
 * A name, a birthday, or a language is not something that fades with disuse, and
 * a companion that forgets your name because it has not come up in a month is not
 * forgetful, it is broken. Everything else is fair game for decay.
 */
const PINNED_PREDICATES = new Set([
  'name',
  'nickname',
  'birthday',
  'born_on',
  'language',
  'native_language',
]);

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
  // Identity-shaped attributes are pinned on write, not on request. Forgetting
  // which city someone lives in is a reasonable thing to have happen; forgetting
  // their name is a bug that makes every later turn feel like a stranger.
  const pinned = fact.pinned === true || PINNED_PREDICATES.has(String(fact.predicate));
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
      pinned ? 1 : 0,
      fact.costTokens ?? 0,
      now,
      now,
    );
    db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)')
      .run(segment(`${fact.subject} ${fact.predicate} ${fact.object} ${synonymsFor(fact.object)}`), id);
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
  // subject and predicate are selected because the row is about to be re-indexed
  // from scratch. They were missing from this SELECT for a while, so every
  // reinforced fact was rewritten with a body of "undefined undefined <object>"
  // and stopped answering any query about its own attribute.
  const row = db.prepare('SELECT subject, predicate, confidence, object, cost_tokens FROM facts WHERE id = ?').get(factId);
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
    // Re-index the whole row, not just the object. The first version indexed
    // `${oldObject} ${newObject}`, which silently dropped subject and predicate:
    // after any update, the fact stopped answering queries about its own
    // attribute ("我的工作" found nothing once the object had been refined once).
    db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)')
      .run(segment(`${String(row.subject)} ${String(row.predicate)} ${String(row.object)} ${object} ${synonymsFor(object)}`), factId);
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
/**
 * Every (subject, predicate) that holds more than one live value.
 *
 * Only single-valued predicates count: "likes coffee" and "likes hiking" are two
 * live rows on purpose, while "lives_in 杭州" next to "lives_in 苏州" is the store
 * contradicting itself. Nothing in the prompt shows it — `renderResident`
 * collapses a single-valued predicate to its best-ranked line, so the second
 * value is invisible exactly where a human would notice, while `memory_recall`
 * still finds it. That is how a broken seed in the end-to-end suite left a stray
 * live 杭州 in place for a whole run without any assertion objecting.
 *
 * Every write path that displaces a single-valued fact retires the old row in the
 * same transaction, so this must come back empty; `test/consistency.mjs` asserts
 * it for consolidation, explicit overwrite and both clarification resolutions.
 */
export function liveContradictions(db) {
  return db.prepare(`
    SELECT subject, predicate, count(*) AS n FROM facts
    WHERE invalid_at IS NULL AND superseded_by IS NULL
    GROUP BY subject, predicate HAVING n > 1
    ORDER BY subject, predicate
  `).all().filter((row) => SINGLE_VALUED.has(String(row.predicate)));
}

export function liveFacts(db, options = {}) {
  const limit = options.limit ?? 100;
  if (options.subject !== undefined) {
    return db.prepare(`
      SELECT * FROM facts WHERE invalid_at IS NULL AND subject = ?
      ORDER BY pinned DESC, confidence DESC, updated_at DESC, id ASC LIMIT ?
    `).all(options.subject, limit);
  }
  if (options.exceptSubject !== undefined) {
    // Everyone but the owner. These are the facts that used to be write-only:
    // extracted, indexed and linked, but never rendered anywhere the model could
    // see them, because every read path filtered on the owner's subject.
    return db.prepare(`
      SELECT * FROM facts WHERE invalid_at IS NULL AND subject <> ?
      ORDER BY pinned DESC, confidence DESC, updated_at DESC, id ASC LIMIT ?
    `).all(options.exceptSubject, limit);
  }
  return db.prepare(`
    SELECT * FROM facts WHERE invalid_at IS NULL
    ORDER BY pinned DESC, confidence DESC, updated_at DESC, id ASC LIMIT ?
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
    // '' rather than null for the unused half of the key: STRICT tables make
    // primary-key columns implicitly NOT NULL, and OR IGNORE would drop every such
    // row without a word. See the table's definition in lib/db.js.
    for (const factId of reflection.evidenceFacts ?? []) stmt.run(id, factId, '');
    for (const episodeId of reflection.evidenceEpisodes ?? []) stmt.run(id, '', episodeId);
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
 * Record one standing instruction the person gave.
 *
 * Supersedes by topic rather than by wording: "叫我老大" and "别叫我老大，叫工兵"
 * are one topic with two values, and rendering both would leave the model to pick.
 * The old row is retired, not deleted — a preference that changed is different from
 * one that was never held, and the difference is what a person can inspect when the
 * agent's behaviour surprises them.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ topic: string, text: string, source?: string, at?: number }} directive - what to record.
 * @returns {{ id: string, superseded: string[] }} the new row and whatever it replaced.
 */
export function addDirective(db, directive) {
  const id = newId();
  const now = directive.at ?? Date.now();
  const topic = String(directive.topic ?? '').trim().toLowerCase();
  const text = String(directive.text ?? '').replace(/\s+/g, ' ').trim();
  if (topic === '' || text === '') return { id: '', superseded: [] };

  // Saying the same thing twice is not a new instruction.
  //
  // This returned the existing id and wrote nothing, and the first version got it
  // wrong in a way that showed up exactly as reported: "一会儿说叫老大，一会儿又说
  // 不叫" — the block rendered the same line twice, so she read it as two rules
  // fighting. The `continue` below skipped the retirement, so the old row stayed
  // live, and a second row was inserted anyway. The result was two live rows on one
  // topic, which is the one state the topic key exists to prevent.
  const existing = db.prepare('SELECT id, text FROM directives WHERE topic = ? AND invalid_at IS NULL').all(topic);
  const same = existing.find((row) => String(row.text) === text);
  if (same !== undefined) return { id: String(same.id), superseded: [] };

  const superseded = [];
  transact(db, () => {
    for (const row of existing) {
      db.prepare('UPDATE directives SET invalid_at = ?, superseded_by = ? WHERE id = ?').run(now, id, String(row.id));
      superseded.push(String(row.id));
    }
    db.prepare(`
      INSERT INTO directives (id, topic, text, source, valid_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, topic, text.slice(0, 200), String(directive.source ?? 'user'), now, now);
  });
  return { id, superseded };
}

/**
 * Withdraw a standing instruction.
 *
 * Retired, not deleted, for the same reason the superseded rows are: what the person
 * used to want is part of why the behaviour looks the way it does. The difference
 * between "never wanted that" and "wanted that until Tuesday" is exactly the thing a
 * person checks when the agent does something surprising.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} topic - which instruction to withdraw.
 * @param {number} [at] - when it was withdrawn.
 * @returns {{ retired: number }} how many rows were live on that topic.
 */
export function retireDirective(db, topic, at = Date.now()) {
  const key = String(topic ?? '').trim().toLowerCase();
  if (key === '') return { retired: 0 };
  const result = db.prepare('UPDATE directives SET invalid_at = ? WHERE topic = ? AND invalid_at IS NULL').run(at, key);
  return { retired: Number(result.changes) };
}

/**
 * The instructions currently in force, newest first.
 *
 * Rendered into every turn rather than retrieved: none of these is similar to
 * anything the person will say next, so a search would never surface them.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ limit?: number }} [options] - how many.
 * @returns {Array<Record<string, unknown>>} live directive rows.
 */
export function liveDirectives(db, limit = 20) {
  return db.prepare(`
    SELECT * FROM directives WHERE invalid_at IS NULL
    ORDER BY valid_at DESC LIMIT ?
  `).all(Math.max(1, Number(limit) || 20));
}

/**
 * Track something the user said they would do or that is due later.
 *
 * Two times are recorded and they are not the same thing:
 *
 *   - `dueAt` is when the *event* happens, resolved from the sentence and kept
 *     with the phrase that named it ("下周三"). This is what the agent needs in
 *     order to say something true about a date the person mentioned in the past.
 *   - `followAfter` is when it becomes *appropriate to raise it*, which is after
 *     the event rather than after the message.
 *
 * Collapsing them is the mistake that made a loop about an appointment come due
 * that same evening.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId: string, text: string, followAfter?: number | null,
 *   dueAt?: number | null, duePhrase?: string }} loop - the loop to record.
 * @returns {string} the new loop id.
 */
export function addOpenLoop(db, loop) {
  const id = newId();
  db.prepare(`
    INSERT INTO open_loops (id, user_id, text, created_at, follow_after, due_at, due_phrase)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    loop.userId,
    loop.text,
    Date.now(),
    loop.followAfter ?? null,
    loop.dueAt ?? null,
    loop.duePhrase ?? '',
  );
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
 * Attach a resolved date to a loop that does not have one yet.
 *
 * Loops are deduplicated by surface overlap, so a second mention of the same
 * worry usually keeps the first row — including its missing date, because it was
 * written before anything parsed dates. Resolving the duplicate and then
 * dropping it discards the only version of the sentence that still knew when it
 * was about. This fills the date in instead.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} loopId - the loop to update.
 * @param {{ dueAt: number, duePhrase: string, followAfter: number }} due - resolved date.
 * @returns {boolean} whether a row changed.
 */
export function setLoopDue(db, loopId, due) {
  const result = db.prepare(
    `UPDATE open_loops SET due_at = ?, due_phrase = ?, follow_after = ?
     WHERE id = ? AND closed_at IS NULL AND due_at IS NULL`,
  ).run(due.dueAt, due.duePhrase ?? '', due.followAfter, loopId);
  return Number(result.changes) > 0;
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
 *   fallback?: boolean, sessionId?: string,
 * }} query - the recall request. `fallback` asks for the owner's most memorable
 *   rows when the cue itself matched nothing. `sessionId` restricts episodes to
 *   one session, which is how a group room is stopped from reaching the
 *   conversations this agent had in private.
 * @returns {{ episodes: Array<Record<string, unknown>>, facts: Array<Record<string, unknown>>, terms: number }}
 *   scored rows, each with a `score` field.
 */
export function recall(db, query) {
  const now = query.now ?? Date.now();
  const limit = query.limit ?? 8;
  const expr = matchExpression(query.cue);
  const wantEpisodes = query.includeEpisodes !== false;
  const wantFacts = query.includeFacts !== false;
  const sessionId = typeof query.sessionId === 'string' && query.sessionId !== ''
    ? query.sessionId
    : null;
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
      // The session filter is applied after the lexical match rather than folded
      // into the FTS query: `episodes_fts` indexes text, not session ids, and a
      // join predicate here would be optimised away only by luck. A group with
      // more than `limit * 4` matching messages still gets a full page of *its
      // own*, which is the property that matters.
      episodeRows = db.prepare(`
        SELECT e.*, bm25(episodes_fts) AS rank
        FROM episodes_fts
        JOIN episodes e ON e.id = episodes_fts.episode_id
        WHERE episodes_fts MATCH ? AND e.redacted_at IS NULL
        ORDER BY rank LIMIT ?
      `).all(expr, sessionId === null ? limit * 4 : limit * 40);
      if (sessionId !== null) {
        episodeRows = episodeRows.filter((row) => String(row.session_id) === sessionId).slice(0, limit * 4);
      }
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
      // Salience has three inputs, and the third is what makes a companion recall
      // the right things: sensitivity (how private), confidence (how sure), and
      // arousal (how charged the moment was). Without arousal, "我妈住院了" and
      // "今天天气不错" are indistinguishable once both are stored as facts.
      const sensitivityBoost = String(row.sensitivity ?? '') === 'sensitive' ? 0.9 : 0;
      const confidence = Number(row.confidence ?? 0.5);
      const arousal = Number(row.arousal ?? 0);
      const salience = Math.min(1, 0.6 * confidence + 0.3 * sensitivityBoost + 0.4 * arousal);
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
    // Associative spread is one hop along the link graph, and that graph was
    // built across the whole store: a fact from a private conversation is
    // linked to an episode that happened in a room, because both are about the
    // same person. Admitting the neighbour is therefore a way around the
    // session filter above — the direct match was scoped, the neighbour was not.
    // Facts are excluded entirely in a room (the caller sets includeFacts), so
    // only episodes need checking here.
    if (sessionId !== null && node.kind === 'episode'
      && String(node.session_id) !== sessionId) continue;
    node.score += delta;
    byId.set(id, node);
    if (node.kind === 'episode') scoredEpisodes.push(node);
    else scoredFacts.push(node);
  }

  // A cue made only of question scaffolding ("你还记得我什么样吗") matches nothing
  // lexically, so there are no seeds, so the spread above had nothing to spread
  // from and the whole recall came back empty. That is the moment retrieval
  // matters most — the person is explicitly asking whether anything was kept.
  //
  // Falling back to salience is the honest answer to an unspecific request: not
  // "what is relevant to this question" (there is no question content) but "what
  // would I think of first about this person", which is exactly what the
  // activation model is for.
  //
  // It is opt-in rather than default because the two callers want opposite
  // things. Automatic recall on a vague cue needs a floor; the `memory_recall`
  // tool is a precise lookup, and answering a search for an unknown word with
  // the owner's most memorable facts teaches the model that its query was heard
  // when it was not.
  if (directCount === 0 && query.fallback === true) {
    const fallbackFacts = wantFacts ? fallbackFactsBySalience(db, { userId: query.userId ?? 'user', now, limit }) : [];
    const fallbackEpisodes = wantEpisodes
      ? fallbackEpisodesBySalience(db, { now, limit, sessionId })
      : [];
    scoredFacts.push(...fallbackFacts);
    scoredEpisodes.push(...fallbackEpisodes);
  }

  return {
    episodes: scoredEpisodes.sort((a, b) => b.score - a.score).slice(0, limit),
    facts: scoredFacts.sort((a, b) => b.score - a.score).slice(0, limit),
    terms: expr.split(' OR ').length,
  };
}

/**
 * The most memorable facts about the owner, when the cue carried no content.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId: string, now: number, limit: number }} query - fallback request.
 * @returns {Array<Record<string, unknown>>} scored rows.
 */
function fallbackFactsBySalience(db, query) {
  const rows = db.prepare(`
    SELECT * FROM facts
    WHERE invalid_at IS NULL AND subject = ?
    ORDER BY pinned DESC, confidence DESC, updated_at DESC, id ASC
    LIMIT ?
  `).all(query.userId, query.limit);
  return rows.map((row) => {
    const ageDays = msToDays(query.now - Number(row.updated_at ?? row.created_at ?? query.now));
    const recency = Math.exp(-ageDays / 90);
    const sensitivityBoost = String(row.sensitivity ?? '') === 'sensitive' ? 0.9 : 0;
    const salience = Math.min(1, 0.6 * Number(row.confidence ?? 0.5) + 0.3 * sensitivityBoost);
    return { ...row, kind: 'fact', rank: 0, score: 0.4 * salience + 0.3 * recency + (Number(row.pinned) === 1 ? 10 : 0) };
  });
}

/**
 * The most memorable recent episodes, when the cue carried no content.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ now: number, limit: number, sessionId?: string|null }} query - fallback request.
 * @returns {Array<Record<string, unknown>>} scored rows.
 */
function fallbackEpisodesBySalience(db, query) {
  // Charged moments first: without arousal the two rows this returns would be
  // whatever happened to be written last, which is the least interesting thing
  // in the store rather than the most.
  //
  // The session filter is not a refinement: in a room, the fallback is reached
  // precisely when the cue was too vague to match anything, which is exactly when
  // "the most memorable moments in the store" would hand the room the owner's
  // worst week. Same query, one extra predicate, two different guarantees.
  const scoped = typeof query.sessionId === 'string' && query.sessionId !== '';
  const rows = scoped
    ? db.prepare(`
      SELECT * FROM episodes
      WHERE redacted_at IS NULL AND session_id = ?
      ORDER BY arousal DESC, at DESC
      LIMIT ?
    `).all(query.sessionId, query.limit)
    : db.prepare(`
      SELECT * FROM episodes
      WHERE redacted_at IS NULL
      ORDER BY arousal DESC, at DESC
      LIMIT ?
    `).all(query.limit);
  return rows.map((row) => {
    const ageDays = msToDays(query.now - Number(row.at ?? query.now));
    const recency = Math.exp(-ageDays / 14);
    return { ...row, kind: 'episode', rank: 0, score: 0.4 * Number(row.arousal ?? 0) + 0.3 * recency };
  });
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
  const episode = db.prepare('SELECT * FROM episodes WHERE id = ? AND redacted_at IS NULL').get(id);
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
 * Remember what a recall block actually showed, so the next message can grade it.
 *
 * This is persisted rather than kept in memory because the common call shape is a
 * one-shot process: `dsh --profile call "..."` answers one message and exits. An
 * in-process map cannot survive to the next message, so grading would only ever
 * run inside a long-lived web session — the opposite of where A calls B.
 *
 * The scope is the owner, not the session. A one-shot process opens a fresh
 * session every call, so a session-keyed table would write each block into a
 * different bucket and the next call would never find it. "Did they push back on
 * what we said we remembered" is a fact about the person, not about a session.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} owner - whose memory this is.
 * @param {Array<{ id: string, kind: 'episode'|'fact', needle: string }>} rows - what was shown.
 * @param {number} [at] - epoch milliseconds.
 */
export function savePendingRecall(db, owner, rows, at = Date.now()) {
  if (owner === '' || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO pending_recall (user_id, target_id, target_kind, needle, at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, target_id, target_kind)
    DO UPDATE SET needle = excluded.needle, at = excluded.at
  `);
  for (const row of rows) stmt.run(owner, row.id, row.kind, row.needle, at);
}

/**
 * Take the pending block for an owner, removing it as it is read.
 *
 * Reading consumes: grading the same block twice would apply a correction to rows
 * that are no longer on screen. Nothing is returned once the block is older than
 * `maxAgeMs` — a reply an hour later is a new conversation, not a verdict.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} owner - whose memory this is.
 * @param {number} [now] - epoch milliseconds.
 * @param {number} [maxAgeMs] - how long a block stays gradeable.
 * @returns {Array<{ id: string, kind: 'episode'|'fact', needle: string, at: number }>} the rows.
 */
export function takePendingRecall(db, owner, now = Date.now(), maxAgeMs = 30 * 60_000) {
  if (owner === '') return [];
  // Expiry is swept here rather than on a timer: a process that exits has no
  // timer, and stale rows would otherwise be graded on a later unrelated reply.
  db.prepare('DELETE FROM pending_recall WHERE at < ?').run(now - maxAgeMs);
  const rows = db.prepare(
    'SELECT target_id, target_kind, needle, at FROM pending_recall WHERE user_id = ? ORDER BY at ASC',
  ).all(owner);
  if (rows.length === 0) return [];
  db.prepare('DELETE FROM pending_recall WHERE user_id = ?').run(owner);
  return rows.map((row) => ({
    id: String(row.target_id),
    kind: String(row.target_kind) === 'episode' ? 'episode' : 'fact',
    needle: String(row.needle),
    at: Number(row.at),
  }));
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
