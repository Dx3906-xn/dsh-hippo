/**
 * One-off probe: did the "forget" path ever leave a summary quoting the message?
 *
 * Before redaction invalidated summaries, a reflection built out of a message
 * that was later forgotten kept that message's words and was rendered into the
 * resident prompt on every turn. This prints anything the real database still
 * carries in that shape, so the hole can be measured rather than assumed.
 *
 * Usage: node test/leakprobe.mjs <db-path>
 */

import { openDatabase, ensureSchema } from '../lib/db.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node test/leakprobe.mjs <db-path>');
  process.exit(2);
}

const db = await openDatabase(path);
ensureSchema(db);

const liveQuotingRedacted = db.prepare(`
  SELECT r.id, r.text, e.id AS episode_id, e.text AS episode_text, e.redacted_reason
  FROM reflections r
  JOIN reflection_evidence re ON re.reflection_id = r.id
  JOIN episodes e ON e.id = re.episode_id
  WHERE r.invalid_at IS NULL AND e.redacted_at IS NOT NULL
`).all();

const blankLive = db.prepare(`SELECT COUNT(*) AS n FROM reflections WHERE invalid_at IS NULL AND text = ''`).get();
const evidenceOrphans = db.prepare(`
  SELECT COUNT(*) AS n FROM reflection_evidence re
  JOIN episodes e ON e.id = re.episode_id
  WHERE e.redacted_at IS NOT NULL
`).get();

console.log('live reflections quoting a redacted episode:', liveQuotingRedacted.length);
for (const row of liveQuotingRedacted) {
  console.log(`  reflection ${row.id} (${String(row.text).slice(0, 60)}…)`);
  console.log(`    cites redacted episode ${row.episode_id} (reason=${row.redacted_reason})`);
}
console.log('live reflections with blanked text:', Number(blankLive.n));
console.log('evidence rows pointing at a redacted episode:', Number(evidenceOrphans.n));

db.close();