/**
 * Assertions for `/memory`, the operator surface.
 *
 * Why a command and not a tool: every tool is reachable by anyone who can talk
 * the agent into calling it, and "write my whole memory to this path" is not a
 * thing a stranger in a group should be able to talk it into. The tests below
 * check both halves of that — what the command does, and what it refuses to do
 * when the caller is not the owner.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';
import { addFact, recordEpisode, addOpenLoop, userId as readUserId } from '../lib/store.js';
import { runMemoryCommand } from '../lib/commands.js';
import { DUMP_FORMAT } from '../lib/dump.js';

const now = Date.now();
const db = await openDatabase(':memory:');
const owner = readUserId(db);
const dir = mkdtempSync(join(tmpdir(), 'hippo-cmd-'));
const file = join(dir, 'memory.json');

recordEpisode(db, {
  sessionId: 'qq:onebot:private:3184763831',
  actor: 'user',
  text: '我在合肥做插画师，家里有两只猫。',
  at: now - 60_000,
});
addFact(db, {
  subject: owner,
  predicate: 'lives_in',
  object: '合肥',
  confidence: 0.9,
  source: 'explicit',
  now,
});
addOpenLoop(db, {
  userId: owner,
  text: '等她告诉我绘本稿的反馈',
  createdAt: now - 3600_000,
  followAfter: now + 3600_000,
});

const asOwner = (rawInput) => runMemoryCommand(db, { rawInput, agent: { room: false } }, {
  language: 'zh',
  isOutsider: (agent) => agent?.room === true,
});
const asRoom = (rawInput) => runMemoryCommand(db, { rawInput, agent: { room: true } }, {
  language: 'zh',
  isOutsider: (agent) => agent?.room === true,
});

// --- status -----------------------------------------------------------------

const status = asOwner('');
assert.equal(status.kind, 'success', 'a bare /memory did not print status');
assert.match(status.text, /记忆/, 'status did not use the configured language');
assert.match(status.text, /1 情景/, 'status miscounted episodes');
assert.match(status.text, /1 事实/, 'status miscounted live facts');
assert.match(status.text, /1 未了的事/, 'status miscounted open loops');
assert.match(status.text, /今日模型开销/, 'status did not report the daily spend');

assert.equal(asOwner('status').kind, 'success', 'the explicit `status` word was rejected');
assert.equal(asOwner('status').text, status.text, '`/memory` and `/memory status` disagree');

// --- dump -------------------------------------------------------------------

const dumped = asOwner(`dump ${file}`);
assert.equal(dumped.kind, 'success', `dump failed: ${dumped.text}`);
assert.match(dumped.text, /已导出/, 'dump did not say it wrote anything');
assert.match(dumped.text, /1 情景/, 'dump did not report what it wrote');
assert.match(dumped.text, /含已退休的/, 'dump did not say its fact count includes retired beliefs');

const written = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(written.format, DUMP_FORMAT, 'the file is not a memory dump');
assert.equal(written.tables.episodes.length, 1, 'the file is missing the episode');
assert.equal(written.tables.facts.length, 1, 'the file is missing the fact');
assert.equal(written.tables.open_loops.length, 1, 'the file is missing the open loop');

// A retired fact is still exported. "I used to believe this" is part of the
// record, and the count a dump reports is rows in the file, not live beliefs —
// which is why it is allowed to disagree with `status`.
addFact(db, {
  subject: '妈妈',
  predicate: 'works_at',
  object: '苏州一家医院',
  confidence: 0.8,
  source: 'explicit',
  now,
});
db.prepare("UPDATE facts SET invalid_at = ? WHERE subject = '妈妈'").run(now);
asOwner(`dump ${file}`);
const withRetired = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(withRetired.tables.facts.length, 2, 'a retired fact was left out of the dump');
assert.equal(asOwner('').text.includes('1 事实'), true, 'status counted a retired fact as live');
db.prepare("DELETE FROM facts WHERE subject = '妈妈'").run();
// Put the single-fact dump back, because `import` below measures against it.
asOwner(`dump ${file}`);

// A dump with no path is a question, and the answer is how to ask it.
const noPath = asOwner('dump');
assert.equal(noPath.kind, 'error');
assert.match(noPath.text, /用法/, 'a missing path did not show the usage line');

// --- inspect ----------------------------------------------------------------

const inspected = asOwner(`inspect ${file}`);
assert.equal(inspected.kind, 'success', `inspect failed: ${inspected.text}`);
assert.match(inspected.text, /这个文件里有/, 'inspect did not lead with what the file holds');
assert.match(inspected.text, /episodes 1/, 'inspect did not count the episodes');
assert.match(inspected.text, /按设计不导出/, 'inspect did not name what a dump leaves out');

const missing = asOwner(`inspect ${join(dir, 'nope.json')}`);
assert.equal(missing.kind, 'error');
assert.match(missing.text, /could not read/, 'a missing file did not produce a sentence');

// --- import -----------------------------------------------------------------

// Importing a file exported from the same store must add nothing: the ids match,
// so every row is already there. This is the boring case, and it is the one that
// catches an importer that duplicates everything it is given.
const again = asOwner(`import ${file}`);
assert.equal(again.kind, 'success', `import failed: ${again.text}`);
assert.match(again.text, /\(nothing new\)/, `a re-import added rows: ${again.text}`);
assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n), 1, 'a re-import duplicated the episode');

// --- the operator verbs are not reachable from a room -----------------------

const roomDump = asRoom(`dump ${join(dir, 'stolen.json')}`);
assert.equal(roomDump.kind, 'error', 'a room was allowed to write the memory to a file');
assert.match(roomDump.text, /群聊或陌生人/, 'the refusal did not say why');
assert.throws(
  () => readFileSync(join(dir, 'stolen.json'), 'utf8'),
  'the refused dump still wrote a file',
);

const roomImport = asRoom(`import ${file}`);
assert.equal(roomImport.kind, 'error', 'a room was allowed to import a file');

// ...but status is fine, because a count is not a disclosure.
assert.equal(asRoom('status').kind, 'success', 'a room was refused a row count');

// --- usage ------------------------------------------------------------------

const unknown = asOwner('forget-everything');
assert.equal(unknown.kind, 'error');
assert.match(unknown.text, /未知子命令/, 'an unknown verb did not say so');
assert.match(unknown.text, /用法/, 'an unknown verb did not show the usage line');

const english = runMemoryCommand(db, { rawInput: 'status', agent: { room: false } }, {
  language: 'en',
  isOutsider: () => false,
});
assert.match(english.text, /^memory:/, 'the English status line did not use the English word');

rmSync(dir, { recursive: true, force: true });
console.log('commands: all checks passed');
