import { openDatabase } from '../lib/db.js';

const db = await openDatabase('D:/A/DSH-L/agent/home/hippo/memory.db');
const now = Date.now();
const rows = db.prepare('SELECT id, text, created_at, follow_after, closed_at, closed_by FROM open_loops ORDER BY created_at').all();
console.log(`== ${rows.length} loop(s), now=${new Date(now).toISOString().slice(0, 16)} ==`);
for (const row of rows) {
  const age = Math.round((now - Number(row.created_at)) / 3600000);
  const due = row.follow_after === null ? 'null' : `${Math.round((Number(row.follow_after) - now) / 3600000)}h`;
  console.log(`${row.closed_at === null ? 'OPEN' : 'closed'}  age=${age}h  due=${due}  ${String(row.text)}`);
}
