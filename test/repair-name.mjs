/**
 * Undo one wrong belief: the owner's name was overwritten by a stranger's.
 *
 * A stranger opened a private chat with the bot before `ownerIds` existed, said
 * "I'm so-and-so from that group", and the extractor stored that nickname as
 * `subject = user, predicate = name`. That retired "林晚" and made the owner's
 * profile open with somebody else's name.
 *
 * This is not a special case with special SQL. It is exactly what
 * `resolveClarification(..., 'keep_old')` already means: the newer value was
 * wrong, the older value was right, put the older one back. Using that path
 * rather than a hand-written UPDATE keeps the history readable — both rows stay
 * on disk, and the one that was never true is the one that ends up retired.
 *
 *   node test/repair-name.mjs [db]           # dry run, prints what it would do
 *   node test/repair-name.mjs [db] --apply   # do it
 */
import { openDatabase } from '../lib/db.js';
import { resolveClarification } from '../lib/store.js';

const dbPath = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
const path = dbPath ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const apply = process.argv.includes('--apply');
const db = await openDatabase(path);

const history = db.prepare(`
  SELECT id, object, confidence, source, invalid_at, superseded_by, created_at
  FROM facts WHERE subject = 'user' AND predicate = 'name'
  ORDER BY created_at
`).all();

console.log(`db: ${path}`);
console.log(`mode: ${apply ? 'APPLY' : 'dry run (pass --apply to write)'}`);
console.log('history of user/name:');
for (const row of history) {
  console.log(`  [${row.invalid_at === null ? 'LIVE' : 'dead'}] ${JSON.stringify(row.object)}` +
    ` c=${row.confidence} src=${row.source} at=${new Date(Number(row.created_at)).toISOString().slice(0, 19)}`);
}

const live = history.filter((row) => row.invalid_at === null);
if (live.length === 0) {
  console.log('\nthere is no live name fact. nothing to undo.');
  db.close();
  process.exit(0);
}

// The row that displaced its predecessor. Not "the newest row" — a name written
// twice on purpose has no predecessor and must not be second-guessed.
const wrong = live.find((row) => {
  const peer = db.prepare('SELECT id FROM facts WHERE superseded_by = ? AND invalid_at IS NOT NULL LIMIT 1')
    .get(String(row.id));
  return peer !== undefined;
});

if (wrong === undefined) {
  console.log('\nthe live name did not displace anything. it is not this bug. stopping.');
  db.close();
  process.exit(0);
}

const restored = db.prepare('SELECT id, object FROM facts WHERE superseded_by = ? AND invalid_at IS NOT NULL LIMIT 1')
  .get(String(wrong.id));
console.log(`\nretire : ${JSON.stringify(wrong.object)} (${String(wrong.id).slice(0, 8)})`);
console.log(`restore: ${JSON.stringify(restored.object)} (${String(restored.id).slice(0, 8)})`);

if (!apply) {
  console.log('\nnothing written.');
} else {
  const result = resolveClarification(db, String(wrong.id), 'keep_old');
  console.log(`resolved=${result.resolved} revivedId=${String(result.revivedId).slice(0, 8)}`);
  const after = db.prepare(`
    SELECT object FROM facts WHERE subject = 'user' AND predicate = 'name' AND invalid_at IS NULL
  `).all().map((row) => String(row.object));
  console.log(`live name now: ${JSON.stringify(after)}`);
}
db.close();
