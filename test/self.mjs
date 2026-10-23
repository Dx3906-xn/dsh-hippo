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
import { addFact, addOpenLoop, liveFacts, openLoops, recordEpisode, addDirective, liveDirectives, retireDirective, addPersonaEdit, livePersonaEdits, retirePersonaEdit } from '../lib/store.js';
import { renderResident, describeSelf, SELF_SUBJECT } from '../lib/prompt.js';
import { parseFacts } from '../lib/extract.js';

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

// ---- her own vocabulary -----------------------------------------------------
{
  console.log('her attributes use her words, not his');
  const db = new DatabaseSync(join(dir, 'vocab.db'));
  ensureSchema(db);
  addFact(db, { subject: SELF_SUBJECT, predicate: 'self_habit', object: '刷B站' });
  addFact(db, { subject: SELF_SUBJECT, predicate: 'self_plan', object: '没打算去那边上班' });
  addFact(db, { subject: SELF_SUBJECT, predicate: 'self_habit', object: '趴着' });
  const block = renderResident(db, { userId: OWNER, language: 'zh' });
  check(block.includes('我习惯刷B站'), 'a habit reads as hers, in first person');
  check(!block.includes('习惯：'), 'and not as a labelled field');
  check(block.includes('没打算去那边上班'), 'a plan is stated as she stated it');

  // Two habits are two habits. The one-per-predicate rule kept whichever sorted
  // first, which lost half of what she does with her time.
  check(block.includes('我习惯趴着') && block.includes('我习惯刷B站'), 'several habits all appear');

  // Rows written before her vocabulary existed carry the person's key. They are
  // hers and must read the same as new ones — otherwise the section looks like
  // two different people.
  addFact(db, { subject: SELF_SUBJECT, predicate: 'habit', object: '发呆' });
  const legacy = renderResident(db, { userId: OWNER, language: 'zh' });
  check(legacy.includes('我习惯发呆'), 'a row under the old key renders in her voice too');
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

// ---- evidence: a belief has to point at something ---------------------------
//
// The failure this covers is not hypothetical: "反正我也没打算去那边上班" was said in
// reply to a question, filed as her standing plan, and then rendered back to her as
// "this is who you are". Two defects made that possible.
//
// The first was an off-by-one-level read — `batch[index].id` where the batch holds
// `{episode, text}` pairs — so every fact ever extracted got `evidence: []`. The
// table that exists to answer "why do you believe this" was written by nobody.
//
// The second was that nothing required a claim about *her* to come from *her* line.
{
  console.log('a belief has to point at something');
  const batch = [
    { episode: { id: 'e-user', actor: 'user' }, text: '你以后还去那边上班吗' },
    { episode: { id: 'e-agent', actor: 'agent' }, text: '反正我也没打算去那边上班 我就在这待着' },
  ];
  const extract = (fact) => parseFacts(JSON.stringify({ facts: [fact] }), batch);

  const hers = extract({ subject: 'agent', predicate: 'self_plan', object: '在这待着', confidence: 0.8, episode: 1 });
  check(hers.length === 1, 'a self-claim citing her own line is accepted');
  check(hers[0]?.evidence?.[0] === 'e-agent', `and carries that line as evidence (${JSON.stringify(hers[0]?.evidence)})`);

  // The exact shape of the original bug: the model attributes a self-plan but
  // points at the person's question.
  const borrowed = extract({ subject: 'agent', predicate: 'self_plan', object: '去上班', confidence: 0.9, episode: 0 });
  check(borrowed.length === 0, "a self-claim citing the person's line is refused");

  // No citation at all falls back to the first episode, which is the person's, so
  // the same check refuses it. A self-claim that points at nothing is a belief
  // with no evidence.
  const unfounded = extract({ subject: 'agent', predicate: 'self_image', object: '懒', confidence: 0.9 });
  check(unfounded.length === 0, 'a self-claim with no citation is refused');

  // Everything about the person still works, and now records evidence.
  const aboutThem = extract({ subject: 'user', predicate: 'likes', object: '猫', confidence: 0.9, episode: 0 });
  check(aboutThem.length === 1, 'a fact about the person is unaffected');
  check(aboutThem[0]?.evidence?.[0] === 'e-user', `and records where it came from (${JSON.stringify(aboutThem[0]?.evidence)})`);
}

// ---- the block reports what it could not fit ---------------------------------
//
// Every resident block hits this and every one of them gets it wrong the same way:
// the budget cuts the list, and a fact simply stops appearing — indistinguishable,
// from inside the prompt, from something she never knew. A footer makes it visible.
//
// The count has to mean "the block is full". Counting every fact that was folded
// into a duplicate or dropped past a multi-value cap would make it permanent noise,
// and a footer that is always there is one nobody reads.
{
  console.log('the block reports what it could not fit');
  const db = new DatabaseSync(join(dir, 'budget.db'));
  ensureSchema(db);
  const predicates = ['likes', 'dislikes', 'goal', 'plan', 'habit', 'health', 'dietary', 'personality', 'language', 'contact', 'lives_in', 'works_as'];
  for (let i = 0; i < 40; i += 1) {
    addFact(db, { subject: OWNER, predicate: predicates[i % predicates.length], object: `值${i}号${'很长的描述内容'.repeat(4)}` });
  }

  const tight = renderResident(db, { userId: OWNER, language: 'zh', maxTokens: 120 });
  check(/还有 \d+ 条没放进这里/.test(tight), 'a full block says how many facts it left out');

  const roomy = renderResident(db, { userId: OWNER, language: 'zh', maxTokens: 20000 });
  check(!roomy.includes('没放进这里'), 'a block with room says nothing about omissions');

  // A smaller budget must leave more out, so the number is a real count rather than
  // a flag that happens to be set.
  const looser = renderResident(db, { userId: OWNER, language: 'zh', maxTokens: 400 });
  const countIn = (block) => Number(/还有 (\d+) 条/.exec(block)?.[1] ?? 0);
  check(countIn(tight) >= countIn(looser), `a tighter budget omits at least as many (${countIn(tight)} vs ${countIn(looser)})`);
  db.close();
}

// ---- directives: one topic, one live line -----------------------------------
//
// Reported from the outside as "她一会儿说叫老大，一会儿又说不叫" — the block was
// rendering the same instruction twice, so she read one rule as two rules fighting.
// The cause was in the write path: a repeated instruction `continue`d instead of
// retiring, so the old row stayed live *and* a second row was inserted. Two live rows
// on one topic is the one state the topic key exists to prevent.
{
  console.log('directives: one topic, one live line');
  const db = new DatabaseSync(join(dir, 'directives.db'));
  ensureSchema(db);

  addDirective(db, { topic: 'address', text: '叫我老大' });
  const again = addDirective(db, { topic: 'address', text: '叫我老大' });
  check(liveDirectives(db).length === 1, `saying it twice leaves one live row (${liveDirectives(db).length})`);
  check(again.superseded.length === 0, 'and reports nothing as replaced');

  addDirective(db, { topic: 'address', text: '叫我工兵' });
  const live = liveDirectives(db);
  check(live.length === 1, `a correction replaces rather than adds (${live.length})`);
  check(String(live[0].text) === '叫我工兵', 'and the newest wording is the one in force');
  check(db.prepare('SELECT COUNT(*) n FROM directives').get().n === 2, 'while the old wording is kept, not deleted');

  // Withdrawal is the missing verb. Without it the agent could record an instruction
  // and never take one back -- and the complaint it actually made was "I can't even
  // delete cleanly", about a memory system it is meant to be running.
  const withdrawn = retireDirective(db, 'address');
  check(withdrawn.retired === 1, `retiring a topic withdraws its live row (${withdrawn.retired})`);
  check(liveDirectives(db).length === 0, 'and nothing is left in force');
  check(db.prepare('SELECT COUNT(*) n FROM directives').get().n === 2, 'but the record of it survives');

  const nothing = retireDirective(db, 'address');
  check(nothing.retired === 0, 'retiring it again reports nothing to do');

  // The rendered block follows the same rule: one line per topic.
  addDirective(db, { topic: 'length', text: '每次只回一行' });
  addDirective(db, { topic: 'length', text: '每次只回一行' });
  const block = renderResident(db, { userId: OWNER, language: 'zh' });
  const occurrences = block.split('\n').filter((line) => line.includes('每次只回一行')).length;
  check(occurrences === 1, `the block shows it once (${occurrences})`);
  db.close();
}

// ---- she can change who she is ----------------------------------------------
//
// The persona is a config string with no write path, so "you are read-only" was a
// property of the deployment rather than a decision — and it was being defended as
// one. A layer of her own amendments is the version that lets her grow without
// erasing where she started.
{
  console.log('she can change who she is');
  const db = new DatabaseSync(join(dir, 'persona.db'));
  ensureSchema(db);

  const id = addPersonaEdit(db, { section: '语气', text: '我可以有不想说话的时候，不解释' });
  check(id !== '', 'an amendment is stored');
  addPersonaEdit(db, { text: '我不是非得可爱' });
  check(livePersonaEdits(db).length === 2, 'and they accumulate');

  const block = renderResident(db, { userId: OWNER, language: 'zh' });
  check(block.includes('你自己改过的'), 'the block shows them under their own heading');
  check(block.includes('我可以有不想说话的时候'), 'with her words, not a paraphrase');
  check(block.indexOf('你自己改过的') < block.indexOf('你记得的事'), 'above the person\'s profile, since it is about her');

  // A change she cannot take back is not hers. Retiring keeps the record.
  check(retirePersonaEdit(db, String(id)) === true, 'an amendment can be withdrawn');
  check(livePersonaEdits(db).length === 1, 'and stops being in force');
  check(db.prepare('SELECT COUNT(*) n FROM persona_edits').get().n === 2, 'while the record of it survives');
  check(retirePersonaEdit(db, String(id)) === false, 'retiring it twice is a no-op, not an error');

  // Order is oldest first: these accumulate into an account of who she is now, and
  // newest-first would put the latest thought before the ones it was written on.
  const ordered = livePersonaEdits(db).map((row) => String(row.text));
  check(ordered[0] === '我不是非得可爱', 'what is left is the one not retired');
  db.close();
}

{
  // An agent with nothing but an amendment of her own still renders. Otherwise the
  // permission would exist in the database and never reach the prompt, which is the
  // exact failure this layer is for.
  console.log('an amendment alone is enough to render');
  const db = new DatabaseSync(join(dir, 'persona2.db'));
  ensureSchema(db);
  addPersonaEdit(db, { text: '我在学着不那么怕' });
  const block = renderResident(db, { userId: OWNER, language: 'zh' });
  check(block.includes('我在学着不那么怕'), 'her own words reach the prompt with no other memory');
  db.close();
}

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nself: all checks passed');
