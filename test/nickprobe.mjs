// Observation: why did the agent's own nickname displace the owner's?
//
// `test/nameprobe.mjs` shows the shape (`user/nickname` is dead, its
// superseded_by points at `agent/nickname`), but not the mechanism. The
// mechanism matters because the three plausible ones have different fixes:
//
//   1. the extractor wrote subject "user" for "you are DaFeiYu", so
//      similarFacts() matched the owner's nickname and `decide()` retired it
//      as a same-predicate contradiction;
//   2. resolveSubject() folded "agent" into the owner;
//   3. something else wrote the same row twice.
//
// This prints the raw columns so the answer is read off the data instead of
// guessed from the code.
//
// Usage: node test/nickprobe.mjs [db]

import { openDatabase } from '../lib/db.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);

const rows = db.prepare(`
  SELECT id, subject, predicate, object, confidence, source,
         created_at, updated_at, invalid_at, superseded_by, pinned
  FROM facts
  WHERE predicate IN ('nickname', 'name')
  ORDER BY created_at ASC
`).all();

console.log(`=== ${rows.length} name/nickname rows, oldest first ===`);
for (const row of rows) {
  const state = row.invalid_at === null ? 'LIVE' : 'dead';
  console.log(`\n[${state}] ${row.subject} / ${row.predicate} = ${JSON.stringify(row.object)}`);
  console.log(`   id           ${row.id}`);
  console.log(`   confidence   ${row.confidence}   source ${row.source}   pinned ${row.pinned}`);
  console.log(`   created      ${new Date(Number(row.created_at)).toISOString()}`);
  console.log(`   updated      ${new Date(Number(row.updated_at)).toISOString()}`);
  if (row.invalid_at !== null) {
    console.log(`   invalidated  ${new Date(Number(row.invalid_at)).toISOString()}`);
  }
  console.log(`   superseded   ${row.superseded_by ?? '-'}`);
}

// Which episodes back each row? A row with no evidence was guessed from
// something; a row with evidence can be read back against the transcript.
console.log('\n=== evidence ===');
for (const row of rows) {
  const links = db.prepare(`
    SELECT e.id, e.at, e.actor, e.channel, e.speaker_name, e.session_id,
           substr(e.text, 1, 90) AS text
    FROM evidence v JOIN episodes e ON e.id = v.episode_id
    WHERE v.fact_id = ? ORDER BY e.at ASC
  `).all(String(row.id));
  console.log(`\n${row.subject}/${row.predicate} = ${JSON.stringify(row.object)}`);
  if (links.length === 0) {
    console.log('   (no evidence)');
    continue;
  }
  for (const link of links) {
    console.log(`   [${link.actor}/${link.channel}] ${link.speaker_name || '-'} :: ${link.text}`);
  }
}
