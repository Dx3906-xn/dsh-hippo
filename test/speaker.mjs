/**
 * Who said it, and does the memory believe them.
 *
 * A group chat is the first place where "the person talking" and "the person
 * this memory belongs to" are different people. Every failure in this file has
 * the same shape: a stranger's sentence becomes a fact about the owner, stated
 * back to the owner in the second person, forever.
 */

import assert from 'node:assert/strict';
import { openDatabase } from '../lib/db.js';
import { recordEpisode } from '../lib/store.js';
import { applyFacts } from '../lib/consolidate.js';

const db = await openDatabase(':memory:');

// Who the deployment says the owner is. This is configuration, not something the
// transport can prove: a private chat only proves two parties are alone. The test
// names it for the same reason the config does.
const OWNERS = ['3184763831'];

/** A batch of episodes as `recordEpisode` would return them. */
function episode(overrides) {
  return {
    id: recordEpisode(db, {
      sessionId: 'qq:onebot:group:1',
      actor: 'user',
      text: '正文',
      speakerId: '1405337008',
      speakerName: '不想',
      channel: 'group',
      ...overrides,
    }),
  };
}

/** Find a live fact by subject and predicate. */
function fact(subject, predicate) {
  return db.prepare(
    'SELECT * FROM facts WHERE subject = ? AND predicate = ? AND invalid_at IS NULL',
  ).all(subject, predicate);
}

// ---- a visitor's words are not the owner's facts -------------------------

const visitor = episode({});
applyFacts(db, [{
  subject: 'user',
  predicate: 'likes',
  object: '玩原神',
  confidence: 0.9,
  evidence: [visitor.id],
}], 'user', OWNERS);

assert.equal(fact('user', 'likes').length, 0, 'a stranger\'s preference was filed as the owner\'s');
assert.equal(fact('不想', 'likes').length, 1, 'the visitor\'s preference was not filed under their name');
assert.equal(fact('不想', 'likes')[0].object, '玩原神');

// ---- the owner speaking in a group is still the owner --------------------

// The transport marks a group message from the owner the same way it marks any
// other speaker: by id. What makes it the owner is that the id is one seen on a
// private channel, where the other party is the owner by construction — never the
// display name, because a group card is whatever that person typed into it.
recordEpisode(db, {
  sessionId: 'qq:onebot:private:3184763831',
  actor: 'user',
  text: '私聊里我是主人',
  speakerId: '3184763831',
  speakerName: '66',
  channel: 'direct',
});
const ownerSong = episode({ speakerId: '3184763831', speakerName: '晚晚' });
applyFacts(db, [{
  subject: 'user',
  predicate: 'likes',
  object: '海獭',
  confidence: 0.9,
  evidence: [ownerSong.id],
}], 'user', OWNERS);

assert.equal(fact('user', 'likes').length, 1, 'the owner\'s own group message was attributed to the group');
assert.equal(fact('user', 'likes')[0].object, '海獭');

// ---- a mixed batch does not guess ---------------------------------------

// Two speakers in one batch means there is no single answer to "who is this
// about". Falling back to the old behaviour is the honest move: the model's
// subject stands, and a wrong one is visible rather than silently reassigned.
const mixedA = episode({ speakerId: '111', speakerName: '甲' });
const mixedB = episode({ speakerId: '222', speakerName: '乙' });
applyFacts(db, [{
  subject: 'user',
  predicate: 'plan',
  object: '周末去爬山',
  confidence: 0.8,
  evidence: [mixedA.id, mixedB.id],
}], 'user', OWNERS);

assert.equal(fact('甲', 'plan').length + fact('乙', 'plan').length, 0, 'a mixed batch was attributed to one speaker');
assert.equal(fact('user', 'plan').length, 1, 'a mixed batch should keep the model\'s subject');

// ---- a private message is unaffected ------------------------------------

const priv = recordEpisode(db, {
  sessionId: 'qq:onebot:private:3184763831',
  actor: 'user',
  text: '我最近在戒烟',
  speakerId: '3184763831',
  speakerName: '66',
  channel: 'direct',
});
applyFacts(db, [{
  subject: 'user',
  predicate: 'habit',
  object: '戒烟',
  confidence: 0.9,
  evidence: [priv],
}], 'user', OWNERS);

assert.equal(fact('user', 'habit').length, 1, 'a private message stopped being the owner\'s');

// ---- no evidence at all keeps the model's choice -------------------------

// `memory_remember` calls `applyFacts` with no batch: the model was asked to
// store something and chose the subject itself. There is nothing to second-guess.
applyFacts(db, [{
  subject: 'user',
  predicate: 'goal',
  object: '学会游泳',
  confidence: 0.9,
}], 'user', OWNERS);

assert.equal(fact('user', 'goal').length, 1, 'an explicit remember lost its subject');

// ---- the columns are actually stored -----------------------------------

const stored = db.prepare('SELECT * FROM episodes WHERE id = ?').get(visitor.id);
assert.equal(stored.speaker_name, '不想');
assert.equal(stored.speaker_id, '1405337008');
assert.equal(stored.channel, 'group');
assert.equal(String(db.prepare('SELECT * FROM episodes WHERE id = ?').get(priv).channel), 'direct');

console.log('speaker: all checks passed');
db.close();
