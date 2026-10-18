// Does hippo currently tell two people in one group apart?
//
// Builds an in-memory store, records two different speakers from the same group
// session, and looks at what the facts and episodes actually carry. The point is
// to find out what is MISSING before deciding what to add.
import { openDatabase } from '../lib/db.js';
import { recordEpisode, addFact, liveFacts, userId as readUserId } from '../lib/store.js';

const db = await openDatabase(':memory:');
const owner = readUserId(db);
console.log(`owner (meta.user_id): ${owner}`);

const session = 'qq:onebot:group:1070071261';

// Two people, same group session.
recordEpisode(db, { sessionId: session, actor: 'user', text: '我是小周，今天加班', source: 'turn' });
recordEpisode(db, { sessionId: session, actor: 'user', text: '我是老李，今天钓鱼', source: 'turn' });

const episodes = db.prepare('SELECT actor, text, session_id FROM episodes').all();
console.log('\nepisodes:');
for (const row of episodes) console.log(`  actor=${row.actor}  session=${row.session_id}  text=${row.text}`);

// What the extractor would produce for two speakers: it writes subject "user"
// for "the person", which is the owner.
addFact(db, { subject: 'user', predicate: 'works_as', object: '程序员', confidence: 0.9 });
addFact(db, { subject: 'user', predicate: 'likes', object: '钓鱼', confidence: 0.9 });

const facts = liveFacts(db, { limit: 50 });
console.log('\nfacts about "user" (the owner):');
for (const row of facts) console.log(`  ${row.subject} ${row.predicate} = ${row.object}`);

console.log('\n--- the problem ---');
console.log('Both speakers share actor="user" and subject="user".');
console.log('The owner is "' + owner + '", and 老李\'s liking for fishing is now a fact about them.');
console.log(`facts stored under the owner: ${liveFacts(db, { subject: owner === 'user' ? 'user' : owner, limit: 100 }).length}`);
