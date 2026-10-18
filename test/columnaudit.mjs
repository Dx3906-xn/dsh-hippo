/**
 * One-off probe: which columns does the plugin write and never read?
 *
 * The table-level version of this (`tableaudit.mjs`) found `reflection_evidence`.
 * The same question one level down: a column that is assigned on every write and
 * never appears in a SELECT is state that looks maintained and informs nothing.
 * Generic names (id, at, text) show up everywhere, so only the ones whose read
 * count is literally zero are reported.
 *
 * Usage: node test/columnaudit.mjs
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, ensureSchema } from '../lib/db.js';

const dir = mkdtempSync(join(tmpdir(), 'hippo-cols-'));
const db = await openDatabase(join(dir, 'memory.db'));
ensureSchema(db);

const tables = db.prepare(`
  SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
`).all().map((row) => String(row.name));

const files = readdirSync('lib')
  .filter((name) => name.endsWith('.js') && name !== 'db.js')
  .map((name) => ({ name, statements: readFileSync(join('lib', name), 'utf8').split(';') }));

console.log(`columns written and never read (across ${files.length} lib files, db.js excluded)\n`);

let suspects = 0;
for (const table of tables) {
  const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((row) => String(row.name));
  for (const column of columns) {
    const pattern = new RegExp(`\\b${column}\\b`, 'i');
    // A column is "read" if a SELECT names it *or* if any row's property is
    // touched — `SELECT *` plus `row.sensitivity` is the common shape here, and
    // counting only the first would report half the schema as dead.
    const property = new RegExp(`\\.${column}\\b|\\[['"]${column}['"]\\]`);
    let reads = 0;
    let writes = 0;
    for (const file of files) {
      for (const statement of file.statements) {
        if (property.test(statement)) reads += 1;
        if (!pattern.test(statement)) continue;
        if (/SELECT/i.test(statement)) reads += 1;
        if (/INSERT|UPDATE|DELETE/i.test(statement)) writes += 1;
      }
    }
    if (writes > 0 && reads === 0) {
      suspects += 1;
      console.log(`  ${table}.${column}  writes=${writes} reads=0`);
    }
  }
}

console.log(`\n${suspects} column(s) written and never read`);

db.close();
rmSync(dir, { recursive: true, force: true });