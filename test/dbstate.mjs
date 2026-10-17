import { openDatabase } from '../lib/db.js';

const db = await openDatabase(process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db');
const all = (sql) => db.prepare(sql).all();
const one = (sql) => db.prepare(sql).get();

console.log('episodes   ', one('SELECT COUNT(*) AS n FROM episodes').n, 'redacted', one('SELECT COUNT(*) AS n FROM episodes WHERE redacted_at IS NOT NULL').n);
console.log('facts      ', 'live', one('SELECT COUNT(*) AS n FROM facts WHERE invalid_at IS NULL').n, 'all', one('SELECT COUNT(*) AS n FROM facts').n);
console.log('reflections', one('SELECT COUNT(*) AS n FROM reflections').n);
console.log('loops      ', 'open', one('SELECT COUNT(*) AS n FROM open_loops WHERE closed_at IS NULL').n);
console.log('clarify    ', one('SELECT COUNT(*) AS n FROM facts WHERE needs_clarification = 1 AND invalid_at IS NULL').n);
console.log('affect     ', one('SELECT COUNT(*) AS n FROM affect').n);
console.log('reviews    ', one('SELECT COUNT(*) AS n FROM reviews').n);
console.log('relationship', one('SELECT familiarity, trust, mood_baseline, revision FROM relationship'));
console.log('\nlinks by kind:');
console.log(all('SELECT kind, COUNT(*) AS n FROM links GROUP BY kind ORDER BY n DESC'));
console.log('\nopen loops:');
console.log(all('SELECT substr(text,1,50) AS text, closed_at, follow_after FROM open_loops ORDER BY created_at DESC LIMIT 10'));
console.log('\nlive facts:');
console.log(all('SELECT predicate, substr(object,1,40) AS object, confidence, pinned, stability FROM facts WHERE invalid_at IS NULL ORDER BY created_at DESC LIMIT 20'));
console.log('\nreflections:');
console.log(all('SELECT kind, level, substr(text,1,70) AS text FROM reflections ORDER BY created_at DESC LIMIT 6'));
db.close();
