// What does the real store know about who is who?
import { openDatabase } from '../lib/db.js';
import { userId as readUserId } from '../lib/store.js';

const db = await openDatabase('D:\\A\\DSH-L\\agent\\home\\hippo\\memory.db');
console.log(`meta.user_id = ${JSON.stringify(readUserId(db))}`);

const meta = db.prepare('SELECT key, value FROM meta').all();
console.log('\nmeta:');
for (const row of meta) console.log(`  ${row.key} = ${row.value}`);

console.log('\nsessions in episodes:');
for (const row of db.prepare('SELECT session_id, COUNT(*) AS n FROM episodes GROUP BY session_id ORDER BY n DESC').all()) {
  console.log(`  ${row.n}  ${row.session_id}`);
}

console.log('\ndistinct subjects in facts:');
for (const row of db.prepare('SELECT subject, COUNT(*) AS n FROM facts GROUP BY subject ORDER BY n DESC').all()) {
  console.log(`  ${row.n}  ${JSON.stringify(row.subject)}`);
}

console.log('\nname/nickname facts:');
for (const row of db.prepare("SELECT subject, predicate, object FROM facts WHERE predicate IN ('name','nickname')").all()) {
  console.log(`  ${row.subject} ${row.predicate} = ${row.object}`);
}
