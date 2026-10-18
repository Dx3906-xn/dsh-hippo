// Observation: the identity facts in a real store, with enough detail to tell a
// poisoned row from an empty one.
//
//   node test/nameprobe.mjs D:/A/DSH-L/agent/home/hippo/memory.db

import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);

console.log('=== name / nickname facts, every version ===');
const rows = db.prepare(`
  SELECT id, subject, predicate, object, confidence, invalid_at, superseded_by, source, created_at, updated_at
  FROM facts WHERE predicate IN ('name', 'nickname')
  ORDER BY created_at
`).all();
for (const row of rows) {
  const state = row.invalid_at === null ? 'LIVE' : 'dead';
  console.log(`  [${state}] ${row.subject}/${row.predicate} = ${JSON.stringify(row.object)} c=${row.confidence} src=${row.source}`);
  console.log(`      id=${row.id} created=${new Date(Number(row.created_at)).toISOString().slice(0, 19)} superseded_by=${row.superseded_by ?? '-'}`);
}

console.log('\n=== every version of user/name, in order ===');
for (const row of db.prepare(`
  SELECT object, confidence, invalid_at, created_at FROM facts
  WHERE subject = 'user' AND predicate = 'name' ORDER BY created_at
`).all()) {
  console.log(`  ${row.invalid_at === null ? 'LIVE' : 'dead'} ${JSON.stringify(row.object)} c=${row.confidence} at=${new Date(Number(row.created_at)).toISOString().slice(0, 19)}`);
}
