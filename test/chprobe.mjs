// Which sessions are rooms, and which rows know it. Usage: node test\chprobe.mjs [path]
import { openDatabase } from '../lib/db.js';
const db = await openDatabase(process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db');
console.log('--- group sessions ---');
for (const r of db.prepare("SELECT session_id, channel, COUNT(*) AS n FROM episodes WHERE session_id LIKE '%group%' GROUP BY session_id, channel").all()) {
  console.log(r.n, JSON.stringify(r.session_id), r.channel);
}
console.log('--- channel totals ---');
for (const r of db.prepare('SELECT channel, COUNT(*) AS n FROM episodes GROUP BY channel').all()) console.log(r.channel, r.n);
console.log('--- total ---', db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c);
db.close();
