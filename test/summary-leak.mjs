/**
 * Every live summary that still carries a sentence from a room it should not be
 * quoted outside of.
 *
 * `redactEpisode` is supposed to invalidate summaries that cite the episode it
 * killed, and it did invalidate one. Five more still contain the words, which
 * means either they cite a different episode of the same conversation, or the
 * invalidation found them by the wrong key.
 *
 * This prints what is there, with the citation, so the answer comes from the
 * store rather than from a guess about the code.
 */
import { openDatabase } from '../lib/db.js';

const dbPath = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(dbPath);

const rows = db.prepare(`
  SELECT id, invalid_at, valid_at, text FROM reflections
  WHERE text LIKE '%晚晚%' OR text LIKE '%稿子交了%' OR text LIKE '%林晚%'
  ORDER BY valid_at
`).all();

console.log(`db: ${dbPath}`);
console.log(`summaries mentioning the owner: ${rows.length}`);
for (const row of rows) {
  const cites = db.prepare(`
    SELECT re.episode_id, re.fact_id, e.session_id, e.redacted_at, substr(e.text, 1, 40) AS t
    FROM reflection_evidence re
    LEFT JOIN episodes e ON e.id = re.episode_id
    WHERE re.reflection_id = ?
  `).all(String(row.id));
  const live = row.invalid_at === null;
  console.log(`\n[${String(row.id).slice(0, 8)}] ${live ? 'LIVE' : 'dead'} valid=${new Date(Number(row.valid_at)).toISOString()}`);
  console.log(`  ${String(row.text).replace(/\n+/g, ' / ').slice(0, 200)}`);
  for (const cite of cites) {
    console.log(`  <- ep ${String(cite.episode_id ?? '').slice(0, 8)} [${cite.session_id ?? 'gone'}] ${cite.redacted_at === null ? 'live' : 'redacted'} ${JSON.stringify(String(cite.t ?? ''))}`);
  }
}
db.close();
