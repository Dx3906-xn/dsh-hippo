/**
 * One-off probe: which tables does the plugin write and never read?
 *
 * A table that is written but never read is a mechanism that appears to exist
 * and changes nothing — the same shape as `reflection_evidence` was. This counts
 * SELECT vs INSERT/UPDATE/DELETE references per table across lib/*.js, ignoring
 * migration code in db.js (which reads everything by construction).
 *
 * Usage: node test/tableaudit.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const tables = [
  'meta', 'episodes', 'episodes_fts', 'facts', 'facts_fts', 'evidence',
  'reflections', 'reflection_evidence', 'relationship', 'open_loops',
  'affect', 'reviews', 'budget', 'links', 'pending_recall',
];

const files = readdirSync('lib')
  .filter((name) => name.endsWith('.js') && name !== 'db.js')
  .map((name) => ({ name, text: readFileSync(join('lib', name), 'utf8') }));

for (const table of tables) {
  const pattern = new RegExp(`\\b${table}\\b`, 'g');
  let reads = 0;
  let writes = 0;
  for (const file of files) {
    for (const statement of file.text.split(';')) {
      const hits = statement.match(pattern);
      if (hits === null) continue;
      if (/INSERT|UPDATE|DELETE|CREATE/i.test(statement)) writes += hits.length;
      if (/SELECT/i.test(statement)) reads += hits.length;
    }
  }
  const verdict = writes > 0 && reads === 0 ? '  <-- write-only' : '';
  console.log(`${table.padEnd(22)} reads=${String(reads).padStart(3)} writes=${String(writes).padStart(3)}${verdict}`);
}