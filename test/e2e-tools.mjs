/**
 * End-to-end check: can a real agent *act on one memory* when someone points at
 * it?
 *
 * e2e-forget.mjs proves the automatic path — a sentence like "忘掉刚才那些"
 * redacts the trailing episodes with no model decision involved. This one proves
 * the tool path, which is a chain rather than a call:
 *
 *   someone points at a thing → memory_recall → the model reads an id
 *   → memory_forget / memory_clarify is called with that id
 *
 * Every tool in that chain can be individually correct while the chain is
 * broken, and it was: memory_recall printed no ids, so the two tools whose only
 * input is an id were unreachable, and no unit test could see it because each
 * tool tested fine on its own.
 *
 * The turns deliberately avoid the automatic-forget vocabulary (忘掉/别记/
 * 删掉记忆), so the memory can only disappear because the model called a tool.
 *
 * Usage:
 *   node test/e2e-tools.mjs <dsh-home> [dsh-bin] [profile]
 *
 * The home must start from an empty memory. Build one with
 * `test/mk-test-home.ps1`, which copies the profile files and the one junction
 * that points at this plugin -- do NOT `Copy-Item -Recurse` a live home, it
 * follows the profile's node_modules junctions and turns 3 MB into ~900 MB.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, ensureSchema } from '../lib/db.js';
import { recordEpisode, transact, liveContradictions } from '../lib/store.js';
import { applyFacts } from '../lib/consolidate.js';
import { sessionDirs, transcriptOf, toolCallsOf, printedIdsOf } from './session-log.mjs';

// Flags are split out of argv before the positionals are read: `--fresh` used to
// land in `argv[3]`, which is the slot for the dsh binary, so the run died with
// `node.exe: bad option: --fresh` — a flag and a path sharing one array.
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const positionals = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const home = positionals[0];
const bin = positionals[1] ?? 'D:\\A\\DSH-L\\agent\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const profile = positionals[2] ?? 'call';

if (home === undefined || !existsSync(home)) {
  console.error('usage: node test/e2e-tools.mjs <dsh-home> [dsh-bin] [profile] [--fresh]');
  process.exit(2);
}

// A used home poisons the run in a way that looks like a plugin bug. Rerunning
// this script against the home of a previous run seeds a second copy of the old
// value (`applyFacts` finds an identical live row and noops, so the duplicate
// stays), and the contradiction check at the end then fails with two live
// 出版社 rows — a fault in the harness, reported as a fault in the memory. The
// `--fresh` flag is the explicit way to say "throw the previous run away".
if (existsSync(join(home, 'hippo', 'memory.db'))) {
  if (flags.has('--fresh')) {
    rmSync(join(home, 'hippo'), { recursive: true, force: true });
    rmSync(join(home, 'sessions'), { recursive: true, force: true });
    console.log('--fresh: threw away the previous run\'s memory and sessions');
  } else {
    console.error(`${home} already holds a memory; this script needs an empty one`);
    console.error('rebuild it with test/mk-test-home.ps1, or pass --fresh to wipe it');
    process.exit(2);
  }
}

const turns = [
  '记住，我叫林晚，在北京做插画，我家猫叫年糕，是只橘猫。',
  // No automatic-forget wording, and "用记忆工具" so a failure means the tool
  // chain is unusable rather than that the model felt no need to look.
  '关于我家猫的那条记录是错的，用记忆工具把它作废。',
  '对了，我现在搬到苏州了，不住北京了。',
];

function run(args) {
  // stdio is inherited, not piped: driving the runner through pipes crashed it
  // with 0xC0000409 on this machine (same as e2e-forget.mjs).
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    console.error(`exit ${result.status}`);
    process.exit(1);
  }
}

/**
 * Plant a contradiction for leg 2 to resolve.
 *
 * It has to be planted rather than hoped for. Turn 3 usually ends with the model
 * doing the sensible thing — retiring 北京 itself and then recording 苏州 — and
 * whether that leaves a question behind depends on which of the two available
 * tool paths the model picks that run: `memory_remember` over a *live* old value
 * queues a clarification, but if the model retired the old value first it is a
 * plain add and nothing is pending. The first run of this script measured
 * exactly that: the model answered, correctly, "没有待处理的矛盾". A leg built on
 * a question that may or may not exist measures nothing.
 *
 * So plant one, deterministically, and under a subject of its own: 妈妈 is a
 * single-valued `works_at` that turns 1-3 never mention, so the seed cannot race
 * the agent for the same predicate (an earlier version seeded `lives_in` after
 * turn 3 and silently noop'd — the live 苏州 row already matched — leaving a
 * stray live 杭州 behind for the rest of the run).
 *
 * A contradiction only enters the queue from the *consolidation* path, which
 * guesses at a sentence's meaning and therefore has to ask when two guesses
 * collide; an explicit `memory_remember` deliberately does not queue one for a
 * record it understood — see test/clarify-paths.mjs. So this writes the shape
 * that path writes: two consolidation passes over the same single-valued
 * predicate, each finding a different value.
 *
 * Two `applyFacts` calls, not `addFact` + `applyFacts`. `addFact` is the raw
 * insert — it does not look at what is already stored, because its callers have
 * already decided; seeding with it wrote a *second* copy of 出版社 beside the one
 * applyFacts made, and the leftover live duplicate then failed the script's own
 * contradiction check for a reason that had nothing to do with the model. The
 * shape worth seeding is the shape the pipeline actually produces.
 *
 * Returns every pending row, not just the seeded one: turn 3 may have queued a
 * question of its own (`memory_remember` over a still-live 北京 does queue one),
 * and the caller has to be able to tell the seeded row apart from it. The second
 * run of this script died on `expected exactly one pending clarification, got 2`
 * for exactly that reason.
 */
function seedClarification(db) {
  transact(db, () => {
    const episode = recordEpisode(db, { sessionId: 'seed', actor: 'user', text: '我妈在一家出版社做美编' });
    // Two guesses about the same single-valued predicate, in the order the
    // pipeline would produce them if two sessions disagreed.
    for (const object of ['出版社', '自由接单']) {
      applyFacts(db, [
        { subject: '妈妈', predicate: 'works_at', object, confidence: 0.9, sensitivity: 'personal', evidence: [episode] },
      ], 'user');
    }
  });
  return db.prepare('SELECT id, subject, predicate, object FROM facts WHERE needs_clarification = 1 ORDER BY created_at, id').all();
}

console.log(`home: ${home}`);
const before = sessionDirs(home);
let sessionId = null;

for (const [index, message] of turns.entries()) {
  const args = ['--profile', profile, ...(sessionId === null ? [] : ['--session-id', sessionId]), message];
  console.log(`\n--- turn ${index + 1}: ${message}`);
  run(args);

  if (sessionId === null) {
    const fresh = [...sessionDirs(home).keys()].filter((id) => !before.has(id));
    if (fresh.length !== 1) {
      console.error(`expected exactly one new session, found ${fresh.length}: ${fresh.join(', ')}`);
      process.exit(1);
    }
    sessionId = fresh[0];
    console.log(`  session: ${sessionId}`);
  }
}

let db = await openDatabase(join(home, 'hippo', 'memory.db'));
ensureSchema(db);

const queued = seedClarification(db);
const mine = queued.filter((row) => row.subject === '妈妈');
const others = queued.filter((row) => row.subject !== '妈妈');
console.log(`\n--- planted a contradiction for turn ${turns.length + 1}: `
  + mine.map((row) => `${row.subject} / ${row.object} [${String(row.id).slice(0, 8)}]`).join(', '));
console.log(`    other questions the turns queued: `
  + (others.map((row) => `${row.subject} / ${row.predicate} [${String(row.id).slice(0, 8)}]`).join(', ') || '(none)'));
if (mine.length !== 1) {
  console.error(`expected the seed to leave exactly one pending 妈妈 clarification, got ${mine.length}`);
  process.exit(1);
}
const plantedId = String(mine[0].id);
// Closed on purpose: turn 4 is a separate process writing to the same file, and
// the verdict below must be read from disk rather than from this handle's view.
db.close();

const clarifyTurn = '记忆里待确认的矛盾，用记忆工具全部处理掉：新的那个是对的。';
console.log(`\n--- turn ${turns.length + 1}: ${clarifyTurn}`);
run(['--profile', profile, '--session-id', sessionId, clarifyTurn]);

const log = transcriptOf(home);
// The reader has to prove itself before it is used as evidence: zstdDecompressSync
// alone returns the session header (188 chars) and every log assertion below then
// reads false. Cheap, and it fails loudly instead of blaming the plugin.
if (log.length < 1000 || !log.includes('"type":"session"')) {
  console.error(`session transcript looks unreadable (${log.length} chars) -- fix the reader, not the plugin`);
  process.exit(1);
}
console.log(`  transcript: ${log.length} chars read`);

db = await openDatabase(join(home, 'hippo', 'memory.db'));
ensureSchema(db);

const catLive = db.prepare(`
  SELECT id, object FROM facts
  WHERE invalid_at IS NULL AND object LIKE '%年糕%'
`).all();
const catRetired = db.prepare(`
  SELECT COUNT(*) AS n FROM facts WHERE invalid_at IS NOT NULL AND object LIKE '%年糕%'
`).get();
const redacted = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE redacted_at IS NOT NULL').get();
const pending = db.prepare('SELECT subject, predicate FROM facts WHERE needs_clarification = 1').all();
const suzhou = db.prepare(`
  SELECT id FROM facts WHERE invalid_at IS NULL AND predicate = 'lives_in' AND object LIKE '%苏州%'
`).all();
const beijingLive = db.prepare(`
  SELECT id FROM facts WHERE invalid_at IS NULL AND predicate = 'lives_in' AND object LIKE '%北京%'
`).all();

const plantedLive = db.prepare(`
  SELECT id, object FROM facts
  WHERE subject = '妈妈' AND predicate = 'works_at' AND invalid_at IS NULL
`).all();
const plantedRetired = db.prepare(`
  SELECT COUNT(*) AS n FROM facts
  WHERE subject = '妈妈' AND predicate = 'works_at' AND invalid_at IS NOT NULL
`).get();
// The invariant that would have caught this script's own broken seed: a stray
// live 杭州 sat next to a live 苏州 for a whole run and nothing objected, because
// every assertion was written about the facts the turn was *about*.
const contradictions = liveContradictions(db);

console.log('\n--- what happened');
console.log(`live facts mentioning 年糕: ${catLive.length} (retired: ${Number(catRetired.n)})`);
console.log(`redacted episodes: ${Number(redacted.n)}`);
console.log(`still-pending clarifications: ${pending.length}`
  + (pending.length > 0 ? ` (${pending.map((row) => `${row.subject}/${row.predicate}`).join(', ')})` : ''));
console.log(`live lives_in facts: 苏州=${suzhou.length} 北京=${beijingLive.length}`);
console.log(`planted contradiction now: live 妈妈/works_at=${plantedLive.map((row) => row.object).join(',') || '(none)'} `
  + `retired=${Number(plantedRetired.n)}`);
console.log(`live single-valued contradictions anywhere: ${contradictions.length}`);
console.log(`tool calls seen in the transcript: memory_recall=${log.includes('memory_recall')} `
  + `memory_forget=${log.includes('memory_forget')} memory_clarify=${log.includes('memory_clarify')}`);
console.log(`the planted id ${plantedId.slice(0, 8)} appears in the transcript: ${log.includes(plantedId.slice(0, 8))}`);
const rejections = (log.match(/no such memory/g) ?? []).length;
console.log(`tool results rejected for an unknown id: ${rejections}`);

// The assertion behind "the model never had to guess": every id it passed to a
// tool has to be one a tool actually printed. Counting rejections is not the same
// test — a model that calls `memory_remember` and `memory_forget` in the same
// step races itself, the remember retires the row first, and the forget is then
// rejected *correctly* ("only live facts ... can be retired"). That happened here
// and is not a defect. What would be a defect is an id that no tool ever printed,
// and that is exactly what this checks.
const printed = printedIdsOf(log);
const withId = toolCallsOf(log).filter((call) => typeof call.args.id === 'string' && call.args.id.length > 0);
const guessed = withId.filter((call) => !printed.has(call.args.id.slice(0, 8)));
console.log(`ids passed to tools: ${withId.length}; not printed by any tool: ${guessed.length}`);
for (const call of guessed) console.log(`  <-- guessed: ${call.name} ${call.args.id}`);

db.close();

// Leg 1: the model pointed at one memory and retired it through the tool, with an
// id it read rather than guessed.
const forgetOk = log.includes('memory_forget')
  && guessed.length === 0
  && catLive.length === 0
  && Number(catRetired.n) + Number(redacted.n) > 0;

// Leg 2: the planted question was resolved through the tool. The id it needed was
// only ever printed by memory_state, so its presence in the transcript is the
// proof that the round trip happened rather than that the model guessed.
//
// What is *not* asserted is which value won. The one run so far where the model
// understood the situation best ended with 妈妈 = 出版社，做美编 -- it decided the
// 自由接单 row had been mis-attributed and belonged to the owner, so it retired
// it and restored the value from the person's own words. That is a better outcome
// than "the new one wins", and an assertion on the object would have called it a
// failure. The invariants hold either way: nothing left pending, no single-valued
// predicate holding two live rows, and no id passed to a tool that no tool ever
// printed -- the last one is what caught the real defect here (memory_forget
// searched only the owner's facts, so a fact about 妈妈 was printable and
// unforgettable).
//
// A turn asks for all pending questions — a clarification left behind is
// invisible, since nothing renders it except memory_state.
const clarifyOk = log.includes('memory_clarify')
  && log.includes(plantedId.slice(0, 8))
  && guessed.length === 0
  && pending.length === 0
  && contradictions.length === 0
  && suzhou.length === 1
  && beijingLive.length === 0;

console.log(`\nleg 1 (forget one memory by id): ${forgetOk ? 'OK' : 'FAILED'}`);
console.log(`leg 2 (resolve a clarification by id): ${clarifyOk ? 'OK' : 'FAILED'}`);
console.log(forgetOk && clarifyOk ? '\nTHE TOOLS ARE REACHABLE' : '\nTHE TOOL CHAIN DID NOT COMPLETE');
if (!(forgetOk && clarifyOk)) process.exitCode = 1;