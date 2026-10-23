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
import { synonymsFor } from './topics.js';

/** Bumped when a change needs explicit migration rather than `IF NOT EXISTS`. */
export const SCHEMA_VERSION = 21;

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
  [4, (db) => {
    // `superseded_by` on episodes was overloaded to mean two unrelated things:
    // "a reflection absorbed this" (consolidation) and "the person asked for this
    // to be forgotten" (redaction). Since consolidation writes it on every batch,
    // every consolidated episode looked redacted — and redaction looked like it
    // had already happened, so a forget request on one of them was a no-op.
    //
    // The two meanings get separate columns. An episode is redacted only when it
    // has a `redacted_at`; `superseded_by` keeps its original job of pointing at
    // the reflection that absorbed it.
    const columns = db.prepare("SELECT name FROM pragma_table_info('episodes')").all()
      .map((row) => String(row.name));
    if (!columns.includes('redacted_at')) {
      db.exec('ALTER TABLE episodes ADD COLUMN redacted_at INTEGER');
    }
    if (!columns.includes('redacted_reason')) {
      db.exec("ALTER TABLE episodes ADD COLUMN redacted_reason TEXT NOT NULL DEFAULT ''");
    }
    // Recover the distinction for existing rows: a redaction stored the reason
    // string, consolidation stored a reflection id. Anything pointing at a
    // reflection row was consolidation, so it keeps `superseded_by` and is not
    // marked redacted.
    const reflections = new Set(
      db.prepare('SELECT id FROM reflections').all().map((row) => String(row.id)),
    );
    const rows = db.prepare('SELECT id, superseded_by, text FROM episodes WHERE superseded_by IS NOT NULL').all();
    const redact = db.prepare('UPDATE episodes SET redacted_at = ?, redacted_reason = ? WHERE id = ?');
    const clear = db.prepare('UPDATE episodes SET superseded_by = NULL WHERE id = ?');
    for (const row of rows) {
      const marker = String(row.superseded_by);
      if (reflections.has(marker)) continue;
      redact.run(Date.now(), marker, String(row.id));
    }
    db.exec("UPDATE episodes SET superseded_by = NULL, text = '' WHERE redacted_at IS NOT NULL");
    void clear;
  }],
  [5, (db) => {
    // Facts are now indexed with their synonym cluster so that a paraphrase
    // ("你画画怎么样") reaches a stored object that shares no character with the
    // cue ("插画师"). Existing rows were written before the table existed, so
    // their bodies hold no synonyms and the new lookup cannot find them.
    //
    // The repair is not just re-running the old body through the new builder:
    // an earlier version of `reinforceFact` rebuilt the index from
    // `${oldObject} ${newObject}`, silently dropping subject and predicate. Any
    // fact refined at least once had already lost its own attribute key, which
    // is why "我的工作" stopped finding `works_as` after a single update. The
    // rebuild restores all of it.
    db.exec('DELETE FROM facts_fts');
    const facts = db.prepare('SELECT id, subject, predicate, object FROM facts').all();
    const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
    for (const row of facts) {
      insert.run(
        segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
        String(row.id),
      );
    }
  }],
  [6, (db) => {
    // Emotional salience only existed in the `affect` table, which records the
    // numeric reading but cannot say *which message* carried it. Recall ranked on
    // sensitivity and confidence alone, so "我妈住院了" and "今天天气不错" scored
    // identically — the exact failure the README opens with.
    //
    // Arousal is stored on the episode because that is the unit recall returns
    // and the unit salience is computed from. Valence is deliberately not copied:
    // the sign of an emotion belongs in the affect curve, while what recall needs
    // is only how loud it was.
    const columns = db.prepare("SELECT name FROM pragma_table_info('episodes')").all()
      .map((row) => String(row.name));
    if (!columns.includes('arousal')) {
      db.exec('ALTER TABLE episodes ADD COLUMN arousal REAL NOT NULL DEFAULT 0');
    }
  }],
  [7, (db) => {
    // `reinforceFact` selected only (confidence, object, cost_tokens) and then
    // re-indexed the row from `${row.subject} ${row.predicate} ${row.object}`,
    // reading two columns that were never in the result set. Every fact touched
    // by an UPDATE/NOOP decision was therefore re-indexed as
    // "undefined undefined <object>", losing its own attribute key.
    //
    // The visible symptom is subtle and ugly: the fact still renders in the
    // resident profile (that reads the table, not the index), so it looks fine
    // until you ask for it by topic — "我妈身体怎么样" matched nothing while the
    // row sat right there. schema 5 rebuilt the index for a similar reason and
    // did not prevent this one, because the corruption happened afterwards at
    // write time rather than in the historical rows.
    db.exec('DELETE FROM facts_fts');
    const facts = db.prepare('SELECT id, subject, predicate, object FROM facts').all();
    const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
    for (const row of facts) {
      insert.run(
        segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
        String(row.id),
      );
    }
  }],
  [8, (db) => {
    // Facts whose subject is the owner's own name are the owner's facts.
    //
    // The extractor writes `subject: "user"`, but when the message says "我叫林晚"
    // it sometimes files the next fact under 林晚 instead. Those rows are invisible
    // to every read path that filters on the owner's subject, so they were stored,
    // indexed and then never shown. `applyFacts` now resolves subjects at write
    // time; this fixes the rows written before it did.
    const owner = db.prepare("SELECT value FROM meta WHERE key = 'user_id'").get()?.value ?? 'user';
    const aliases = db.prepare(`
      SELECT object FROM facts WHERE invalid_at IS NULL AND subject = ? AND predicate IN ('name', 'nickname')
    `).all(owner).map((row) => String(row.object ?? '').trim());
    const update = db.prepare('UPDATE facts SET subject = ? WHERE subject = ?');
    let changed = 0;
    for (const alias of aliases) {
      if (alias === '' || alias === owner) continue;
      changed += update.run(owner, alias).changes;
    }
    // Re-index only after every rename is in place, and read the rows fresh.
    //
    // The first version of this migration captured the owner's rows *before* the
    // UPDATE and rebuilt the index from that snapshot, so the renamed rows — the
    // entire point of the migration — were missing from the index afterwards.
    // Migration 9 repairs the index it left behind; this ordering is the fix.
    if (changed > 0) {
      db.exec('DELETE FROM facts_fts');
      const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
      for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts').all()) {
        insert.run(
          segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
          String(row.id),
        );
      }
    }
  }],
  [9, (db) => {
    // Rebuild the whole facts index, unconditionally.
    //
    // Migration 8 could leave it short: it deleted and re-inserted from a stale
    // snapshot taken before its own renames, so any row not in that snapshot lost
    // its index entry entirely. A missing entry is worse than a wrong one — the
    // row still renders in the resident profile (which reads the table) and still
    // shows up in `memory_state`, so the store looks healthy while topic recall
    // silently returns nothing for it.
    //
    // This is also the cheap repair for any future write-path bug of the same
    // shape: the index is derivable, so the safe migration is always "throw it
    // away and rebuild from the table".
    db.exec('DELETE FROM facts_fts');
    const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
    for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts').all()) {
      insert.run(
        segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
        String(row.id),
      );
    }
  }],
  [10, (db) => {
    // Retire fragments: a live fact whose object is a strict substring of another
    // live fact with the same subject and predicate is not a second belief, it is
    // a piece of the first one that an extraction stored separately.
    //
    // The write path now refuses these (see `decide` in lib/extract.js), but the
    // rows written before it did are still there: `妈妈 health` holds both the full
    // diagnosis and the bare word `血糖`, and the profile rendered both, which
    // reads as two separate claims about the same person's health.
    //
    // The condition is deliberately narrow. Only a *strict* substring counts, and
    // only while the longer row is still live, so a belief that was later retired
    // never drags its own fragments down with it, and two unrelated values stay
    // unrelated. `likes 咖啡` is not a fragment of `likes 咖啡店里的那只猫` in any
    // useful sense, but it is a substring, so multi-valued predicates are skipped
    // entirely — the risk of hiding a real preference is worse than one redundant
    // line.
    const MULTI = new Set(['likes', 'dislikes', 'has_pet', 'not_has_pet', 'personality', 'language']);
    const rows = db.prepare(`
      SELECT id, subject, predicate, object FROM facts
      WHERE invalid_at IS NULL ORDER BY length(object) DESC
    `).all();
    const retire = db.prepare('UPDATE facts SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL');
    const now = Date.now();
    let retired = 0;
    for (const row of rows) {
      const predicate = String(row.predicate);
      if (MULTI.has(predicate)) continue;
      const object = String(row.object).trim();
      if (object.length < 2) continue;
      const longer = rows.find((other) => other !== row
        && String(other.subject) === String(row.subject)
        && String(other.predicate) === predicate
        && String(other.object).trim().length > object.length
        && String(other.object).includes(object));
      if (longer === undefined) continue;
      retired += retire.run(now, now, String(row.id)).changes;
    }
    if (retired > 0) {
      // The retired rows leave the index with them: a fragment that no longer
      // counts as a belief should not surface in a search either, or the model
      // gets a hit for a fact the profile refuses to state.
      db.exec('DELETE FROM facts_fts');
      const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
      for (const row of db.prepare("SELECT id, subject, predicate, object FROM facts WHERE invalid_at IS NULL").all()) {
        insert.run(
          segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
          String(row.id),
        );
      }
    }
  }],
  [11, (db) => {
    // Backfill reflection evidence, which was never written.
    //
    // `reflection_evidence` is keyed on (reflection_id, fact_id, episode_id) and
    // stores "absent" for the unused half of the key. The write used NULL for
    // absent, STRICT tables make primary-key columns implicitly NOT NULL, and
    // `INSERT OR IGNORE` turned that violation into a silent no-op on every row.
    // The table has therefore been empty since it was created, which means no
    // reflection has ever been traceable to what produced it — the one property
    // the whole consolidation design is justified by.
    //
    // Both halves are recoverable from data that was written correctly:
    // `episodes.superseded_by` already points at the reflection that absorbed the
    // episode, and `evidence` already maps every fact back to the episode it came
    // from. So the missing rows are a join, not a reconstruction.
    // Episodes: the pointer is exact.
    db.exec(`
      INSERT OR IGNORE INTO reflection_evidence (reflection_id, fact_id, episode_id)
      SELECT e.superseded_by, '', e.id FROM episodes e
      WHERE e.superseded_by IN (SELECT id FROM reflections)
    `);
    // Facts: a fact belongs to the reflection that absorbed any episode it was
    // drawn from. `evidence` has the mapping, so this is a two-hop join and the
    // only judgement call is what to do when a fact's episodes were absorbed by
    // more than one reflection — every such pair is recorded rather than picking
    // one, because the fact genuinely descends from all of them.
    db.exec(`
      INSERT OR IGNORE INTO reflection_evidence (reflection_id, fact_id, episode_id)
      SELECT DISTINCT e.superseded_by, ev.fact_id, '' FROM evidence ev
      JOIN episodes e ON e.id = ev.episode_id
      WHERE e.superseded_by IN (SELECT id FROM reflections)
    `);
  }],
  [12, (db) => {
    // Give a loop a resolved date, not just a delay.
    //
    // Loops stored a `follow_after` offset computed when the message arrived, so
    // "下周三复查" meant "ask in six hours" — that evening, when the answer was
    // guaranteed to be "it hasn't happened yet". The words also stopped being true
    // a week later, which is exactly when the loop came due.
    //
    // The date is nullable and the phrase is kept beside it, because the sentence
    // stays quotable while the instant stays correct. Existing rows keep
    // `due_at` empty: their dates were never resolved and inventing one now from
    // text that may be weeks old would put appointments on the wrong day.
    const columns = new Set(
      db.prepare("SELECT name FROM pragma_table_info('open_loops')").all().map((row) => String(row.name)),
    );
    if (!columns.has('due_at')) db.exec('ALTER TABLE open_loops ADD COLUMN due_at INTEGER');
    if (!columns.has('due_phrase')) {
      db.exec("ALTER TABLE open_loops ADD COLUMN due_phrase TEXT NOT NULL DEFAULT ''");
    }
  }],
  [13, (db) => {
    // Re-file facts written under the owner's own name.
    //
    // `applyFacts` has normalised the subject for a while, but `memory_remember`
    // stored whatever string the model passed, and the model passes "林晚" about
    // as often as "user". A row filed under the owner's own name is unreachable:
    // every read path filters by owner, except the one that lists *other* people,
    // so the person's own plan showed up under "对方身边的人" — their own words
    // attributed to someone else.
    //
    // The alias list is read before the rename, because resolving after would
    // have nothing left to resolve against.
    const owner = db.prepare("SELECT value FROM meta WHERE key = 'user_id'").get();
    const userId = owner === undefined ? 'user' : String(owner.value);
    const aliases = db.prepare(`
      SELECT DISTINCT object FROM facts
      WHERE invalid_at IS NULL AND subject = ? AND predicate IN ('name', 'nickname')
    `).all(userId)
      .map((row) => String(row.object ?? '').trim().toLowerCase())
      .filter((value) => value !== '');

    if (aliases.length > 0) {
      const rename = db.prepare('UPDATE facts SET subject = ? WHERE subject = ?');
      let renamed = 0;
      for (const alias of aliases) {
        renamed += Number(rename.run(userId, alias).changes ?? 0);
        renamed += Number(rename.run(userId, `${alias}（用户）`).changes ?? 0);
        renamed += Number(rename.run(userId, `${alias}(用户)`).changes ?? 0);
      }
      if (renamed > 0) {
        // Rebuild rather than re-index the renamed rows one by one. The index body
        // contains the subject, and a partial rebuild is exactly how migration 8
        // dropped rows out of `facts_fts` — the rows stayed visible in the profile
        // and silently stopped answering topic queries.
        db.exec('DELETE FROM facts_fts');
        const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
        for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts WHERE invalid_at IS NULL').all()) {
          insert.run(
            segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
            String(row.id),
          );
        }
      }
    }
  }],
  [14, (db) => {
    // Retire pending plans that a later completion of the same thread replaced.
    //
    // Plans stopped being single-valued because one line out of six was hiding a
    // hospital appointment. The cost of that fix is that a completion no longer
    // overwrites anything: `decide` now handles it on the write path, but every
    // plan stored before that fix is still live beside its own completion, and
    // the profile renders "下周要交一本猫的绘本稿" and "猫绘本稿已于今天交稿" as
    // two present-tense commitments.
    //
    // The match is content-token overlap, not similarity: the two sentences carry
    // a date and a tense that pull character Dice below any usable threshold
    // (0.17 here), while what identifies the subject — 绘本稿, 猫 — survives.
    // Multi-valued predicates that are not plans are skipped; a finished book is
    // not a reason to forget that someone likes an author.
    const MULTI = new Set(['likes', 'dislikes', 'has_pet', 'not_has_pet', 'personality', 'language']);
    const rows = db.prepare(`
      SELECT id, subject, predicate, object, created_at FROM facts
      WHERE invalid_at IS NULL AND predicate IN ('plan', 'goal', 'habit')
      ORDER BY created_at ASC
    `).all();
    const completed = /已(经)?(于|在|是)?[^，。！？]{0,5}(交|交稿|完成|做完|写好|画完|结束|去过|参加|搞定|办完)|已交|交了|交稿了|做完了|写完了|画完了|搞定了|结束了|去过了|参加了|办完了/;
    const negated = /(没|不|未|还没|尚未)(有)?(交|做|写|画|去|完成|结束|参加)/;
    const retire = db.prepare('UPDATE facts SET invalid_at = ?, updated_at = ? WHERE id = ? AND invalid_at IS NULL');
    let retired = 0;
    for (const row of rows) {
      if (MULTI.has(String(row.predicate))) continue;
      if (!completed.test(String(row.object)) || negated.test(String(row.object))) continue;
      const tokens = new Set(segment(`${row.predicate} ${row.object}`).split(' ').filter((t) => t.length >= 2));
      for (const other of rows) {
        if (String(other.id) === String(row.id)) continue;
        if (String(other.predicate) !== String(row.predicate)) continue;
        if (String(other.subject) !== String(row.subject)) continue;
        if (Number(other.created_at) > Number(row.created_at)) continue;
        const otherText = String(other.object);
        if (completed.test(otherText) || negated.test(otherText)) continue;
        const shared = segment(otherText).split(' ').filter((t) => t.length >= 2 && tokens.has(t));
        if (shared.length < 2) continue;
        retired += Number(retire.run(Number(row.created_at), Date.now(), String(other.id)).changes ?? 0);
      }
    }
    if (retired > 0) db.exec('DELETE FROM facts_fts');
    if (retired > 0) {
      const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
      for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts WHERE invalid_at IS NULL').all()) {
        insert.run(
          segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(row.object)}`),
          String(row.id),
        );
      }
    }
  }],
  [15, (db) => {
    // Who said it.
    //
    // `subject: "user"` was defined as "the person this memory belongs to", and
    // that was unambiguous while every message came from them. A group chat
    // breaks it: the extractor writes `user` for whoever was talking, and in a
    // room that is usually a visitor — so their preferences get filed as the
    // owner's and stated back to the owner in the second person. These columns
    // are the raw facts needed to tell the two apart.
    //
    // Existing rows are left empty rather than guessed at. The information is
    // not in the store: `qq:onebot:group:...` session ids are the only trace, and
    // a session id is not a speaker. A backfill would be invention dressed as
    // data. An empty channel reads as `direct`, which is exactly the old
    // behaviour, so nothing that worked before changes meaning.
    const columns = db.prepare("SELECT name FROM pragma_table_info('episodes')").all()
      .map((row) => String(row.name));
    if (!columns.includes('speaker_id')) {
      db.exec("ALTER TABLE episodes ADD COLUMN speaker_id TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.includes('speaker_name')) {
      db.exec("ALTER TABLE episodes ADD COLUMN speaker_name TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.includes('channel')) {
      db.exec("ALTER TABLE episodes ADD COLUMN channel TEXT NOT NULL DEFAULT 'direct'");
    }
  }],
  [16, (db) => {
    // Which rows were said in a room.
    //
    // Migration 15 deliberately left every existing row at `channel = 'direct'`,
    // because a session id is not a speaker. That reasoning holds for
    // `speaker_id` and `speaker_name` and it does not hold for `channel`: a
    // session id is exactly where a message was said. `qq:onebot:group:7` is a
    // room and `qq:onebot:private:7` is not, and no part of that is inferred.
    //
    // Leaving it unfilled was not harmless. `channelOf` falls back to the id
    // pattern, so the runtime was right, while the table said `direct` — two
    // accounts of the same fact that disagree, and the next person to run a
    // query would have believed the table and concluded the room filter was
    // broken. `test/chprobe.mjs` printed exactly that contradiction.
    //
    // Only rows that still say `direct` are touched, so this cannot overwrite a
    // channel the runtime recorded from a real message source. The pattern is
    // `:group:` and not `%group%` to match `channelOf`'s deliberately narrow
    // rule — a session called `session-groupish-1` is not a room, and SQL that
    // disagrees with the code is how the two drift apart.
    const columns = db.prepare("SELECT name FROM pragma_table_info('episodes')").all()
      .map((row) => String(row.name));
    if (!columns.includes('channel')) return;
    db.prepare(`
      UPDATE episodes SET channel = 'group'
      WHERE channel = 'direct' AND session_id LIKE '%:group:%'
    `).run();
  }],
  [17, (db) => {
    // `self` is a third voice, and it is not a synonym for either existing one.
    //
    //   user  — the person said it
    //   agent — the agent's own reply inside a conversation
    //   self  — something the agent did on its own time: a page it read, a note
    //           it wrote, a thing it considered and dropped
    //
    // Without the third value a companion's own time can only be filed as
    // `agent`, which is indistinguishable from "this is what she answered you" —
    // so nothing she does while alone can be recalled as her own experience
    // later. The check constraint is the reason this needs a table rebuild
    // rather than an enum edit: SQLite cannot ALTER a CHECK.
    const columns = db.prepare("SELECT name FROM pragma_table_info('episodes')").all()
      .map((row) => String(row.name));
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes'").get();
    if (columns.includes('actor') && String(sql?.sql ?? '').includes("'self'")) return;

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec(`
        CREATE TABLE episodes_new (
          id            TEXT PRIMARY KEY,
          session_id    TEXT NOT NULL,
          message_id    TEXT,
          at            INTEGER NOT NULL,
          actor         TEXT NOT NULL CHECK (actor IN ('user','agent','self')),
          text          TEXT NOT NULL,
          tokens        INTEGER NOT NULL DEFAULT 0,
          stability     REAL NOT NULL DEFAULT 1.0,
          difficulty    REAL NOT NULL DEFAULT 5.0,
          last_review_at INTEGER,
          review_count  INTEGER NOT NULL DEFAULT 0,
          consolidated  INTEGER NOT NULL DEFAULT 0,
          superseded_by TEXT,
          redacted_at   INTEGER,
          redacted_reason TEXT NOT NULL DEFAULT '',
          sensitivity   TEXT NOT NULL DEFAULT 'personal',
          source        TEXT NOT NULL DEFAULT 'observed',
          arousal       REAL NOT NULL DEFAULT 0,
          speaker_id    TEXT NOT NULL DEFAULT '',
          speaker_name  TEXT NOT NULL DEFAULT '',
          channel       TEXT NOT NULL DEFAULT 'direct'
        ) STRICT
      `);
      // Column list is spelled out rather than `SELECT *`: an older database may
      // legitimately lack a column that a later migration adds, and a star copy
      // would fail the whole upgrade instead of leaving that column at default.
      const shared = [
        'id', 'session_id', 'message_id', 'at', 'actor', 'text', 'tokens',
        'stability', 'difficulty', 'last_review_at', 'review_count',
        'consolidated', 'superseded_by', 'redacted_at', 'sensitivity',
        'source', 'arousal',
      ].filter((name) => columns.includes(name));
      const optional = ['redacted_reason', 'speaker_id', 'speaker_name', 'channel']
        .filter((name) => columns.includes(name));
      const all = [...shared, ...optional];
      db.exec(`INSERT INTO episodes_new (${all.join(', ')}) SELECT ${all.join(', ')} FROM episodes`);
      db.exec('DROP TABLE episodes');
      db.exec('ALTER TABLE episodes_new RENAME TO episodes');
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    db.exec('CREATE INDEX IF NOT EXISTS episodes_at ON episodes(at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id, at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS episodes_open ON episodes(consolidated, at)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS episodes_message ON episodes(session_id, message_id) WHERE message_id IS NOT NULL');

    // The FTS table is a separate row set keyed by episode id, so it survives the
    // rebuild: it indexes nothing about the actor column, and re-segmenting every
    // row here would be a full rebuild of the search index for no gain.
  }],
  [18, (db) => {
    // Her own habits and intentions were extracted under the person's keys
    // (`habit`, `plan`) because those were the nearest thing in the vocabulary she
    // was given. The values are hers and stay hers; only the label was wrong, so
    // they are relabelled rather than dropped.
    //
    // The subject rewrite this migration originally also did is *not* here, and
    // that is deliberate: it needs `owner_account`, which comes from plugin
    // configuration and is therefore written after `ensureSchema` runs. A migration
    // that ran before its own input existed silently did nothing — which is exactly
    // what happened the first time. `alignOwnerSubject` in the plugin body does it
    // instead, on every start, idempotently.
    db.prepare("UPDATE facts SET predicate = 'self_habit' WHERE subject = 'agent' AND predicate = 'habit'").run();
    db.prepare("UPDATE facts SET predicate = 'self_plan' WHERE subject = 'agent' AND predicate = 'plan'").run();

    // The FTS body carries the predicate, so a relabelled fact would otherwise
    // still be found by its old key. Re-indexing the affected rows is cheap; a
    // full rebuild is not.
    const reindex = db.prepare('DELETE FROM facts_fts WHERE fact_id = ?');
    const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
    for (const row of db.prepare("SELECT id, subject, predicate, object FROM facts WHERE subject = 'agent'").all()) {
      reindex.run(String(row.id));
      insert.run(segment(`${String(row.subject)} ${String(row.predicate)} ${String(row.object)}`), String(row.id));
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
      actor         TEXT NOT NULL CHECK (actor IN ('user','agent','self')),
      text          TEXT NOT NULL,
      tokens        INTEGER NOT NULL DEFAULT 0,
      stability     REAL NOT NULL DEFAULT 1.0,
      difficulty    REAL NOT NULL DEFAULT 5.0,
      last_review_at INTEGER,
      review_count  INTEGER NOT NULL DEFAULT 0,
      consolidated  INTEGER NOT NULL DEFAULT 0,
      superseded_by TEXT,
      redacted_at   INTEGER,
      redacted_reason TEXT NOT NULL DEFAULT '',
      sensitivity   TEXT NOT NULL DEFAULT 'personal',
      source        TEXT NOT NULL DEFAULT 'observed',
      arousal       REAL NOT NULL DEFAULT 0,
      speaker_id    TEXT NOT NULL DEFAULT '',
      speaker_name  TEXT NOT NULL DEFAULT '',
      channel       TEXT NOT NULL DEFAULT 'direct'
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
  // ---- 反思与它的证据 ----------------------------------------------------
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
  // The evidence table stores "absent" as an empty string, not NULL, and that is
  // not a style choice.
  //
  // In a STRICT table every PRIMARY KEY column is implicitly NOT NULL. This table
  // is keyed on (reflection_id, fact_id, episode_id) because one reflection cites
  // both facts and episodes, so exactly one of the last two is meaningful per row
  // and the other has to be "absent" — and NULL is the obvious spelling of absent.
  // `INSERT OR IGNORE` then swallowed the NOT NULL violation for *every* row,
  // silently, so the table stayed empty for as long as it existed. A plain INSERT
  // would have thrown on the first one; OR IGNORE turned a hard error into a
  // no-op, which is worse.
  //
  // Empty string is the sentinel instead: it satisfies the constraint, it is a
  // legal primary-key value, and it compares equal only to itself, so the
  // uniqueness the table exists for still holds.
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflection_evidence (
      reflection_id TEXT NOT NULL REFERENCES reflections(id) ON DELETE CASCADE,
      fact_id       TEXT NOT NULL,
      episode_id    TEXT NOT NULL,
      PRIMARY KEY (reflection_id, fact_id, episode_id)
    ) STRICT
  `);

  // ---- 她对自己人设的改写 ------------------------------------------------
  //
  // The persona text lives in the profile's config and is injected as a prefix. It
  // was read-only by construction: not because anybody decided she should not change
  // it, but because a config file has no write path. That is a limitation of the
  // deployment, and it was being defended as if it were a design principle — "keep
  // the core stable" — which is the wrong trade for a project whose whole point is
  // that she grows.
  //
  // So the base persona stays where it is, untouched, and this table holds the
  // amendments she makes. A layer rather than a rewrite, for two reasons: the
  // original is the record of where she started, and an amendment can be withdrawn
  // without reconstructing the text it was written against.
  //
  // Nothing here is hidden from her: what she writes is rendered back at the top of
  // her prompt every turn, in her own words, right after the persona it modifies.
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_edits (
      id         TEXT PRIMARY KEY,
      section    TEXT NOT NULL DEFAULT 'any',
      text       TEXT NOT NULL,
      reason     TEXT NOT NULL DEFAULT '',
      valid_at   INTEGER NOT NULL,
      invalid_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS persona_edits_live ON persona_edits(invalid_at, section)');

  // ---- 人设原文 ----------------------------------------------------------
  //
  // The persona text lived only in the profile YAML, which has no write path — not by
  // a decision about her, but because a config string cannot be edited by the thing it
  // configures. "Read-only" was a property of the storage, and it had been defended as
  // a design principle.
  //
  // Keeping a copy here makes it editable. The profile seeds it once; after that this
  // row is the authority, so an edit survives a restart. A single row by construction
  // (`id = 'base'`) because "the persona" is one document.
  db.exec(`
    CREATE TABLE IF NOT EXISTS persona_base (
      id         TEXT PRIMARY KEY,
      text       TEXT NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    ) STRICT
  `);

  // ---- 用户对这个 agent 的长期要求 ------------------------------------
  //
  // A second store next to `facts`, not more `facts`. The two answer different
  // questions and mix badly:
  //
  //   facts        what is true about somebody — names, plans, habits
  //   directives   how the agent is expected to behave — "call me 老大",
  //                "one line per reply", "less kaomoji"
  //
  // A directive is not a fact about the person; it is an instruction that has to
  // reach the model every turn, because it is not semantically similar to anything
  // the person will say later — "叫我老大" would never be found by searching for
  // "今天吃什么". Retrieval cannot carry it, so it has to sit in the prompt.
  //
  // Every industry system that solved this keeps the two apart: ChatGPT has Custom
  // Instructions beside Memory, Claude has Instructions beside Memory, Letta puts a
  // read-only `persona` block beside a writable `human` block. None of them write
  // the user's standing requests into the static system prompt, which is what this
  // deployment was doing — hence "call me 老大" lasting exactly as long as the
  // session.
  //
  // `topic` is the key, not the wording: at most one live directive per topic is
  // rendered, so a later instruction supersedes an earlier one on the same subject
  // without deleting it. That is the cheapest conflict rule there is, and it is the
  // one OpenAI's Model Spec states — a later instruction at the same level wins.
  db.exec(`
    CREATE TABLE IF NOT EXISTS directives (
      id         TEXT PRIMARY KEY,
      topic      TEXT NOT NULL,
      text       TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'user',
      valid_at   INTEGER NOT NULL,
      invalid_at INTEGER,
      superseded_by TEXT,
      created_at INTEGER NOT NULL
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS directives_live ON directives(invalid_at, topic)');

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
      due_at       INTEGER,
      due_phrase   TEXT NOT NULL DEFAULT '',
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

  // ---- 待评分的召回快照 ------------------------------------------------
  // 上一轮注入给模型的记忆，等下一句话来判它是对是错。放数据库而不是内存，
  // 是因为最常见的调用形态是一次性进程：一个 `--profile call` 说完就退出，
  // 进程内的 Map 连下一次对话都活不到，评分永远发不出去。
  //
  // 主键是 owner 而不是 session：一次性进程每次都新建 session，按 session 存
  // 等于每轮都写在不同的桶里，下一轮永远读不到上一轮的东西。要判的是「这个
  // 人有没有推翻我们上次说过的记忆」，那是关于人的事实，不是关于会话的。
  //
  // 早期版本按 session 建过这张表。它不是累积数据，一行的寿命只有一句话，
  // 所以旧表直接扔掉重建，比写一个逐列搬迁的迁移更诚实。
  const recallColumns = db.prepare("SELECT name FROM pragma_table_info('pending_recall')").all();
  if (recallColumns.some((column) => String(column.name) === 'session_id')) {
    db.exec('DROP TABLE pending_recall');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_recall (
      user_id     TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      target_kind TEXT NOT NULL CHECK (target_kind IN ('episode','fact')),
      needle      TEXT NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (user_id, target_id, target_kind)
    ) STRICT
  `);
  db.exec('CREATE INDEX IF NOT EXISTS pending_recall_at ON pending_recall(at)');

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

  // Indexes over migrated columns are built after migration, not before: on a
  // fresh database the column is in the CREATE TABLE, but on an upgraded one it
  // only exists once migration has run, and indexing it earlier fails the whole
  // open.
  db.exec('CREATE INDEX IF NOT EXISTS episodes_live ON episodes(redacted_at, at)');
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
 * Current revision of the relational state.
 *
 * Nothing calls this. `relationship.revision` is incremented on every recorded
 * touch, so the counter is correct, but no behaviour reads it: it was added for
 * the Web UI that does not exist yet, where "has this changed since I painted
 * it" is a real question. Kept because the column costs nothing and removing it
 * needs a migration; kept *documented* because a getter with no caller is
 * exactly the shape this project spent a session hunting. If you are looking for
 * drift detection, there is none.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @returns {number} the revision.
 */
export function relationshipRevision(db, userId) {
  const row = db.prepare('SELECT revision FROM relationship WHERE user_id = ?').get(userId);
  return row === undefined ? 0 : Number(row.revision);
}

/**
 * Rebuild both full-text indexes from the source rows.
 *
 * An index is a cache of a tokenizer's output, so the only correct repair for a
 * wrong index is to throw it away and derive it again. Patching one is how a
 * migration once left `facts_fts` holding 18 rows for 20 facts. This lives here
 * rather than in the importer because two callers now need it, and two copies of
 * an index builder is the same bug waiting for the second copy to drift.
 *
 * Redacted episodes are skipped: their bodies are empty by contract, and a row
 * in the index is a row that can be recalled.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @returns {{ episodes: number, facts: number }} rows written to each index.
 */
export function rebuildSearchIndex(db) {
  db.exec('DELETE FROM episodes_fts');
  db.exec('DELETE FROM facts_fts');
  const insertEpisode = db.prepare('INSERT INTO episodes_fts (body, episode_id) VALUES (?, ?)');
  let episodes = 0;
  for (const row of db.prepare('SELECT id, text FROM episodes WHERE redacted_at IS NULL').all()) {
    insertEpisode.run(segment(String(row.text)), String(row.id));
    episodes += 1;
  }
  const insertFact = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
  let facts = 0;
  for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts WHERE invalid_at IS NULL').all()) {
    insertFact.run(
      segment(`${row.subject} ${row.predicate} ${row.object} ${synonymsFor(String(row.object))}`),
      String(row.id),
    );
    facts += 1;
  }
  return { episodes, facts };
}

/**
 * Fresh primary key.
 * @returns {string} an id.
 */
export function newId() {
  return randomUUID();
}
