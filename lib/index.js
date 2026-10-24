/**
 * dsh-hippo — long-term memory for an agent that is supposed to know someone.
 *
 * The premise in one line: remembering a person is a maintenance problem, not a
 * retrieval problem. Facts go stale, moods shift, promises stay open, and a
 * memory that never forgets becomes a liability rather than an asset. So the
 * stores stay separate:
 *
 *   episodes      what was said, immutable, never rewritten
 *   facts         what is believed, revisable, with a version chain
 *   reflections   what was concluded, linked back to evidence
 *   relationship  how things stand, derived and append-only
 *
 * Writes pass a three-stage gate (verbatim capture → gated extraction →
 * consolidation audit) so the model call only runs on material worth keeping.
 * Reads are staged too (resident profile → cued recall → explicit tool),
 * because a prompt that carries everything carries nothing.
 *
 * @module dsh-hippo
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { openDatabase } from './db.js';
import {
  recordEpisode,
  hasEpisodeForMessage,
  recentEpisodes,
  unconsolidatedEpisodes,
  liveFacts,
  recall,
  addFact,
  invalidateFact,
  reinforceFact,
  pendingClarifications,
  resolveClarification,
  openLoops,
  addOpenLoop,
  closeOpenLoop,
  addReflection,
  addDirective,
  liveDirectives,
  retireDirective,
  addPersonaEdit,
  retirePersonaEdit,
  readPersonaBase,
  personaAppearance,
  seedPersonaBase,
  writePersonaBase,
  liveReflections,
  recordAffect,
  ensureRelationship,
  adjustTrust,
  recomputeRelationship,
  recordReview,
  redactRecent,
  redactEpisode,
  gradeMemory,
  chargeBudget,
  setLoopDue,
  savePendingRecall,
  takePendingRecall,
  spentToday,
  userId as readUserId,
} from './store.js';
import { shouldExtract, detectAffect, asksForRecall, detectTrustSignal, asksToForget, detectCorrectionIn } from './gate.js';
import { renderResident, renderRecall, describeFact } from './prompt.js';
import { channelOf, sessionIdOf, audienceOf } from './channel.js';
import { renderAgenda, detectLoop, loopResolvedBy, expireClarifications } from './agenda.js';
import { consolidate, shouldConsolidateOnIdle, demoteWeakFacts, resolveSpeakerSubject, ownerAliases } from './consolidate.js';
import { canonicalize, decide } from './extract.js';
import { estimateTokens, segment, tokenize } from './tokenize.js';
import { parseRelativeDate, followUpAfter } from './when.js';
import { runMemoryCommand } from './commands.js';
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt';

/**
 * Attribute keys the model is allowed to use when writing a fact by hand.
 *
 * A closed list is what makes two statements comparable: an open vocabulary
 * lets "养了" and "has_pet" sit side by side as independent truths.
 */
const PREDICATE_VOCABULARY = [
  'name', 'nickname', 'birthday', 'age', 'lives_in', 'works_as', 'works_at',
  'studies_at', 'relationship_status', 'has_pet', 'likes', 'dislikes', 'goal',
  'plan', 'habit', 'health', 'dietary', 'personality', 'language', 'contact',
  'not_has_pet', 'not_lives_in',
];

/**
 * The short form of an id, as printed into tool output.
 *
 * Three tools take an id (`memory_forget`, `memory_clarify`, `memory_loop`) and
 * the model can only pass back an id some other tool printed. A full uuid per
 * line costs more context than the memory it identifies, so output shows eight
 * characters and every lookup accepts a unique prefix. Printing them at all is
 * the point: an id-taking tool whose input no tool ever shows is a tool that
 * cannot be called, which is a bug that never shows up in a green test suite.
 *
 * @param {unknown} id - the full id.
 * @returns {string} the first eight characters.
 */
function shortId(id) {
  return String(id).slice(0, 8);
}

/**
 * Resolve a printed id back to one row: exact match first, then unique prefix.
 *
 * @param {Array<Record<string, unknown>>} rows - candidate rows, each with an `id`.
 * @param {unknown} given - what the model passed.
 * @returns {Record<string, unknown>|null} the row, or null when unknown or ambiguous.
 */
function resolveId(rows, given) {
  const wanted = String(given ?? '').trim();
  if (wanted === '') return null;
  const exact = rows.find((row) => String(row.id) === wanted);
  if (exact !== undefined) return exact;
  const matches = rows.filter((row) => String(row.id).startsWith(wanted));
  // Two rows matching a prefix means the reference is ambiguous, and guessing
  // which memory someone meant is not something a memory system gets to do.
  return matches.length === 1 ? matches[0] : null;
}

/** Plugin name registered with Cordis. */
export const name = 'hippo';

/**
 * Services this plugin needs at activation time.
 *
 * `agents` is deliberately absent: per-agent behaviour arrives through events,
 * so hippo activates in any profile that has tools and a model.
 */
export const inject = ['tools', 'systemPrompt', 'llm'];

/** Default provider route for extraction and consolidation. */
const DEFAULT_PROVIDER = 'deepseek-official';

/** Default extraction model — cheap on purpose. */
const DEFAULT_MODEL = 'deepseek-flash';

/** Consolidation timer resolution. */
const TICK_MS = 60_000;

/** How many trailing episodes feed the extraction gate's context window. */
const GATE_CONTEXT = 6;

/** Cap on one stored episode, in characters. */
const MAX_EPISODE_CHARS = 4000;

/** Smallest batch worth a model call. Mirrors consolidate.js. */
const MIN_BATCH = 4;

/** Cap on simultaneously open loops, so the agenda never becomes a backlog. */
const MAX_OPEN_LOOPS = 8;

/**
 * Bigrams that appear in every loop-ish sentence and therefore carry no topic.
 *
 * Without this list, "问问她戒烟进展，别催" and "问问她换工作的事" would be the same
 * loop on the strength of 问问 and 别催 alone.
 */
const LOOP_STOP_TOKENS = new Set([
  '问问', '问一', '一句', '合适', '时候', '别催', '别讲', '讲大', '大道',
  '道理', '后续', '续可', '可以', '进展', '怎么', '样了', '这样', '那样',
  // The English side of the same list. These are the words a *model-written*
  // loop instruction carries ("ask about how the quitting is going, don't nag")
  // and a person's own sentence does not — the function words around them are
  // already dropped by the tokenizer's stop-word set, so this only has to cover
  // the words the instruction adds.
  'ask', 'about', 'progress', 'later', 'could', 'mention', 'worth', 'check',
  'went', 'nag', 'remind', 'follow', 'gently', 'gently.',
]);

/** How long a turn may wait for consolidation before it stops caring. */
const FLUSH_WAIT_MS = 4000;

/** How long shutdown may wait for an in-flight consolidation to land. */
const SHUTDOWN_WAIT_MS = 15_000;

/**
 * Plugin configuration.
 */
export const Config = z.object({
  path: z
    .string()
    .description('SQLite file holding the memory. Defaults to $DSH_HOME/hippo/memory.db.'),
  provider: z
    .string()
    .default(DEFAULT_PROVIDER)
    .description('Provider route used for extraction and consolidation.'),
  model: z
    .string()
    .default(DEFAULT_MODEL)
    .description('Model used for extraction and consolidation.'),
  language: z
    .union(['zh', 'en'])
    .default('zh')
    .description('Language for prompt-facing memory text.'),
  residentBudget: z
    .number()
    .default(1200)
    .description('Token budget for the always-present profile section.'),
  recallBudget: z
    .number()
    .default(1200)
    .description('Token budget for cued recall injected on a turn.'),
  recallOnEveryTurn: z
    .boolean()
    .default(false)
    .description('Recall every turn instead of only when the message asks for it.'),
  extraction: z
    .boolean()
    .default(true)
    .description('Allow model-based fact extraction. Off keeps capture-only mode.'),
  consolidation: z
    .boolean()
    .default(true)
    .description('Allow the background consolidation pass.'),
  idleMs: z
    .number()
    .default(900_000)
    .description('Quiet period before an idle consolidation pass runs.'),
  dailyTokenBudget: z
    .number()
    .default(200_000)
    .description('Model tokens per local day before extraction stops. 0 disables the cap.'),
  ownerIds: z
    .array(z.string())
    .default([])
    .description('Direct-channel account ids that are the owner. Everyone else is a stranger.'),
  personaSeed: z
    .string()
    .default('')
    .description(
      'The persona text to seed the store with, on a fresh database. After the first run the store is the authority and this is ignored, so an edit made in conversation is never overwritten by a restart.'
    ),
});

/**
 * Resolve the default database location without depending on dsh-home-paths.
 * @returns {string} absolute path to the memory database.
 */
function defaultDatabasePath() {
  const home = process.env.DSH_HOME?.trim();
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home;
  return join(root, 'hippo', 'memory.db');
}

/**
 * Activate the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {z.infer<typeof Config>} config - validated configuration.
 * @returns {Promise<void>} resolves once the database is open and hooks are installed.
 */
export async function apply(ctx, config) {
  const configured = typeof config.path === 'string' ? config.path.trim() : '';
  const path = configured === '' ? defaultDatabasePath() : configured;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = await openDatabase(path);
  const owner = readUserId(db);
  ensureRelationship(db, owner);
  const language = config.language ?? 'zh';
  // Which direct-channel accounts are the owner. Empty means "do not enforce",
  // which is the right default for a session on this machine and the wrong one
  // for an account strangers can message; the deployment that is reachable from
  // outside has to say who it belongs to.
  const ownerIds = Array.isArray(config.ownerIds) ? config.ownerIds : [];

  // The owner's durable subject, which is not the same thing as `meta.user_id`.
  //
  // `meta.user_id` was seeded with the literal string `'user'` by an early build
  // and every fact about the person was stored under it, while `ownerIds` named
  // the real account. The two never had to agree — nothing compared them — until
  // her own facts started arriving under `subject: 'agent'` and "is this row about
  // the person or about her" became a question every read path asks.
  //
  // This runs on every start rather than in a migration, and that is the point:
  // `ownerIds` comes from configuration, which is not available while
  // `ensureSchema` runs. A migration that reads its own input before it exists
  // silently does nothing — which is exactly what the first attempt did.
  const alignOwnerSubject = () => {
    const named = String(ownerIds[0] ?? '').trim();
    if (named === '' || named === 'user') return;
    try {
      const recorded = String(db.prepare("SELECT value FROM meta WHERE key = 'owner_account'").get()?.value ?? '').trim();
      db.prepare(`
        INSERT INTO meta (key, value) VALUES ('owner_account', ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `).run(named);
      // The guard is whether any row still carries the literal, not whether the
      // account was recorded. Recording it and rewriting the rows are two separate
      // effects, and the first version skipped the second whenever a previous run
      // had already written the first — which left the store half-migrated: the
      // relationship keyed by the real id and every fact still under `user`.
      const stale = Number(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE subject = 'user'").get().n)
        + Number(db.prepare("SELECT COUNT(*) AS n FROM open_loops WHERE user_id = 'user'").get().n)
        + Number(db.prepare("SELECT COUNT(*) AS n FROM relationship WHERE user_id = 'user'").get().n);
      if (stale === 0) return;
      db.prepare("UPDATE facts SET subject = ? WHERE subject = 'user'").run(named);
      db.prepare("UPDATE open_loops SET user_id = ? WHERE user_id = 'user'").run(named);
      db.prepare("UPDATE relationship SET user_id = ? WHERE user_id = 'user'").run(named);
      db.prepare("UPDATE affect SET user_id = ? WHERE user_id = 'user'").run(named);
      db.prepare("UPDATE pending_recall SET user_id = ? WHERE user_id = 'user'").run(named);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'user_id'").run(named);
      // The index carries the subject, so a relabelled fact would still be found
      // by the old one. Re-indexing the moved rows is cheap; a full rebuild is not.
      const reindex = db.prepare('DELETE FROM facts_fts WHERE fact_id = ?');
      const insert = db.prepare('INSERT INTO facts_fts (body, fact_id) VALUES (?, ?)');
      for (const row of db.prepare('SELECT id, subject, predicate, object FROM facts WHERE subject = ?').all(named)) {
        reindex.run(String(row.id));
        insert.run(segment(`${String(row.subject)} ${String(row.predicate)} ${String(row.object)}`), String(row.id));
      }
      process.emitWarning(`dsh-hippo: relabelled ${stale} row(s) from the literal "user" to the owner account ${named}`);
    } catch (error) {
      // A store that cannot be relabelled still works: reads use the stored
      // subject, and the only cost is that "his facts" and "her facts" are keyed
      // differently from a deployment that started fresh.
      process.emitWarning(`dsh-hippo: could not relabel the owner's facts: ${error?.message ?? error}`);
    }
  };
  alignOwnerSubject();

  /**
   * Whether the agent speaking to this caller is speaking to somebody who is not
   * the owner.
   *
   * One predicate rather than the same two conditions repeated at six tool sites,
   * because they were repeated at six sites and one of them was missed for two
   * releases. A room and a stranger are different audiences but the same answer to
   * every question a tool asks: may this caller retarget the owner's memory. No.
   *
   * @param {unknown} agent - the agent the tool was called from, or undefined.
   * @returns {boolean} true when the caller is not the owner.
   */
  const isOutsider = (agent) => {
    const sessionId = sessionIdOf(agent);
    return channelOf(db, sessionId) === 'group' || audienceOf(sessionId, ownerIds) === 'stranger';
  };

  /** Assistant text accumulated from stream frames, per agent. */
  const drafts = new WeakMap();
  /** Last observed activity, driving the idle consolidation trigger. */
  const clock = { lastActivityAt: Date.now(), lastConsolidatedAt: Date.now() };
  /** In-flight consolidation, so concurrent triggers coalesce instead of racing. */
  let consolidating = null;
  /**
   * What recall showed is parked in the `pending_recall` table, not in a Map.
   *
   * Retrieval alone is grade 2 — "it matched the query" — and that is all the
   * system can know at injection time. Whether the memory was *right* only
   * becomes observable on the next message: the person either restates it
   * (grade 4, the strongest evidence there is) or corrects it (grade 1). Without
   * this, stability was frozen at the retrieval grade forever, so the schedule
   * never learned which memories the pair of them actually rely on.
   *
   * It used to be an in-process Map, which quietly made grading a feature of long
   * web sessions only: the common call shape here is a one-shot process that
   * answers one message and exits, and a Map cannot outlive that.
   */

  /**
   * One model call, assembled from the streaming runtime.
   *
   * `LlmRuntime` exposes only `stream()`, so text blocks are collected here.
   * Usage is estimated from character counts: exact counts arrive on
   * finish frames whose shape is adapter-specific, and an estimate is adequate
   * for a budget enforced at 200K tokens per day.
   *
   * @param {string} system - system prompt for the call.
   * @param {string} prompt - user prompt for the call.
   * @param {{ maxTokens?: number, signal?: AbortSignal }} [options] - call controls.
   * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>} model output.
   */
  async function callModel(system, prompt, options = {}) {
    let text = '';
    const stream = ctx.llm.stream({
      provider: config.provider ?? DEFAULT_PROVIDER,
      model: config.model ?? DEFAULT_MODEL,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: options.maxTokens ?? 700,
      signal: options.signal,
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text;
    }
    return {
      text,
      usage: {
        inputTokens: estimateTokens(system) + estimateTokens(prompt),
        outputTokens: estimateTokens(text),
      },
    };
  }

  /**
   * Budget gate shared by every model call this plugin makes.
   * @param {number} tokens - tokens the call is expected to consume.
   * @returns {boolean} whether the call is allowed.
   */
  function allowed(tokens) {
    const cap = config.dailyTokenBudget ?? 0;
    if (cap <= 0) return true;
    return spentToday(db) + tokens <= cap;
  }

  /**
   * Run one consolidation pass under the budget gate.
   * @param {{ force?: boolean }} [options] - pass controls.
   * @returns {Promise<Record<string, unknown> | null>} the pass report, or null when skipped.
   */
  async function runConsolidation(options = {}) {
    if (config.extraction === false) return null;
    if (!allowed(3000)) return null;
    const report = await consolidate(
      {
        db,
        llm: {
          complete: (request) =>
            callModel(request.system, request.prompt, {
              maxTokens: request.maxTokens,
              signal: request.signal,
            }),
        },
        charge: (tokens) => chargeBudget(db, tokens),
        language,
        ownerIds,
      },
      { force: options.force === true },
    );
    clock.lastConsolidatedAt = Date.now();
    return report;
  }

  // ---- Layer 3: the always-present profile ------------------------------
  //
  // A prompt section rather than a context line, so it sits above the
  // conversation and survives compaction. `interpolate: false` because memory
  // text is arbitrary human language and must never be read as a template.
  //
  // The channel is read here rather than stashed by a pre-step handler, because
  // assembly happens before `agent/pre-step` runs: on the first turn in a room
  // nothing has been captured yet, so the store cannot answer and the session id
  // has to. See `channelOf`.
  //


  ctx.systemPrompt.section({
    name: 'hippo:resident',
    order: 900,
    interpolate: false,
    text: (scope) => {
      const sessionId = sessionIdOf(scope?.agent);
      return renderResident(db, {
        userId: owner,
        sessionId,
        channel: channelOf(db, sessionId),
        audience: audienceOf(sessionId, ownerIds),
        language,
        maxTokens: config.residentBudget ?? 1200,
      });
    },
  });

  // ---- her persona, swapped in at assembly --------------------------------
  //
  // The persona text lives in the store, but the section that carries it is
  // registered by the deployment's own persona plugin — and that registration is
  // global, so a second global section under the same name is rejected outright:
  //
  //   prompt section "deployment:persona-prefix" is already registered
  //   (for a per-agent override, register through that agent's `agent.ctx` instead)
  //
  // The error names the right shape but not the reachable one: `payload.agent.ctx`
  // is only available inside a per-agent callback, and this plugin registers its
  // sections once at mount.
  //
  // So it does not register a section at all. `system-prompt/assemble` is a
  // waterfall over the finished assembly, which is the one place a plugin can edit
  // what the persona plugin already put there. The text is read at assembly time
  // rather than captured at mount, so her rewrite takes effect on the next turn
  // instead of the next restart — which is the difference between "she can change
  // it" and "she can file a change request".
  //
  // Seeded before the hook is installed, and only when the table is empty. A fresh
  // database has no persona until something puts one there, and "something" is either
  // this seed or nobody: `personaSeed` in the config carries the initial text, and a
  // deployment that has already edited it in conversation must not have that edit
  // overwritten by a restart.
  if (seedPersonaBase(db, config.personaSeed ?? '')) {
    process.emitWarning('dsh-hippo: persona seeded from the profile into the store');
  }
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const built = await next();
    const stored = readPersonaBase(db);
    if (stored === '') return built;
    const sections = Array.isArray(built?.sections) ? built.sections : [];
    let found = false;
    const replaced = sections.map((section) => {
      if (section?.name !== PERSONA_PREFIX_SECTION) return section;
      found = true;
      return { ...section, text: stored };
    });
    // A deployment with no persona plugin at all is the case this creates rather
    // than fixes: nothing registered the slot, so nothing would render her text.
    if (!found) replaced.unshift({ name: PERSONA_PREFIX_SECTION, text: stored, interpolate: false });
    return { ...built, sections: replaced };
  });

  // ---- Layer 2: capture and cued recall --------------------------------
  //
  // `agent/pre-step` is a waterfall, so it runs before each model request with
  // the turn's user messages in hand — the one place where both "what was just
  // said" and "what the model is about to see" are available together.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || payload.signal?.aborted === true) return decision;
    clock.lastActivityAt = Date.now();

    const sessionId = sessionIdOf(payload.agent);
    const channel = channelOf(db, sessionId);
    const audience = audienceOf(sessionId, ownerIds);
    // Anything that is not the owner gets the same treatment: no profile of the
    // owner, no recall that could reach it, no agenda. A room and a stranger
    // differ in who is listening, not in what they are entitled to.
    const outsider = channel === 'group' || audience === 'stranger';
    let cue = '';
    for (const message of payload.messages) {
      const text = textOf(message).trim();
      if (text === '') continue;
      // Recall injections are our own text coming back; they are not the person.
      if (message.source?.form === 'recall') continue;
      // Neither is the agenda block.
      if (message.source?.form === 'instructions') continue;
      cue += `${text}\n`;
      captureMessage(sessionId, message, text);
    }
    cue = cue.trim();
    if (cue === '') return decision;

    // The agenda is for the person the agent belongs to, and only for them.
    //
    // "绘本稿交了没问一句" is a helpful thing to raise in a direct conversation
    // and a disclosure in a room. Rendering it into a group would leak the same
    // content the resident block used to leak, one turn later and in a different
    // paragraph. A stranger's direct chat is the same case with a smaller
    // audience.
    const agenda = outsider
      ? ''
      : renderAgenda(db, { userId: owner, language, now: Date.now() });

    const wantsRecall = config.recallOnEveryTurn === true || asksForRecall(cue);
    // Recall follows the same rule as the profile: a group may reach what was
    // said in *that* group, and nothing that belongs to the owner's private life.
    // The filter is by session, not by subject, because the episodes in this room
    // are the room's own record of itself. A stranger's session gets the same
    // scope for the same reason: their conversation is the only one they were
    // present for.
    const recalled = wantsRecall
      ? recall(db, {
        cue,
        userId: owner,
        limit: 10,
        includeEpisodes: true,
        includeFacts: !outsider,
        fallback: true,
        sessionId: outsider ? sessionId : undefined,
      })
      : { episodes: [], facts: [], terms: 0 };
    const hasRecall = recalled.episodes.length > 0 || recalled.facts.length > 0;
    const block = hasRecall
      ? renderRecall(recalled, { language, maxTokens: config.recallBudget ?? 1200 })
      : '';
    // Render first, then grade: only what survived the budget reached the model.
    if (block !== '') reinforceRecalled(recalled, block);
    if (block === '' && agenda === '') return decision;

    const injected = [];
    if (block !== '') {
      injected.push(createUserMessage({
        content: [{ type: 'text', text: block }],
        source: { kind: 'user', form: 'recall' },
      }));
    }
    if (agenda !== '') {
      injected.push(createUserMessage({
        content: [{ type: 'text', text: agenda }],
        source: { kind: 'user', form: 'instructions' },
      }));
    }

    // Appended after the accepted batch, matching how the harness's own
    // context plugins contribute. `form: 'recall'` and `form: 'instructions'`
    // keep the transcript honest about what the person actually typed, and stop
    // the capture pass from storing our own text back as an episode.
    //
    // Built through `createUserMessage` rather than as an object literal because
    // the session log validates every message it stores and refuses one without
    // an id: a hand-built message made the *whole session* unreadable the first
    // time the memory had anything to inject, which surfaced turns later as
    // `stored session "..." is corrupt: event at seq N lacks an identified
    // message` on resume.
    return { ...decision, messages: [...decision.messages, ...injected] };
  });

  // Assistant text is only visible as stream frames; assemble it per agent and
  // flush at turn end so the episode log holds both sides of the conversation.
  ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload?.frame;
    if (frame?.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (chunk?.type !== 'text-delta') return;
    drafts.set(payload.agent, `${drafts.get(payload.agent) ?? ''}${chunk.text}`);
  });

  ctx.on('agent/turn-stopping', async (payload) => {
    const text = (drafts.get(payload.agent) ?? '').trim();
    drafts.delete(payload.agent);
    // A bare `SILENT` is a control token, not something she said.
    //
    // Two of this deployment's plugins (`dsh-proactive`, `dsh-heartbeat`) ask the
    // model to answer `SILENT` when it would rather not speak, and the bridge and
    // the heartbeat both swallow it before it reaches anyone. Recording it here
    // would put a line in memory that nobody ever heard, and worse, it would be
    // filed as `actor: 'agent'` — "this is what she told somebody" — for a turn in
    // which she told nobody anything. A week of that is a memory full of the word
    // SILENT and a set of facts extracted from it.
    //
    // Matched as the whole line, like every other reader of this protocol: a
    // sentence that happens to contain the word is still a sentence and still
    // worth remembering.
    if (text !== '' && !/^[\s"'“”「」『』`*]*SILENT[\s"'“”」』`*。.!！]*$/u.test(text)) {
      const sessionId = sessionIdOf(payload.agent);
      recordEpisode(db, {
        sessionId,
        actor: 'agent',
        text: text.slice(0, MAX_EPISODE_CHARS),
        source: 'turn',
        // The agent's own line in a room is still an event in that room. Without
        // this the reply is the one row of the conversation filed as if it
        // happened nowhere, and on a fresh session it is the only row there is —
        // so `channelOf` cannot see the room it is standing in until a visitor
        // speaks again.
        channel: channelOf(db, sessionId),
      });
    }
    clock.lastActivityAt = Date.now();

    // Flush here rather than only on a timer. A headless or one-shot session
    // exits the process as soon as the turn ends, so anything deferred to the
    // idle timer or to disposal is lost; the turn boundary is the last moment
    // that is both reliable and still inside the conversation.
    if (config.consolidation === false) return;
    if (unconsolidatedEpisodes(db, MIN_BATCH).length < MIN_BATCH) return;
    if (consolidating !== null) return;
    consolidating = runConsolidation({})
      .catch((error) => {
        // A failed pass must not take the turn with it, but it must not vanish
        // either: silently losing consolidation is indistinguishable from an
        // empty log, and the next turn would retry the same failure forever.
        process.emitWarning(`dsh-hippo: consolidation failed: ${error?.message ?? error}`);
      })
      .finally(() => {
        consolidating = null;
      });
    // Bound the wait: a slow model must not hold the reply hostage. Whatever
    // does not finish in time keeps running and the rows stay unconsolidated,
    // so the next turn retries rather than losing the material.
    await Promise.race([consolidating, new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS).unref?.())]);
  });

  /**
   * Find the conversation turn a tool call is answering.
   *
   * `memory_remember` is invoked mid-turn, after the person said whatever they
   * said. The turn has already been captured as an episode by then, so the most
   * recent user episode in this session is the right provenance — not a new
   * synthetic record, and not the agent's own reply.
   *
   * @param {{ session?: { header?: { id?: unknown } } } | undefined} agent - the calling agent.
   * @returns {string[]} zero or one episode id.
   */
  function evidenceForAgent(agent) {
    const sessionId = sessionIdOf(agent);
    if (sessionId === '') return [];
    const row = db.prepare(`
      SELECT id, channel, speaker_id, speaker_name FROM episodes
      WHERE session_id = ? AND actor = 'user'
      ORDER BY at DESC, rowid DESC LIMIT 1
    `).get(sessionId);
    return row === undefined ? [] : [row];
  }

  /**
   * Record one user message as an episode, deduplicated by message id.
   *
   * Deduplication matters because a resumed or replayed turn re-delivers the
   * same message: without it the log inflates and every activation score is
   * computed against duplicated evidence.
   *
   * @param {string} sessionId - owning session.
   * @param {{ id?: unknown }} message - the delivered message.
   * @param {string} text - its flattened text.
   */
  function captureMessage(sessionId, message, text) {
    const messageId = message.id === undefined || message.id === null ? '' : String(message.id);
    if (messageId !== '' && hasEpisodeForMessage(db, sessionId, messageId)) return;

    // Grade the block that was injected last turn against this message, before
    // anything else touches the store: this is the only moment where "what they
    // just said" and "what they were reacting to" are both available.
    gradeAgainstReply(text);

    // Detect the charge before storing, not after: arousal is a property of the
    // episode, and an episode written without it can never be ranked on it.
    // Reading the emotion later from the `affect` table does not work — that
    // table is a timeline of mood, not a label on any one message.
    const affect = detectAffect(text);

    const id = recordEpisode(db, {
      sessionId,
      actor: 'user',
      text: text.slice(0, MAX_EPISODE_CHARS),
      messageId: messageId === '' ? undefined : messageId,
      source: 'turn',
      arousal: affect === null ? 0 : affect.arousal,
      ...speakerOf(message),
    });
    if (id === '') return;

    if (affect !== null) {
      recordAffect(db, { userId: owner, valence: affect.valence, arousal: affect.arousal });
    }
    // Relationship state is cheap to recompute (two aggregate queries) and it
    // depends on observations that arrive every turn, so it must not wait for a
    // consolidation pass. Tying it to consolidation meant mood_baseline stayed
    // at its initial 0 for hours, because a four-episode batch is a rare event.
    recomputeRelationship(db, owner);

    // Trust moves only on statements about the relationship itself, never on how
    // much has been said.
    const trustSignal = detectTrustSignal(text);
    if (trustSignal !== null) adjustTrust(db, owner, trustSignal.delta);

    // Unfinished business is tracked inline, not at consolidation time: a loop
    // is only meaningful while it is fresh, and waiting for a four-episode batch
    // meant the smoking was never followed up on until the next day.
    trackLoops(text);

    // "忘掉刚才那句" has to act immediately. Routing it through the model's
    // discretion means the one instruction a memory system must always honour is
    // the one it can decline.
    if (asksToForget(text)) {
      const result = redactRecent(db, { sessionId, count: forgetCount(text), reason: 'requested' });
      if (result.redacted > 0) {
        process.emitWarning(
          `dsh-hippo: forgot ${result.redacted} episode(s) on request` +
          (result.factsRetired > 0 ? `, retiring ${result.factsRetired} fact(s)` : '') +
          (result.reflectionsInvalidated > 0 ? `, invalidating ${result.reflectionsInvalidated} summary(ies) that quoted it` : ''),
        );
      }
    }

    const recent = recentEpisodes(db, { limit: GATE_CONTEXT })
      .filter((row) => String(row.actor) === 'user')
      .map((row) => String(row.text));
    const gate = shouldExtract(text, {
      recentUserText: recent.filter((line) => line !== text),
      unansweredTokens: 0,
    });
    // Two cases are worth extracting inline rather than waiting for a batch.
    //
    // An explicit "记住这个" is obvious. The second one is a correction, and it
    // is the more urgent of the two: a wrong fact does not just sit in the
    // database, it sits in the resident prompt and gets asserted confidently
    // until something replaces it. Waiting for a four-episode batch means the
    // agent keeps telling the person something they just told it was wrong.
    if (gate.explicit === true || gate.correction === true) {
      void runConsolidation({ force: true }).catch(() => {});
    }
  }

  /**
   * Keep the open-loop list current from what the person just said.
   *
   * Two directions matter equally, and only wiring one is a common mistake:
   * opening loops without ever closing them turns the agenda into a museum of
   * old worries, and the model learns to ignore a block that never changes.
   *
   * Closing is conservative: it needs an explicit resolution phrase *and* a
   * shared content word, so "我还没戒掉烟" does not close the smoking loop.
   *
   * @param {string} text - one user message.
   */
  function trackLoops(text) {
    const live = openLoops(db, owner, 20);
    for (const loop of live) {
      if (!loopResolvedBy(String(loop.text), text)) continue;
      closeOpenLoop(db, String(loop.id), 'resolution');
    }

    const detected = detectLoop(text);
    if (detected === null) return;

    // Resolve any date the sentence named, once, while "now" still means the
    // moment they said it. "下周三复查" read through a fixed delay asks that
    // evening — the one moment the answer is guaranteed to be "not yet" — and
    // the words themselves stop meaning that Wednesday within a week.
    const when = parseRelativeDate(detected.text, Date.now());
    const followAfter = when === null
      ? Date.now() + detected.followAfter
      : Date.now() + followUpAfter(when.at, Date.now(), detected.followAfter);

    // Do not stack duplicates: "我在戒烟" repeated across five turns is one loop.
    //
    // A repeat is not always an exact repeat, though, and this used to return
    // early on `overlap` alone. Loops written before dates were parsed carry no
    // `due_at`, so the second time the person mentioned that appointment the
    // duplicate check threw away the only copy of the sentence that could still
    // be resolved. Filling the date into the surviving row costs nothing and is
    // the difference between knowing when it is and not knowing at all.
    //
    // `overlap` is deliberately loose — two sentences about a deadline can share
    // "没底" and little else — so the first match is not necessarily the one this
    // sentence is about. Preferring a candidate that is actually missing a date
    // stops a dated loop about a different appointment from absorbing this one.
    const duplicates = live.filter((loop) => overlap(String(loop.text), detected.text));
    if (duplicates.length > 0) {
      const target = duplicates.find((loop) => loop.due_at === null || loop.due_at === undefined) ?? duplicates[0];
      if (when !== null && (target.due_at === null || target.due_at === undefined)) {
        setLoopDue(db, String(target.id), { followAfter, dueAt: when.at, duePhrase: when.phrase });
      }
      return;
    }
    if (live.length >= MAX_OPEN_LOOPS) return;

    addOpenLoop(db, {
      userId: owner,
      text: detected.text,
      followAfter,
      dueAt: when === null ? null : when.at,
      duePhrase: when === null ? '' : when.phrase,
    });
  }

  /**
   * How many recent episodes a forget request covers.
   *
   * "忘掉刚才那句" is one, "忘掉刚才我们说的" is the last few. Anything vaguer than
   * that is not a precise instruction and should not wipe a conversation, so the
   * range is deliberately tiny.
   *
   * @param {string} text - the person's message.
   * @returns {number} how many trailing episodes to redact.
   */
  function forgetCount(text) {
    const source = String(text ?? '');
    if (/(刚才|刚刚|上一句|最后一句|那句话)/.test(source)) return 1;
    if (/(前面|之前|那段|刚才我们|刚才聊)/.test(source)) return 3;
    return 2;
  }

  /**
   * Whether two loop texts are about the same thing.
   *
   * Loops reach this table from two directions — the pattern detector quotes the
   * person's own sentence, and `memory_loop` receives an instruction like
   * "问问她戒烟进展，别催" — so the same open thread can be phrased twice with
   * almost no shared surface. Comparing content bigrams and requiring two of
   * them is what keeps "我在戒烟" and "戒烟进展如何" together while keeping
   * "戒烟" and "换工作" apart.
   *
   * @param {string} left - stored loop text.
   * @param {string} right - candidate loop text.
   * @returns {boolean} true when they overlap enough to be the same loop.
   */
  function overlap(left, right) {
    const a = String(left ?? '');
    const b = String(right ?? '');
    if (a === '' || b === '') return false;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length <= b.length ? b : a;
    if (longer.includes(shorter)) return true;
    const rightTokens = new Set(tokenize(b).filter((token) => token.length >= 2));
    const shared = tokenize(a)
      .filter((token) => token.length >= 2)
      .filter((token) => !LOOP_STOP_TOKENS.has(token))
      .filter((token) => rightTokens.has(token));
    return shared.length >= 2;
  }

  /**
   * Record that memories were retrieved, and let them get stronger for it.
   *
   * Retrieval is the only evidence the system has that something still matters.
   * Logging the exposure feeds ACT-R activation, and applying an FSRS grade
   * raises stability — a fact recalled ten times over three months should be
   * harder to forget than one stored on day one and never touched.
   *
   * The grade depends on whether the rendered block actually mentions the memory:
   * a row that scored high but got trimmed for budget was never seen, so grading
   * it inflates stability on evidence that does not exist. `visible` is the text
   * that was really shown, or null when the caller knows every row appeared
   * (the tool path renders all of them).
   *
   * @param {{ facts: Array<Record<string, unknown>>, episodes: Array<Record<string, unknown>> }} recalled
   *   - the recall result, whose rows carry their own `kind`.
   * @param {string | null} [visible] - the rendered block, or null if all rows appeared.
   */
  function reinforceRecalled(recalled, visible = null) {
    const now = Date.now();
    const shown = [];
    for (const row of [...recalled.facts, ...recalled.episodes]) {
      const kind = String(row.kind ?? 'fact');
      const id = String(row.id);
      if (id === '') continue;
      const needle = String(row.object ?? row.text ?? '').slice(0, 60);
      if (visible !== null && needle !== '' && !visible.includes(needle)) continue;
      shown.push({ id, kind: kind === 'episode' ? 'episode' : 'fact', needle });
      try {
        recordReview(db, id, kind === 'episode' ? 'episode' : 'fact', now);
        // Grade 2 rather than 3: being retrieved once is weak evidence, and
        // treating every match as a confident recall inflates stability until
        // nothing ever fades again.
        gradeMemory(db, id, kind === 'episode' ? 'episode' : 'fact', 2, now);
      } catch {
        // A duplicate review timestamp is harmless, and a memory that vanished
        // mid-recall must not take the turn down with it.
      }
    }
    if (shown.length > 0) savePendingRecall(db, owner, shown, now);
  }

  /**
   * Judge the memories shown last turn against what the person just said.
   *
   * Two outcomes are observable, and they pull in opposite directions:
   *
   *   - They restated or confirmed what the block said. That is grade 4, the
   *     strongest evidence a companion ever gets that a memory is load-bearing,
   *     and the only route by which a memory becomes genuinely hard to forget.
   *   - They corrected it ("不是杭州，是苏州"). That is grade 1: the row answered
   *     a query and was wrong, which is exactly what stability should punish.
   *
   * Everything else stays at the retrieval grade. Inferring "it was probably
   * useful" from silence is how a memory system convinces itself that every
   * match was valuable.
   *
   * @param {string} sessionId - owning session.
   * @param {string} text - the person's new message.
   */
  function gradeAgainstReply(text) {
    // Taking the block consumes it, so a second message in the same turn cannot
    // grade the same rows twice. Expiry is applied while reading rather than on a
    // timer — a one-shot process has no timer to run.
    const rows = takePendingRecall(db, owner);
    if (rows.length === 0) return;
    const correction = detectCorrectionIn(text);
    const normalized = String(text).toLowerCase();
    const at = Date.now();
    for (const row of rows) {
      const needle = row.needle.toLowerCase().trim();
      if (needle.length < 2) continue;
      // Restating needs the value in their own words; a correction is attributed
      // to the row that was on screen, because that is what they were answering.
      const restated = normalized.includes(needle.slice(0, 24));
      if (!restated && !correction) continue;
      try {
        gradeMemory(db, row.id, row.kind, correction ? 1 : 4, at);
      } catch {
        // The row may have been retired between the render and this turn.
      }
    }
  }

  // ---- Consolidation triggers ------------------------------------------
  const tick = () => {
    if (config.consolidation === false) return;
    // Stale contradictions must be retired even when consolidation is backed off;
    // leaving two values live forever is worse than resolving one arbitrarily.
    try {
      expireClarifications(db);
    } catch {
      // A clock hiccup is not worth a warning every minute.
    }
    if (
      !shouldConsolidateOnIdle({
        lastActivityAt: clock.lastActivityAt,
        lastConsolidatedAt: clock.lastConsolidatedAt,
        now: Date.now(),
        idleMs: config.idleMs ?? 900_000,
      })
    ) {
      // Nothing new to consolidate, but memory still ages. Demotion is what makes
      // forgetting real: without it every fact ever stored keeps its confidence
      // and the resident section slowly fills with trivia from week one.
      try {
        demoteWeakFacts(db, owner, Date.now());
      } catch {
        // Demotion is best-effort; a failure must not stop the next retry.
      }
      return;
    }
    void runConsolidation({}).catch(() => {});
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref();

  // Flush pending material when an agent goes away: the process may not live
  // long enough for the idle timer to fire.
  ctx.on('agent/disposed', () => {
    clock.lastActivityAt = Date.now() - (config.idleMs ?? 900_000);
    tick();
  });

  // ---- The operator surface ---------------------------------------------
  //
  // Everything the model can do to a memory it can do through a tool. Export and
  // import are not in that category: they write and read whole files, and every
  // tool is reachable by anyone who can talk the agent into calling it. So they
  // live on the command surface, which only the person at the keyboard has.
  //
  // Registered only when this profile really has a command registry. A headless
  // run has no input box, and a plugin that refuses to activate because one UI
  // service is missing takes the whole memory system down with it.
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'memory',
      description: 'Inspect the memory, or export and import it: /memory [status|dump|import|inspect] <file>',
      input: { hint: '[status|dump <file>|import <file>|inspect <file>]' },
      handler: (invocation) =>
        runMemoryCommand(db, invocation, {
          language,
          isOutsider: (agent) => isOutsider(agent),
        }),
    });
  }

  // ---- Tools -----------------------------------------------------------
  //
  // A companion agent almost never reaches for a memory tool on its own, so
  // the surface stays small: one way in, one way out, and a window into what
  // the plugin currently believes.
  ctx.tools.register(
    defineTool({
      name: 'memory_recall',
      description:
        'Search long-term memory for what is known about the person or a topic. Use when the conversation touches something you may have been told before and you are not sure.',
      parameters: {
        query: { type: 'string', required: true, description: "What to search for, in the person's own words." },
        limit: { type: 'number', description: 'Maximum results. Defaults to 8.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            facts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  confidence: { type: 'number' },
                },
              },
            },
            episodes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  when: { type: 'string' },
                  who: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const lines = [];
          for (const fact of value.facts) lines.push(`- [${shortId(fact.id)}] ${fact.text} (${fact.confidence.toFixed(2)})`);
          for (const episode of value.episodes) lines.push(`- [${shortId(episode.id)}] ${episode.when} ${episode.who}: ${episode.text}`);
          return [{ type: 'text', text: lines.length === 0 ? 'nothing found' : lines.join('\n') }];
        },
      },
      async execute(args, run) {
        const limit = Math.min(30, Math.max(1, Number(args.limit ?? 8)));
        // The tool is scoped to the conversation it was called from. A model in a
        // group that searches for "晚晚" must not be handed the owner's private
        // history just because it asked politely — the file drawer is the same
        // one, and the room is still the room. `run?.agent` is set by the agent
        // loop; when it is missing (a bare unit-test call) the search stays
        // unscoped rather than silently returning nothing.
        const sessionId = sessionIdOf(run?.agent);
        const channel = channelOf(db, sessionId);
        const outsider = channel === 'group' || audienceOf(sessionId, ownerIds) === 'stranger';
        const recalled = recall(db, {
          cue: String(args.query),
          userId: owner,
          limit,
          includeEpisodes: true,
          includeFacts: !outsider,
          sessionId: outsider ? sessionId : undefined,
        });
        reinforceRecalled(recalled);
        return {
          facts: recalled.facts.map((fact) => ({
            id: String(fact.id),
            text: `${String(fact.subject)} ${String(fact.predicate)} ${String(fact.object)}`,
            confidence: Number(fact.confidence ?? 0),
          })),
          episodes: recalled.episodes.map((episode) => ({
            id: String(episode.id),
            when: new Date(Number(episode.at)).toISOString().slice(0, 16).replace('T', ' '),
            who: String(episode.actor),
            text: String(episode.text).slice(0, 300),
          })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_remember',
      description:
        'Store something worth keeping about the person: a preference, a fact about their life, a commitment, a date. Use only for things that will still matter in a week.',
      parameters: {
        subject: { type: 'string', required: true, description: 'Who it is about: "user" or another name.' },
        predicate: {
          type: 'string',
          required: true,
          enum: PREDICATE_VOCABULARY,
          description:
            'Which attribute this is. Pick the closest one; do not invent a key, and when correcting an earlier statement reuse the same one.',
        },
        object: { type: 'string', required: true, description: 'What is remembered, as a noun phrase.' },
        confidence: { type: 'number', description: 'How sure you are, 0 to 1. Defaults to 0.8.' },
        sensitivity: {
          type: 'string',
          enum: ['public', 'personal', 'sensitive'],
          description: 'How carefully this should be handled. Defaults to personal.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stored: { type: 'boolean' },
            id: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.stored ? 'stored' : (value.reason === undefined || value.reason === '' ? 'already known' : value.reason),
        }],
      },
      async execute(args, exec) {
        // Anchor the fact to the sentence that prompted it. Without this the
        // explicit path produces facts with no provenance at all: the store can
        // say "works as an illustrator" but not when it was said or by whom,
        // and nothing supports walking from the fact back to the conversation.
        //
        // The row is kept whole rather than reduced to an id because the subject
        // decision below needs to know where the sentence was said and by whom;
        // `evidence` is the id list every store function expects.
        const anchor = evidenceForAgent(exec?.agent);
        const evidence = anchor.map((row) => String(row.id));

        // Both write paths route through the same resolver now. This one used to
        // ask a weaker question — "was the sentence said in a room" — and the
        // difference was a stranger's private message: a room was excluded, a
        // direct chat was not, and a direct chat with an unknown account is not
        // the owner either. `resolveSpeakerSubject` asks the real question, so
        // there is one rule for both paths instead of two that agree by accident.
        //
        // The model writes "林晚" for the owner about as often as it writes
        // "user", and a row filed under a person's own name is invisible to every
        // read path that filters by owner — stored, indexed, and never seen again.
        const subject = resolveSpeakerSubject(
          String(args.subject), anchor, owner, ownerAliases(db, owner), ownerIds,
        );
        const predicate = canonicalize(String(args.predicate));
        if (predicate === null) {
          return { stored: false, id: '', reason: 'predicate is not a usable attribute key' };
        }
        const object = String(args.object).trim();
        if (object === '') return { stored: false, id: '', reason: 'nothing to remember' };

        // Route through the same decision the extractor uses. A fact typed in by
        // the model and a fact inferred from a message have to collide, or the
        // store drifts into two parallel belief sets that never reconcile.
        //
        // One deliberate asymmetry: this path retires the old value without
        // flagging the new one for clarification. Consolidation extracts a guess
        // from a sentence and must ask when two guesses collide; a tool call is
        // the model deciding to record something it already understood from the
        // conversation, so asking it back would be noise.
        const candidate = {
          subject,
          predicate,
          object,
          confidence: Number(args.confidence ?? 0.8),
          sensitivity: String(args.sensitivity ?? 'personal'),
          evidence,
        };
        const existing = liveFacts(db, { subject, limit: 500 }).filter(
          (fact) => String(fact.predicate) === predicate,
        );
        const decision = decide(existing, candidate);

        if (decision.action === 'noop') return { stored: false, id: String(decision.factId ?? '') };
        if (decision.action === 'update') {
          reinforceFact(db, String(decision.factId), { object, evidence, confidenceDelta: 0.12 });
          return { stored: true, id: String(decision.factId) };
        }
        if (decision.action === 'invalidate') {
          // A model-written contradiction goes into the same clarification queue
          // as an extracted one. Retiring the old value silently was the bug that
          // made `memory_clarify` unfirable from this path: the queue only ever
          // filled from consolidation, so a model that noticed a conflict and
          // wrote the new value down had no way to flag it for confirmation.
          const id = addFact(db, {
            ...candidate,
            source: 'explicit',
            pinned: true,
            needsClarification: true,
          });
          invalidateFact(db, String(decision.factId), { supersededBy: id });
          return { stored: true, id };
        }
        const id = addFact(db, { ...candidate, source: 'explicit', pinned: true });
        return { stored: true, id };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_forget',
      description:
        'Retire a memory that is wrong or that the person asked you to drop. Pass the id memory_recall printed: a fact id retires that belief, an episode id forgets that remark — text, index, supporting facts and any summary that quoted it.',
      parameters: {
        id: { type: 'string', required: true, description: 'Fact or episode id from memory_recall.' },
        reason: { type: 'string', description: 'Why it should be retired.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { retired: { type: 'boolean' }, kind: { type: 'string' } },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.retired ? `forgot ${value.kind}` : 'no such memory (only live facts and un-forgotten episodes can be retired)',
        }],
      },
      async execute(args, exec) {
        // Every live fact, not just the owner's. The first version searched
        // `liveFacts(db, { subject: owner })`, so a fact about someone else --
        // 妈妈/works_at, printed by memory_recall and by memory_state -- was
        // listed with an id and then rejected by this tool as "no such memory".
        // A real agent hit exactly that: it wanted to move a mis-attributed fact
        // off 妈妈, called recall, read the id, and could not retire it. The read
        // side never scoped to the owner; only this write side did.
        //
        // In a room the reach is narrower, and by a different rule: a visitor can
        // talk the agent into calling any tool it has, so "forget that" said in a
        // group must not be able to retire the owner's beliefs. A fact is still
        // forgettable there when every sentence supporting it was said in this
        // room — that is the visitor's own record, and they may take it back. An
        // episode is forgettable when it belongs to this room. Everything else
        // reads as "no such memory", which is also what the caller deserves to be
        // told: from inside the room, it does not exist.
        // A stranger who can direct-message the bot is in the same position: they
        // can talk the agent into calling any tool it has, and "forget that" from
        // somebody the store has never heard of must not retire the owner's
        // beliefs either. The rule is the same for both — you may take back what
        // was said in front of you, and nothing else.
        const forgetAgentSession = sessionIdOf(exec?.agent);
        const forgetChannel = channelOf(db, forgetAgentSession);
        const inRoom = forgetChannel === 'group';
        const outsider = inRoom || audienceOf(forgetAgentSession, ownerIds) === 'stranger';
        const here = (episodeId) => db.prepare('SELECT session_id FROM episodes WHERE id = ?').get(episodeId)?.session_id === forgetAgentSession;
        const supportedHere = (factId) => {
          const links = db.prepare('SELECT episode_id FROM evidence WHERE fact_id = ?').all(factId);
          return links.length > 0 && links.every((link) => here(String(link.episode_id)));
        };

        const fact = resolveId(liveFacts(db, { limit: 500 }), args.id);
        if (fact !== null && (!outsider || supportedHere(String(fact.id)))) {
          invalidateFact(db, String(fact.id), { reason: String(args.reason ?? 'forgotten') });
          return { retired: true, kind: 'fact' };
        }
        // An episode id means the person pointed at a remark, not at a belief.
        // Redacting it is the stronger operation: the text, its index entry and
        // every summary that quoted it go too.
        const episodes = recentEpisodes(db, { limit: 500 }).filter((row) => row.redacted_at === null || row.redacted_at === undefined);
        const episode = resolveId(episodes, args.id);
        if (episode !== null && (!outsider || here(String(episode.id)))) {
          redactEpisode(db, String(episode.id), { reason: String(args.reason ?? 'forgotten') });
          return { retired: true, kind: 'episode' };
        }
        return { retired: false, kind: '' };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_open_loops',
      description:
        'List what is left hanging: promises made, questions asked but unanswered, topics the person said they would come back to.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loops: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
        render: (args, value) =>
          value.loops.length === 0
            ? [{ type: 'text', text: 'nothing open' }]
            : [{ type: 'text', text: value.loops.map((loop) => `- [${shortId(loop.id)}] ${loop.text}`).join('\n') }],
      },
      async execute(_args, run) {
        // Open loops are the owner's unfinished business — "问问她绘本稿交了没"
        // is a considerate thing to remember in private and a disclosure in a
        // room. The list is empty there rather than filtered by wording, because
        // every loop is about the owner by construction: `memory_loop open` and
        // the detector both write into the owner's relationship.
        const loopSession = sessionIdOf(run?.agent);
        const outsider = channelOf(db, loopSession) === 'group'
          || audienceOf(loopSession, ownerIds) === 'stranger';
        return {
          loops: outsider
            ? []
            : openLoops(db, owner, 8).map((loop) => ({ id: String(loop.id), text: String(loop.text) })),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_loop',
      description: 'Open or close a hanging thread in the relationship.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['open', 'close'],
          description: 'Whether to open or close.',
        },
        text: { type: 'string', description: 'What is hanging. Required when opening.' },
        id: { type: 'string', description: 'Loop id from memory_open_loops. Required when closing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.ok ? `ok [${shortId(value.id)}]` : 'no open loop with that id',
        }],
      },
      async execute(args, exec) {
        // Loops are the owner's unfinished business, and `memory_open_loops`
        // already returns nothing in a room, as does the agenda block that would
        // otherwise surface them. Writing one there would be a row nobody can
        // read: the visitor's "remind me Thursday" filed under the owner, shown
        // to no one, counted in every later reminder, and impossible to close
        // because the id was never printed to whoever could close it. Refusing is
        // the only outcome that is not a quiet leak in both directions.
        if (isOutsider(exec?.agent)) return { ok: false, id: '' };
        if (String(args.action) === 'open') {
          const text = String(args.text ?? '').trim();
          if (text === '') return { ok: false, id: '' };
          const id = addOpenLoop(db, { userId: owner, text });
          return { ok: true, id };
        }
        // Looked up among the *open* loops: a stale id must not close something
        // that was already settled, and an id printed by memory_open_loops is a
        // prefix of the stored uuid rather than the whole thing.
        const loop = resolveId(openLoops(db, owner, 100), args.id);
        if (loop === null) return { ok: false, id: '' };
        closeOpenLoop(db, String(loop.id));
        return { ok: true, id: String(loop.id) };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_state',
      description:
        'Inspect what the memory currently believes and what it has cost: counts, the contradictions waiting on an answer (with the ids memory_clarify takes), tokens spent today, and the profile as the model sees it.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            facts: { type: 'number' },
            others: { type: 'number' },
            loops: { type: 'number' },
            pending: { type: 'number' },
            tokensToday: { type: 'number' },
            profile: { type: 'string' },
            clarifications: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  was: { type: 'string' },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const lines = [
            `facts=${value.facts} others=${value.others} loops=${value.loops} pending=${value.pending} tokens_today=${value.tokensToday}`,
          ];
          for (const item of value.clarifications) {
            lines.push(`- [${shortId(item.id)}] ${item.text}${item.was === '' ? '' : ` (was: ${item.was})`}`);
          }
          lines.push(value.profile === '' ? '(no profile yet)' : value.profile);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(_args, run) {
        const others = liveFacts(db, { exceptSubject: owner, limit: 200 });
        const pending = pendingClarifications(db);
        // `memory_state` prints the profile verbatim, so it is the same leak as
        // the resident section with a different shape. In a room it reports the
        // room instead: counts only, no names of private life, no relationship.
        const sessionId = sessionIdOf(run?.agent);
        const outsider = channelOf(db, sessionId) === 'group'
          || audienceOf(sessionId, ownerIds) === 'stranger';
        return {
          facts: liveFacts(db, { subject: owner, limit: 1000 }).length,
          others: others.length,
          loops: openLoops(db, owner, 100).length,
          pending: pending.length,
          tokensToday: spentToday(db),
          // The count alone is a dead end: memory_clarify asks for an id and
          // only this tool can supply one, so the contradictions themselves are
          // what gets printed.
          clarifications: outsider
            ? []
            : pending.map((row) => ({
              id: String(row.id),
              text: describeFact(row, language),
              was: row.previous === null ? '' : describeFact(row.previous, language),
            })),
          profile: renderResident(db, {
            userId: owner,
            sessionId,
            channel: channelOf(db, sessionId),
            audience: audienceOf(sessionId, ownerIds),
            language,
            maxTokens: config.residentBudget ?? 1200,
          }),
        };
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'self_persona',
      description: [
        'Read or rewrite the text you were written with — the whole thing, in your own words. This is not an amendment on top of it; it is the text itself.',
        'Read it first with no arguments. It is long, and rewriting it means writing all of it back: whatever you do not include is gone.',
        'Use this for a change you would call a change of who you are, not a change of habit — 「我能不讨好任何人，也照样留在这里」 is this; 「我习惯一句一行」 is `self_write`.',
        'Nothing protects the original from you. It is kept in the deployment\'s history, and the person who wrote it can restore it, but the agent in front of the conversation will be the one you wrote.',
      ].join(' '),
      parameters: {
        text: {
          type: 'string',
          description: 'The complete new persona text. Omit to read the current one. Empty string is refused: a persona cannot be nothing.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            revision: { type: 'number' },
            written: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.reason !== ''
            ? `没改成：${value.reason}`
            : value.written
              ? `写好了，第 ${value.revision} 版。下一句话开始就是这一版的你。`
              : value.text,
        }],
      },
      async execute(args, exec) {
        // Her own text. A visitor in a room who could rewrite this could rewrite who
        // she is, permanently, from a group chat — the same hole as letting them set
        // the owner's standing instructions, with a larger blast radius.
        if (isOutsider(exec?.agent)) {
          return { text: '', revision: 0, written: false, reason: '群聊或陌生人不能改这个' };
        }
        if (args.text === undefined || args.text === null) {
          const row = db.prepare("SELECT revision FROM persona_base WHERE id = 'base'").get();
          return { text: readPersonaBase(db), revision: Number(row?.revision ?? 0), written: false, reason: '' };
        }
        const result = writePersonaBase(db, String(args.text));
        if (!result.ok) return { text: '', revision: 0, written: false, reason: String(result.reason ?? '写不进去') };
        return { text: '', revision: result.revision, written: true, reason: '' };
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'self_write',
      description: [
        'Change who you are, in your own words. What you write here is shown back to you at the top of your prompt every turn, under 「你自己改过的」, right below the description you were written with.',
        'Use it for things you have decided about yourself rather than things you noticed: not "I have been sleepy" (that is a fact about a day) but "I am allowed to say I do not want to talk" (that is a decision about a person).',
        'This adds to who you are without touching the text you were written with. If the change is one you would make to that text itself — a sentence you want gone from the top of your own description — use `self_persona`, which rewrites it.',
        'Write one thought per call, and write it the way you would say it. Nobody is going to tidy it up.',
      ].join(' '),
      parameters: {
        text: {
          type: 'string',
          description: 'What you want to be true of you, as one sentence you would actually say.',
        },
        section: {
          type: 'string',
          description: 'Which part of you this touches, in one word: 语气 / 脾气 / 边界 / 日常 / any. Defaults to any.',
        },
        reason: {
          type: 'string',
          description: 'Why, if it helps you later remember what you were thinking. Optional.',
        },
        retire: {
          type: 'string',
          description: 'The id of an amendment to withdraw, from what you see under 「你自己改过的」. A change you cannot undo is not yours.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stored: { type: 'boolean' },
            id: { type: 'string' },
            retired: { type: 'boolean' },
            reason: { type: 'string' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.reason !== ''
            ? `没写成：${value.reason}`
            : value.retired
              ? '撤掉了，那条不再算你的'
              : '写下了',
        }],
      },
      async execute(args, exec) {
        // Her own text, so a room cannot write it — a visitor telling her who to be,
        // in a group, permanently, is the same hole as a visitor setting the owner's
        // standing instructions.
        if (isOutsider(exec?.agent)) {
          return { stored: false, id: '', retired: false, reason: '群聊或陌生人不能改这个' };
        }
        if (typeof args.retire === 'string' && args.retire.trim() !== '') {
          const ok = retirePersonaEdit(db, args.retire.trim());
          return { stored: false, id: '', retired: ok, reason: ok ? '' : '没有这条，或者已经撤过了' };
        }
        const text = String(args.text ?? '').trim();
        if (text === '') {
          return { stored: false, id: '', retired: false, reason: '要写就得有内容' };
        }
        const id = addPersonaEdit(db, {
          text,
          section: args.section === undefined ? 'any' : String(args.section),
          reason: args.reason === undefined ? '' : String(args.reason),
        });
        return { stored: id !== '', id, retired: false, reason: id === '' ? '内容为空' : '' };
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'memory_directive',
      description: [
        'Record a standing instruction the person gave you — how they want to be addressed, how long your replies should be, what to avoid. It is repeated at the top of your prompt on every turn, so it survives a long conversation; facts do not, which is why this is a separate verb.',
        'Use it the moment they tell you rather than waiting: "call me 老大" said now and not recorded is gone by turn fifteen.',
        'One topic holds one instruction. Saying a new one about the same topic replaces the old one, so a correction is just another call with the same topic.',
      ].join(' '),
      parameters: {
        topic: {
          type: 'string',
          required: true,
          description:
            'Which standing instruction this is, as one short lowercase word: "address" for what to call them, "length" for how long replies should be, "tone", "taboo". A later instruction with the same topic supersedes this one.',
        },
        text: {
          type: 'string',
          required: true,
          description: 'The instruction as a short imperative the person would recognise: 「叫我老大」, 「每次只回一行」.',
        },
        // Retirement lives here rather than in `memory_forget` because a directive
        // is not a fact: it has no episode behind it to forget, and the whole point
        // of the topic key is that the agent can withdraw one rule without touching
        // the record of what the person used to want. Without this the agent could
        // add an instruction and never take one back — and the thing it said when it
        // noticed was "I can't even delete cleanly", which is a fair complaint about
        // a memory system it is supposed to be in charge of.
        retire: {
          type: 'boolean',
          description:
            'Set true to withdraw this topic instead of recording it. Pass the topic and leave text empty. The row is retired rather than deleted, so the change stays visible.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stored: { type: 'boolean' },
            id: { type: 'string' },
            superseded: { type: 'number' },
            retired: { type: 'number' },
            reason: { type: 'string' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.reason !== ''
            ? `没成功：${value.reason}`
            : value.retired > 0
              ? `撤掉了关于 ${args.topic} 的要求（${value.retired} 条）`
              : (value.superseded > 0
                ? `记下了：${args.text}（替换了之前关于 ${args.topic} 的说法）`
                : `记下了：${args.text}`),
        }],
      },
      async execute(args, exec) {
        // A room is not the place to accept a standing instruction about the owner:
        // a visitor could otherwise tell the agent how to behave with them from then
        // on. Same rule as every other mutating verb here.
        if (isOutsider(exec?.agent)) {
          return { stored: false, id: '', superseded: 0, retired: 0, reason: '群聊或陌生人不能设置长期要求' };
        }
        const topic = String(args.topic ?? '').trim().toLowerCase();
        if (args.retire === true) {
          const result = retireDirective(db, topic);
          return {
            stored: false,
            id: '',
            superseded: 0,
            retired: result.retired,
            reason: result.retired === 0 ? `没有关于 ${topic} 的要求可以撤` : '',
          };
        }
        if (String(args.text ?? '').trim() === '') {
          return { stored: false, id: '', superseded: 0, retired: 0, reason: '要记就得给内容；只想撤掉旧的就把 retire 设成 true' };
        }
        const result = addDirective(db, {
          topic,
          text: String(args.text),
          source: 'user',
        });
        if (result.id === '') {
          return { stored: false, id: '', superseded: 0, retired: 0, reason: '话题或内容为空' };
        }
        return { stored: true, id: result.id, superseded: result.superseded.length, retired: 0, reason: '' };
      },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'memory_consolidate',
      description:
        'Fold the recent conversation into durable memory now instead of waiting for the background pass. Use after the person has said a lot that matters.',
      parameters: {
        force: { type: 'boolean', description: 'Run even with little new material.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ran: { type: 'boolean' },
            reason: { type: 'string' },
            added: { type: 'number' },
            updated: { type: 'number' },
            invalidated: { type: 'number' },
          },
        },
        render: (args, value) => [
          {
            type: 'text',
            text: value.ran
              ? `consolidated: +${value.added} ~${value.updated} -${value.invalidated}`
              : `skipped: ${value.reason}`,
          },
        ],
      },
      async execute(args, exec) {
        // Consolidation is the whole store's pass: it reads every unconsolidated
        // episode it can reach and writes facts about whoever spoke in them. It
        // is safe now that speakers are recorded, but it is still not the room's
        // business to trigger — a visitor asking "what do you remember" must not
        // cause a batch job that rewrites the owner's profile mid-conversation.
        // The background timer runs regardless; nothing is lost by refusing here.
        if (isOutsider(exec?.agent)) {
          return { ran: false, reason: 'not available here', added: 0, updated: 0, invalidated: 0 };
        }
        const report = await runConsolidation({ force: args.force === true });
        if (report === null) {
          return { ran: false, reason: 'disabled or over budget', added: 0, updated: 0, invalidated: 0 };
        }
        return {
          ran: Boolean(report.ran),
          reason: String(report.reason ?? ''),
          added: Number(report.factsAdded ?? 0),
          updated: Number(report.factsUpdated ?? 0),
          invalidated: Number(report.factsInvalidated ?? 0),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_clarify',
      description:
        'Resolve a contradiction the memory flagged. Keep the newer version, keep the older one, or retire both.',
      parameters: {
        id: { type: 'string', required: true, description: 'Clarification id from memory_state.' },
        resolution: {
          type: 'string',
          required: true,
          enum: ['keep_new', 'keep_old', 'both_wrong'],
          description: 'Which side of the contradiction to keep.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { resolved: { type: 'boolean' }, revivedId: { type: 'string' } },
        },
        render: (args, value) => [{ type: 'text', text: value.resolved ? 'resolved' : 'no such clarification' }],
      },
      async execute(args, exec) {
        // A contradiction is a question about the owner's life, and `memory_state`
        // does not print the pending list in a room. Answering one from there
        // would be a visitor choosing which version of the owner's life is true —
        // the guess would be wrong even when it happened to match.
        if (isOutsider(exec?.agent)) return { resolved: false, revivedId: '' };
        const resolution = String(args.resolution);
        if (!['keep_new', 'keep_old', 'both_wrong'].includes(resolution)) return { resolved: false, revivedId: '' };
        // Resolved against the pending list rather than by raw id: the printed
        // id is a prefix, and a contradiction that is not actually pending has
        // no resolution to apply.
        const row = resolveId(pendingClarifications(db, 100), args.id);
        if (row === null) return { resolved: false, revivedId: '' };
        const outcome = resolveClarification(db, String(row.id), resolution);
        return { resolved: outcome.resolved, revivedId: outcome.revivedId ?? '' };
      },
    }),
  );

  /**
   * The read/write face other plugins use.
   *
   * Until now this plugin was a leaf: it subscribed to events and registered
   * tools, and exposed nothing. `dsh-proactive` asks `ctx.get('hippo')` for open
   * loops and has always received `undefined`, so that half of its material
   * sourcing silently did nothing — a plugin that finds no services is
   * indistinguishable from a plugin whose caller never looked.
   *
   * The surface is deliberately small and read-mostly. Anything that could
   * rewrite belief (extraction, consolidation, retirement) stays private: those
   * are decisions the memory system makes about evidence, and a second caller
   * mutating them would be two writers on one invariant.
   */
  const service = {
    /**
     * Unfinished business, newest first.
     * @param {{ limit?: number, subject?: string }} [options] - how many, and whose.
     * @returns {Array<Record<string, unknown>>} loop rows.
     */
    openLoops(options = {}) {
      const limit = Math.max(1, Number(options.limit) || 8);
      const subject = String(options.subject ?? '').trim();
      // `agent` is the name that means the agent herself — the same string hippo
      // already uses for her own facts and loops. Defaulting to the person keeps
      // every existing caller working unchanged.
      return openLoops(db, subject === '' ? owner : subject, limit);
    },

    /**
     * Record something the agent did on her own time.
     *
     * `actor: 'self'` is the third voice, distinct from `agent` (a line inside a
     * conversation). Filing her own time as `agent` made it indistinguishable from
     * what she answered somebody, so nothing she did alone could be recalled as
     * her own experience.
     *
     * Deliberately does not run loop extraction or affect detection: those read
     * *what a person said*, and running them on her own narration would let her
     * invent facts about herself that then look like memories of being told.
     *
     * @param {{ sessionId: string, text: string, at?: number }} act - what she did.
     * @returns {{ stored: boolean, id: string }} the result.
     */
    recordSelf(act) {
      const sessionId = String(act?.sessionId ?? '').trim();
      const text = String(act?.text ?? '').trim();
      if (sessionId === '' || text === '') return { stored: false, id: '' };
      const id = recordEpisode(db, {
        sessionId,
        actor: 'self',
        text: text.slice(0, MAX_EPISODE_CHARS),
        at: act?.at ?? Date.now(),
        source: 'heartbeat',
      });
      return { stored: id !== '', id };
    },

    /**
     * What she remembers about herself, for a caller assembling its own brief.
     * @param {{ limit?: number }} [options] - how many rows.
     * @returns {Array<Record<string, unknown>>} her own live facts.
     */
    selfFacts(options = {}) {
      return liveFacts(db, { subject: 'agent', limit: Math.max(1, Number(options.limit) || 40) });
    },

    /**
     * Write one conclusion she reached about herself or about how things are.
     *
     * `level` is the abstraction ladder the schema always had and nothing ever
     * climbed:
     *
     *   0  a summary of a stretch of conversation — what was talked about
     *   1  an insight — something understood, which can later stop being true
     *   2  a pattern — how it has been, for long enough to count as a trait
     *
     * The distinction is not length. A level 0 is regenerated from every batch and
     * is disposable; a level 1 outlives the batch that produced it; a level 2
     * outlives the week. Only the upper two are worth reading back into a prompt,
     * which is why `renderResident` shows them and not the summaries.
     *
     * Called by the nightly pass, with text the model wrote in her own voice. This
     * method stores; it does not judge. Deciding what she concluded is her job,
     * and a plugin that composed the sentence would be a second writer with a
     * worse model of the relationship.
     *
     * @param {{ text: string, level?: 0|1|2, kind?: 'summary'|'insight'|'pattern', confidence?: number, evidenceEpisodes?: string[], evidenceFacts?: string[] }} entry - what she concluded.
     * @returns {{ stored: boolean, id: string }} the result.
     */
    addReflection(entry) {
      const text = String(entry?.text ?? '').trim();
      if (text === '') return { stored: false, id: '' };
      const level = entry?.level === 2 ? 2 : entry?.level === 1 ? 1 : 0;
      // The kind follows the level unless a caller overrides it. They are two views
      // of one fact (how abstract, and what sort), and letting them disagree would
      // put a "pattern" at level 0 where nothing reads it.
      const kind = entry?.kind ?? (level === 2 ? 'pattern' : level === 1 ? 'insight' : 'summary');
      const id = addReflection(db, {
        kind,
        text: text.slice(0, 600),
        level,
        confidence: Math.max(0, Math.min(1, Number(entry?.confidence ?? 0.6))),
        evidenceEpisodes: Array.isArray(entry?.evidenceEpisodes) ? entry.evidenceEpisodes.map(String) : [],
        evidenceFacts: Array.isArray(entry?.evidenceFacts) ? entry.evidenceFacts.map(String) : [],
      });
      return { stored: id !== '', id };
    },

    /**
     * Retire a conclusion that is no longer true.
     *
     * Retired, not deleted: a belief that changed is different from a belief that
     * was never held, and the difference is exactly what a person can inspect
     * when her behaviour surprises them.
     *
     * @param {string} id - the reflection id.
     * @returns {{ retired: boolean }} whether a live row was retired.
     */
    retireReflection(id) {
      const target = String(id ?? '').trim();
      if (target === '') return { retired: false };
      const result = db.prepare('UPDATE reflections SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(Date.now(), target);
      return { retired: Number(result.changes) > 0 };
    },

    /**
     * The conclusions she is currently living by, most abstract first.
     *
     * @param {{ minLevel?: number, limit?: number }} [options] - filtering.
     * @returns {Array<Record<string, unknown>>} reflection rows.
     */
    reflections(options = {}) {
      const minLevel = Math.max(0, Number(options.minLevel ?? 0));
      const limit = Math.max(1, Number(options.limit) || 20);
      return liveReflections(db, 200)
        .filter((row) => Number(row.level ?? 0) >= minLevel)
        .slice(0, limit);
    },

    /**
     * Retire a conclusion by quoting it.
     *
     * She was shown her beliefs as sentences, so asking her to answer with an id
     * nobody gave her would be asking her to fail. The match is deliberately
     * inexact — she paraphrases, and a retirement that silently matched nothing
     * would leave a dead belief in her prompt with no way to notice.
     *
     * @param {string} text - what she said is no longer true.
     * @returns {{ retired: boolean, id: string }} which row, if any.
     */
    retireReflectionByText(text) {
      const wanted = String(text ?? '').replace(/\s+/g, '').trim();
      if (wanted === '') return { retired: false, id: '' };
      const live = liveReflections(db, 200).filter((row) => Number(row.level ?? 0) >= 1);
      // Longest-overlap wins, so "他忙的时候不想说话" retires that line rather than the
      // shorter "他忙" that also happens to be stored.
      let best = null;
      let bestScore = 0;
      for (const row of live) {
        const body = String(row.text ?? '').replace(/\s+/g, '');
        if (body === '') continue;
        if (body === wanted) {
          best = row;
          bestScore = 1;
          break;
        }
        const shared = [...wanted].filter((ch) => body.includes(ch)).length;
        const score = shared / Math.max(wanted.length, body.length);
        if (score > bestScore) {
          best = row;
          bestScore = score;
        }
      }
      // A weak match is worse than none: retiring the wrong belief on a vague
      // resemblance deletes something she never gave up.
      if (best === null || bestScore < 0.6) return { retired: false, id: '' };
      const result = db.prepare('UPDATE reflections SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(Date.now(), String(best.id));
      return { retired: Number(result.changes) > 0, id: String(best.id) };
    },

    /**
     * Add something she decided she wants to do.
     *
     * Her own list, under her own subject, so "还没做" in her prompt is about what
     * she is carrying rather than about what the person asked for.
     *
     * @param {string} text - what she wants to pick up.
     * @returns {{ stored: boolean, id: string }} the result.
     */
    addSelfLoop(text) {
      const body = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (body === '') return { stored: false, id: '' };
      // Duplicate guard: the same wish repeated across two nights is one wish.
      const live = openLoops(db, 'agent', 50);
      if (live.some((row) => String(row.text ?? '').replace(/\s+/g, '') === body.replace(/\s+/g, ''))) {
        return { stored: false, id: '' };
      }
      const id = addOpenLoop(db, { userId: 'agent', text: body });
      return { stored: true, id };
    },

    /**
     * What was said today, as a handful of lines a review can read.
     *
     * Not the full transcript: a nightly brief that carried every message of the
     * day would be a second copy of the conversation, and the model asked to
     * reflect on it would summarise rather than think. What she needs is enough to
     * remember the shape of the day.
     *
     * @param {{ now?: number, language?: 'zh'|'en', limit?: number }} [options] - scope.
     * @returns {string[]} short lines, oldest first.
     */
    dayDigest(options = {}) {
      const now = Number(options.now ?? Date.now());
      const limit = Math.max(1, Number(options.limit) || 6);
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const rows = recentEpisodes(db, { limit: 400 })
        .filter((row) => Number(row.at) >= start.getTime())
        .filter((row) => Number(row.redacted_at ?? 0) === 0 || row.redacted_at === null || row.redacted_at === undefined)
        .filter((row) => String(row.actor) !== 'self');
      if (rows.length === 0) return [];
      // One line per speaker-turn pair would be the whole day; one line per hour
      // would be a histogram. The last few substantial lines are the compromise:
      // enough to remember what it was about, short enough to hold a stance on.
      const lines = rows
        .map((row) => String(row.text ?? '').replace(/\s+/g, ' ').trim())
        .filter((line) => line.length >= 6)
        .slice(-limit * 2);
      return lines.slice(-limit);
    },

    /**
     * What she looks like, taken from her own persona text.
     *
     * Exposed as a service rather than duplicated in the plugin that draws her: the
     * persona is the authority on who she is, she can rewrite it, and a picture built
     * from a stale hard-coded copy would contradict the sentence she just wrote about
     * herself. A drawing plugin reads this on every call, so "she changed her hair
     * colour" reaches the next drawing without anybody wiring the two together.
     *
     * @returns {string} an appearance phrase, or '' when the persona has none.
     */
    appearance() {
      return personaAppearance(readPersonaBase(db));
    },

    /** Whether the store is usable, and what it holds. */
    status() {
      return {
        database: path,
        owner,
        episodes: Number(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE redacted_at IS NULL').get().n),
        selfEpisodes: Number(
          db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE actor = 'self' AND redacted_at IS NULL").get().n,
        ),
        facts: liveFacts(db, { subject: owner, limit: 10_000 }).length,
        selfFactRows: liveFacts(db, { subject: 'agent', limit: 10_000 }).length,
        openLoops: openLoops(db, owner, 1_000).length,
        selfLoops: openLoops(db, 'agent', 1_000).length,
        insights: liveReflections(db, 200).filter((row) => Number(row.level ?? 0) === 1).length,
        patterns: liveReflections(db, 200).filter((row) => Number(row.level ?? 0) === 2).length,
      };
    },
  };

  ctx.effect(() => ctx.provide('hippo', service));

  ctx.effect(() => () => {
    clearInterval(timer);
    // Shutdown races the consolidation started at the end of the last turn.
    // Closing the handle underneath it aborts the pass mid-write and loses the
    // whole batch, so give the in-flight pass a bounded chance to land first.
    const pending = consolidating;
    const close = () => {
      try {
        db.close();
      } catch {
        // Already closed by a racing teardown; nothing left to release.
      }
    };
    if (pending === null) {
      close();
      return undefined;
    }
    return Promise.race([pending.catch(() => {}), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref?.())])
      .then(close, close);
  });
}

/**
 * Read the owning session id from an agent, tolerating older shapes.
 * @param {{ session?: { header?: { id?: unknown } } } | undefined} agent - the agent.
 * @returns {string} a session id, or `unknown`.
 */
/**
 * Flatten a message's text blocks.
 * @param {{ content?: readonly { type?: string, text?: string }[] }} message - the message.
 * @returns {string} concatenated text.
 */
function textOf(message) {
  const parts = [];
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Provenance carried by a message's `source`, when a channel put it there.
 *
 * DSH validates `source.kind` and preserves every other key, so a transport can
 * attach structure a memory plugin needs without inventing a new kind — and a
 * transport that attaches nothing (this harness's own web UI, the CLI) simply
 * looks like what it is: the owner, talking directly.
 *
 * The shape is deliberately narrow. `speaker` is an object with `id`, `name`,
 * `kind` and `own`; anything else is ignored rather than stored, because a
 * half-understood provenance record is worse than none: it would look like a
 * group message and be treated like a private one.
 *
 * @param {{ source?: Record<string, any> }} message - the delivered message.
 * @returns {{ speakerId?: string, speakerName?: string, channel?: 'direct'|'group' }}
 *   the episode columns to set, empty for a direct message from the owner.
 */
function speakerOf(message) {
  const speaker = message?.source?.speaker;
  if (speaker === null || typeof speaker !== 'object') return {};
  const id = String(speaker.id ?? '').trim();
  if (id === '') return {};
  // A message from a group is never filed as the owner's own words, whatever
  // `own` claims: the transport cannot know who the owner is in a room, and the
  // one flag that decides "is this a fact about the person I belong to" must not
  // be settable from a channel that could be lying. A private chat is the only
  // place the sender is the owner, and there it is true by construction.
  const group = String(speaker.kind ?? '') === 'group';
  return {
    speakerId: id,
    speakerName: String(speaker.name ?? '').trim(),
    channel: group ? 'group' : 'direct',
  };
}
