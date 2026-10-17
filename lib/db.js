/**
 * SQLite schema and access layer.
 *
 * One file, opened with `node:sqlite`'s synchronous `DatabaseSync`. The schema
 * is append-only by construction: no row is ever deleted by a normal operation,
 * because a companion agent that silently loses history is worse than one that
 * retrieves something stale. Anything "forgotten" is marked, not removed.
 *
 * @module dsh-hippo/db
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { segment } from './tokenize.js';

/** Bumped when a change needs explicit migration rather than `IF NOT EXISTS`. */
export const SCHEMA_VERSION = 3;

const MIGRATIONS = new Map([
  [3, (db) => {
    // The FTS index changed shape: Chinese runs now store unigrams alongside
    // bigrams so a one-character cue can match inside a longer run. The stored
    // column keeps its name, but its contents are only valid for the tokenizer
    // that wrote them, so every row is rebuilt.
    db.exec('DELETE FROM episodes_fts');
    db.exec('DELETE FROM facts_fts');
    const episodes = db.prepare('SELECT id, session_id, actor, text FROM episodes').all();
    const insertEpisode = db.prepare('INSERT INTO episodes_fts (body, episode_id) VALUES (?, ?)');
    for (const row of episodes) {
      insertEpisode.run(segment(`${row.actor} ${row.text}`), String(row.id));
    }
    const facts = db.prepare('SELECT id, subject, predicate, object FROM facts').all();
    const insertFact = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
    for (const row of facts) {
      insertFact.run(segment(`${row.subject} ${row.predicate} ${row.object}`), String(row.id));
    }
  }],
]);

/**
 * Open the memory database and ensure the schema exists.
 * @param {string} path - absolute database path, or `:memory:`.
 * @returns {Promise<import('node:sqlite').DatabaseSync>} the open database.
 */
export async function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureSchema(db);
  return db;
}

/**
 * Create every table, index, and the FTS index when absent.
 *
 * `STRICT` tables reject type drift at write time. Timestamps are epoch
 * milliseconds as INTEGER so range queries stay index-friendly.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `);

  // ---- L2 情景记忆：逐轮原文，永不改写 ----------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      message_id    TEXT,
      at            INTEGER NOT NULL,
      actor         TEXT NOT NULL CHECK (actor IN ('user','agent')),
      text          TEXT NOT NULL,
      tokens        INTEGER NOT NULL DEFAULT 0,
      stability     REAL NOT NULL DEFAULT 1.0,
      difficulty    REAL NOT NULL DEFAULT 5.0,
      last_review_at INTEGER,
      review_count  INTEGER NOT NULL DEFAULT 0,
      consolidated  INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      sensitivity   TEXT NOT NULL DEFAULT 'personal',
      source        TEXT NOT NULL DEFAULT 'observed'
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS episodes_at ON episodes(at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id, at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS episodes_open ON episodes(consolidated, at)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS episodes_message ON episodes(session_id, message_id) WHERE message_id IS NOT NULL');

  // ---- L3 语义记忆：可修正的画像事实，bi-temporal ------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id                 TEXT PRIMARY KEY,
      subject            TEXT NOT NULL,
      predicate          TEXT NOT NULL,
      object             TEXT NOT NULL,
      confidence         REAL NOT NULL DEFAULT 0.6,
      valid_at           INTEGER NOT NULL,
      invalid_at         INTEGER,
      superseded_by      TEXT,
      stability          REAL NOT NULL DEFAULT 1.0,
      difficulty         REAL NOT NULL DEFAULT 5.0,
      last_review_at     INTEGER,
      review_count       INTEGER NOT NULL DEFAULT 0,
      sensitivity        TEXT NOT NULL DEFAULT 'personal',
      source             TEXT NOT NULL DEFAULT 'inferred',
      needs_clarification INTEGER NOT NULL DEFAULT 0,
      pinned             INTEGER NOT NULL DEFAULT 0,
      cost_tokens        INTEGER NOT NULL DEFAULT 0,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS facts_live ON facts(invalid_at, subject)');
  db.exec('CREATE INDEX IF NOT EXISTS facts_spo ON facts(subject, predicate)');
  db.exec('CREATE INDEX IF NOT EXISTS facts_clarify ON facts(needs_clarification, updated_at DESC)');

  // ---- 关联：两条记忆之间的边，巩固阶段建立 ----------------------------
  //
  // A memory with no edges is only findable by lexical cue, which means it is
  // effectively gone the moment the phrasing changes. These edges are what make
  // "年糕" reach "在杭州养的那只橘猫" without sharing a single token.
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      from_id    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('shared_subject','temporal','semantic','supports')),
      weight     REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id, kind)
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS links_to ON links(to_id, kind)');

  // ---- 事实来源的原文指针 ----------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence (
      fact_id    TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL,
      added_at   INTEGER NOT NULL,
      PRIMARY KEY (fact_id, episode_id)
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS evidence_episode ON evidence(episode_id)');

  // ---- 巩固产物：reflection，必须带 evidence ----------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('summary','insight','pattern')),
      text       TEXT NOT NULL,
      level      INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.6,
      valid_at   INTEGER NOT NULL,
      invalid_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflection_evidence (
      reflection_id TEXT NOT NULL REFERENCES reflections(id) ON DELETE CASCADE,
      fact_id       TEXT,
      episode_id    TEXT,
      PRIMARY KEY (reflection_id, fact_id, episode_id)
    ) STRICT
  `);

  // ---- 关系状态：派生视图，可从 facts/reflections 重建 -------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationship (
      user_id       TEXT PRIMARY KEY,
      familiarity   REAL NOT NULL DEFAULT 0.0,
      trust         REAL NOT NULL DEFAULT 0.5,
      mood_baseline REAL NOT NULL DEFAULT 0.0,
      revision      INTEGER NOT NULL DEFAULT 0,
      last_updated  INTEGER NOT NULL
    ) STRICT
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS open_loops (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      text         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      follow_after INTEGER,
      closed_at    INTEGER,
      closed_by    TEXT
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS loops_open ON open_loops(user_id, closed_at, follow_after)');

  // ---- 月度情绪/活跃度，用于 mood_baseline 与显著性 ----------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS affect (
      user_id  TEXT NOT NULL,
      at       INTEGER NOT NULL,
      valence  REAL NOT NULL,
      arousal  REAL NOT NULL,
      note     TEXT,
      PRIMARY KEY (user_id, at)
    ) STRICT
  `);

  // ---- 检索历史：ACT-R base-level activation 的唯一输入 -------------------
  // 每次召回记一行。这张表只增不改，是「近期用过的更容易被想起」的实现，
  // 也是不引入额外 importance 字段就能做显著性排序的原因。
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      target_id   TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('episode','fact')),
      at          INTEGER NOT NULL,
      PRIMARY KEY (target_id, target_kind, at)
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS reviews_target ON reviews(target_id, target_kind, at)');

  // ---- 写入预算账本 ------------------------------------------------------
  db.exec(`
    CREATE TABLE IF NOT EXISTS budget (
      day      TEXT PRIMARY KEY,
      tokens   INTEGER NOT NULL DEFAULT 0
    ) STRICT
  `);

  // ---- FTS 索引：分词后的镜像，不是 source of truth ----------------------
  // 使用 external-content 表，行由触发器/显式写入同步。因为我们要自己做
  // 中文 bigram 分词，所以存的是 segment() 后的字符串，查询也必须走
  // matchExpression()（它做同样的分词）。
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      body,
      episode_id UNINDEXED
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      body,
      fact_id UNINDEXED
    )
  `);

  // Migrate before the version stamp is updated, so a crash mid-migration leaves
  // the old version in place and the next open retries rather than skipping.
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const from = stored === undefined ? SCHEMA_VERSION : Number(stored.value);
  if (Number.isFinite(from) && from < SCHEMA_VERSION) {
    for (const [target, migrate] of MIGRATIONS) {
      if (from < target) migrate(db);
    }
  }

  // Upsert, not INSERT OR IGNORE: a database created by an older build carries
  // the older version string, and ignoring the row would leave it stale forever.
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `).run('schema_version', String(SCHEMA_VERSION));
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('user_id');
  if (row === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('user_id', 'user');
  }
}

/**
 * Read a meta value.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} key - meta key.
 * @returns {string | undefined} the stored value or undefined.
 */
export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row === undefined ? undefined : String(row.value);
}

/**
 * Write a meta value.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} key - meta key.
 * @param {string} value - value to store.
 */
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/**
 * Current revision of the relational state; used to detect UI-visible drift.
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @returns {number} the revision.
 */
export function relationshipRevision(db, userId) {
  const row = db.prepare('SELECT revision FROM relationship WHERE user_id = ?').get(userId);
  return row === undefined ? 0 : Number(row.revision);
}

/**
 * Fresh primary key.
 * @returns {string} an id.
 */
export function newId() {
  return randomUUID();
}
