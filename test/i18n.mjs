/**
 * Language coverage.
 *
 * Everything the plugin says to the model is prose, and prose has two languages.
 * The Chinese path is the one exercised all day; these checks exist so the English
 * path cannot rot into half-translated lines like "- today, 对方说过: ...".
 */

import { openDatabase } from '../lib/db.js';
import { addFact, recordEpisode, addOpenLoop } from '../lib/store.js';
import { renderResident, renderRecall, renderTimeContext } from '../lib/prompt.js';
import { renderAgenda, describeTerm } from '../lib/agenda.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

/** True when the text contains any CJK codepoint. */
function hasCjk(text) {
  return /[\u3400-\u9fff]/.test(text);
}

const db = await openDatabase(':memory:');
const now = Date.now();

addFact(db, { subject: 'user', predicate: 'name', object: 'Lin Wan', confidence: 0.95, pinned: true });
addFact(db, { subject: 'user', predicate: 'lives_in', object: 'Hefei', confidence: 0.9 });
addFact(db, { subject: 'user', predicate: 'goal', object: 'to adopt a cat', confidence: 0.8 });
addFact(db, { subject: 'mother', predicate: 'health', object: 'diabetes, currently managed', confidence: 0.9, sensitivity: 'sensitive' });
recordEpisode(db, { sessionId: 's1', actor: 'user', text: 'I moved to Hefei last month.', at: now });
recordEpisode(db, { sessionId: 's1', actor: 'agent', text: 'Noted, Hefei it is.', at: now });
addOpenLoop(db, { userId: 'user', text: 'she is trying to quit smoking', followAfter: now - 3_600_000 });

console.log('resident');
{
  const text = renderResident(db, { userId: 'user', now, language: 'en' });
  check(text.length > 0, 'renders something');
  check(!hasCjk(text), 'contains no Chinese characters');
  check(text.includes('## What you remember'), 'English heading');
  check(text.includes('People around them'), 'English section for other people');
  check(text.includes('mother'), 'names the other person');
  check(!text.includes('对方身边的人'), 'no Chinese section heading');
  check(!text.includes('{{'), 'no bare mustache');
}

console.log('recall');
{
  const recall = {
    facts: [{ predicate: 'lives_in', object: 'Hefei' }],
    episodes: [
      { actor: 'user', text: 'I moved to Hefei last month.', at: now },
      { actor: 'agent', text: 'Noted, Hefei it is.', at: now },
    ],
  };
  const text = renderRecall(recall, { language: 'en' });
  check(text.includes('they said'), 'uses "they said" for the person');
  check(text.includes('you said'), 'uses "you said" for the agent');
  check(!hasCjk(text), 'contains no Chinese characters');
}

console.log('time context');
{
  const text = renderTimeContext(now, 'en');
  check(!hasCjk(text), 'contains no Chinese characters');
  check(/night|morning|noon|afternoon|evening|late/.test(text), 'names a part of the day');
}

console.log('agenda');
{
  const text = renderAgenda(db, { userId: 'user', now, language: 'en' });
  check(text.length > 0, 'renders something');
  check(!hasCjk(text), 'contains no Chinese characters');
  check(text.includes('quit smoking'), 'carries the loop text');
}

console.log('terms');
{
  check(describeTerm('lives_in', 'en') !== describeTerm('lives_in', 'zh'), 'predicate labels differ per language');
  check(!hasCjk(describeTerm('health', 'en')), 'English term has no Chinese');
  check(!/[\u3400-\u9fff]/.test(describeTerm('mbti', 'en')), 'fallback term has no Chinese');
}

db.close();

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
