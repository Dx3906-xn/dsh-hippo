// End-to-end consolidation check with a stub model: proves the pipeline
// (load batch -> extract -> audit -> apply) works without spending tokens.
import { openDatabase, ensureSchema } from '../lib/db.js';
import { recordEpisode, liveFacts, pendingClarifications, unconsolidatedEpisodes } from '../lib/store.js';
import { consolidate } from '../lib/consolidate.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const db = await openDatabase(':memory:');
ensureSchema(db);
const owner = 'probe-owner';
const session = 'probe-session';

recordEpisode(db, { sessionId: session, actor: 'user', text: '我家猫叫年糕，是只橘猫。' });
recordEpisode(db, { sessionId: session, actor: 'user', text: '我其实最喜欢喝美式，不太喝拿铁。' });
recordEpisode(db, { sessionId: session, actor: 'agent', text: '记下了。' });
recordEpisode(db, { sessionId: session, actor: 'user', text: '我住在上海。' });
recordEpisode(db, { sessionId: session, actor: 'user', text: '下周要去杭州出差三天。' });

console.log('pipeline');
let extractCalls = 0;
const llm = {
  async complete(request) {
    extractCalls++;
    if (String(request.system).includes('audit') || String(request.system).includes('AUDIT')) {
      return { text: JSON.stringify({ approved: [{ index: 0, confidence: 0.9 }, { index: 1, confidence: 0.9 }], rejected: [] }) };
    }
    return {
      text: JSON.stringify({
        facts: [
          { subject: 'user', predicate: 'has_pet', object: '年糕（橘猫）', confidence: 0.95, sensitivity: 'personal', episode: 0 },
          { subject: 'user', predicate: 'likes', object: '美式咖啡', confidence: 0.85, sensitivity: 'personal', episode: 1 },
          { subject: 'user', predicate: 'lives_in', object: '上海', confidence: 0.9, sensitivity: 'personal', episode: 3 },
        ],
      }),
    };
  },
};

const result = await consolidate({ db, llm, userId: owner, language: 'zh' }, { force: true });
check(result.ran === true, 'consolidation ran');
check(result.episodes === 5, `batch covered 5 episodes (got ${result.episodes})`);
check(extractCalls >= 1, 'model was called');

const facts = liveFacts(db, { userId: owner });
check(facts.length === 3, `three facts stored (got ${facts.length})`);
check(facts.some((f) => f.predicate === 'has_pet'), 'cat fact present');
check(facts.some((f) => f.object.includes('上海')), 'city fact present');

console.log('second pass');
const before = facts.length;
const again = await consolidate({ db, llm, userId: owner }, { force: true });
check(again.ran === false || again.factsAdded === 0, 'nothing new to add on a drained log');
check(liveFacts(db, { userId: owner }).length === before, 'live fact count unchanged');

console.log('marking');
check(unconsolidatedEpisodes(db, 100).length === 0, 'all episodes marked consolidated');

console.log('blank log');
const empty = await consolidate({ db, llm, userId: owner }, { force: true });
check(empty.ran === false, 'empty log short-circuits');

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
