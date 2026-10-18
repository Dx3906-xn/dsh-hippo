/**
 * Every row for the predicates a clarification is about, with the flags that
 * decide whether a read path shows it.
 *
 * Observation script, not a suite. Pass a DB path; defaults to the throwaway home
 * the e2e scripts use, so the state left behind by a run can be read back.
 */
import { join } from 'node:path';
import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home-mini-t/hippo/memory.db';
const db = await openDatabase(path);

const predicates = process.argv[3] ? [process.argv[3]] : ['works_at', 'lives_in'];
const marks = predicates.map(() => '?').join(', ');
const rows = db.prepare(`
  SELECT id, subject, predicate, object, confidence, invalid_at, superseded_by,
         needs_clarification, created_at
  FROM facts WHERE predicate IN (${marks}) ORDER BY created_at, id
`).all(...predicates);

console.log(`${path}\n`);
for (const row of rows) {
  console.log([
    String(row.id).slice(0, 8),
    `${row.subject}/${row.predicate}`,
    row.object,
    `conf=${row.confidence}`,
    `live=${row.invalid_at === null ? 'Y' : 'n'}`,
    `superseded_by=${row.superseded_by === null ? '-' : String(row.superseded_by).slice(0, 8)}`,
    `needs_clarification=${row.needs_clarification}`,
  ].join('  '));
}
db.close();