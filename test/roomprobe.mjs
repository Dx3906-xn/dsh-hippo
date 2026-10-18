/**
 * What the real store says to a room, next to what it says in private.
 *
 * Run against the live database, because the question is not whether the code
 * branches — the suite covers that — but whether this particular store, with its
 * thirty facts about one person, still has anything to hand a group of three.
 *
 *   node test\roomprobe.mjs [path-to-memory.db]
 */

import { openDatabase } from '../lib/db.js';
import { renderResident } from '../lib/prompt.js';
import { recall } from '../lib/store.js';
import { channelOf } from '../lib/channel.js';

const path = process.argv[2] ?? 'D:\\A\\DSH-L\\agent\\home\\hippo\\memory.db';
const db = await openDatabase(path);
const owner = String(db.prepare("SELECT value FROM meta WHERE key = 'user_id'").get()?.value ?? 'user');

const rows = db.prepare(`
  SELECT session_id, count(*) AS n FROM episodes
  WHERE channel = 'group' OR session_id LIKE '%group%'
  GROUP BY session_id ORDER BY n DESC
`).all();

console.log(`db: ${path}`);
console.log(`owner: ${owner}`);
console.log('\nsessions that look like rooms:');
for (const row of rows) {
  console.log(`  ${row.n}  ${row.session_id}  -> ${channelOf(db, row.session_id)}`);
}
const room = rows[0]?.session_id ?? 'qq:onebot:group:0';

console.log(`\n=== what a room is told (${room}) ===`);
console.log(renderResident(db, { userId: owner, sessionId: room, channel: 'group', now: Date.now() }));

console.log('\n=== what a private chat is told ===');
const direct = renderResident(db, { userId: owner, channel: 'direct', now: Date.now() });
console.log(`${direct.slice(0, 600)}${direct.length > 600 ? '\n…' : ''}`);

console.log('\n=== a vague cue in a room returns ===');
const vague = recall(db, {
  cue: '你还记得我什么样吗',
  userId: owner,
  limit: 10,
  includeEpisodes: true,
  includeFacts: false,
  fallback: true,
  sessionId: room,
});
console.log(`episodes=${vague.episodes.length} facts=${vague.facts.length}`);
for (const episode of vague.episodes.slice(0, 5)) {
  console.log(`  [${episode.session_id}] ${String(episode.text).slice(0, 60)}`);
}
const leaked = vague.episodes.filter((episode) => String(episode.session_id) !== room);
console.log(leaked.length === 0 ? '  (nothing from outside the room)' : `  LEAK: ${leaked.length} rows`);

console.log('\n=== a named cue about the owner, asked in a room ===');
const named = recall(db, {
  cue: '糖尿病',
  userId: owner,
  limit: 10,
  includeEpisodes: true,
  includeFacts: false,
  fallback: true,
  sessionId: room,
});
console.log(`episodes=${named.episodes.length} facts=${named.facts.length}`);
for (const episode of named.episodes.slice(0, 5)) {
  console.log(`  [${episode.session_id}] ${String(episode.text).slice(0, 60)}`);
}
db.close();
