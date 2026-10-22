/**
 * The agent's own half of memory: her facts, her loops, her own acts.
 *
 * Everything else in this suite set is about the person — what they said, who
 * they know, what they promised. This file covers the parts that are about the
 * agent herself, because for a long time none of it existed:
 *
 *  - `episodes.actor` had no value for "something I did on my own time", so
 *    nothing she did while alone could be recalled as her own experience.
 *  - Her facts were stored under `subject: 'agent'` and then rendered under
 *    `对方身边的人`, in the paragraph reserved for bystanders, in third person.
 *  - Her loops had somewhere to live (`open_loops.user_id`) but no read path.
 *
 * These assertions are the contract that keeps those read paths honest.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSchema, SCHEMA_VERSION } from '../lib/db.js';
import { addFact, addOpenLoop, liveFacts, openLoops, recordEpisode } from '../lib/store.js';
import { renderResident, describeSelf, SELF_SUBJECT } from '../lib/prompt.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hippo-self-'));
const OWNER = 'user';

// ---- actor: a third voice ---------------------------------------------------
{
  console.log('a third voice exists');
  const db = new DatabaseSync(join(dir, 'actor.db'));
  ensureSchema(db);

  const selfId = recordEpisode(db, { sessionId: 'hb:1', actor: 'self', text: '翻了一下午搁浅的鲸鱼' });
  check(selfId !== '', 'an act of her own can be recorded');

  const agentId = recordEpisode(db, { sessionId: 'qq:1', actor: 'agent', text: '在' });
  check(agentId !== '', 'a reply inside a conversation is still recordable');

  const rows = db.prepare('SELECT actor FROM episodes ORDER BY at').all().map((row) => String(row.actor));
  check(rows.includes('self') && rows.includes('agent'), `the two voices stay distinct (${rows.join(',')})`);

  // The constraint is the point: without it a typo would silently make a new
  // voice, and every read that enumerates actors would miss it.
  let rejected = false;
  try {
    db.prepare("INSERT INTO episodes (id, session_id, at, actor, text) VALUES ('bad','s',1,'robot','x')").run();
  } catch {
    rejected = true;
  }
  check(rejected === true, 'an unknown actor is refused rather than stored');
  db.close();
}

// ---- migration: an older database keeps its rows ----------------------------
{
  console.log('a database from before the third voice upgrades');
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('schema_version','16'), ('user_id','user');
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT,
      at INTEGER NOT NULL, actor TEXT NOT NULL CHECK (actor IN ('user','agent')),
      text TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
      stability REAL NOT NULL DEFAULT 1.0, difficulty REAL NOT NULL DEFAULT 5.0,
      last_review_at INTEGER, review_count INTEGER NOT NULL DEFAULT 0,
      consolidated INTEGER NOT NULL DEFAULT 0, superseded_by TEXT, redacted_at INTEGER,
      redacted_reason TEXT NOT NULL DEFAULT '', sensitivity TEXT NOT NULL DEFAULT 'personal',
      source TEXT NOT NULL DEFAULT 'observed', arousal REAL NOT NULL DEFAULT 0,
      speaker_id TEXT NOT NULL DEFAULT '', speaker_name TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'direct'
    ) STRICT;
    INSERT INTO episodes (id, session_id, at, actor, text, consolidated)
      VALUES ('a','s1',1,'user','旧的一句话',1);
    INSERT INTO episodes (id, session_id, at, actor, text)
      VALUES ('b','s1',2,'agent','旧的回话');
  `);
  old.close();

  const db = new DatabaseSync(path);
  ensureSchema(db);
  const kept = db.prepare('SELECT id, actor, text, consolidated FROM episodes ORDER BY at').all();
  check(kept.length === 2, `both old rows survived the rebuild (${kept.length})`);
  check(String(kept[0].text) === '旧的一句话', 'and kept their text');
  check(Number(kept[0].consolidated) === 1, 'and their consolidation state');
  check(recordEpisode(db, { sessionId: 's1', actor: 'self', text: '新的' }) !== '', 'and the new voice works after upgrading');
  check(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value) === SCHEMA_VERSION, 'the version was stamped');
  db.close();
}

// ---- rendering: her own section, in first person ----------------------------
{
  console.log('her own section renders as herself');
  const db = new DatabaseSync(join(dir, 'render.db'));
  ensureSchema(db);

  addFact(db, { subject: OWNER, predicate: 'likes', object: '猫' });
  addFact(db, { subject: SELF_SUBJECT, predicate: 'self_image', object: '觉得自己有点懒，但不想改' });
  addFact(db, { subject: SELF_SUBJECT, predicate: 'interest', object: '鲸鱼为什么搁浅' });
  addFact(db, { subject: SELF_SUBJECT, predicate: 'commitment', object: '明天给他看那个视频' });
  addFact(db, { subject: 'visitor:晚晚', predicate: 'works_as', object: '写稿' });
  addOpenLoop(db, { userId: SELF_SUBJECT, text: '把搁浅的鲸鱼那个资料看完' });

  const block = renderResident(db, { userId: OWNER, language: 'zh' });
  check(block.includes('## 你自己'), 'there is a section about her');
  check(block.includes('鲸鱼为什么搁浅'), 'her curiosity is in it');
  check(block.includes('答应了'), 'and a promise she made');
  check(block.includes('还没做'), 'and something she has not finished');

  // The section comes before the person's, because order is the message: a self
  // block below somebody else's file reads as an appendix about a third party.
  const selfAt = block.indexOf('## 你自己');
  const personAt = block.indexOf('## 你记得的事');
  check(selfAt >= 0 && personAt > selfAt, `her section comes first (${selfAt} < ${personAt})`);

  // The regression this file exists for: her facts used to be swept into the
  // bystander paragraph by `exceptSubject: userId`, so they appeared twice and
  // the second time as somebody else.
  const othersAt = block.indexOf('对方身边的人');
  check(othersAt === -1 || !block.slice(othersAt).includes('鲸鱼为什么搁浅'), 'her facts do not also appear as somebody else');
  check(block.includes('visitor:晚晚'), 'while real bystanders still do');
  db.close();
}

// ---- an agent with nothing to say says nothing ------------------------------
{
  console.log('an empty self section is omitted, not empty-headed');
  const db = new DatabaseSync(join(dir, 'empty.db'));
  ensureSchema(db);
  check(renderResident(db, { userId: OWNER, language: 'zh' }) === '', 'a store with no memories renders no section at all');

  addFact(db, { subject: OWNER, predicate: 'likes', object: '猫' });
  const personOnly = renderResident(db, { userId: OWNER, language: 'zh' });
  check(personOnly.includes('喜欢猫'), 'and a person-only store still renders the person');
  check(!personOnly.includes('## 你自己'), 'without inventing an empty self section');
  db.close();
}

// ---- first person -----------------------------------------------------------
{
  console.log('a self description is written as herself');
  check(describeSelf({ predicate: 'interest', object: '搁浅' }, 'zh').startsWith('最近在琢磨'), 'interest reads in first person');
  check(!describeSelf({ predicate: 'interest', object: '搁浅' }, 'zh').includes('：'), 'and not as a labelled field');
  check(describeSelf({ predicate: 'something_new', object: 'x' }, 'zh').includes('something new'), 'an unknown predicate degrades to words, not snake_case');
  check(describeSelf({ predicate: 'commitment', object: '明天' }, 'zh').includes('答应'), 'a promise is phrased as a promise');
}

// ---- ordering and budget ----------------------------------------------------
{
  console.log('her section stays inside its budget');
  const db = new DatabaseSync(join(dir, 'budget.db'));
  ensureSchema(db);
  addFact(db, { subject: OWNER, predicate: 'likes', object: '猫' });
  for (let i = 0; i < 60; i++) {
    addFact(db, { subject: SELF_SUBJECT, predicate: 'interest', object: `第 ${i} 个念头` });
  }
  const block = renderResident(db, { userId: OWNER, language: 'zh', maxTokens: 300 });
  check(block.length < 2000, `sixty interests do not become sixty lines (${block.length} chars)`);
  check(block.includes('## 你记得的事'), 'and the person is not crowded out by her');
  db.close();
}

// ---- loops under her own subject --------------------------------------------
{
  console.log('her own open loops are readable');
  const db = new DatabaseSync(join(dir, 'loops.db'));
  ensureSchema(db);
  addOpenLoop(db, { userId: SELF_SUBJECT, text: '想搞清楚鲸鱼为什么搁浅' });
  addOpenLoop(db, { userId: OWNER, text: '他说要交稿' });
  const mine = openLoops(db, SELF_SUBJECT);
  check(mine.length === 1, `she has her own list (${mine.length})`);
  check(String(mine[0].text).includes('搁浅'), 'with her own item in it');
  const theirs = openLoops(db, OWNER);
  check(theirs.length === 1 && String(theirs[0].text).includes('交稿'), 'and the person\'s list is separate');
  db.close();
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nself: all checks passed');
