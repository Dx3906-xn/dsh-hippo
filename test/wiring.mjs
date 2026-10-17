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

// --- tool round trip --------------------------------------------------------
console.log('tools');
const recallTool = tools.find((tool) => tool.name === 'memory_recall');
const recalled = await recallTool.execute({ query: '年糕', limit: 5 }, { callId: 'c1', name: 'memory_recall', arguments: {}, signal: new AbortController().signal });
check(recalled !== undefined, 'memory_recall returns a value');
check(JSON.stringify(recalled).includes('年糕'), 'memory_recall finds the cat');

const stateTool = tools.find((tool) => tool.name === 'memory_state');
const state = await stateTool.execute({}, { callId: 'c2', name: 'memory_state', arguments: {}, signal: new AbortController().signal });
check(typeof state?.facts === 'number', 'memory_state reports a fact count');

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
