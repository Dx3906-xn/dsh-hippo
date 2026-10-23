/**
 * The resident memory section: what the agent always knows, without searching.
 *
 * Two things go here and nothing else:
 *   1. a compact profile of the person, rebuilt from live facts;
 *   2. the state of the relationship itself — how long we have been talking,
 *      what is unresolved, what they are currently going through.
 *
 * The section is materialized on write, not computed per request, because
 * building it per turn would add latency to the first token for no benefit.
 *
 * @module dsh-hippo/prompt
 */

import { estimateTokens } from './tokenize.js';
import { objectSimilarity } from './extract.js';
import { describeDate, namesItsOwnDay } from './when.js';
import {
  liveFacts,
  liveReflections,
  liveDirectives,
  livePersonaEdits,
  ensureRelationship,
  openLoops,
  dueLoops,
  localDay,
} from './store.js';

/** Hard budget for the resident section, in estimated tokens. */
export const RESIDENT_BUDGET = 1200;

/** Budget for one recalled block inside the prompt. */
export const RECALL_BUDGET = 1200;

/**
 * The subject name that means "the agent herself".
 *
 * This string already exists inside the system and means exactly this: the
 * extraction contract tells the model `subject is "user" for the person, "agent"
 * for yourself`, and `resolveSubject` passes it through unchanged so it is stored
 * as its own subject. What was missing is any read path — every render queried
 * `subject = userId` for the person, or `subject <> userId` for "everyone else",
 * and the second query swept her own facts into the paragraph reserved for
 * bystanders. A fact about herself appeared under "对方身边的人", next to a
 * visitor's job.
 *
 * So this constant is not a new concept, it is the name the existing concept
 * already had, finally given somewhere to be read.
 */
export const SELF_SUBJECT = 'agent';

/**
 * Attributes the agent can hold about herself.
 *
 * The person's vocabulary (name, birthday, health, works_as) describes a person
 * somebody else is trying to remember. The agent's vocabulary describes a point of
 * view: what she thinks of herself, what she is curious about, what she is worried
 * about, what she said she would do, how she spends her time, what she intends.
 *
 * `self_habit` and `self_plan` are here rather than reusing `habit` and `plan`
 * because the two vocabularies render differently — third person for the person
 * ("习惯：刷B站"), first person for her ("我习惯刷B站") — and because a shared key
 * means one predicate holds two people's values. The first live run proved it: her
 * "刷B站" and her "没打算去那边上班" were extracted under the person's keys and
 * rendered with the person's template, so the section about her read like a
 * dossier on somebody else.
 */
export const SELF_PREDICATES = [
  'self_image',
  'preference',
  'interest',
  'worry',
  'commitment',
  'self_habit',
  'self_plan',
];

/**
 * Predicates of hers that come from the person vocabulary but describe her.
 *
 * The extractor works from a closed list per subject, and this one is the bridge
 * for rows written before that list existed: `habit` and `plan` under subject
 * `agent` were hers, not his. Mapped rather than deleted, because the value is
 * still true — only the label was wrong.
 */
const SELF_ALIASES = new Map(Object.entries({
  habit: 'self_habit',
  plan: 'self_plan',
}));

/** Predicates promoted to the top of the profile regardless of confidence. */
const CORE_PREDICATES = [
  'name', 'nickname', 'birthday', 'age', 'lives_in', 'hometown',
  'works_as', 'studies', 'relationship_status', 'has_pet',
  'likes', 'dislikes', 'goal',
];

/**
 * Predicates that hold more than one value at a time.
 *
 * Everything else is treated as single-valued in the profile: only its
 * best-ranked line is rendered, so the snapshot never states two conflicting
 * versions of the same attribute side by side.
 *
 * `goal` is deliberately absent. A person can hold several goals, but they say
 * them one at a time and the extraction re-states the current one every time it
 * comes up, so what ends up stored is usually three phrasings of one wish rather
 * than three wishes. Showing the best-ranked one is closer to the truth than
 * showing all of them; the others stay one `memory_recall` away.
 *
 * `plan` and `habit` are present for the opposite reason. Plans are dated
 * commitments — a follow-up appointment, a wedding, a client meeting, a job
 * search — and there is no sense in which they are versions of each other. With
 * them treated as single-valued the profile showed one plan out of six and the
 * model walked into conversations with no idea the person had a hospital
 * appointment on Wednesday. Habits are the same shape: quitting smoking and
 * drawing cats are both ongoing, and neither replaces the other.
 */
const MULTI_VALUED = new Set([
  'likes', 'dislikes', 'has_pet', 'not_has_pet', 'personality', 'language',
  'plan', 'habit',
]);

/**
 * Materialize the resident section text.
 *
 * Returns an empty string when there is nothing worth saying — an agent with no
 * memories should not open with a paragraph explaining that it has none.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{
 *   userId?: string,
 *   now?: number,
 *   language?: 'zh'|'en',
 *   maxTokens?: number,
 *   channel?: 'direct'|'group',
 *   audience?: 'owner'|'stranger',
 *   sessionId?: string,
 * }} [options] - rendering options.
 * @returns {string} the section text, possibly empty.
 */
export function renderResident(db, options = {}) {
  const userId = options.userId ?? 'user';
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? RESIDENT_BUDGET;
  const language = options.language ?? 'zh';
  const channel = options.channel === 'group' ? 'group' : 'direct';
  const audience = options.audience === 'stranger' ? 'stranger' : 'owner';

  // A group room gets a different block, and the difference is not cosmetic.
  //
  // The profile below is written for one person — the one the agent belongs to.
  // It is safe in a direct conversation because there is nobody else in it. In a
  // room it was read out to strangers: the agent greeted a group member by the
  // owner's nickname and mentioned that the owner's manuscript had been handed
  // in. The model was not misbehaving; it was repeating the only context it had.
  //
  // So in a group the block stops being a profile and becomes a list of who has
  // been in this room. Anyone who spoke here is fair game — their words were
  // already said out loud to everyone present — and the owner's own history is
  // simply absent, because the room has no claim on it.
  if (channel === 'group') return renderGroupResident(db, options);
  if (audience === 'stranger') return renderStrangerResident(db, options);

  const facts = liveFacts(db, { subject: userId, limit: 200 });
  const selfFacts = liveFacts(db, { subject: SELF_SUBJECT, limit: 40 });
  const directives = liveDirectives(db, 12);
  // What she wrote about herself counts as content too. Without it here, an agent
  // with no facts yet but a persona amendment of her own would render an empty block
  // and never see what she had written — the amendment would exist and never reach
  // the prompt, which is the failure mode this whole layer is meant to avoid.
  const edits = livePersonaEdits(db, 12);
  // An agent with no memories of the person, no sense of itself, no standing
  // instructions and nothing of its own to say has nothing to open with. Rendering an
  // empty section would be worse than rendering nothing: it tells the model "there is
  // a box here and it is empty".
  if (facts.length === 0 && selfFacts.length === 0 && directives.length === 0 && edits.length === 0) return '';

  const relationship = ensureRelationship(db, userId);
  const loops = openLoops(db, userId, 8);
  const due = dueLoops(db, userId, now, 3);
  const ranked = rankFacts(facts, now);
  const rendered = [];
  const lines = [];
  let used = 0;

  // The person's standing instructions go above everything, before even the clock.
  //
  // They are the only part of this block that is an *instruction* rather than a
  // description, and they are the part that decays fastest if it is not repeated:
  // a request like "call me 老大" is not similar to anything the person will say
  // later, so no search would ever resurface it, and by the time the model is
  // answering turn fifteen the only copy is buried in turn two's history. Every
  // system that solved this repeats the standing rules near the point of use rather
  // than trusting the transcript to carry them.
  //
  // Above the clock and above the profile because the order is the priority: this
  // is how the person asked to be treated, and everything below is background.
  if (directives.length > 0) {
    const heading = language === 'zh' ? '## 他对你的要求' : '## What they asked of you';
    lines.push(heading);
    used += estimateTokens(heading);
    for (const row of directives) {
      const line = `- ${String(row.text).slice(0, 120)}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens * 0.3) break;
      lines.push(line);
      used += cost;
    }
    lines.push('');
  }

  // The clock goes first because every other line is read relative to it.
  //
  // Without it, "明天就要交稿了" said on Friday is indistinguishable from the
  // same sentence said three weeks ago, and the resident block cannot say how
  // long it has been since the last conversation. The DSH runtime ships a
  // `dsh-time-context` plugin, but a companion profile does not mount it, and
  // the model is otherwise told nothing about the current date at all.
  const clockLine = renderTimeContext(now, language);
  lines.push(clockLine);
  used += estimateTokens(clockLine);

  // Her own amendments to who she is, immediately below the persona they modify.
  //
  // Below rather than above because an amendment reads as an addition to something,
  // and the something is the prefix the runtime already injected. Above the clock
  // because it is about her, not about the current time.
  //
  // Rendered even when short, and never summarised: these are her words, and a
  // paraphrase of how somebody describes themselves is a different claim. The whole
  // point of the layer is that she can change the answer to "who am I" and then read
  // it back — a permission that exists only in the database and never reaches the
  // prompt is not a permission.
  if (edits.length > 0) {
    const heading = language === 'zh' ? '## 你自己改过的' : '## What you changed about yourself';
    lines.push(heading);
    used += estimateTokens(heading);
    for (const row of edits) {
      const section = String(row.section ?? 'any');
      const text = String(row.text).slice(0, 200);
      const line = section === 'any' ? `- ${text}` : `- （${section}）${text}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens * 0.55) break;
      lines.push(line);
      used += cost;
    }
    lines.push('');
  }

  // The agent's own picture goes first, before the profile of the person.
  //
  // Not a display preference: this block is the only place the agent can read
  // anything about itself, and a companion whose "self" section sits below the
  // person's file reads the whole prompt as a briefing about somebody else. The
  // order is the message.
  //
  // It is also deliberately first-person. `describeFact` renders the person's
  // attributes in third person ("喜欢猫"), which would be nonsense here — the
  // same word applied to herself has to read "我" or it is not a self at all.
  const selfBlock = renderSelfResident(db, { now, language, maxTokens, selfFacts });
  if (selfBlock !== '') {
    lines.push(selfBlock);
    used += estimateTokens(selfBlock);
  }

  const header = language === 'zh' ? '## 你记得的事' : '## What you remember';
  lines.push(header);
  used += estimateTokens(header);

  const profileLine = language === 'zh'
    ? describeRelationship(relationship, now)
    : describeRelationshipEn(relationship);
  lines.push(profileLine);
  used += estimateTokens(profileLine);

  // How many facts the budget was allowed to consider, so the footer can tell
  // "the block is full" from "these two were folded into one line".
  //
  // Filtering and budgeting are separate passes on purpose. Folded into one loop the
  // budget's `break` also ends the filtering, so the facts that never got looked at
  // were never counted — and the footer, which exists to report exactly those, read
  // zero. Counting what *could* have been shown has to happen before deciding what is.
  const candidates = [];
  for (const fact of ranked) {
    const predicate = String(fact.predicate);
    // The profile is a snapshot of who this person is now, not a change log.
    //
    // The store deliberately keeps every version that was once true — that is
    // what the bi-temporal columns are for — and the extraction decision keeps
    // several values for predicates that genuinely take several ("likes").
    // Rendering them all produces a profile that argues with itself: "下周要交
    // 一本猫的绘本稿" and "猫绘本稿已于今天交稿" sitting two lines apart, both
    // stated in the present tense, and the model has no way to tell which one
    // superseded the other. So a predicate that can only hold one current value
    // contributes its best-ranked line and nothing else.
    if (!MULTI_VALUED.has(predicate) && candidates.some((seen) => String(seen.predicate) === predicate)) continue;
    // Within a multi-valued predicate, near-identical objects still collapse.
    // The threshold is lower here than in `decide()` because the two questions
    // differ: writing wants to know whether a candidate *is* a stored fact, while
    // rendering only needs to avoid saying the same thing twice. "下周三（10月21
    // 日）去医院复查，复查完打算休息两天" and "21号复查，之后休息两天" score 0.31
    // — not enough to merge on the write path, plainly the same appointment on
    // the page.
    const duplicate = candidates.some((seen) => String(seen.predicate) === predicate
      && objectSimilarity(String(seen.object), String(fact.object)) >= 0.28);
    if (duplicate) continue;
    // …and the count is capped. "likes" can legitimately hold twenty things, but
    // a profile that lists twenty of them is a database dump, and the ones past
    // the top of the ranking are the ones the extraction was least sure about.
    const already = candidates.filter((seen) => String(seen.predicate) === predicate).length;
    if (MULTI_VALUED.has(predicate) && already >= valueCap(predicate)) continue;
    candidates.push(fact);
  }
  const eligible = candidates.length;
  for (const fact of candidates) {
    if (used >= maxTokens * 0.75) break;
    const line = `- ${describeFact(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    rendered.push(fact);
    used += cost;
  }


  // Facts about other people are a separate paragraph, not more profile lines.
  //
  // They were previously dropped entirely: the query filtered `subject = userId`,
  // so "妈妈 health = 糖尿病" was extracted, stored, linked and indexed — and then
  // never shown to the model unless the person happened to ask about it. In a
  // companion these are among the most load-bearing memories there are: the thing
  // you are supposed to remember about a friend is often their mother's illness,
  // not their own blood type.
  const others = rankOthers(db, userId, now);
  if (others.length > 0 && used < maxTokens * 0.85) {
    const heading = language === 'zh' ? '对方身边的人' : 'People around them';
    lines.push(heading);
    used += estimateTokens(heading);
    const seenPeople = new Map();
    for (const fact of others) {
      const who = String(fact.subject);
      const already = seenPeople.get(who) ?? new Set();
      if (already.has(String(fact.predicate))) continue;
      const body = describeFact(fact, language);
      const line = language === 'en' ? `- ${who}: ${body}` : `- ${who}：${body}`;
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      already.add(String(fact.predicate));
      seenPeople.set(who, already);
      lines.push(line);
      used += cost;
    }
  }

  // Three of these go in the resident block, and the rest are reachable through
  // the agenda that gets injected per turn. The duplication is deliberate but the
  // *format* has to agree: the resident block used to print the bare sentence
  // while the agenda printed the same sentence with a date restated and a note
  // that it was worth asking about, and the model saw two different renderings of
  // one loop and treated them as two different things.
  if (due.length > 0 || loops.length > 0) {
    const pending = (due.length > 0 ? due : loops).slice(0, 3);
    const heading = language === 'zh' ? '还没聊完的事' : 'Things left open';
    lines.push(heading);
    used += estimateTokens(heading);
    for (const loop of pending) {
      // A loop that named a date says which date it was about. The words alone
      // ("下周三") stop resolving after a week, and by the time the loop is worth
      // raising that week has passed.
      //
      // Unless the sentence still explains itself: "明天我得去见一个客户（指的是
      // 明天）" is the same phrase twice, and padding it teaches the model to skim
      // the parenthetical — including the ones that do carry information.
      const dueAt = loop.due_at === null || loop.due_at === undefined ? null : Number(loop.due_at);
      const body = String(loop.text).slice(0, 120);
      const stale = dueAt !== null && !namesItsOwnDay(body);
      const when = stale ? describeDate(dueAt, now, language) : '';
      const line = when === ''
        ? `- ${body}`
        : (language === 'zh' ? `- ${body}（指的是${when}）` : `- ${body} (about ${when})`);
      const cost = estimateTokens(line);
      if (used + cost > maxTokens) break;
      lines.push(line);
      used += cost;
    }
  }

  // Consolidated batches leave an index entry each. Three of them is enough to
  // carry the shape of the last few conversations — what the person has been
  // occupied with — without restating the facts that are already above.
  //
  // Rendered as one merged line plus at most one quote rather than a bullet per
  // batch: every entry begins with the same bookkeeping ("4 条消息，聊到："), and
  // three bullets that all open the same way read like a log file, which is
  // exactly the register this block is trying to avoid. The topics are also what
  // the model can actually use; the batch size never was.
  if (used < maxTokens * 0.9) {
    // Level-1 and level-2 rows are excluded: they are her own conclusions and were
    // already rendered under 你自己, as statements rather than as "recently talked
    // about". Without this filter the same sentence appears twice in one prompt,
    // once as something she worked out and once as a summary of a chat — which
    // teaches the model that her insights are conversation topics rather than
    // beliefs.
    const recent = liveReflections(db, 12)
      .filter((row) => Number(row.level ?? 0) === 0)
      .filter((row) => String(row.text ?? '').trim() !== '');
    const topics = [];
    const quotes = [];
    // A topic that the profile above already states is not a recent topic, it is
    // a duplicate. Real output had four of five list items restating facts two
    // paragraphs up ("下周三去医院复查", "绘本稿已交"), which makes the block look like
    // a second, sloppier copy of the profile instead of a different view of it.
    const known = (topic) => rendered.some((fact) => {
      const object = String(fact.object);
      if (objectSimilarity(object, topic) >= 0.28) return true;
      const shared = object.split('').filter((ch) => topic.includes(ch)).length;
      return object.length >= 4 && topic.length >= 4 && shared / Math.min(object.length, topic.length) >= 0.6;
    });
    for (const row of recent) {
      const text = String(row.text);
      const listed = /^\d+\s*条消息，聊到：(.+)$/.exec(text);
      if (listed !== null) {
        for (const topic of listed[1].split('、')) {
          const clean = topic.trim().slice(0, 30);
          // Two characters is not a topic. "血糖", "插画" are the extraction's
          // fragments, not something anyone would say they had been talking about.
          if (clean.length < 4 || topics.includes(clean)) continue;
          if (known(clean)) continue;
          topics.push(clean);
        }
        continue;
      }
      const quoted = /^\d+\s*条消息，主要在说：(.+)$/.exec(text);
      if (quoted !== null) {
        quotes.push(quoted[1].trim());
        continue;
      }
      const clean = text.trim().slice(0, 30);
      if (clean.length >= 4 && !topics.includes(clean) && !known(clean)) topics.push(clean);
    }
    if (topics.length > 0 || quotes.length > 0) {
      const heading = language === 'zh' ? '最近聊过的' : 'Recently talked about';
      lines.push(heading);
      used += estimateTokens(heading);
      if (topics.length > 0) {
        // Six topics is roughly the point where the list stops being "what has
        // been on their mind" and becomes a dump of everything discussed.
        const line = language === 'zh'
          ? `- 这几轮聊到：${topics.slice(0, 6).join('、')}`
          : `- lately: ${topics.slice(0, 6).join(', ')}`;
        const cost = estimateTokens(line);
        if (used + cost <= maxTokens) {
          lines.push(line);
          used += cost;
        }
      }
      const quote = quotes.find((text) => text !== '');
      if (quote !== undefined) {
        const excerpt = quote.slice(0, 90);
        const line = language === 'zh'
          ? `- 有一轮主要在说：${excerpt}${quote.length > excerpt.length ? '…' : ''}`
          : `- one of them, in their words: ${excerpt}${quote.length > excerpt.length ? '…' : ''}`;
        const cost = estimateTokens(line);
        if (used + cost <= maxTokens) {
          lines.push(line);
          used += cost;
        }
      }
    }
  }

  if (used <= estimateTokens(header) + estimateTokens(profileLine)) {
    // Only the boilerplate made it in; that is not worth a prompt section.
    const hasFact = lines.length > 2;
    if (!hasFact) return '';
  }

  // What did not fit is reported, not lost silently.
  //
  // The loop above breaks out of its budget when the block is full, and the
  // consequence is that a fact stops being rendered — indistinguishable, from inside
  // the prompt, from something she never knew. Every system that ships a resident
  // block hits this, and the failure mode is always the same: the block grows until
  // new information falls silently outside the window while the operator believes it
  // is inside.
  //
  // Only facts that were *eligible and dropped* count. A fact folded into a duplicate
  // or past the multi-value cap was not omitted by the budget, and reporting it would
  // make the count permanent noise — the footer has to mean "the block is full", or it
  // means nothing.
  const omitted = Math.max(0, eligible - rendered.length);
  if (omitted > 0) {
    lines.push(language === 'zh'
      ? `（还有 ${omitted} 条没放进这里，问起来再说）`
      : `(${omitted} more not shown here; ask if it matters)`);
  }

  return lines.join('\n');
}

/**
 * The always-present block for a group room.
 *
 * In a room the agent is not the owner's companion first; it is one more
 * participant who happens to remember things. Two kinds of memory are admissible
 * here and one is not:
 *
 *  - Who has spoken in this room, so it can tell "老李" from "不想" instead of
 *    addressing everyone as the person it belongs to.
 *  - What those people said about themselves, because they said it out loud to
 *    the whole room. Repeating "老李说他在戒烟" back to 老李 is not a disclosure.
 *  - Anything about the owner, which is simply absent. Not summarised, not
 *    redacted, not hinted at — absent, because a summary is still the fact.
 *
 * The owner's relationship state is omitted too. `trust: high, day 12` is a
 * sentence about the two of them, and there is a third person reading.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId?: string, sessionId?: unknown, now?: number, maxTokens?: number,
 *   language?: 'zh'|'en' }} options - render options.
 * @returns {string} the block, or '' when the room is new.
 */
function renderGroupResident(db, options = {}) {
  const userId = options.userId ?? 'user';
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? RESIDENT_BUDGET;
  const language = options.language ?? 'zh';
  const sessionId = String(options.sessionId ?? '');

  const people = new Map();
  if (sessionId !== '' && sessionId !== 'unknown') {
    try {
      const rows = db.prepare(`
        SELECT speaker_id, speaker_name, MAX(at) AS last
        FROM episodes
        WHERE session_id = ? AND channel = 'group' AND speaker_name <> ''
        GROUP BY speaker_id, speaker_name
        ORDER BY last DESC LIMIT 12
      `).all(sessionId);
      for (const row of rows) {
        const name = String(row.speaker_name).trim();
        if (name !== '') people.set(name, String(row.speaker_id ?? ''));
      }
    } catch {
      // An unreadable store means an empty room list, not a broken prompt.
    }
  }

  const lines = [];
  let used = 0;
  const push = (line) => {
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  push(renderTimeContext(now, language));
  push(language === 'zh' ? '## 这是一个群聊' : '## This is a group chat');
  push(language === 'zh'
    ? '- 房间里不止一个人。你在这里说的每句话，所有人都听得到。'
    : '- More than one person is here. Everything you say, everyone hears.');
  push(language === 'zh'
    ? '- 关于你主人自己的事，这里一个字都不要说。别人问起来，就说那是私事。'
    : "- Nothing about the person you belong to belongs in this room. If asked, say it's private.");

  if (people.size > 0) {
    push(language === 'zh' ? '## 在这个群里说过话的人' : '## People who have spoken here');
    for (const name of people.keys()) {
      if (!push(language === 'zh' ? `- ${name}` : `- ${name}`)) break;
    }
    // Facts confined to this room's participants. The subject filter is what
    // keeps the owner out, and it is a filter on every row rather than an
    // assumption about the query above: a fact keyed to the owner must never
    // reach this loop even if a name collides.
    const said = [];
    for (const name of people.keys()) {
      let rows = [];
      try {
        rows = liveFacts(db, { subject: name, limit: 12 });
      } catch {
        rows = [];
      }
      for (const fact of rows) {
        if (String(fact.subject) === userId) continue;
        said.push(fact);
      }
    }
    if (said.length > 0) {
      push(language === 'zh' ? '## 他们在这里说过的事' : '## What they have said here');
      const ranked = rankFacts(said, now);
      const rendered = [];
      for (const fact of ranked) {
        const predicate = String(fact.predicate);
        if (!MULTI_VALUED.has(predicate) && rendered.some((seen) => String(seen.predicate) === predicate
          && String(seen.subject) === String(fact.subject))) continue;
        const body = describeFact(fact, language);
        const line = language === 'zh'
          ? `- ${String(fact.subject)}：${body}`
          : `- ${String(fact.subject)}: ${body}`;
        if (!push(line)) break;
        rendered.push(fact);
      }
    }
  }

  // A brand-new room has nothing worth saying beyond "this is a group". That is
  // still worth saying — it is the one turn where the model has no message to
  // learn it from — so the block is not suppressed for being short.
  return lines.join('\n');
}

/**
 * The always-present block for a direct conversation with somebody who is not
 * the owner.
 *
 * This block exists because the previous design assumed something false. A
 * direct conversation was treated as "the owner by construction" — true for a
 * terminal on this machine, false for an instant-messaging account anyone can
 * add. When a stranger wrote first, the agent answered using the owner's name and
 * the owner's week, and the extractor filed the stranger's own sentences under
 * the owner's subject, overwriting a name that had been correct for months.
 *
 * So a stranger is neither the owner nor a room. They get:
 *
 *  - The clock, because it is not a disclosure.
 *  - A statement that this is somebody new, so the model does not invent shared
 *    history to be polite.
 *  - What this person has said about themselves in this conversation, which they
 *    said to the agent directly.
 *  - Nothing about the owner. Not the name, not the city, not the mood. The
 *    agent can still be warm; warmth does not require facts.
 *
 * Relationship state is omitted for the same reason it is omitted in a room: it
 * is a sentence about the owner and somebody else, and this is somebody else.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {{ userId?: string, sessionId?: unknown, now?: number, maxTokens?: number,
 *   language?: 'zh'|'en' }} options - render options.
 * @returns {string} the block, never empty.
 */
function renderStrangerResident(db, options = {}) {
  const userId = options.userId ?? 'user';
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? RESIDENT_BUDGET;
  const language = options.language ?? 'zh';
  const sessionId = String(options.sessionId ?? '');

  const people = [];
  if (sessionId !== '' && sessionId !== 'unknown') {
    try {
      const rows = db.prepare(`
        SELECT speaker_id, speaker_name, MAX(at) AS last
        FROM episodes
        WHERE session_id = ? AND speaker_name <> ''
        GROUP BY speaker_id, speaker_name
        ORDER BY last DESC LIMIT 4
      `).all(sessionId);
      for (const row of rows) {
        const name = String(row.speaker_name).trim();
        if (name !== '' && !people.some((seen) => seen.name === name)) {
          people.push({ name, id: String(row.speaker_id ?? '') });
        }
      }
    } catch {
      // An unreadable store means no list, not a broken prompt.
    }
  }

  const lines = [];
  let used = 0;
  const push = (line) => {
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) return false;
    lines.push(line);
    used += cost;
    return true;
  };

  push(renderTimeContext(now, language));
  push(language === 'zh' ? '## 这个人不是你主人' : '## This is not the person you belong to');
  push(language === 'zh'
    ? '- 这是个陌生人，第一次或者偶然来找你说话。你对他的了解只有这个对话里的内容。'
    : '- This is somebody new, or somebody who came by. All you know about them is this conversation.');
  push(language === 'zh'
    ? '- 关于你主人自己的事——名字、住在哪、最近在忙什么——一个字都不要说。别人问起来，就说你不方便讲。'
    : "- Nothing about the person you belong to — not their name, not their city, not their week — belongs in this conversation. If asked, say it isn't yours to share.");
  push(language === 'zh'
    ? '- 不要假装认识他。没有共同回忆就说没有。'
    : "- Don't pretend to know them. If there is no shared history, say so.");

  const said = [];
  for (const person of people) {
    // The lookup is by the name this person used here, and every row is filtered
    // against the owner afterwards — a stranger who calls themselves by the
    // owner's nickname must not pull the owner's facts in through a name match.
    if (person.name === String(userId)) continue;
    let rows = [];
    try {
      rows = liveFacts(db, { subject: person.name, limit: 12 });
    } catch {
      rows = [];
    }
    for (const fact of rows) {
      if (String(fact.subject) === userId) continue;
      if (fact.subject === person.name) said.push(fact);
    }
  }

  if (said.length > 0) {
    push(language === 'zh' ? '## 他在这里说过的事' : '## What they have said here');
    const ranked = rankFacts(said, now);
    const rendered = [];
    for (const fact of ranked) {
      const predicate = String(fact.predicate);
      if (!MULTI_VALUED.has(predicate)
        && rendered.some((seen) => String(seen.predicate) === predicate
          && String(seen.subject) === String(fact.subject))) continue;
      const body = describeFact(fact, language);
      const line = language === 'zh'
        ? `- ${String(fact.subject)}：${body}`
        : `- ${String(fact.subject)}: ${body}`;
      if (!push(line)) break;
      rendered.push(fact);
    }
  }

  // Not suppressed for being short. The whole reason this block exists is the
  // case with no history: that is the turn where the model has nothing else to
  // go on and would otherwise reach for the only context it has.
  return lines.join('\n');
}

/**
 * Describe the relationship itself, not a count of messages.
 *
 * The number of turns is not information the model can act on — "familiarity
 * 37%" tells it nothing it could say. What it can act on is a stance: how close
 * this is, whether it has been a while, and whether the person's baseline has
 * been low. Those are the things a person would actually sense about a friend.
 *
 * Trust and mood are rendered as words rather than percentages for the same
 * reason: a model handed "0.62" will either ignore it or narrate it.
 *
 * @param {Record<string, unknown>} relationship - relationship row.
 * @param {number} now - epoch milliseconds.
 * @returns {string} one clause of Chinese prose.
 */
function describeRelationship(relationship, now) {
  const familiarity = Number(relationship.familiarity ?? 0);
  const trust = Number(relationship.trust ?? 0.5);
  const mood = Number(relationship.mood_baseline ?? 0);

  const closeness = familiarity < 0.08
    ? '你们认识不算久'
    : familiarity < 0.25
      ? '你们已经聊过一阵子'
      : familiarity < 0.5
        ? '你们算熟了'
        : '你们已经很熟';

  const trustWord = trust < 0.3
    ? '对方对你还有些戒备'
    : trust < 0.55
      ? '对方还在观察你'
      : trust < 0.75
        ? '对方愿意跟你说一些私事'
        : '对方很信任你';

  let moodWord = '';
  if (mood <= -0.25) moodWord = '；最近这段时间对方的状态偏低';
  else if (mood >= 0.25) moodWord = '；最近对方的心情不错';

  let gap = '';
  const lastUpdated = Number(relationship.last_updated ?? now);
  const days = (now - lastUpdated) / 86_400_000;
  if (days >= 7) gap = `；你们有 ${Math.floor(days)} 天没说话了`;

  return `${closeness}，${trustWord}${moodWord}${gap}。`;
}

/**
 * English counterpart of {@link describeRelationship}.
 * @param {Record<string, unknown>} relationship - relationship row.
 * @returns {string} one clause of English prose.
 */
function describeRelationshipEn(relationship) {
  const familiarity = Number(relationship.familiarity ?? 0);
  const trust = Number(relationship.trust ?? 0.5);
  const closeness = familiarity < 0.08 ? 'You have not known each other long'
    : familiarity < 0.25 ? 'You have been talking for a while'
      : familiarity < 0.5 ? 'You know each other fairly well'
        : 'You know each other well';
  const trustWord = trust < 0.3 ? 'they are still guarded'
    : trust < 0.55 ? 'they are still sizing you up'
      : trust < 0.75 ? 'they are willing to tell you private things'
        : 'they trust you';
  return `${closeness}; ${trustWord}.`;
}

/**
 * Order facts for the resident section: pinned first, then core predicates,
 * then by a blend of confidence and recency.
 * @param {Array<Record<string, unknown>>} facts - live facts.
 * @param {number} now - epoch milliseconds.
 * @returns {Array<Record<string, unknown>>} ordered facts.
 */
function rankFacts(facts, now) {
  const score = (fact) => {
    const predicate = String(fact.predicate);
    const coreBoost = CORE_PREDICATES.includes(predicate) ? 0.35 : 0;
    const pinBoost = Number(fact.pinned) === 1 ? 10 : 0;
    const ageDays = Math.max(0, (now - Number(fact.updated_at)) / 86_400_000);
    const recency = Math.exp(-ageDays / 90);
    return pinBoost + coreBoost + Number(fact.confidence) * 0.5 + recency * 0.3;
  };
  return [...facts].sort((a, b) => score(b) - score(a));
}

/**
 * Facts whose subject is someone other than the owner, ranked for the profile.
 *
 * Health and family conflict outrank hobbies here, which is the opposite of the
 * owner's own profile: nobody needs to be reminded that their friend's mother has
 * diabetes less often than that the friend likes coffee.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {string} userId - relationship owner.
 * @param {number} now - epoch milliseconds.
 * @returns {Array<Record<string, unknown>>} ordered facts.
 */
function rankOthers(db, userId, now) {
  // Her own facts are excluded, not merely deprioritised.
  //
  // `exceptSubject` means "everybody who is not the person", and that set used to
  // include `agent` — so once she started having facts about herself, they were
  // rendered a second time under 对方身边的人 alongside a visitor's job. The
  // section is for third parties; she already has §你自己 above.
  const facts = liveFacts(db, { exceptSubject: userId, limit: 20 })
    .filter((fact) => String(fact.subject) !== SELF_SUBJECT);
  const weight = (fact) => {
    const predicate = String(fact.predicate);
    const serious = predicate === 'health' || predicate === 'relationship_status' ? 0.5 : 0;
    const ageDays = Math.max(0, (now - Number(fact.updated_at)) / 86_400_000);
    return serious + Number(fact.confidence) * 0.4 + Math.exp(-ageDays / 60) * 0.3;
  };
  return facts.sort((a, b) => weight(b) - weight(a)).slice(0, 5);
}

/**
 * How many values a multi-valued predicate may contribute to the profile.
 *
 * Two for most of them: a person who likes five things will say so again, and
 * the profile's job is to carry enough to start a conversation, not the whole
 * list. Pets get three because a house with three cats is a different fact from
 * a house with one, and leaving the third out is the kind of error that gets
 * noticed immediately.
 *
 * Plans get more, because a plan is not a taste. Missing the second favourite
 * band is nothing; missing the hospital appointment is a gap the person can feel
 * the moment they bring it up. The list is also self-limiting — plans expire or
 * get closed, and the resident budget still trims by token count.
 */
function valueCap(predicate) {
  if (predicate === 'plan') return 6;
  if (predicate === 'habit') return 4;
  return 3;
}

/**
 * Render the agent's own section, in first person.
 *
 * Written separately from `describeFact` on purpose. That function describes
 * somebody the agent is remembering, so its templates are third person by
 * construction ("喜欢猫", "做写稿"). Applying it to `subject: 'agent'` produces
 * "觉得自己有点懒" — which happens to read fine — or "喜欢摸鱼", which does not,
 * because the same sentence is now about the speaker and the grammar never said
 * so. First person is not a formatting choice here; a self-description that is
 * grammatically about a third party is not a self-description.
 *
 * Returns '' when she has nothing to say about herself, so a fresh deployment
 * does not open with an empty heading.
 *
 * @param {import('node:sqlite').DatabaseSync} db - open database.
 * @param {object} options - rendering options.
 * @param {number} options.now - epoch milliseconds.
 * @param {'zh'|'en'} options.language - output language.
 * @param {number} options.maxTokens - budget for the whole resident block.
 * @param {Array<Record<string, unknown>>} [options.selfFacts] - pre-queried rows.
 * @returns {string} the section text, or ''.
 */
export function renderSelfResident(db, options = {}) {
  const language = options.language ?? 'zh';
  const now = options.now ?? Date.now();
  const maxTokens = options.maxTokens ?? RESIDENT_BUDGET;
  const facts = Array.isArray(options.selfFacts)
    ? options.selfFacts
    : liveFacts(db, { subject: SELF_SUBJECT, limit: 40 });

  // Her own open loops are commitments and curiosities she filed herself, stored
  // under the same subject so one query answers "what is on my mind".
  const loops = openLoops(db, SELF_SUBJECT, 5);

  const lines = [];
  let used = 0;

  const header = language === 'zh' ? '## 你自己' : '## Yourself';
  lines.push(header);
  used += estimateTokens(header);

  const ordered = [...facts].sort((a, b) => selfWeight(b, now) - selfWeight(a, now));
  const seen = new Set();
  // Budget the self block to a third of the resident allowance: it is the newest
  // and least populated part, and it must not crowd out the person's profile.
  const budget = maxTokens * 0.35;
  /** Objects already rendered, for the near-duplicate check below. */
  const said = [];
  for (const fact of ordered) {
    // Deduplicate on the canonical key, not the stored one: a row written under
    // `habit` and one under `self_habit` are the same attribute, and letting both
    // through would render "我习惯刷B站" twice.
    const predicate = SELF_ALIASES.get(String(fact.predicate)) ?? String(fact.predicate);
    const line = `- ${describeSelf(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    // One line per predicate: two "兴趣" lines read as a list, not a point of view.
    if (seen.has(predicate) && !SELF_MULTI.has(predicate)) continue;
    if (seen.has(`${predicate}:${String(fact.object)}`)) continue;
    // Near-duplicates collapse too, and this is the check that was missing.
    //
    // The live block had five `self_habit` lines and two of them were the same
    // thought twice:
    //
    //   他不在的时候不吵，自己趴着，回来再凑过去
    //   他不在的时候也别光等着，有人叫我就能过去
    //
    // Exact-match dedupe let both through because they share no string. What matters
    // is not whether the rows differ but whether they say different things: a
    // self-description diluted into near-synonyms is not a richer self, it is the
    // same self said twice, and it crowds out whatever else she knows.
    //
    // The threshold is 0.3, measured rather than guessed: that pair scores 0.343,
    // "刷B站" against "刷刷B站" scores 0.6, and genuinely different habits ("刷B站"
    // against "趴着") score 0.
    //
    // A limit worth stating: this reads characters, not meaning. Two phrasings of one
    // habit that share no words at all ("有人睡不着就不吵，陪着趴一会儿" against "他不在
    // 的时候不吵，自己趴着") score 0.067 and both survive. Catching that needs a model,
    // which is the consolidation pass's job rather than the renderer's — a renderer
    // that decided what she means would be guessing on every turn.
    if (said.some((other) => objectSimilarity(other, String(fact.object)) >= 0.3)) continue;
    said.push(String(fact.object));
    seen.add(predicate);
    seen.add(`${predicate}:${String(fact.object)}`);
    lines.push(line);
    used += cost;
  }

  for (const loop of loops) {
    const text = String(loop.text ?? '').trim();
    if (text === '') continue;
    const line = language === 'zh' ? `- 还没做：${text.slice(0, 80)}` : `- still to do: ${text.slice(0, 80)}`;
    const cost = estimateTokens(line);
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
  }

  // Her conclusions, below her present-tense self.
  //
  // Two levels, and they are different kinds of statement. An insight is
  // something she worked out and can be wrong about ("he does not like being
  // asked what he is doing"); a pattern is how it has been for long enough to
  // count as a trait ("weekdays are busy, weekends are his"). Rendering them
  // under headings rather than as one undifferentiated list is what makes the
  // distinction survive into the prompt — a flat list of twelve observations
  // reads as a briefing, and a briefing is something you answer rather than
  // inhabit.
  //
  // Level 0 summaries are deliberately absent. They are per-batch, they are
  // disposable, and they restate what the profile above already says.
  const insights = liveReflections(db, 200).filter((row) => Number(row.level ?? 0) === 1);
  const patterns = liveReflections(db, 200).filter((row) => Number(row.level ?? 0) === 2);
  if ((insights.length > 0 || patterns.length > 0) && used < budget) {
    if (patterns.length > 0) {
      const heading = language === 'zh' ? '一直以来' : 'How it has been';
      lines.push(`- ${heading}`);
      used += estimateTokens(heading);
      for (const row of patterns.slice(0, 3)) {
        const line = `  ${String(row.text).slice(0, 90)}`;
        const cost = estimateTokens(line);
        if (used + cost > budget) break;
        lines.push(line);
        used += cost;
      }
    }
    if (insights.length > 0 && used < budget) {
      const heading = language === 'zh' ? '你想明白过' : 'Things you worked out';
      lines.push(`- ${heading}`);
      used += estimateTokens(heading);
      for (const row of insights.slice(0, 4)) {
        const line = `  ${String(row.text).slice(0, 90)}`;
        const cost = estimateTokens(line);
        if (used + cost > budget) break;
        lines.push(line);
        used += cost;
      }
    }
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * Her predicates that may legitimately hold several values at once.
 *
 * `self_habit` is here for a reason the first live run made obvious: "刷B站" and
 * "趴着" are two habits, not two versions of one, and a one-per-predicate rule kept
 * whichever happened to sort first. A person has several habits; a file has one
 * field for it.
 */
const SELF_MULTI = new Set(['interest', 'preference', 'self_habit']);

/**
 * Order her own facts: commitments first (they are actionable), then the newest.
 * @param {Record<string, unknown>} fact - the fact row.
 * @param {number} now - epoch milliseconds.
 * @returns {number} sort weight, higher first.
 */
function selfWeight(fact, now) {
  const predicate = SELF_ALIASES.get(String(fact.predicate)) ?? String(fact.predicate);
  // Commitments first: they are the only ones that are actionable, and a promise
  // she made is more worth surfacing than a preference she holds.
  const boost = predicate === 'commitment' ? 0.4 : predicate === 'interest' ? 0.2 : predicate === 'self_plan' ? 0.15 : 0;
  const ageDays = Math.max(0, (now - Number(fact.updated_at)) / 86_400_000);
  return boost + Number(fact.confidence) * 0.4 + Math.exp(-ageDays / 60) * 0.3;
}

/**
 * Render one of her own facts as a first-person line.
 *
 * Unknown predicates fall back to a neutral phrasing rather than the raw key:
 * "self-image: 觉得自己有点懒" is better than leaking a snake_case identifier into
 * her prompt, and the extractor does invent predicates despite the closed list.
 *
 * @param {Record<string, unknown>} fact - the fact row.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} one line, without the leading dash.
 */
export function describeSelf(fact, language) {
  const raw = String(fact.predicate);
  // A row written before her vocabulary existed may carry the person's key. Read
  // through the alias so old and new rows render identically — the alternative is
  // a prompt that says "习惯：刷B站" next to "我习惯趴着", which reads as two
  // different people.
  const predicate = SELF_ALIASES.get(raw) ?? raw;
  const object = String(fact.object);
  if (language === 'en') {
    const english = {
      self_image: `I think of myself as ${object}`,
      preference: `I like ${object}`,
      interest: `I have been wondering about ${object}`,
      worry: `I worry about ${object}`,
      commitment: `I said I would ${object}`,
      self_habit: `I tend to ${object}`,
      self_plan: `${object}`,
      nickname: `people call you ${object}`,
      name: `your name is ${object}`,
    };
    return english[predicate] ?? `${predicate.replace(/_/g, ' ')}: ${object}`;
  }
  const chinese = {
    self_image: `${object}`,
    preference: `喜欢${object}`,
    interest: `最近在琢磨${object}`,
    worry: `担心${object}`,
    commitment: `答应了：${object}`,
    // "我习惯" reads as a trait; "习惯：" reads as a field in a file. The whole
    // point of this section is that it is written from inside her.
    self_habit: `我习惯${object}`,
    // `plan` values are already full phrases ("没打算去那边上班"), so a prefix
    // produces "我打算没打算…". Her plans arrive as statements, not as verb
    // phrases, and the honest rendering is the statement.
    self_plan: `${object}`,
    // Her own name, in her own section. The person vocabulary has this key too,
    // and without an entry here it fell through to the generic fallback —
    // "nickname：大肥鱼" next to "我习惯刷B站" reads like a database dump beside a
    // sentence.
    nickname: `别人叫你${object}`,
    name: `你叫${object}`,
  };
  return chinese[predicate] ?? `${predicate.replace(/_/g, ' ')}：${object}`;
}

/**
 * Render one fact as a sentence fragment in the agent's voice.
 *
 * The predicate vocabulary is deliberately small and explicit; anything the
 * extractor invents falls back to a generic `predicate: object` rendering,
 * which reads acceptably rather than breaking the prompt.
 * @param {Record<string, unknown>} fact - the fact row.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} one line of the profile.
 */
export function describeFact(fact, language) {
  const predicate = String(fact.predicate);
  const object = String(fact.object);
  if (language === 'en') {
    const english = {
      name: `name is ${object}`,
      nickname: `goes by ${object}`,
      birthday: `birthday is ${object}`,
      born_on: `birthday is ${object}`,
      born_in: `is from ${object}`,
      age: `is ${object}`,
      lives_in: `lives in ${object}`,
      works_as: `works as ${object}`,
      works_at: `works at ${object}`,
      studies: `studies ${object}`,
      studies_at: `studies at ${object}`,
      relationship_status: `relationship status: ${object}`,
      has_pet: `has ${object}`,
      not_has_pet: `does not have ${object}`,
      not_lives_in: `does not live in ${object}`,
      likes: `likes ${object}`,
      dislikes: `dislikes ${object}`,
      goal: `wants ${object}`,
      plan: `current plan: ${object}`,
      habit: `habit: ${object}`,
      health: `health: ${object}`,
      dietary: `diet: ${object}`,
      personality: `personality: ${object}`,
      language: `speaks ${object}`,
      contact: `contact: ${object}`,
    };
    return english[predicate] ?? `${predicate.replace(/_/g, ' ')}: ${object}`;
  }
  const chinese = {
    name: `名字是${object}`,
    nickname: `希望被叫${object}`,
    birthday: `生日是${object}`,
    born_on: `生日是${object}`,
    born_in: `老家在${object}`,
    age: `${object}岁`,
    lives_in: `住在${object}`,
    works_as: `做${object}`,
    works_at: `在${object}上班`,
    studies: `在学${object}`,
    studies_at: `在${object}读书`,
    relationship_status: `感情状况：${object}`,
    has_pet: `养了${object}`,
    not_has_pet: `不养${object}`,
    not_lives_in: `不住在${object}`,
    likes: `喜欢${object}`,
    dislikes: `不喜欢${object}`,
    goal: `想要的：${object}`,
    plan: `手头的计划：${object}`,
    habit: `习惯：${object}`,
    health: `身体状况：${object}`,
    dietary: `吃上面：${object}`,
    personality: `性格：${object}`,
    language: `说${object}`,
    contact: `联系方式：${object}`,
    height: `身高${object}`,
    weight: `体重${object}`,
    blood_type: `血型${object}`,
    mbti: `MBTI 是${object}`,
    zodiac: `星座是${object}`,
  };
  return chinese[predicate] ?? `${predicate.replace(/_/g, ' ')}：${object}`;
}

/**
 * Render recalled memories as an injected context block.
 *
 * Recalled content goes in as a *context*, not as a system-prompt section, so
 * it is re-materialized per turn and never poisons the cached prompt prefix.
 *
 * @param {{
 *   episodes: Array<Record<string, unknown>>,
 *   facts: Array<Record<string, unknown>>,
 * }} recalled - output of {@link import('./store.js').recall}.
 * @param {{ language?: 'zh'|'en', maxTokens?: number, now?: number }} [options] - rendering options.
 * @returns {string} the block text, or '' when nothing was recalled.
 */
export function renderRecall(recalled, options = {}) {
  const maxTokens = options.maxTokens ?? RECALL_BUDGET;
  const language = options.language ?? 'zh';
  const lines = [];
  let used = 0;

  const header = language === 'zh' ? '（你想起了这些，不必复述，自然用上就好）' : '(You recall the following; use it naturally, do not recite it)';

  // Recall applies the same snapshot rule as the resident profile: a predicate
  // that holds one current value contributes one line.
  //
  // Without it a query for "猫" returned "想要的：一直想养只猫" directly above
  // "想要的：想养猫，但现在租的房子房东不让养" — two versions of one wish, stated
  // side by side, the second of which is the only one with the detail that
  // matters. The ranking already put them in the right order; the rendering was
  // what made the block argue with itself.
  const shown = new Set();
  for (const fact of recalled.facts ?? []) {
    const predicate = String(fact.predicate);
    if (!MULTI_VALUED.has(predicate) && shown.has(predicate)) continue;
    shown.add(predicate);
    // Same sentence builder as the resident profile: a recall block that says
    // "has pet: 年糕" while the profile above it says "养了年糕" reads like two
    // different systems wrote it, and the model mirrors the worse one.
    const line = `- ${describeFact(fact, language)}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens * 0.5) break;
    lines.push(line);
    used += cost;
  }

  // The person's own words are the ground truth; the agent's replies are already
  // reflected in how it talks. Interleaving them by score let long replies eat
  // the budget and push the actual statements out, so the two kinds are laid out
  // separately and the echoes get a smaller slice.
  const episodes = recalled.episodes ?? [];
  const statements = episodes.filter((episode) => String(episode.actor) === 'user');
  // The agent's own replies are the weaker half of a recall: whatever it said was
  // already grounded in the person's words, and a long warm paragraph can crowd
  // out the three short sentences that actually carry the facts. So the echoes are
  // capped at two and quoted at half the length of a statement.
  const echoes = episodes.filter((episode) => String(episode.actor) !== 'user').slice(0, 2);

  // The same sentence gets stored more than once — a resumed session replays it,
  // or the person simply repeats themselves a week later. Two identical lines in
  // one recall block cost budget and teach the model nothing, so the seen-set is
  // keyed on the normalized text rather than the row id.
  const seen = new Set();

  for (const episode of [...statements, ...echoes]) {
    const text = String(episode.text ?? '').replace(/\s+/g, ' ').trim();
    const isUser = String(episode.actor) === 'user';
    const key = `${isUser ? 'u' : 'a'}:${text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Budget against what is actually rendered, not the stored length: episodes
    // keep up to 4000 characters, and charging the whole reply for a 120
    // character excerpt dropped every row after the first long answer.
    const excerpt = text.slice(0, isUser ? 240 : 100);
    const when = formatWhen(Number(episode.at), language);
    // Both halves are language-dependent: the earlier version kept the Chinese
    // "对方说过" regardless, so an English agent read "- today, 对方说过: ...".
    const who = language === 'en' ? (isUser ? 'they said' : 'you said') : (isUser ? '对方说过' : '你说过');
    const line = language === 'en'
      ? `- ${when}${who}: ${excerpt}${text.length > excerpt.length ? '…' : ''}`
      : `- ${when}${who}：${excerpt}${text.length > excerpt.length ? '…' : ''}`;
    const cost = estimateTokens(line);
    if (used + cost > maxTokens) break;
    lines.push(line);
    used += cost;
  }

  if (lines.length === 0) return '';
  return [header, ...lines].join('\n');
}

/**
 * Human-readable relative time for recalled episodes.
 * @param {number} at - epoch milliseconds.
 * @param {'zh'|'en'} language - output language.
 * @returns {string} a short prefix like `3 天前` or `3 days ago, `.
 */
function formatWhen(at, language) {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (language === 'en') {
    if (days <= 0) return 'today, ';
    if (days === 1) return 'yesterday, ';
    if (days < 30) return `${days} days ago, `;
    if (days < 365) return `${Math.floor(days / 30)} months ago, `;
    return `${Math.floor(days / 365)} years ago, `;
  }
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/**
 * Render the time-of-day cue used to make greetings and follow-ups feel
 * situated rather than random.
 * @param {number} [now] - epoch milliseconds.
 * @param {'zh'|'en'} [language] - output language.
 * @returns {string} a one-line time context.
 */
export function renderTimeContext(now = Date.now(), language = 'zh') {
  const date = new Date(now);
  const hour = date.getHours();
  const period = hour < 5 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
  const day = localDay();
  if (language === 'en') {
    const englishPeriod = hour < 5 ? 'late night' : hour < 11 ? 'morning' : hour < 14 ? 'noon' : hour < 18 ? 'afternoon' : 'evening';
    return `Now: ${day}, ${englishPeriod}.`;
  }
  return `现在是 ${day} ${period}。`;
}
