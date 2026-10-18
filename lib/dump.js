/**
 * Export and import of a whole memory.
 *
 * The shape is deliberately boring: one JSON object, one key per table, rows as
 * they sit in the database. A memory that can only leave the machine through a
 * SQLite file is a memory the person cannot inspect, cannot back up selectively,
 * and cannot carry to a new machine without carrying a binary they have to trust.
 *
 * @module dsh-hippo/dump
 */

import { rebuildSearchIndex } from './db.js';

/**
 * Re-exported so a single import covers the whole lifecycle: export, import,
 * and the index rebuild an import always needs. The implementation lives in
 * `db.js` next to the schema it derives from.
 */
export { rebuildSearchIndex };

/** Format marker, checked on import so a future shape is refused rather than half-read. */
export const DUMP_FORMAT = 'dsh-hippo/memory';
export const DUMP_VERSION = 1;

/**
 * Tables that are copied verbatim.
 *
 * Order matters on import: `evidence` has a foreign key into `facts`, and
 * `reflection_evidence` into `reflections`, both ON DELETE CASCADE. Inserting a
 * child before its parent fails, and the failure is the good case — the bad case
 * is `INSERT OR IGNORE`, which would drop the row quietly.
 */
const TABLES = [
  'episodes',
  'facts',
  'reflections',
  'links',
  'evidence',
  'reflection_evidence',
  'open_loops',
  'affect',
  'reviews',
];

/**
 * Tables that are deliberately left out, with the reason each one is not data.
 *
 * `budget` is a ledger of what this machine spent today. Importing another
 * machine's spending would not give it more room; it would give *this* machine a
 * smaller one, or, if the numbers happened to be low, a fresh allowance for work
 * that was already paid for. Either way the number stops meaning what it says.
 *
 * `pending_recall` is a snapshot of what was injected one message ago, kept so
 * the next message can grade it. It has a lifetime of a single turn. A snapshot
 * restored from a backup is a memory attributed to a reply nobody gave.
 *
 * `relationship` is a derived view — familiarity, trust and mood recomputed from
 * episodes and affect on every turn — so importing it would let a stale summary
 * overwrite a fresher derivation. It is rebuilt instead.
 *
 * FTS tables are indexes over text. They are rebuilt from the source rows after
 * import, never copied: an index is a cache of a tokenizer's output, and the
 * tokenizer is allowed to change.
 */
const DERIVED_TABLES = ['episodes_fts', 'facts_fts'];
const NOT_DATA = {
  budget: 'a local daily ledger, meaningless on another machine',
  pending_recall: 'a one-turn snapshot; restoring it would attribute memories to a reply nobody gave',
  relationship: 'derived from episodes and affect, rebuilt rather than overwritten',
};

/**
 * Column names of a table, in declared order.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} table - table name.
 * @returns {string[]} column names.
 */
function columnsOf(db, table) {
  return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => String(row.name));
}

/**
 * Everything worth keeping, as plain JSON.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ now?: number }} [options] - export controls.
 * @returns {{ format: string, version: number, exportedAt: number, schemaVersion: number, tables: Record<string, object[]> }} the snapshot.
 */
export function exportMemory(db, options = {}) {
  const schemaVersion = Number(
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0,
  );
  const tables = {};
  for (const table of TABLES) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  // Not `SELECT *` on meta: `schema_version` describes the file the rows came
  // out of, and an importer that trusts it would skip the migrations that make
  // those rows readable here. The rows carry their own columns; the version that
  // wrote them is reported separately and only used to explain a mismatch.
  tables.meta = db.prepare("SELECT * FROM meta WHERE key <> 'schema_version'").all();
  return {
    format: DUMP_FORMAT,
    version: DUMP_VERSION,
    exportedAt: options.now ?? Date.now(),
    schemaVersion,
    tables,
  };
}

/**
 * Merge a snapshot into an open database.
 *
 * Merge, not replace, and the difference is the whole safety story: every insert
 * is `INSERT OR IGNORE`, so an id that already exists is left exactly as it is.
 * A replacement would have to decide what to do about a fact edited since the
 * backup, and every answer to that question is a way to lose the newer one.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {object} snapshot - the object `exportMemory` produced.
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   added: Record<string, number>,
 *   skipped: Record<string, number>,
 *   dropped: Record<string, string[]>,
 *   refused: { facts: number, episodes: number },
 *   failed: Record<string, number>,
 *   rebuilt?: { episodes: number, facts: number },
 * }} what changed, per table.
 */
export function importMemory(db, snapshot) {
  const added = {};
  const skipped = {};
  const dropped = {};
  const failed = {};
  const refused = { facts: 0, episodes: 0 };
  const emptyReport = { ok: false, added, skipped, dropped, refused, failed };

  if (snapshot === null || typeof snapshot !== 'object') {
    return { ...emptyReport, error: 'not a memory dump' };
  }
  if (snapshot.format !== DUMP_FORMAT) {
    return { ...emptyReport, error: `not a memory dump: format is ${JSON.stringify(snapshot.format ?? null)}` };
  }
  if (Number(snapshot.version) > DUMP_VERSION) {
    return {
      ...emptyReport,
      error: `dump version ${snapshot.version} is newer than this build understands (${DUMP_VERSION})`,
    };
  }
  const tables = snapshot.tables;
  if (tables === null || typeof tables !== 'object') {
    return { ...emptyReport, error: 'the dump has no tables' };
  }

  // Forgetting has to survive a restore, and `INSERT OR IGNORE` alone does not
  // give that. Two of the three ways a belief dies are content-level rather than
  // id-level: a fact retired here, or an episode whose text was blanked on
  // request. A backup taken before that carries the same sentence under the same
  // id — which `OR IGNORE` catches — but also under a *different* id whenever the
  // two stores recorded it independently (two machines, an export taken after a
  // re-import, a merge of two accounts). Restoring that row would resurrect
  // exactly what someone asked to be rid of, and silently, because the row looks
  // like ordinary history.
  //
  // So the retired values are collected first and any incoming row that claims to
  // be live while matching one is refused. Refused, not merged: there is no
  // correct way to reconcile "still true" with "was retired by the person", and
  // of the two possible mistakes only one is recoverable.
  const retiredFacts = new Set();
  for (const row of db.prepare('SELECT subject, predicate, object FROM facts WHERE invalid_at IS NOT NULL').all()) {
    retiredFacts.add(`${row.subject}\u0000${row.predicate}\u0000${row.object}`);
  }
  // A belief that was retired and later re-established by the person is live
  // again, and that re-establishment is the more recent decision. Subtracting the
  // live bodies keeps this from freezing a topic permanently: forgetting one
  // phrasing must not make the whole subject unmentionable across restores.
  for (const row of db.prepare('SELECT subject, predicate, object FROM facts WHERE invalid_at IS NULL').all()) {
    retiredFacts.delete(`${row.subject}\u0000${row.predicate}\u0000${row.object}`);
  }
  const forgottenEpisodes = new Set();
  for (const row of db.prepare('SELECT message_id, text FROM episodes WHERE redacted_at IS NOT NULL').all()) {
    // `message_id` is the only stable handle on a message that survives having
    // its text erased. Rows without one fall back to the body they used to hold,
    // which is what a redaction replaced with the empty string — so a redacted
    // row cannot be matched this way and does not need to be.
    if (row.message_id !== null && row.message_id !== undefined) forgottenEpisodes.add(String(row.message_id));
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of [...TABLES, 'meta']) {
      added[table] = 0;
      skipped[table] = 0;
      dropped[table] = [];
      failed[table] = 0;
      const rows = Array.isArray(tables[table]) ? tables[table] : [];
      if (rows.length === 0) continue;

      // Column sets differ between the build that wrote the snapshot and this
      // one. Intersect rather than assume: an unknown column is reported, and a
      // column this build requires but the snapshot lacks falls back to its
      // DEFAULT, which is the only value that is not a guess.
      const here = new Set(columnsOf(db, table));
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const keys = Object.keys(row);
        for (const key of keys) {
          if (!here.has(key) && !dropped[table].includes(key)) dropped[table].push(key);
        }
        const usable = keys.filter((key) => here.has(key));
        if (usable.length === 0) continue;
        // The two refusals described above, checked before the insert so a
        // refused row is a number in the report rather than an exception.
        if (table === 'facts') {
          const body = `${row.subject ?? ''}\u0000${row.predicate ?? ''}\u0000${row.object ?? ''}`;
          const alive = row.invalid_at === null || row.invalid_at === undefined;
          if (alive && retiredFacts.has(body)) {
            refused.facts += 1;
            continue;
          }
        }
        if (table === 'episodes') {
          const alive = row.redacted_at === null || row.redacted_at === undefined;
          const messageId = row.message_id;
          if (alive && messageId !== null && messageId !== undefined && forgottenEpisodes.has(String(messageId))) {
            refused.episodes += 1;
            continue;
          }
        }
        const placeholders = usable.map(() => '?').join(', ');
        // `INSERT OR IGNORE` for every table, `meta` included: a key that already
        // exists is this machine's own answer (its `user_id`, its owner name), and
        // a backup is not an authority on who this store belongs to.
        //
        // The try/catch is per row and not around the table, because a single
        // dangling foreign key — evidence whose fact was written by a build that
        // did not export it — must not cost the other nine hundred rows. A row
        // that cannot land is counted, not silently swallowed.
        try {
          const result = db.prepare(
            `INSERT OR IGNORE INTO ${table} (${usable.join(', ')}) VALUES (${placeholders})`,
          ).run(...usable.map((key) => (row[key] === undefined ? null : row[key])));
          if (Number(result.changes) > 0) added[table] += 1;
          else skipped[table] += 1;
        } catch {
          failed[table] += 1;
        }
      }
    }
    const rebuilt = rebuildSearchIndex(db);
    db.exec('COMMIT');
    return { ok: true, added, skipped, dropped, refused, failed, rebuilt };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original error is the one worth reporting.
    }
    return { ...emptyReport, error: String(error?.message ?? error) };
  }
}

/**
 * What a dump would leave behind, without writing anything.
 *
 * Answers the question a person actually asks before importing — "does this
 * contain my conversations or only the summary of them" — by counting rows per
 * table and quoting the one thing a count cannot express: that a redacted
 * episode is exported as an empty body, because a forget is part of the record.
 *
 * @param {object} snapshot - the object `exportMemory` produced.
 * @returns {{ format: string, version: number, exportedAt: number, schemaVersion: number, rows: Record<string, number>, omitted: string[], redactedEpisodes: number }} a description.
 */
export function describeDump(snapshot) {
  const tables = snapshot?.tables ?? {};
  const rows = {};
  for (const table of [...TABLES, 'meta']) {
    rows[table] = Array.isArray(tables[table]) ? tables[table].length : 0;
  }
  const episodes = Array.isArray(tables.episodes) ? tables.episodes : [];
  return {
    format: String(snapshot?.format ?? ''),
    version: Number(snapshot?.version ?? 0),
    exportedAt: Number(snapshot?.exportedAt ?? 0),
    schemaVersion: Number(snapshot?.schemaVersion ?? 0),
    rows,
    omitted: [...Object.keys(NOT_DATA), ...DERIVED_TABLES],
    redactedEpisodes: episodes.filter((row) => row.redacted_at !== null && row.redacted_at !== undefined).length,
  };
}
