/**
 * A memory that can leave the machine.
 *
 * Two failures matter here and they are both silent. The first is an export that
 * quietly omits a table, so a backup looks complete and restores a person with no
 * promises and no apologies. The second is an import whose full-text index is
 * stale — every row is present, `liveFacts` answers, and nothing can be found by
 * talking about it, which is the only way anyone finds anything.
 */

import assert from 'node:assert/strict';
import { openDatabase, rebuildSearchIndex } from '../lib/db.js';
import {
  recordEpisode,
  addFact,
  liveFacts,
  openLoops,
  addOpenLoop,
  closeOpenLoop,
  recall,
  invalidateFact,
  redactEpisode,
  chargeBudget,
  savePendingRecall,
  takePendingRecall,
} from '../lib/store.js';
import { exportMemory, importMemory, describeDump, DUMP_FORMAT } from '../lib/dump.js';

const OWNER = 'user';
const now = Date.parse('2026-10-18T21:00:00Z');

/**
 * A store with one of everything, including the two rows that must not travel.
 * @returns {Promise<object>} an open database.
 */
async function seeded() {
  const db = await openDatabase(':memory:');
  const first = recordEpisode(db, {
    sessionId: 'qq:onebot:private:3184763831',
    actor: 'user',
    text: '我在合肥做插画，最近在戒烟，已经两周了。',
    at: now - 60_000,
    speakerId: '3184763831',
    speakerName: '66',
    channel: 'direct',
  });
  const second = recordEpisode(db, {
    sessionId: 'qq:onebot:private:3184763831',
    actor: 'agent',
    text: '记下了。戒了两周，正是最难的时候。',
    at: now - 30_000,
    channel: 'direct',
  });
  addFact(db, {
    subject: OWNER, predicate: 'lives_in', object: '合肥', confidence: 0.95, source: 'explicit',
  }, [first]);
  addFact(db, {
    subject: OWNER, predicate: 'habit', object: '戒烟两周', confidence: 0.8, source: 'explicit',
  }, [first]);
  addFact(db, {
    subject: '妈妈', predicate: 'health', object: '血糖稳定了', confidence: 0.7, source: 'consolidated',
  }, [second]);
  addOpenLoop(db, {
    userId: OWNER,
    text: '过两天问问戒烟怎么样了',
    dueAt: now + 86_400_000,
    followAfter: now + 86_400_000,
    duePhrase: '过两天',
  });
  chargeBudget(db, 1234, '2026-10-18');
  savePendingRecall(db, OWNER, [{ id: first, kind: 'episode', needle: '戒烟' }], now);
  return db;
}

// ---- everything that is data travels -------------------------------------

const source = await seeded();
const dump = exportMemory(source, { now });

assert.equal(dump.format, DUMP_FORMAT);
assert.equal(dump.version, 1);
assert.equal(dump.schemaVersion, 16, 'the dump recorded a schema version that is not this build\'s');
assert.equal(dump.tables.episodes.length, 2);
assert.equal(dump.tables.facts.length, 3);
assert.equal(dump.tables.open_loops.length, 1);

// The three tables that stay behind, each for its own reason. Asserting their
// absence by name rather than by count: an export that grows a new table without
// anyone deciding whether it is data should fail here, not in a backup nobody
// restored until they needed it.
assert.equal(dump.tables.budget, undefined, 'the daily spend ledger was exported');
assert.equal(dump.tables.pending_recall, undefined, 'a one-turn snapshot was exported');
assert.equal(dump.tables.relationship, undefined, 'derived relationship state was exported as if it were data');
assert.equal(dump.tables.episodes_fts, undefined, 'an index was exported as if it were data');

// `schema_version` describes the file, not this machine. Exporting it into `meta`
// would let an importer trust a foreign version number and skip the migrations
// that make those rows readable here.
assert.equal(
  dump.tables.meta.some((row) => row.key === 'schema_version'),
  false,
  'the exporting build\'s schema version was exported into meta',
);
assert.equal(dump.tables.meta.some((row) => row.key === 'user_id'), true, 'the owner id did not travel');

// ---- a restore can find things by talking about them ----------------------

const target = await openDatabase(':memory:');
const report = importMemory(target, dump);

assert.equal(report.ok, true, `import refused: ${report.error}`);
assert.equal(report.added.episodes, 2);
assert.equal(report.added.facts, 3);
assert.equal(report.added.open_loops, 1);
assert.equal(report.rebuilt.episodes, 2);
assert.equal(report.rebuilt.facts, 3);

// The point of the whole test: rows present is not the same as rows reachable.
const found = recall(target, { cue: '戒烟', userId: OWNER, limit: 10, includeEpisodes: true });
assert.ok(found.facts.length >= 1, 'an imported fact could not be found by asking about it');
assert.ok(found.episodes.length >= 1, 'an imported episode could not be found by asking about it');
assert.equal(liveFacts(target, { subject: OWNER, limit: 20 }).length, 2);

const loops = openLoops(target, OWNER);
assert.equal(loops.length, 1, 'an open promise did not survive the round trip');
assert.equal(String(loops[0].text), '过两天问问戒烟怎么样了');
assert.equal(Number(loops[0].due_at), now + 86_400_000, 'a due date was lost, so the promise can never come due');

// ---- the two local ledgers did not come along -----------------------------

// Not "were not copied" — the reason they were not copied. A restored snapshot of
// yesterday's spending does not give this machine more room, it gives it a wrong
// number, and the wrong number is smaller.
assert.equal(
  target.prepare('SELECT COUNT(*) AS n FROM budget').get().n,
  0,
  'another machine\'s daily ledger was imported',
);
assert.deepEqual(
  takePendingRecall(target, OWNER),
  [],
  'a recall snapshot from another process was restored',
);
// Non-vacuous companion: the same call on the source store does find the snapshot.
// Without it this assertion would also pass against a `takePendingRecall` that
// simply always answered empty.
assert.equal(takePendingRecall(source, OWNER).length, 1, 'the source store had no snapshot to begin with');
// `relationship` is rebuilt by the importer's own machinery, never overwritten,
// so a fresh store has the row `ensureRelationship` would create and nothing more.
const relationship = target.prepare('SELECT * FROM relationship WHERE user_id = ?').get(OWNER);
assert.equal(relationship, undefined, 'derived relationship state arrived as data');

// ---- importing twice does not double the memory ---------------------------

const again = importMemory(target, dump);
assert.equal(again.ok, true);
assert.equal(again.added.episodes, 0, 'a second import of the same dump duplicated episodes');
assert.equal(again.added.facts, 0, 'a second import of the same dump duplicated facts');
assert.equal(again.skipped.episodes, 2);
assert.equal(again.skipped.facts, 3);
assert.equal(target.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 3);
assert.equal(
  target.prepare('SELECT COUNT(*) AS n FROM facts_fts').get().n,
  3,
  'the rebuilt index counted duplicates the table does not have',
);

// ---- a merge keeps the newer local answer ---------------------------------

// The whole safety story of merge-not-replace: a fact retired here stays retired
// even if the backup still believes it. The reverse — a restore that quietly
// resurrects a belief the person asked to forget — is unrecoverable.
const local = await seeded();
const live = liveFacts(local, { subject: OWNER, limit: 10 }).find((row) => String(row.predicate) === 'habit');
invalidateFact(local, String(live.id), { at: now });
const merged = importMemory(local, dump);
assert.equal(merged.ok, true);
assert.equal(
  liveFacts(local, { subject: OWNER, limit: 10 }).filter((row) => String(row.predicate) === 'habit').length,
  0,
  'an import resurrected a fact this store had retired',
);
// The refusal is counted, not silent: a restore that drops rows has to say so, or
// the person reading the report cannot tell a clean merge from a lossy one.
assert.equal(merged.refused.facts, 1, 'the refusal was not reported');
assert.equal(merged.added.facts, 2, 'refusing one fact also cost the other two');

// Re-establishing the belief after the retirement is the more recent decision, so
// the guard must not freeze the subject forever. Without this, forgetting one
// phrasing of "戒烟" would make every future restore of that phrasing a no-op.
addFact(local, {
  subject: OWNER, predicate: 'habit', object: '戒烟两周', confidence: 0.9, source: 'explicit',
}, []);
const afterReestablish = importMemory(local, dump);
assert.equal(afterReestablish.refused.facts, 0, 'a re-established belief stayed refused as retired');

// ---- a forgotten message is exported as forgotten -------------------------

// A redaction is part of the record: the row stays, the text does not. An export
// that dropped the row would make "it was forgotten" indistinguishable from "it
// never happened", and an export that carried the text would undo the forgetting.
const redacted = await seeded();
const secret = recordEpisode(redacted, {
  sessionId: 'qq:onebot:private:3184763831',
  actor: 'user',
  text: '我的银行卡密码是……',
  at: now - 10_000,
});
redactEpisode(redacted, secret, { reason: 'requested', now });
const redactedDump = exportMemory(redacted, { now });
const carried = redactedDump.tables.episodes.find((row) => String(row.id) === String(secret));
assert.ok(carried !== undefined, 'a redacted episode vanished from the export');
assert.equal(carried.text, '', 'a redacted episode exported its text');
assert.equal(Number(carried.redacted_at), now, 'the redaction time did not travel');
const described = describeDump(redactedDump);
assert.equal(described.redactedEpisodes, 1);
assert.equal(described.rows.episodes, 3);

const restored = await openDatabase(':memory:');
const restoredReport = importMemory(restored, redactedDump);
assert.equal(restoredReport.ok, true);
assert.equal(restoredReport.rebuilt.episodes, 2, 'the rebuilt index included a redacted episode');
const hit = recall(restored, { cue: '银行卡密码', userId: OWNER, limit: 10, includeEpisodes: true });
assert.equal(hit.episodes.length, 0, 'a forgotten sentence came back through the index');

// The same sentence, forgotten here and still live in a backup taken elsewhere:
// `INSERT OR IGNORE` cannot catch it because the ids differ, so the message id is
// the only handle left. Without this guard a restore is a way to un-forget.
const elsewhere = {
  format: DUMP_FORMAT,
  version: 1,
  exportedAt: now,
  schemaVersion: 16,
  tables: {
    meta: [{ key: 'user_id', value: OWNER }],
    episodes: [{
      id: 'a-different-id-for-the-same-message',
      session_id: 'qq:onebot:private:3184763831',
      message_id: 'the-same-message',
      at: now - 10_000,
      actor: 'user',
      text: '我的银行卡密码是……',
      tokens: 0,
      stability: 1,
      difficulty: 0.3,
      review_count: 0,
      consolidated: 0,
      sensitivity: 'personal',
      source: 'observed',
      arousal: 0,
      speaker_id: '',
      speaker_name: '',
      channel: 'direct',
    }],
  },
};
const withForgotten = await openDatabase(':memory:');
recordEpisode(withForgotten, {
  sessionId: 'qq:onebot:private:3184763831',
  actor: 'user',
  text: '我的银行卡密码是……',
  messageId: 'the-same-message',
  at: now - 10_000,
});
const doomed = withForgotten.prepare('SELECT id FROM episodes WHERE message_id = ?').get('the-same-message');
redactEpisode(withForgotten, String(doomed.id), { reason: 'requested', now });
const unforget = importMemory(withForgotten, elsewhere);
assert.equal(unforget.ok, true);
assert.equal(unforget.refused.episodes, 1, 'a restore un-forgot a message that had been redacted here');
assert.equal(unforget.added.episodes, 0);
assert.equal(
  recall(withForgotten, { cue: '银行卡密码', userId: OWNER, limit: 10, includeEpisodes: true }).episodes.length,
  0,
  'the un-forgotten sentence was findable after the import',
);

// ---- shapes that must be refused rather than half-read -------------------

const refused = [
  [null, 'not a memory dump'],
  [{}, 'format'],
  [{ format: 'something-else/memory', version: 1, tables: {} }, 'format'],
  [{ format: DUMP_FORMAT, version: 999, tables: {} }, 'newer than this build'],
  [{ format: DUMP_FORMAT, version: 1 }, 'no tables'],
];
const blank = await openDatabase(':memory:');
for (const [candidate, why] of refused) {
  const outcome = importMemory(blank, candidate);
  assert.equal(outcome.ok, false, `import accepted a dump it should have refused (${why})`);
  assert.ok(
    String(outcome.error).toLowerCase().includes(why.toLowerCase()),
    `refusal did not explain itself: ${outcome.error}`,
  );
}

// ---- an older dump is read with what it has -----------------------------

// A column this build has and the snapshot lacks takes its DEFAULT; a column the
// snapshot has and this build lacks is reported, not invented into the row.
const older = {
  format: DUMP_FORMAT,
  version: 1,
  exportedAt: now,
  schemaVersion: 14,
  tables: {
    meta: [{ key: 'user_id', value: OWNER }],
    episodes: [{
      id: 'old-episode-1',
      session_id: 'qq:onebot:private:3184763831',
      at: now - 1_000,
      actor: 'user',
      text: '这是一条旧格式的记忆',
      // no speaker_id / speaker_name / channel, and a column from the future
      future_column: 'invented',
    }],
    facts: [{
      id: 'old-fact-1',
      subject: OWNER,
      predicate: 'lives_in',
      object: '苏州',
      confidence: 0.9,
      valid_at: now - 1_000,
    }],
  },
};
const upgraded = await openDatabase(':memory:');
const upgradedReport = importMemory(upgraded, older);
assert.equal(upgradedReport.ok, true, `an older-format dump was refused: ${upgradedReport.error}`);
assert.equal(upgradedReport.added.episodes, 1);
assert.deepEqual(upgradedReport.dropped.episodes, ['future_column'], 'an unknown column was not reported');
const oldRow = upgraded.prepare('SELECT * FROM episodes WHERE id = ?').get('old-episode-1');
assert.equal(String(oldRow.channel), 'direct', 'a missing channel did not fall back to the old behaviour');
assert.equal(String(oldRow.text), '这是一条旧格式的记忆');

// ---- rebuilding the index is idempotent ----------------------------------

const before = target.prepare('SELECT COUNT(*) AS n FROM facts_fts').get().n;
const firstRebuild = rebuildSearchIndex(target);
const secondRebuild = rebuildSearchIndex(target);
assert.deepEqual(firstRebuild, secondRebuild, 'a rebuild changed its own answer on a second run');
assert.equal(target.prepare('SELECT COUNT(*) AS n FROM facts_fts').get().n, before);

console.log('dump: all checks passed');
