/**
 * FSRS-lite: a scheduling model for *retrieval*, not for flashcards.
 *
 * FSRS normally needs a binary recall outcome. A companion agent never gets
 * one. We derive a grade from observable behaviour instead (did the retrieved
 * memory get used, did the user correct it), which is a heuristic with no
 * empirical backing — see {@link gradeFor}. What FSRS is actually good for
 * here is **relative ordering and timing**:
 *
 *   - `retrievability()` answers "is this memory about to be forgotten?", which
 *     is when reinforcing it is cheapest and most valuable.
 *   - `review()` makes important, repeatedly-used memories saturate, so they
 *     stop consuming extraction budget. That is the cost mechanism.
 *
 * Honest limitation, deliberately recorded here so nobody builds on sand:
 * FSRS absolute error is roughly 33%. Never delete on a low `stability`.
 * Deletion is opt-in and default-off; forgetting only lowers a memory's score.
 *
 * @module dsh-hippo/fsrs
 */

/** FSRS-5 default weights (19 parameters). */
export const W = Object.freeze([
  0.40255, 1.18385, 3.173, 15.69105, 7.1949,
  0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698,
  0.2315, 2.9898, 0.51655, 0.6621,
]);

/** Power-law decay exponent; FSRS fixes it at -0.5. */
export const DECAY = -0.5;

/** Factor that makes `retrievability(S, S) === 0.9`. */
export const FACTOR = 19 / 81;

const MS_PER_DAY = 86_400_000;

/** Stability is clamped into a sane band; also prevents division by zero. */
const MIN_STABILITY = 0.1;
const MAX_STABILITY = 36_500;

/**
 * Convert epoch milliseconds to days, guarding against clock skew.
 * @param {number} ms - duration in milliseconds.
 * @returns {number} non-negative days.
 */
export function msToDays(ms) {
  return Math.max(0, ms) / MS_PER_DAY;
}

/**
 * Probability the memory is still retrievable after `elapsedDays`.
 * @param {number} elapsedDays - days since the last successful review.
 * @param {number} stability - S in days.
 * @returns {number} retrievability in (0, 1].
 */
export function retrievability(elapsedDays, stability) {
  const s = Math.max(MIN_STABILITY, stability);
  return Math.pow(1 + FACTOR * Math.max(0, elapsedDays) / s, DECAY);
}

/**
 * Days until retrievability decays to `target`. Used to decide when a memory
 * becomes "fading" and worth reinforcing.
 * @param {number} stability - S in days.
 * @param {number} target - target retrievability, e.g. 0.9.
 * @returns {number} days.
 */
export function intervalFor(stability, target = 0.9) {
  const s = Math.max(MIN_STABILITY, stability);
  return (s / FACTOR) * (Math.pow(target, 1 / DECAY) - 1);
}

/**
 * Initial stability for a first exposure at grade `g`.
 * @param {number} g - grade 1..4.
 * @returns {number} stability in days.
 */
export function initialStability(g) {
  return clampStability(W[Math.min(3, Math.max(0, g - 1))]);
}

/**
 * Initial difficulty for a first exposure at grade `g`.
 * @param {number} g - grade 1..4.
 * @returns {number} difficulty in [1, 10].
 */
export function initialDifficulty(g) {
  return clampDifficulty(W[4] - Math.exp(W[5] * (g - 1)) + 1);
}

/**
 * Mean-reverting difficulty update (FSRS-5).
 * @param {number} difficulty - current D.
 * @param {number} g - grade 1..4.
 * @returns {number} updated D.
 */
export function nextDifficulty(difficulty, g) {
  const delta = -W[6] * (g - 3);
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  const reverted = W[7] * initialDifficulty(4) + (1 - W[7]) * damped;
  return clampDifficulty(reverted);
}

/**
 * Apply one review to a memory's scheduling state, in place.
 *
 * This is the function the doc's pseudo-code describes. Two deliberate
 * choices: a lapse (grade 1) may lower stability but never raise it, and a
 * successful recall can never lower it either.
 *
 * @param {{ stability: number, difficulty: number, lastReviewAt: number | null, reviewCount: number }} state
 *   mutable scheduling state; `lastReviewAt` is epoch milliseconds.
 * @param {number} g - grade 1 (again) .. 4 (easy).
 * @param {number} now - epoch milliseconds.
 * @returns {{ stability: number, difficulty: number, reviewCount: number }} the new state.
 */
export function review(state, g, now) {
  const grade = Math.min(4, Math.max(1, Math.round(g)));
  const last = state.lastReviewAt;
  const first = last === null || last === undefined || state.reviewCount === 0;

  if (first) {
    const stability = initialStability(grade);
    const difficulty = initialDifficulty(grade);
    return Object.assign(state, {
      stability,
      difficulty,
      lastReviewAt: now,
      reviewCount: 1,
    });
  }

  const elapsed = msToDays(now - last);
  const r = retrievability(elapsed, state.stability);

  let stability;
  if (grade === 1) {
    const lapsed = W[11]
      * Math.pow(state.difficulty, -W[12])
      * (Math.pow(state.stability + 1, W[13]) - 1)
      * Math.exp(W[14] * (1 - r));
    stability = Math.min(lapsed, state.stability);
  } else {
    const hardPenalty = grade === 2 ? W[15] : 1;
    const easyBonus = grade === 4 ? W[16] : 1;
    const inc = 1
      + Math.exp(W[8])
        * (11 - state.difficulty)
        * Math.pow(state.stability, -W[9])
        * (Math.exp(W[10] * (1 - r)) - 1)
        * hardPenalty
        * easyBonus;
    stability = state.stability * Math.max(1, inc);
  }

  return Object.assign(state, {
    stability: clampStability(stability),
    difficulty: nextDifficulty(state.difficulty, grade),
    lastReviewAt: now,
    reviewCount: state.reviewCount + 1,
  });
}

/**
 * Derive a review grade from observable behaviour.
 *
 * | situation                              | grade | rationale                          |
 * |----------------------------------------|-------|------------------------------------|
 * | user corrected something we said       | 1     | the memory was wrong              |
 * | recalled but the answer did not use it | 2     | retrieval noise                    |
 * | used, no reaction                      | 3     | ordinary successful recall         |
 * | user confirmed or restated it          | 4     | strongest evidence of relevance    |
 *
 * No citation exists for this mapping; it is a design choice, and it is the
 * first thing to revisit once real conversation data arrives (milestone M5).
 *
 * @param {boolean} usedInAnswer - whether the answer referenced the memory.
 * @param {'confirm'|'neutral'|'correct'|'ignore'} userReaction - observed reaction.
 * @returns {1|2|3|4} the grade.
 */
export function gradeFor(usedInAnswer, userReaction) {
  if (userReaction === 'correct') return 1;
  if (!usedInAnswer) return 2;
  if (userReaction === 'confirm') return 4;
  return 3;
}

/**
 * Clamp a stability into the supported band.
 * @param {number} value - raw stability.
 * @returns {number} clamped stability.
 */
export function clampStability(value) {
  if (!Number.isFinite(value)) return MIN_STABILITY;
  return Math.min(MAX_STABILITY, Math.max(MIN_STABILITY, value));
}

/**
 * Clamp a difficulty into [1, 10].
 * @param {number} value - raw difficulty.
 * @returns {number} clamped difficulty.
 */
export function clampDifficulty(value) {
  if (!Number.isFinite(value)) return 5;
  return Math.min(10, Math.max(1, value));
}
