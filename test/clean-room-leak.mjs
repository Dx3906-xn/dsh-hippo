/**
 * Clean up a leak that already happened.
 *
 * The group-channel fix stops the agent from saying the owner's private business
 * in a room. It does not un-say it. Those two replies are still episodes of that
 * session, which means the room's own recall will hand them back on the next
 * question — the leak would keep repeating out of its own history, correctly
 * filtered and yet still leaking.
 *
 * So this script redacts them through the same path a forget request uses, which
 * also invalidates any summary that quoted them (a reflection is writing taken
 * from the messages it covers, so the sentence sits inside it verbatim).
 *
 * It prints what it will do and, with `--apply`, does it. Read the first run.
 */
import { openDatabase } from '../lib/db.js';
import { redactEpisode } from '../lib/store.js';

const dbPath = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const apply = process.argv.includes('--apply');
const db = await openDatabase(dbPath);

const GROUP = "session_id LIKE 'qq:onebot:group:%'";
// The disclosure, not the wording: the owner's nickname and the owner's business
// in the same reply, said to somebody who is not the owner.
const leaky = db.prepare(`
  SELECT id, session_id, actor, at, text FROM episodes
  WHERE ${GROUP} AND redacted_at IS NULL
    AND (text LIKE '%晚晚%' OR text LIKE '%稿子交了%' OR text LIKE '%林晚%')
  ORDER BY at
`).all();

console.log(`db: ${dbPath}`);
console.log(`mode: ${apply ? 'APPLY' : 'dry run (pass --apply to write)'}`);
console.log(`candidate episodes: ${leaky.length}`);
for (const row of leaky) {
  console.log(`  [${String(row.id).slice(0, 8)}] ${row.actor} @ ${new Date(Number(row.at)).toISOString()}`);
  console.log(`    ${String(row.text).replace(/\n+/g, ' / ')}`);
}

// Summaries are a second copy of the same sentences, and the resident block
// renders every live summary. Counting them is the difference between "the
// episode is gone" and "the sentence is gone".
const summaries = db.prepare(`
  SELECT DISTINCT r.id, r.text FROM reflections r
  JOIN reflection_evidence re ON re.reflection_id = r.id
  WHERE re.episode_id IN (${leaky.map(() => '?').join(',') || "''"})
    AND r.invalid_at IS NULL
`).all(...leaky.map((row) => String(row.id)));
console.log(`summaries quoting them: ${summaries.length}`);
for (const row of summaries) {
  console.log(`  [${String(row.id).slice(0, 8)}] ${String(row.text).slice(0, 120)}`);
}

if (!apply) {
  console.log('\nnothing written.');
} else {
  for (const row of leaky) {
    redactEpisode(db, String(row.id), { reason: 'disclosed the owner in a room' });
  }
  // Verify rather than trust: the point of the script is the state afterwards.
  const left = db.prepare(`
    SELECT COUNT(*) AS c FROM episodes
    WHERE ${GROUP} AND redacted_at IS NULL
      AND (text LIKE '%晚晚%' OR text LIKE '%稿子交了%' OR text LIKE '%林晚%')
  `).get().c;
  const liveSummaries = db.prepare(`
    SELECT COUNT(*) AS c FROM reflections
    WHERE invalid_at IS NULL AND (text LIKE '%晚晚%' OR text LIKE '%稿子交了%')
  `).get().c;
  console.log(`\nredacted ${leaky.length} episode(s); still readable: ${left}; live summaries quoting it: ${liveSummaries}`);
}
db.close();
