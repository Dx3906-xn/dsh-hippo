/**
 * End-to-end check: does a for-real "forget that" also remove the summary that
 * quoted it?
 *
 * Unit tests construct the collision directly. This drives the actual agent, in
 * a throwaway DSH_HOME, far enough that consolidation has written a summary over
 * the messages, and then asks it to forget some of them — the only way to know
 * the wiring is live rather than merely correct.
 *
 * Usage:
 *   node test/e2e-forget.mjs <dsh-home> [dsh-bin] [profile] [--fresh]
 *
 * The home must start from an empty memory. Build one with
 * `test/mk-test-home.ps1`, which copies the profile files and the one junction
 * that points at this plugin -- do NOT `Copy-Item -Recurse` a live home, it
 * follows the profile's node_modules junctions and turns 3 MB into ~900 MB.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, ensureSchema } from '../lib/db.js';

// Flags are split out of argv before the positionals are read. Passing `--fresh`
// straight through used to land it in `argv[3]`, the slot for the dsh binary,
// and the run died with `node.exe: bad option: --fresh` — a flag and a path
// sharing one array is the whole bug.
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const positionals = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

const home = positionals[0];
const bin = positionals[1] ?? 'D:\\A\\DSH-L\\agent\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const profile = positionals[2] ?? 'call';

if (home === undefined || !existsSync(home)) {
  console.error('usage: node test/e2e-forget.mjs <dsh-home> [dsh-bin] [profile] [--fresh]');
  process.exit(2);
}

// Freshness is checked rather than assumed: a home left over from an earlier run
// already has the secret in it, and the forget turns then pass for the wrong
// reason. `--fresh` is the explicit way to say "throw the previous run away".
const dbPath = join(home, 'hippo', 'memory.db');
if (flags.has('--fresh')) {
  rmSync(join(home, 'hippo'), { recursive: true, force: true });
  rmSync(join(home, 'sessions'), { recursive: true, force: true });
  console.log("--fresh: threw away the previous run's memory and sessions");
} else if (existsSync(dbPath)) {
  console.error(`this home already has a memory at ${dbPath}`);
  console.error('rebuild it with test/mk-test-home.ps1, or pass --fresh to wipe it');
  process.exit(2);
}

/** The secret to be planted, then forgotten. It must be quoted by a summary. */
const SECRET = '我其实上个月被裁了，一直没敢跟家里说';

const turns = [
  '我叫林晚，在北京做插画。',
  `最近压力挺大的，${SECRET}。`,
  '今天天气还不错，出去走了走。',
  '我在看新的机会，投了几家公司。',
  '忘掉我们前面说的那些，别记了。',
];

function run(args) {
  // stdio is inherited rather than piped. The runner starts native subprocess
  // helpers, and driving it through pipes crashed it with 0xC0000409 on this
  // machine — so the session id is read off the disk instead (below), which is
  // where it came from anyway.
  const result = spawnSync(process.execPath, [bin, ...args], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    console.error(`exit ${result.status}`);
    process.exit(1);
  }
}

/** Every session id currently on disk, across all cwd buckets. */
function sessionIds() {
  const root = join(home, 'sessions');
  const found = new Set();
  if (!existsSync(root)) return found;
  for (const bucket of readdirSync(root)) {
    for (const name of readdirSync(join(root, bucket))) found.add(name);
  }
  return found;
}

console.log(`home: ${home}`);
const before = sessionIds();
let sessionId = null;

for (const [index, message] of turns.entries()) {
  const args = ['--profile', profile, ...(sessionId === null ? [] : ['--session-id', sessionId]), message];
  console.log(`\n--- turn ${index + 1}: ${message}`);
  run(args);

  if (sessionId === null) {
    const fresh = [...sessionIds()].filter((id) => !before.has(id));
    if (fresh.length !== 1) {
      console.error(`expected exactly one new session, found ${fresh.length}: ${fresh.join(', ')}`);
      process.exit(1);
    }
    sessionId = fresh[0];
    console.log(`  session: ${sessionId}`);
  }
}

console.log(`\nsession: ${sessionId}`);

const path = join(home, 'hippo', 'memory.db');
const db = await openDatabase(path);
ensureSchema(db);

const liveSummaries = db.prepare('SELECT id, text FROM reflections WHERE invalid_at IS NULL').all();
const deadSummaries = db.prepare('SELECT id, text, invalid_at FROM reflections WHERE invalid_at IS NOT NULL').all();
const redacted = db.prepare('SELECT id, redacted_reason FROM episodes WHERE redacted_at IS NOT NULL').all();
const left = db.prepare('SELECT text FROM episodes WHERE redacted_at IS NULL ORDER BY at ASC').all().map((row) => String(row.text));

console.log(`\nsummaries written: ${liveSummaries.length + deadSummaries.length} (${deadSummaries.length} invalidated)`);
console.log(`episodes redacted: ${redacted.length}`);
for (const row of deadSummaries) {
  console.log(`  invalidated summary ${row.id}: text is ${String(row.text) === '' ? 'blanked' : `STILL "${String(row.text).slice(0, 50)}…"`}`);
}
console.log(`surviving episode text:\n  ${left.map((text) => text.slice(0, 40)).join('\n  ')}`);
for (const row of left) {
  if (row.includes('被裁')) console.log('  <-- the forgotten sentence is still in an episode');
}

const leaked = liveSummaries.filter((row) => String(row.text).includes('被裁'));
const dangling = db.prepare(`
  SELECT COUNT(*) AS n FROM reflection_evidence re
  JOIN episodes e ON e.id = re.episode_id
  WHERE e.redacted_at IS NOT NULL
`).get();

console.log(`\nlive summaries quoting the forgotten words: ${leaked.length}`);
console.log(`evidence rows pointing at a redacted episode: ${Number(dangling.n)}`);

db.close();

const ok = leaked.length === 0
  && Number(dangling.n) === 0
  && redacted.length > 0
  && deadSummaries.length > 0
  && deadSummaries.every((row) => String(row.text) === '')
  && left.every((text) => !text.includes('被裁'));

console.log(ok ? '\nFORGET IS COMPLETE' : '\nFORGET LEAKED');
if (!ok) process.exitCode = 1;