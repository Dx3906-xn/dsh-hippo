/**
 * One look at the owner's facts, grouped by predicate, to see what the store
 * actually believes right now. Read-only.
 *
 * Run with: node test/live.mjs [path-to-db]
 */

import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);

const rows = db.prepare(`
  SELECT id, subject, predicate, object, confidence, pinned, invalid_at, updated_at
  FROM facts ORDER BY subject, predicate, confidence DESC
`).all();

const groups = new Map();
for (const row of rows) {
  const key = `${row.invalid_at === null ? 'LIVE' : 'dead'}|${row.subject}|${row.predicate}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

for (const [key, items] of groups) {
  const [state, subject, predicate] = key.split('|');
  console.log(`\n[${state}] ${subject} / ${predicate}`);
  for (const row of items) {
    const pin = Number(row.pinned) === 1 ? ' *' : '';
    console.log(`  c=${Number(row.confidence).toFixed(2)}${pin} ${String(row.object)}`);
  }
}

const counts = db.prepare(`
  SELECT subject, count(*) n FROM facts WHERE invalid_at IS NULL GROUP BY subject
`).all();
console.log('\n== live by subject ==');
for (const row of counts) console.log(`  ${row.subject}  ${row.n}`);
