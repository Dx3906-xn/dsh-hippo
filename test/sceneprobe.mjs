// Observation: what the resident section says in each of the three scenes.
//
// Prints the owner's block, a stranger's block and a room's block from the same
// real store, so the difference is visible side by side. Run against a live
// database:
//
//   node test/sceneprobe.mjs D:/A/DSH-L/agent/home/hippo/memory.db
//
// The first argument is the store; the owner's *facts* are filed under the meta
// user id (`user` by default), while the owner's *accounts* are the ids the
// deployment declared. Those are two different things and mixing them up makes
// this print an empty block and look like a bug in the renderer.

import { openDatabase } from '../lib/db.js';
import { renderResident } from '../lib/prompt.js';
import { sceneOf, channelOf, audienceOf } from '../lib/channel.js';
import { userId as readUserId } from '../lib/store.js';

const path = process.argv[2] ?? 'D:/A/DSH-L/agent/home/hippo/memory.db';
const db = await openDatabase(path);
const owner = readUserId(db);
const ownerIds = process.argv.slice(3);
if (ownerIds.length === 0) ownerIds.push('1405337008', '3184763831');

const first = ownerIds[0];
const scenes = [
  ['owner (private, declared id)', `qq:onebot:private:${first}`],
  ['stranger (private, unknown id)', 'qq:onebot:private:999999999'],
  ['room (group)', 'qq:onebot:group:1070071261'],
  ['terminal (uuid)', 'session-00000000-0000-0000-0000-000000000000'],
];

const OWNER_WORDS = ['林晚', '晚晚', '合肥', '糖尿病', '插画师', '海獭', '年糕', '豆沙'];

for (const [label, sessionId] of scenes) {
  const scene = sceneOf(db, sessionId, ownerIds);
  const channel = channelOf(db, sessionId);
  const audience = audienceOf(sessionId, ownerIds);
  const text = renderResident(db, { userId: owner, sessionId, channel, audience, language: 'zh' });
  const leaked = OWNER_WORDS.filter((word) => text.includes(word));
  console.log(`\n===== ${label} =====`);
  console.log(`scene=${scene} channel=${channel} audience=${audience} chars=${text.length}`);
  console.log(`owner words present: ${leaked.length === 0 ? '(none)' : leaked.join(', ')}`);
  console.log('---');
  console.log(text);
}

console.log('\n===== facts by subject =====');
for (const row of db.prepare('SELECT subject, COUNT(*) AS n FROM facts WHERE invalid_at IS NULL GROUP BY subject ORDER BY n DESC').all()) {
  console.log(`  ${row.subject}: ${row.n}`);
}
