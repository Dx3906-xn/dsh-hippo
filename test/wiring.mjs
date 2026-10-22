// Wiring test: run the real plugin `apply()` against a stub Cordis context and
// a stub model, then drive one simulated conversation through the event hooks.
//
// This is the only test that proves the seams are right -- the unit tests below
// it prove the algorithms, but a wrong event name or a wrong tool schema shape
// would still ship broken.
import { openDatabase } from '../lib/db.js';
import * as hippo from '../lib/index.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const dbPath = new URL('./wiring.db', import.meta.url).pathname.replace(/^\//, '');
try {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(dbPath);
} catch {
  // first run
}

// --- stub model -------------------------------------------------------------
const prompts = [];
const llm = {
  stream(options) {
    const system = String(options.system ?? '');
    prompts.push(system);
    const reply = system.includes('JSON')
      ? JSON.stringify({
        facts: [
          { subject: 'user', predicate: 'has_pet', object: '年糕（一只橘猫）', confidence: 0.95, sensitivity: 'personal', episode: 0 },
          // A fact about someone other than the owner, on purpose: every read
          // path can print it, and one write path used to refuse it.
          { subject: '妈妈', predicate: 'works_at', object: '在出版社做美编', confidence: 0.9, episode: 0 },
        ],
      })
      : '好。';
    return (async function* generate() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      for (const piece of reply.match(/.{1,8}/gs) ?? []) {
        yield { type: 'text-delta', index: 0, text: piece };
      }
      yield { type: 'block-end', index: 0 };
    })();
  },
};

// --- stub context -----------------------------------------------------------
const sections = [];
const contexts = [];
const tools = [];
const handlers = new Map();
const disposers = [];
let settled = null;

const commands = [];
/** Services the plugin published, by name. */
const provided = new Map();
const ctx = {
  llm,
  systemPrompt: {
    section(spec) {
      sections.push(spec);
    },
    context(spec) {
      contexts.push(spec);
    },
  },
  tools: {
    register(tool) {
      tools.push(tool);
    },
  },
  // Cordis installs a service as a method on the context; `ctx.get` is how a
  // plugin asks whether one exists without declaring an `inject` dependency.
  get(name) {
    if (name !== 'commands') return undefined;
    return {
      register(definition) {
        commands.push(definition);
      },
    };
  },
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
    return () => {};
  },
  effect(setup) {
    const dispose = setup();
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  },
  // Cordis installs a service as a method on the context. `provide` records the
  // name so this harness can assert the plugin actually published one — a plugin
  // that only *reads* services is untestable from the outside, and the absence of
  // this stub is what let `ctx.get('hippo')` return undefined in production for
  // as long as it did.
  provide(name, value) {
    provided.set(name, value);
    return () => provided.delete(name);
  },
};

const config = {
  path: dbPath,
  provider: 'stub',
  model: 'stub',
  language: 'zh',
  idleMs: 50,
  dailyTokenBudget: 0,
};

console.log('apply');
await hippo.apply(ctx, config);
check(sections.length === 1, `one system-prompt section (got ${sections.length})`);
check(sections[0]?.name === 'hippo:resident', 'resident section registered');
check(sections[0]?.interpolate === false, 'resident section opts out of {{}} interpolation');
check(typeof sections[0]?.text === 'function', 'resident text is lazy');
check(tools.length === 8, `eight tools registered (got ${tools.length})`);
for (const expected of [
  'memory_recall', 'memory_remember', 'memory_forget', 'memory_open_loops',
  'memory_loop', 'memory_state', 'memory_consolidate', 'memory_clarify',
]) {
  check(tools.some((tool) => tool.name === expected), `tool "${expected}" present`);
}
check(handlers.has('agent/pre-step'), 'pre-step hook attached');
check(handlers.has('agent/assistant-stream'), 'assistant-stream hook attached');
check(handlers.has('agent/turn-stopping'), 'turn-stopping hook attached');
check(handlers.has('agent/disposed'), 'disposed hook attached');

// The operator surface has to actually reach the registry, not merely compile.
// `/memory` is the only way to get the store off the machine as a file, and it
// is registered conditionally — so "the plugin loaded without error" is not
// evidence that the command exists.
console.log('command surface');
check(commands.length === 1, `one command registered (got ${commands.length})`);
check(commands[0]?.name === 'memory', `the command is named memory (got "${commands[0]?.name}")`);
check(typeof commands[0]?.handler === 'function', 'the command has a handler');
const statusResult = await commands[0].handler({ rawInput: '', agent: undefined });
check(statusResult?.kind === 'success', `a bare /memory answered (got ${JSON.stringify(statusResult)})`);
check(statusResult.text.includes('记忆'), 'the command answered in Chinese');

// The verbs that move the whole store are refused where the owner is not known
// to be present. `test/commands.mjs` covers the shapes; this one covers the
// wiring — that the guard is actually passed the agent rather than a session id
// read once at load time.
const refused = await commands[0].handler({
  rawInput: 'dump D:/tmp/should-not-exist.json',
  agent: { session: { header: { id: 'qq:onebot:group:1070071261' } } },
});
check(refused?.kind === 'error', `a room was refused dump (got ${JSON.stringify(refused)})`);

// ---- the service other plugins call ----------------------------------------
//
// This is not cosmetic. `dsh-proactive` has always asked `ctx.get('hippo')` for
// open loops, and the plugin never published anything under that name — so the
// open-loop half of its material sourcing silently did nothing, and the failure
// was invisible because "no service here" and "no loops here" look identical from
// the caller's side.
console.log('service face');
const memory = provided.get('hippo');
check(memory !== undefined, 'hippo publishes a service other plugins can call');
if (memory !== undefined) {
  check(typeof memory.openLoops === 'function', 'it can list open loops');
  check(typeof memory.recordSelf === 'function', 'it can record what she did on her own time');
  check(typeof memory.selfFacts === 'function', 'it can report what she remembers about herself');
  check(typeof memory.status === 'function', 'it can describe the store');

  // Her own time is a third voice, and the distinction has to survive a write.
  const selfWrite = memory.recordSelf({ sessionId: 'hb:companion', text: '翻了一下午搁浅的鲸鱼' });
  check(selfWrite.stored === true, 'an act of her own is stored');
  const status = memory.status();
  check(status.selfEpisodes >= 1, `and is counted as hers (${status.selfEpisodes})`);

  // Empty input must not become an empty episode: a blank row would later read
  // as "she woke up and did nothing" when the truth is that nothing was recorded.
  check(memory.recordSelf({ sessionId: 'hb:companion', text: '   ' }).stored === false, 'a blank act is refused');
  check(memory.recordSelf({ sessionId: '', text: 'x' }).stored === false, 'an act with no session is refused');

  // Loops default to the person, because every existing caller predates the
  // agent's own list and must keep getting what it used to get.
  const ownerLoops = memory.openLoops();
  check(Array.isArray(ownerLoops), 'loops default to a list');
  check(
    memory.openLoops({ subject: 'agent' }).every((row) => String(row.user_id) === 'agent'),
    'and hers can be asked for',
  );
}

// Every registered tool must carry a schema the runtime can render.
console.log('tool schemas');
for (const tool of tools) {
  const ok = tool.parameters !== null
    && typeof tool.parameters === 'object'
    && typeof tool.execute === 'function'
    && tool.output !== undefined
    && typeof tool.output.render === 'function';
  check(ok, `tool "${tool.name}" is well formed`);
}

// --- simulated conversation -------------------------------------------------
console.log('conversation');
const agent = {
  session: { header: { id: 'wiring-session' } },
};
const userMessage = {
  id: 'm1',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '记一下，我家猫叫年糕，是只橘猫。' }],
};

let decision = { kind: 'enter', messages: [userMessage] };
for (const handler of handlers.get('agent/pre-step') ?? []) {
  decision = await handler({ agent, messages: [userMessage], turn: 1, step: 1, signal: new AbortController().signal }, async () => decision);
}
check(decision.kind === 'enter', 'pre-step passes the decision through');
check(decision.messages.length === 1, `no recall injected on a cold store (got ${decision.messages.length})`);

// Explicit "记一下" should have kicked a forced consolidation; wait for it.
await new Promise((resolve) => {
  settled = resolve;
  setTimeout(resolve, 1500);
});

const db = await openDatabase(dbPath);
const episodeCount = db.prepare('SELECT COUNT(*) AS c FROM episodes').get().c;
check(episodeCount >= 1, `the user line became an episode (got ${episodeCount})`);
const factCount = db.prepare('SELECT COUNT(*) AS c FROM facts').get().c;
check(factCount >= 1, `consolidation produced a fact (got ${factCount})`);
const fact = db.prepare('SELECT * FROM facts LIMIT 1').get();
check(String(fact?.object ?? '').includes('年糕'), 'the extracted fact is about the cat');
check(prompts.some((system) => system.includes('JSON')), 'the extraction prompt went through ctx.llm.stream');

// --- assistant side ---------------------------------------------------------
console.log('assistant side');
for (const handler of handlers.get('agent/assistant-stream') ?? []) {
  handler({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '年糕' } } });
  handler({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '是只好猫。' } } });
}
for (const handler of handlers.get('agent/turn-stopping') ?? []) {
  await handler({ agent, turn: 1, signal: new AbortController().signal });
}
const agentLines = db.prepare("SELECT COUNT(*) AS c FROM episodes WHERE actor = 'agent'").get().c;
check(agentLines === 1, `assistant reply stored once (got ${agentLines})`);
const agentText = db.prepare("SELECT text FROM episodes WHERE actor = 'agent'").get().text;
check(agentText === '年糕是只好猫。', 'assistant text assembled in order');

// --- resident section reflects what was learned -----------------------------
console.log('resident');
const resident = sections[0].text();
check(String(resident).includes('年糕'), 'resident text now mentions the cat');
check(!String(resident).includes('{{'), 'resident text is template safe');

// --- a later turn recalls it ------------------------------------------------
console.log('recall');
const later = {
  id: 'm2',
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '你还记得我家猫叫什么吗？' }],
};
let laterDecision = { kind: 'enter', messages: [later] };
for (const handler of handlers.get('agent/pre-step') ?? []) {
  laterDecision = await handler({ agent, messages: [later], turn: 2, step: 1, signal: new AbortController().signal }, async () => laterDecision);
}
const injected = laterDecision.messages.filter((message) => message.source?.form === 'recall');
check(injected.length === 1, `one recall block injected (got ${injected.length})`);
check(
  String(injected[0]?.content?.[0]?.text ?? '').includes('年糕'),
  'the recall block carries the cat',
);
check(laterDecision.messages[laterDecision.messages.length - 1] === injected[0], 'recall is appended after the user turn');

// The session log validates every message it stores and refuses one without an
// id, which took the whole session down with it: the injected block is built by
// hand here, so an object literal used to reach the log unidentified and the
// next resume failed with "event at seq N lacks an identified message".
for (const message of laterDecision.messages) {
  check(
    typeof message?.id === 'string' && message.id !== '',
    `every message in the batch is identified (${String(message?.source?.form ?? message?.source?.kind ?? '?')})`,
  );
}

// --- tool round trip --------------------------------------------------------
console.log('tools');
const recallTool = tools.find((tool) => tool.name === 'memory_recall');
const recalled = await recallTool.execute({ query: '年糕', limit: 5 }, { callId: 'c1', name: 'memory_recall', arguments: {}, signal: new AbortController().signal });
check(recalled !== undefined, 'memory_recall returns a value');
check(JSON.stringify(recalled).includes('年糕'), 'memory_recall finds the cat');

const stateTool = tools.find((tool) => tool.name === 'memory_state');
const state = await stateTool.execute({}, { callId: 'c2', name: 'memory_state', arguments: {}, signal: new AbortController().signal });
check(typeof state?.facts === 'number', 'memory_state reports a fact count');

// --- an id printed by one tool has to resolve in the tool that takes it -----
// Three tools take an id and can only ever be called with an id another tool
// printed. Nothing above this line would have noticed if none did: the suite
// stayed green while memory_forget, memory_loop(close) and memory_clarify were
// unreachable in a real conversation -- the model asked to forget something and
// had nothing to pass.
console.log('id contract');
const openTool = tools.find((tool) => tool.name === 'memory_open_loops');
const loopTool = tools.find((tool) => tool.name === 'memory_loop');
const forgetTool = tools.find((tool) => tool.name === 'memory_forget');
const clarifyTool = tools.find((tool) => tool.name === 'memory_clarify');
const exec = (n) => ({ callId: `id-${n}`, name: n, arguments: {}, signal: new AbortController().signal });
const printed = (tool, value) => tool.output.render({}, value).map((block) => block.text).join('\n');
const idsIn = (text) => [...text.matchAll(/\[([0-9a-f]{8})\]/g)].map((match) => match[1]);

const recalledText = printed(recallTool, recalled);
const recalledIds = idsIn(recalledText);
check(recalledIds.length >= 1, `memory_recall prints an id (${recalledText.split('\n')[0] ?? ''})`);
if (recalledIds.length >= 1) {
  const forgot = await forgetTool.execute({ id: recalledIds[0], reason: 'test' }, exec('memory_forget'));
  check(forgot.retired === true, 'memory_forget accepts the id memory_recall printed');
}

// ...including a fact that is not about the owner. This is the case that got out:
// memory_forget searched `liveFacts(db, { subject: owner })` while memory_recall
// and memory_state printed ids for everyone, so "妈妈 works_at ..." was readable
// and unforgettable. The suite above passed because every fact it built belonged
// to the owner. A test that only ever handles one subject cannot see a scoping
// bug -- it needs a second one to exist.
const otherId = db.prepare("SELECT id FROM facts WHERE subject <> 'user' AND invalid_at IS NULL LIMIT 1").get();
if (otherId === undefined) {
  check(false, 'the fixture has a fact about someone other than the owner');
} else {
  const text = String(otherId.id);
  const forgetOther = await forgetTool.execute({ id: text, reason: 'test' }, exec('memory_forget'));
  check(forgetOther.retired === true, `memory_forget accepts a fact about someone else (${text.slice(0, 8)})`);
  const stillLive = db.prepare('SELECT invalid_at FROM facts WHERE id = ?').get(text);
  check(stillLive?.invalid_at !== null, 'the other subject\'s fact is actually retired');
}

await loopTool.execute({ action: 'open', text: '帮朋友问一下搬家的事' }, exec('memory_loop'));
const loopsText = printed(openTool, await openTool.execute({}, exec('memory_open_loops')));
const loopIds = idsIn(loopsText);
check(loopIds.length >= 1, `memory_open_loops prints an id (${loopsText})`);
if (loopIds.length >= 1) {
  const closed = await loopTool.execute({ action: 'close', id: loopIds[0] }, exec('memory_loop'));
  check(closed.ok === true, 'memory_loop closes the loop id memory_open_loops printed');
}

const anyFact = db.prepare('SELECT id FROM facts LIMIT 1').get();
db.prepare('UPDATE facts SET needs_clarification = 1 WHERE id = ?').run(String(anyFact.id));
const stateText = printed(stateTool, await stateTool.execute({}, exec('memory_state')));
const clarifyIds = idsIn(stateText);
check(clarifyIds.length >= 1, 'memory_state prints the contradiction id');
if (clarifyIds.length >= 1) {
  const resolved = await clarifyTool.execute({ id: clarifyIds[0], resolution: 'keep_new' }, exec('memory_clarify'));
  check(resolved.resolved === true, 'memory_clarify resolves the id memory_state printed');
}

// --- the second write path has to agree with the first ----------------------
//
// `memory_remember` is the tool the model calls when it decides to record
// something, and its schema asks for a subject, so in a group the model writes
// "user" — which is exactly what the tool's own description tells it to write.
// `resolveSubject` then turned that into the owner, and a stranger's hobby was
// filed under the person the agent belongs to. The extractor had been taught
// about speakers; this path had not, so the two write paths disagreed about what
// a subject means and only one of them was wrong.
console.log('remember in a room');
const groupAgent = { session: { header: { id: 'qq:onebot:group:1070071261' } } };
const groupMessage = {
  id: 'g1',
  role: 'user',
  source: {
    kind: 'user',
    speaker: {
      id: '1405337008', name: '不想', kind: 'group', own: false, group: '1070071261',
    },
  },
  content: [{ type: 'text', text: '我喜欢钓鱼，周末都在水库边。' }],
};
let groupDecision = { kind: 'enter', messages: [groupMessage] };
for (const handler of handlers.get('agent/pre-step') ?? []) {
  groupDecision = await handler({
    agent: groupAgent, messages: [groupMessage], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => groupDecision);
}

const stored = db.prepare("SELECT speaker_name, channel FROM episodes WHERE session_id = ? AND actor = 'user'").get('qq:onebot:group:1070071261');
check(String(stored?.speaker_name ?? '') === '不想', 'the room recorded who actually spoke');
check(String(stored?.channel ?? '') === 'group', 'the room episode is marked as a room');

const rememberTool = tools.find((tool) => tool.name === 'memory_remember');
const inRoom = await rememberTool.execute(
  { subject: 'user', predicate: 'likes', object: '钓鱼' },
  {
    callId: 'g-c1', name: 'memory_remember', arguments: {}, signal: new AbortController().signal, agent: groupAgent,
  },
);
check(inRoom.stored === true, `memory_remember stored the fact (${inRoom.reason ?? 'ok'})`);
const visitorFact = db.prepare("SELECT subject FROM facts WHERE predicate = 'likes' AND object = '钓鱼' AND invalid_at IS NULL").get();
check(String(visitorFact?.subject ?? '') === '不想', `the fact belongs to the visitor (${String(visitorFact?.subject ?? 'none')})`);
const leakedToOwner = db.prepare("SELECT COUNT(*) AS c FROM facts WHERE subject = 'user' AND predicate = 'likes' AND object = '钓鱼'").get().c;
check(leakedToOwner === 0, `nothing about the visitor was filed under the owner (got ${leakedToOwner})`);

// The same call in a direct conversation must still land on the owner: the fix
// is a reason to look at the room, not a reason to stop trusting private
// conversations, which are the overwhelming majority of what this plugin sees.
const directStored = await rememberTool.execute(
  { subject: 'user', predicate: 'likes', object: '水库日落' },
  {
    callId: 'd-c1', name: 'memory_remember', arguments: {}, signal: new AbortController().signal, agent,
  },
);
check(directStored.stored === true, 'a private conversation still stores');
const ownerFact = db.prepare("SELECT subject FROM facts WHERE predicate = 'likes' AND object = '水库日落' AND invalid_at IS NULL").get();
check(String(ownerFact?.subject ?? '') === 'user', `a private fact stays with the owner (${String(ownerFact?.subject ?? 'none')})`);

// --- the other three write tools in a room -----------------------------------
//
// A visitor can talk the agent into calling any tool it has; a prompt injection
// does not need a special tool to be dangerous, it needs one that acts on the
// owner's data. Read access was closed above. These are the write paths that
// remain, and each one is closed for a different reason:
//
//   forget      — retiring the owner's beliefs on a stranger's say-so.
//   loop(open)  — a row nobody can read, listed to no one, closable by no one.
//   clarify     — a visitor picking which version of the owner's life is true.
//   consolidate — a batch job triggered from a room, rewriting the profile.
//
// The visitor's own facts stay forgettable: the room's record of itself is the
// room's, and someone who said something and wants it gone meant it.
console.log('the room cannot reach the owner');
const forgetInRoom = (id) => forgetTool.execute({ id, reason: 'stranger asked' }, {
  callId: 'g-f', name: 'memory_forget', arguments: {}, signal: new AbortController().signal, agent: groupAgent,
});
const ownerFactId = String(ownerFact === undefined ? '' : db.prepare("SELECT id FROM facts WHERE subject = 'user' AND predicate = 'likes' AND object = '水库日落'").get()?.id ?? '');
if (ownerFactId === '') {
  check(false, 'the fixture has an owner fact to refuse to forget');
} else {
  const refused = await forgetInRoom(ownerFactId.slice(0, 8));
  check(refused.retired === false, 'a room cannot forget the owner\'s fact');
  const survived = db.prepare('SELECT invalid_at FROM facts WHERE id = ?').get(ownerFactId);
  check(survived?.invalid_at === null, 'the owner\'s fact is still live after the attempt');
}

const visitorFactId = String(db.prepare("SELECT id FROM facts WHERE subject = '不想' AND object = '钓鱼' AND invalid_at IS NULL").get()?.id ?? '');
if (visitorFactId === '') {
  check(false, 'the fixture has a visitor fact the visitor may take back');
} else {
  const takenBack = await forgetInRoom(visitorFactId.slice(0, 8));
  check(takenBack.retired === true, 'a room can forget what was said in it');
}

const loopInRoom = await loopTool.execute({ action: 'open', text: '周四提醒我看医生' }, {
  callId: 'g-l', name: 'memory_loop', arguments: {}, signal: new AbortController().signal, agent: groupAgent,
});
check(loopInRoom.ok === false, 'a room cannot open a loop');
const loopCount = db.prepare('SELECT COUNT(*) AS c FROM open_loops').get().c;
check(loopCount === 1, `only the private loop exists (got ${loopCount})`);

// A fresh pending contradiction: the one above was already resolved, and asking
// this tool to resolve a row that is not pending would fail for the right reason
// but prove the wrong thing — a test that passes because its subject is absent
// is not a test of the refusal.
const pendingId = String(db.prepare("SELECT id FROM facts WHERE subject = 'user' AND invalid_at IS NULL LIMIT 1").get()?.id ?? '');
db.prepare('UPDATE facts SET needs_clarification = 1 WHERE id = ?').run(pendingId);
const clarifyInRoom = await clarifyTool.execute({ id: pendingId.slice(0, 8), resolution: 'keep_new' }, {
  callId: 'g-c', name: 'memory_clarify', arguments: {}, signal: new AbortController().signal, agent: groupAgent,
});
check(clarifyInRoom.resolved === false, 'a room cannot resolve a contradiction');
const stillPending = db.prepare('SELECT needs_clarification FROM facts WHERE id = ?').get(pendingId);
check(stillPending?.needs_clarification === 1, 'the contradiction is still waiting for the owner');
db.prepare('UPDATE facts SET needs_clarification = 0 WHERE id = ?').run(pendingId);

const consolidateInRoom = await tools.find((tool) => tool.name === 'memory_consolidate').execute({ force: true }, {
  callId: 'g-n', name: 'memory_consolidate', arguments: {}, signal: new AbortController().signal, agent: groupAgent,
});
check(consolidateInRoom.ran === false, 'a room cannot trigger a consolidation pass');

// --- teardown ---------------------------------------------------------------
console.log('teardown');
db.close();
for (const dispose of disposers) {
  await dispose();
}
check(true, 'disposers ran without throwing');

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
