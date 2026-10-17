/**
 * Emotional salience must change ranking, not just get stored.
 *
 * The failure this guards against is subtle and already happened once: arousal
 * was recorded into the `affect` table (so `memory_state` looked healthy and the
 * mood curve moved) while recall kept ranking on confidence alone. Two messages
 * about the same topic then came back in insertion order, and the memory that
 * mattered was the one that happened to be written first.
 */

import { openDatabase } from '../lib/db.js';
import { recordEpisode, recall } from '../lib/store.js';
import { detectAffect } from '../lib/gate.js';

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

const db = await openDatabase(':memory:');
const sessionId = 'salience-test';
const now = Date.now();

const calmText = '今天天气不错，我出去走了走。';
const loudText = '我妈住院了，我特别慌，整晚都睡不着。';

const calmAffect = detectAffect(calmText);
const loudAffect = detectAffect(loudText);
check('calm text carries no charge', calmAffect === null, JSON.stringify(calmAffect));
check('charged text is detected', loudAffect !== null);
check('charged text has real arousal', (loudAffect?.arousal ?? 0) > 0.2, String(loudAffect?.arousal));

// Same topic in both, so the FTS rank is identical and only salience can
// separate them. The calm one is written first, so insertion order favours it.
recordEpisode(db, {
  sessionId,
  actor: 'user',
  text: `${calmText} 医院那边没什么事。`,
  at: now - 1000,
  arousal: 0,
});
recordEpisode(db, {
  sessionId,
  actor: 'user',
  text: `${loudText} 医院那边没什么事。`,
  at: now,
  arousal: loudAffect?.arousal ?? 0,
});

const recalled = recall(db, { cue: '医院那边没什么事', userId: 'user', limit: 5, includeFacts: false });
check('both episodes retrieved', recalled.episodes.length === 2, String(recalled.episodes.length));
check(
  'the charged episode outranks the calm one',
  String(recalled.episodes[0]?.text ?? '').includes('住院'),
  recalled.episodes.map((row) => `${row.text.slice(0, 12)}@${row.score.toFixed(3)}`).join(' | '),
);

// Arousal must survive the write path, or a restart silently loses the signal.
const stored = db.prepare('SELECT arousal FROM episodes WHERE session_id = ? ORDER BY at').all(sessionId);
check('arousal is persisted', Number(stored[1]?.arousal) > 0.2, String(stored[1]?.arousal));
check('calm episode stores zero arousal', Number(stored[0]?.arousal) === 0, String(stored[0]?.arousal));

// Out-of-range values are clamped at write time rather than corrupting scores.
recordEpisode(db, { sessionId, actor: 'user', text: '测试越界', at: now + 1000, arousal: 9 });
const clamped = db.prepare("SELECT arousal FROM episodes WHERE text = '测试越界'").get();
check('arousal is clamped to 1', Number(clamped?.arousal) === 1, String(clamped?.arousal));

db.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
