/**
 * Print the open-loop table: what the agent is holding on the person's behalf.
 * Read-only.
 *
 * `follow_after` is when it is fair to ask, `due_at` is when the thing itself
 * happens. They are two different instants on purpose — the whole reason the
 * follow-up on an appointment does not land the same evening — so both are
 * printed, together with the phrase the date was read out of.
 *
 * Run with: node test/loops.mjs [path-to-db]
 */

import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);
const now = Date.now();

const rows = db.prepare(`
  SELECT id, text, created_at, follow_after, due_at, due_phrase, closed_at, closed_by
  FROM open_loops ORDER BY created_at
`).all();

console.log(`== ${rows.length} loop(s), now=${new Date(now).toISOString().slice(0, 16)} ==`);
for (const row of rows) {
  const age = Math.round((now - Number(row.created_at)) / 3600000);
  const follow = row.follow_after === null || row.follow_after === undefined
    ? 'null'
    : `${Math.round((Number(row.follow_after) - now) / 3600000)}h`;
  const due = row.due_at === null || row.due_at === undefined
    ? 'no date'
    : `${new Date(Number(row.due_at)).toISOString().slice(0, 16)} (${String(row.due_phrase ?? '?')})`;
  const closed = row.closed_at === null ? 'OPEN  ' : `closed/${String(row.closed_by ?? '?')}`;
  console.log(`${closed}  ask-in=${follow}  due=${due}  age=${age}h  ${String(row.text)}`);
}