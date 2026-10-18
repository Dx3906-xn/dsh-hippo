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
  recordAffect,
  ensureRelationship,
  adjustTrust,
  recomputeRelationship,
  recordReview,
  redactRecent,
  gradeMemory,
  chargeBudget,
  setLoopDue,
  savePendingRecall,
  takePendingRecall,
  spentToday,
  userId as readUserId,
} from './store.js';
import { shouldExtract, detectAffect, asksForRecall, detectTrustSignal, asksToForget, detectCorrectionIn } from './gate.js';
import { renderResident, renderRecall } from './prompt.js';
import { renderAgenda, detectLoop, loopResolvedBy, expireClarifications } from './agenda.js';
import { consolidate, shouldConsolidateOnIdle, demoteWeakFacts, resolveSubject, ownerAliases } from './consolidate.js';
import { canonicalize, decide } from './extract.js';
import { estimateTokens, tokenize } from './tokenize.js';
import { parseRelativeDate, followUpAfter } from './when.js';

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
  ctx.systemPrompt.section({
    name: 'hippo:resident',
    order: 900,
    interpolate: false,
    text: () =>
      renderResident(db, {
        userId: owner,
        language,
        maxTokens: config.residentBudget ?? 1200,
      }),
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

    // The agenda is independent of recall: a turn can be a plain greeting and
    // still be the right moment to ask how the smoking is going. It goes in on
    // every turn it has something to say, capped by its own budget.
    const agenda = renderAgenda(db, { userId: owner, language, now: Date.now() });

    const wantsRecall = config.recallOnEveryTurn === true || asksForRecall(cue);
    const recalled = wantsRecall
      ? recall(db, { cue, userId: owner, limit: 10, includeEpisodes: true, fallback: true })
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
      injected.push({
        role: 'user',
        content: [{ type: 'text', text: block }],
        source: { kind: 'user', form: 'recall' },
      });
    }
    if (agenda !== '') {
      injected.push({
        role: 'user',
        content: [{ type: 'text', text: agenda }],
        source: { kind: 'user', form: 'instructions' },
      });
    }

    // Appended after the accepted batch, matching how the harness's own
    // context plugins contribute. `form: 'recall'` and `form: 'instructions'`
    // keep the transcript honest about what the person actually typed, and stop
    // the capture pass from storing our own text back as an episode.
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
    if (text !== '') {
      recordEpisode(db, {
        sessionId: sessionIdOf(payload.agent),
        actor: 'agent',
        text: text.slice(0, MAX_EPISODE_CHARS),
        source: 'turn',
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
      SELECT id FROM episodes
      WHERE session_id = ? AND actor = 'user'
      ORDER BY at DESC, rowid DESC LIMIT 1
    `).get(sessionId);
    return row === undefined ? [] : [String(row.id)];
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
          (result.factsRetired > 0 ? `, retiring ${result.factsRetired} fact(s)` : ''),
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
          for (const fact of value.facts) lines.push(`- ${fact.text} (${fact.confidence.toFixed(2)})`);
          for (const episode of value.episodes) lines.push(`- [${episode.when}] ${episode.who}: ${episode.text}`);
          return [{ type: 'text', text: lines.length === 0 ? 'nothing found' : lines.join('\n') }];
        },
      },
      async execute(args) {
        const limit = Math.min(30, Math.max(1, Number(args.limit ?? 8)));
        const recalled = recall(db, { cue: String(args.query), userId: owner, limit, includeEpisodes: true });
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
        // The model writes "林晚" for the owner about as often as it writes
        // "user", and a row filed under a person's own name is invisible to every
        // read path that filters by owner — stored, indexed, and never seen again.
        // The extraction path has resolved this for a while; this one had not, so
        // the two write paths disagreed about what a subject means.
        const subject = resolveSubject(
          String(args.subject),
          owner,
          ownerAliases(db, owner),
        );
        const predicate = canonicalize(String(args.predicate));
        if (predicate === null) {
          return { stored: false, id: '', reason: 'predicate is not a usable attribute key' };
        }
        const object = String(args.object).trim();
        if (object === '') return { stored: false, id: '', reason: 'nothing to remember' };

        // Anchor the fact to the sentence that prompted it. Without this the
        // explicit path produces facts with no provenance at all: the store can
        // say "works as an illustrator" but not when it was said or by whom,
        // and nothing supports walking from the fact back to the conversation.
        const evidence = evidenceForAgent(exec?.agent);

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
        'Retire a memory that is wrong or that the person asked you to drop. It stops being recalled but stays in the log, so this can be undone.',
      parameters: {
        id: { type: 'string', required: true, description: 'Fact id from memory_recall.' },
        reason: { type: 'string', description: 'Why it should be retired.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { retired: { type: 'boolean' } },
        },
        render: (args, value) => [{ type: 'text', text: value.retired ? 'retired' : 'nothing to retire' }],
      },
      async execute(args) {
        const before = liveFacts(db, { subject: owner, limit: 500 }).some((fact) => String(fact.id) === String(args.id));
        if (!before) return { retired: false };
        invalidateFact(db, String(args.id), { reason: String(args.reason ?? 'forgotten') });
        return { retired: true };
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
            : [{ type: 'text', text: value.loops.map((loop) => `- ${loop.text}`).join('\n') }],
      },
      async execute() {
        return {
          loops: openLoops(db, owner, 8).map((loop) => ({ id: String(loop.id), text: String(loop.text) })),
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
        id: { type: 'string', description: 'Loop id. Required when closing.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, id: { type: 'string' } },
        },
        render: (args, value) => [{ type: 'text', text: value.ok ? 'ok' : 'nothing to do' }],
      },
      async execute(args) {
        if (String(args.action) === 'open') {
          const text = String(args.text ?? '').trim();
          if (text === '') return { ok: false, id: '' };
          const id = addOpenLoop(db, { userId: owner, text });
          return { ok: true, id };
        }
        const id = String(args.id ?? '');
        if (id === '') return { ok: false, id: '' };
        closeOpenLoop(db, id);
        return { ok: true, id };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_state',
      description:
        'Inspect what the memory currently believes and what it has cost: counts, pending contradictions, tokens spent today, and the profile as the model sees it.',
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
          },
        },
        render: (args, value) => [
          {
            type: 'text',
            text: `facts=${value.facts} others=${value.others} loops=${value.loops} pending=${value.pending} tokens_today=${value.tokensToday}`,
          },
          { type: 'text', text: value.profile === '' ? '(no profile yet)' : value.profile },
        ],
      },
      async execute() {
        const others = liveFacts(db, { exceptSubject: owner, limit: 200 });
        return {
          facts: liveFacts(db, { subject: owner, limit: 1000 }).length,
          others: others.length,
          loops: openLoops(db, owner, 100).length,
          pending: pendingClarifications(db).length,
          tokensToday: spentToday(db),
          profile: renderResident(db, {
            userId: owner,
            language,
            maxTokens: config.residentBudget ?? 1200,
          }),
        };
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
      async execute(args) {
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
      async execute(args) {
        const resolution = String(args.resolution);
        if (!['keep_new', 'keep_old', 'both_wrong'].includes(resolution)) return { resolved: false, revivedId: '' };
        const exists = pendingClarifications(db, 100).some((row) => String(row.id) === String(args.id));
        if (!exists) return { resolved: false, revivedId: '' };
        const outcome = resolveClarification(db, String(args.id), resolution);
        return { resolved: outcome.resolved, revivedId: outcome.revivedId ?? '' };
      },
    }),
  );

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
function sessionIdOf(agent) {
  const id = agent?.session?.header?.id;
  return id === undefined || id === null ? 'unknown' : String(id);
}

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
