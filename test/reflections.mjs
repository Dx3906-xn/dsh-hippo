/**
 * Print the consolidation trail: reflections and what they cite. Read-only.
 *
 * Run with: node test/reflections.mjs [path-to-db]
 */

import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);

const rows = db.prepare('SELECT * FROM reflections ORDER BY created_at').all();
console.log(`== ${rows.length} reflection(s) ==`);
for (const row of rows) {
  const when = new Date(Number(row.created_at)).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`\n${when}  [${row.kind}]  ${String(row.text)}`);
  const cited = db.prepare(`
    SELECT
      sum(CASE WHEN episode_id <> '' THEN 1 ELSE 0 END) episodes,
      sum(CASE WHEN fact_id <> '' THEN 1 ELSE 0 END) facts
    FROM reflection_evidence WHERE reflection_id = ?
  `).get(String(row.id));
  console.log(`  cites ${cited.episodes ?? 0} episode(s), ${cited.facts ?? 0} fact(s)`);
}

const concepts = db.prepare('SELECT kind, count(*) n FROM reflections GROUP BY kind').all();
console.log('\n== by kind ==');
for (const row of concepts) console.log(`  ${row.kind}  ${row.n}`);
