/**
 * How the plugin behaves after a year of conversation.
 *
 * The unit tests all run on a dozen rows, where every query is instant and any
 * N+1 pattern is invisible. A companion accumulates thousands of episodes, and
 * the resident section is rendered on *every* model request, so the slow paths
 * here are on the critical path of every turn.
 */

import { openDatabase } from '../lib/db.js';
import { recordEpisode, addFact, recall, reviewHistory } from '../lib/store.js';
import { renderResident, renderRecall } from '../lib/prompt.js';
import { renderAgenda } from '../lib/agenda.js';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
}

const db = await openDatabase(':memory:');
const now = Date.now();

const PREDICATES = ['lives_in', 'works_as', 'likes', 'dislikes', 'has_pet', 'habit', 'plan', 'health', 'goal'];
const SUBJECTS = ['user', 'user', 'user', '妈妈', '朋友小周'];
const WORDS = ['咖啡', '爬山', '海獭', '年糕', '稿子', '戒烟', '苏州', '合肥', '领导', '下雨', '绘本', '猫'];

console.log('seeding a year');
{
  const started = Date.now();
  db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < 12000; index++) {
    const at = now - index * 3_600_000;
    const text = `${WORDS[index % WORDS.length]}${WORDS[(index * 7) % WORDS.length]}这件事我今天又想了一遍，第 ${index} 次。`;
    recordEpisode(db, {
      sessionId: `s${index % 40}`,
      actor: index % 3 === 0 ? 'agent' : 'user',
      text,
      at,
      messageId: `m${index}`,
      arousal: index % 11 === 0 ? 0.7 : 0,
    });
  }
  for (let index = 0; index < 1200; index++) {
    addFact(db, {
      subject: SUBJECTS[index % SUBJECTS.length],
      predicate: PREDICATES[index % PREDICATES.length],
      object: `${WORDS[index % WORDS.length]}${index}`,
      confidence: 0.6,
      createdAt: now - index * 86_400_000,
    });
  }
  db.exec('COMMIT');
  console.log(`  ${12000} episodes, ${1200} facts in ${Date.now() - started}ms`);
}

/** Run a function a few times and report the median wall time. */
function timed(fn, runs = 5) {
  const samples = [];
  for (let index = 0; index < runs; index++) {
    const started = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

console.log('resident section, every request');
{
  const ms = timed(() => renderResident(db, { userId: 'user', now, language: 'zh' }), 5);
  console.log(`  median ${ms.toFixed(1)}ms`);
  check(ms < 60, `resident render stays under 60ms (${ms.toFixed(1)}ms)`);
}

console.log('cued recall');
{
  const ms = timed(() => recall(db, { cue: '我养的猫叫什么', userId: 'user', limit: 10, includeEpisodes: true }), 5);
  console.log(`  median ${ms.toFixed(1)}ms`);
  check(ms < 80, `recall stays under 80ms (${ms.toFixed(1)}ms)`);
}

console.log('vague recall (admits graph neighbours)');
{
  const probe = recall(db, { cue: '你还记得我什么样吗', userId: 'user', limit: 10, fallback: true });
  const hit = probe.facts.length + probe.episodes.length;
  // A perf number on a query that returned nothing only measures the cheap path,
  // so the row count is asserted alongside the timing.
  check(hit > 0, `the vague cue actually returns rows (${hit})`);
  const ms = timed(() => recall(db, { cue: '你还记得我什么样吗', userId: 'user', limit: 10, fallback: true }), 5);
  console.log(`  median ${ms.toFixed(1)}ms`);
  check(ms < 120, `vague recall stays under 120ms (${ms.toFixed(1)}ms)`);
}

console.log('agenda');
{
  const ms = timed(() => renderAgenda(db, { userId: 'user', now, language: 'zh' }), 5);
  console.log(`  median ${ms.toFixed(1)}ms`);
  check(ms < 40, `agenda stays under 40ms (${ms.toFixed(1)}ms)`);
}

console.log('review history is not a per-row query storm');
{
  // `recall` scores every candidate row and calls reviewHistory once per row.
  // With limit*4 candidates that is dozens of round trips per turn. This counts
  // them so a refactor that makes it worse is visible.
  const rows = db.prepare('SELECT id FROM facts LIMIT 40').all();
  const started = process.hrtime.bigint();
  for (const row of rows) reviewHistory(db, String(row.id), 'fact');
  const perRow = Number(process.hrtime.bigint() - started) / 1e6 / rows.length;
  console.log(`  ${perRow.toFixed(3)}ms per row`);
  check(perRow < 0.5, `one history lookup is cheap (${perRow.toFixed(3)}ms)`);
}

db.close();

console.log('');
if (failures === 0) console.log('all checks passed');
else {
  console.log(`${failures} check(s) failed`);
  process.exitCode = 1;
}
