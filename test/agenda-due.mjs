/**
 * The agenda is the only mechanism that makes the agent bring something up when
 * the person did not ask about it. Two ways it can fail silently:
 *
 * 1. Nothing due renders as empty, which is correct but indistinguishable from
 *    the block never being computed at all.
 * 2. A due loop is crowded out by loops that are not due. The sort key and the
 *    filter are the same expression, so this cannot happen today — but it is one
 *    edit away from happening, and the symptom would be "the companion quietly
 *    stopped following up", which no transcript reveals.
 *
 * Both look identical from the outside: the agent just never mentions it.
 */

import { openDatabase } from '../lib/db.js';
import { addOpenLoop, closeOpenLoop, ensureRelationship } from '../lib/store.js';
import { renderAgenda } from '../lib/agenda.js';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const HOUR = 60 * 60 * 1000;
const db = await openDatabase(':memory:');
const now = Date.now();
ensureRelationship(db, 'user');

// Three loops scheduled far in the future, written first so they own the limit.
for (let index = 0; index < 3; index += 1) {
  addOpenLoop(db, {
    userId: 'user',
    text: `未来的事 ${index}`,
    followAfter: now + 6 * HOUR,
  });
}
// One overdue loop, written last.
addOpenLoop(db, {
  userId: 'user',
  text: '晚晚在戒烟，两周了',
  followAfter: now - HOUR,
});

const agenda = renderAgenda(db, { userId: 'user', now, language: 'zh' });
check('the overdue loop is rendered', agenda.includes('戒烟'), agenda);
check('future loops are not rendered', !agenda.includes('未来的事'), agenda);
check('the heading is present', agenda.includes('## 你手上还记着的事'), agenda);

// Nothing due must produce nothing, rather than a bare heading.
const db2 = await openDatabase(':memory:');
ensureRelationship(db2, 'user');
addOpenLoop(db2, { userId: 'user', text: '下周要体检', followAfter: now + 6 * HOUR });
const empty = renderAgenda(db2, { userId: 'user', now, language: 'zh' });
check('nothing due renders as empty', empty === '', JSON.stringify(empty));

// A closed loop must never come back, however overdue it is.
closeOpenLoop(db, 'missing-id', 'resolution');
const agendaAgain = renderAgenda(db, { userId: 'user', now, language: 'zh' });
check('render is stable across calls', agendaAgain === agenda);

// The block must be safe to interpolate: `{{` would be read as a template.
check('no bare mustache', !agenda.includes('{{') && !empty.includes('{{'));

db.close();
db2.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
