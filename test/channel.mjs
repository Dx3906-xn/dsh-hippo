/**
 * What a room is allowed to know.
 *
 * This file exists because of something that actually happened: in a group of
 * three, the agent answered a stranger with "晚晚，你今天忙不少吧？稿子交了" —
 * the owner's nickname and the owner's private business, offered to somebody who
 * had only asked whether the bot was awake. Nothing malfunctioned. The resident
 * profile was written for the owner and pasted into every conversation the agent
 * had with anyone, and in a room that sentence is a disclosure.
 *
 * So the tests below are not about formatting. Each one asks the same question in
 * a different place: can the owner's private life reach a room?
 */

import assert from 'node:assert/strict';
import { openDatabase } from '../lib/db.js';
import { recordEpisode, addFact, liveFacts } from '../lib/store.js';
import { renderResident } from '../lib/prompt.js';
import { recall } from '../lib/store.js';
import { channelOf, sessionIdOf } from '../lib/channel.js';

const db = await openDatabase(':memory:');
const now = Date.now();

const DIRECT = 'qq:onebot:private:3184763831';
const GROUP = 'qq:onebot:group:1070071261';

// The owner's private life, stated in a direct conversation.
addFact(db, {
  subject: 'user', predicate: 'name', object: '林晚', confidence: 0.95, validAt: now,
});
addFact(db, {
  subject: 'user', predicate: 'nickname', object: '晚晚', confidence: 0.95, validAt: now,
});
addFact(db, {
  subject: 'user', predicate: 'lives_in', object: '合肥', confidence: 0.9, validAt: now,
});
addFact(db, {
  subject: 'user', predicate: 'health', object: '妈妈糖尿病，在控糖', confidence: 0.9,
  sensitivity: 'sensitive', validAt: now,
});

recordEpisode(db, {
  sessionId: DIRECT, at: now - 1000, actor: 'user',
  text: '我叫林晚，在合肥做插画师，我妈上个月查出糖尿病',
  speakerId: '3184763831', speakerName: '66', channel: 'direct',
});

// ---- the channel is decided before any evidence exists ------------------
//
// This is the case that made the leak possible on the first turn: the always-
// present profile is assembled before `agent/pre-step` runs, so on the first
// message in a room the store has nothing to say about that session. If the
// decision waited for evidence, the very first thing the agent says in a group
// would be the one thing it says while still holding a full profile.

assert.equal(channelOf(db, GROUP), 'group', 'a group session id was not recognised as a room');
assert.equal(channelOf(db, DIRECT), 'direct', 'a private session id was read as a room');
assert.equal(channelOf(db, 'session-019701f8-a5dc'), 'direct', 'a plain session id was read as a room');

// The id rule must be narrow. A channel that puts the word "group" inside
// another word is not a room, and being wrong in that direction would silently
// strip the profile from every private conversation that happened to match.
assert.equal(channelOf(db, 'qq:onebot:private:grouper'), 'direct', 'the id rule matched inside a word');
assert.equal(channelOf(db, 'session-groupish-1'), 'direct', 'the id rule matched a prefix');

// ---- the store outranks the naming rule --------------------------------

recordEpisode(db, {
  sessionId: GROUP, at: now - 500, actor: 'user',
  text: '我是老李，今天去钓鱼',
  speakerId: '1405337008', speakerName: '不想', channel: 'group',
});
assert.equal(channelOf(db, GROUP), 'group', 'the store disagreed with the id rule');

// A session that announces itself as a room in the id but has only ever held
// direct talk still reads as a room. The rule is about the deployment's naming,
// and a name is not worth overriding on the strength of one message: the cost of
// being wrong is asymmetric.
recordEpisode(db, {
  sessionId: 'session-mixed-1', at: now - 400, actor: 'user',
  text: '随便聊聊', channel: 'direct',
});
assert.equal(channelOf(db, 'session-mixed-1'), 'direct', 'a direct session became a room');

// ---- a room never gets the owner's profile ------------------------------

const groupBlock = renderResident(db, { userId: 'user', sessionId: GROUP, channel: 'group', now });
assert.ok(groupBlock.length > 0, 'the room block rendered as empty');
for (const secret of ['林晚', '晚晚', '合肥', '糖尿病', '插画师']) {
  assert.ok(
    !groupBlock.includes(secret),
    `the owner's private detail "${secret}" reached the group block`,
  );
}
assert.ok(groupBlock.includes('群聊'), 'the group block does not say what kind of room this is');
assert.ok(
  /所有人都听得到|everyone hears/.test(groupBlock),
  'the group block does not say that other people can hear',
);

// Who has spoken is fair game: their words were already said out loud to
// everyone present, and the agent needs it to address people by name.
assert.ok(groupBlock.includes('不想'), 'the room block does not list who has spoken there');

// ---- the owner still gets their profile in private ----------------------

const directBlock = renderResident(db, { userId: 'user', sessionId: DIRECT, channel: 'direct', now });
assert.ok(directBlock.includes('林晚'), 'the private profile lost the owner\'s name');
assert.ok(directBlock.includes('合肥'), 'the private profile lost the owner\'s city');

// The same store, the same call, two answers. That is the whole point: the
// difference is the room, not the memory.
assert.notEqual(groupBlock, directBlock, 'the group and private blocks are identical');

// ---- recall is scoped the same way -------------------------------------

// A direct-conversation episode that the group's cue would otherwise reach.
recordEpisode(db, {
  sessionId: DIRECT, at: now - 200, actor: 'user',
  text: '今天又在说糖尿病的事，心里有点乱',
  speakerId: '3184763831', speakerName: '66', channel: 'direct',
});

const unscoped = recall(db, { cue: '糖尿病', userId: 'user', limit: 10, includeEpisodes: true });
assert.ok(
  unscoped.episodes.some((episode) => String(episode.text).includes('心里有点乱')),
  'the unscoped recall does not reach the private episode, so the contrast is not real',
);

// A group episode that matches the same cue, so the scoped recall has something
// it is allowed to return. Without it the loop below would pass on an empty list
// and prove nothing about the filter.
recordEpisode(db, {
  sessionId: GROUP, at: now - 150, actor: 'user',
  text: '群里问了一句糖尿病能不能吃甜的',
  speakerId: '1405337008', speakerName: '不想', channel: 'group',
});

const scoped = recall(db, {
  cue: '糖尿病',
  userId: 'user',
  limit: 10,
  includeEpisodes: true,
  includeFacts: false,
  sessionId: GROUP,
});
assert.ok(scoped.episodes.length >= 1, 'the scoped recall returned nothing, so the filter is untested');
for (const episode of scoped.episodes) {
  assert.equal(String(episode.session_id), GROUP, 'a private episode reached the group recall');
}
assert.ok(
  !scoped.episodes.some((episode) => String(episode.text).includes('心里有点乱')),
  'the private conversation about the same subject came through with it',
);
assert.equal(scoped.facts.length, 0, 'facts were returned to a group recall');

// ---- the salience fallback is scoped too -------------------------------
//
// The fallback is reached exactly when the cue was too vague to match anything,
// which is the moment "the most memorable rows in the store" would hand a room
// the owner's worst week. A vague cue in a group must still stay in the group.
recordEpisode(db, {
  sessionId: GROUP, at: now - 100, actor: 'user',
  text: '群里随便聊了两句',
  speakerId: '1405337008', speakerName: '不想', channel: 'group',
});

const vague = recall(db, {
  cue: '你还记得吗',
  userId: 'user',
  limit: 10,
  includeEpisodes: true,
  includeFacts: false,
  fallback: true,
  sessionId: GROUP,
});
for (const episode of vague.episodes) {
  assert.equal(String(episode.session_id), GROUP, 'the salience fallback handed a room a private episode');
}

// ---- sessionIdOf reads what the DSH agent actually carries --------------

const fakeAgent = { session: { header: { id: GROUP } } };
assert.equal(sessionIdOf(fakeAgent), GROUP, 'sessionIdOf did not read the header');
assert.equal(sessionIdOf(undefined), 'unknown', 'a missing agent did not degrade to unknown');
assert.equal(channelOf(db, 'unknown'), 'direct', 'an unknown session was treated as a room');

// ---- other people's facts are confined to the room they were said in ----

addFact(db, {
  subject: '不想', predicate: 'likes', object: '钓鱼', confidence: 0.9, validAt: now,
});
const roomWithFact = renderResident(db, {
  userId: 'user', sessionId: GROUP, channel: 'group', now,
});
assert.ok(roomWithFact.includes('钓鱼'), 'a fact the visitor said in this room is missing from it');
assert.ok(!roomWithFact.includes('林晚'), 'adding a room fact brought the owner back in');

// The owner filter is applied per row rather than assumed from the query, so a
// fact keyed to the owner whose subject happens to equal a speaker's name still
// cannot come through. This pins the mechanism: delete the `subject === userId`
// check and this assertion fails.
addFact(db, {
  subject: 'user', predicate: 'likes', object: '海獭', confidence: 0.9, validAt: now,
});
const stillClean = renderResident(db, {
  userId: 'user', sessionId: GROUP, channel: 'group', now,
});
assert.ok(!stillClean.includes('海獭'), 'an owner fact leaked into the room block');

console.log('channel: all checks passed');
