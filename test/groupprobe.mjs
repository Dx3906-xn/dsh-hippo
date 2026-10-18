// What did the agent actually say in the group, and what did it file about whom?
import { openDatabase } from '../lib/db.js';

const db = await openDatabase(process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db');

console.log('=== group episodes ===');
for (const row of db.prepare("SELECT at, actor, text FROM episodes WHERE session_id LIKE '%group%' ORDER BY at").all()) {
  const when = new Date(Number(row.at)).toISOString().slice(11, 19);
  console.log(`[${when}] ${row.actor}: ${row.text.replace(/\n/g, ' / ').slice(0, 300)}`);
}

console.log('\n=== private episodes (last 6) ===');
for (const row of db.prepare("SELECT at, actor, text FROM episodes WHERE session_id LIKE '%private%' ORDER BY at DESC LIMIT 6").all().reverse()) {
  const when = new Date(Number(row.at)).toISOString().slice(11, 19);
  console.log(`[${when}] ${row.actor}: ${row.text.replace(/\n/g, ' / ').slice(0, 300)}`);
}

console.log('\n=== reflections mentioning group ===');
for (const row of db.prepare("SELECT id, kind, text FROM reflections").all()) {
  console.log(`  ${row.kind}: ${String(row.text).replace(/\n/g, ' / ').slice(0, 200)}`);
}
