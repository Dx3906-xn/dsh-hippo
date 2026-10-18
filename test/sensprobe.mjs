// How much of the store is private business, by subject. Usage: node test\sensprobe.mjs [path]
import { openDatabase } from '../lib/db.js';
const db = await openDatabase(process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db');
const rows = db.prepare("SELECT subject, predicate, sensitivity, COUNT(*) n FROM facts WHERE invalid_at IS NULL GROUP BY subject, sensitivity, predicate ORDER BY subject, sensitivity").all();
for (const r of rows) console.log(`${r.subject}\t${r.sensitivity}\t${r.predicate}\t${r.n}`);
console.log('--- sensitivity totals ---');
for (const r of db.prepare("SELECT sensitivity, COUNT(*) n FROM facts WHERE invalid_at IS NULL GROUP BY sensitivity").all()) console.log(r.sensitivity, r.n);
db.close();
