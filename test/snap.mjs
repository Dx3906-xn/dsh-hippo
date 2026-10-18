import { openDatabase } from '../lib/db.js';
const db = await openDatabase(process.env.HIPPO_DB);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const out = process.env.HIPPO_SNAP;
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
console.log('snapshot written:', out);
console.log('episodes:', db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n);
console.log('facts:', db.prepare('SELECT COUNT(*) AS n FROM facts').get().n);
