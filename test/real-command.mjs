/**
 * Run `/memory` against the real store, the way the Web UI would.
 *
 * An assertion suite builds its own store from nothing, so it cannot tell you
 * whether the command survives a database that has been through sixteen
 * migrations and a month of real conversations. This is the same code path,
 * pointed at the only store that matters.
 *
 * Usage: node test/real-command.mjs [db]
 */

import { openDatabase } from '../lib/db.js';
import { runMemoryCommand } from '../lib/commands.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);
const file = `${path}.dump.json`;

for (const input of ['', 'status', `dump ${file}`, `inspect ${file}`, `import ${file}`, 'nonsense']) {
  const result = runMemoryCommand(db, { rawInput: input }, { language: 'zh', isOutsider: () => false });
  console.log(`--- /memory ${input}`);
  console.log(`${result.kind}: ${result.text}`);
  console.log('');
}
