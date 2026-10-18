/**
 * Open a database (a copy, usually) through the real migration path and print
 * the live plans, so a migration can be checked against real data before it is
 * allowed near the original file.
 */
import { openDatabase, ensureSchema } from '../lib/db.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node test/migrate.mjs <db-path>');
  process.exit(2);
}
const db = await openDatabase(path);
ensureSchema(db);
const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
console.log('schema', version === undefined ? '?' : String(version.value));
for (const row of db.prepare("SELECT subject, predicate, object FROM facts WHERE invalid_at IS NULL ORDER BY predicate, created_at").all()) {
  console.log(`LIVE [${row.subject}] ${row.predicate} = ${row.object}`);
}
console.log('retired', db.prepare('SELECT count(*) AS n FROM facts WHERE invalid_at IS NOT NULL').get().n);
db.close();
