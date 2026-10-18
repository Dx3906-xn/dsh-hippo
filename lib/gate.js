/**
 * Gate 1: should this message be extracted at all?
 *
 * This is the single most important cost control in the whole system. Every
 * message is archived as an episode (cheap, no model call); only a minority
 * should trigger an LLM extraction pass. The design target is ~30%.
 *
 * Being wrong here has asymmetric costs:
 *   false positive → wasted tokens on a message that held nothing;
 *   false negative → something the user said is never remembered.
 *
 * So the rules below are recall-oriented: they fire on weak signals, and the
 * extractor is allowed to return nothing.
 *
 * @module dsh-hippo/gate
 */

/** Phrases that explicitly ask the agent to remember something. */
const EXPLICIT_REMEMBER = [
  '记住', '记一下', '记下', '别忘了', '别忘记', '你要记得', '帮我记',
  '以后都', '以后叫', '以后要', '从现在开始', '从今天起', '下次',
  'remember', 'keep in mind', 'from now on', 'don\'t forget',
];

/** Self-disclosure markers: the user is describing themselves. */
const SELF_DISCLOSURE = [
  '我是', '我叫', '我的', '我在', '我做', '我住', '我今年', '我生日',
  '我喜欢', '我爱', '我讨厌', '我不喜欢', '我习惯', '我怕', '我担心',
  '我想要', '我希望', '我打算', '我计划', '我准备', '我正在',
  '我有个', '我有一个', '我养了', '我家里',
  'my name', 'i am', 'i\'m', 'i like', 'i love', 'i hate', 'i work',
  'i live', 'i have', 'i want', 'i plan',
];

/** Relationship events worth remembering even though they are transient. */
const RELATIONSHIP_EVENT = [
  '第一次', '生日', '纪念日', '分手', '在一起', '告白', '吵架', '和好',
  '难过', '开心', '焦虑', '失眠', '辞职', '入职', '搬家', '考试',
  '面试', '生病', '住院', '去世', '结婚', '离婚', '怀孕',
];

/** Commitment / future-intent markers; these also seed open loops. */
const COMMITMENT = [
  '明天', '后天', '下周', '下个月', '明年', '待会', '一会儿', '晚点',
  '回头', '到时候', '约好', '答应', '说好', '要去看', '要去', '准备去',
  'tomorrow', 'next week', 'later', 'i will', 'i\'ll',
];

/** Corrections: the user is telling us a memory is wrong. */
const CORRECTION = [
  '不对', '不是', '错了', '搞错', '记错', '你弄错', '说反了', '其实不是',
  'no,', 'that\'s wrong', 'not true', 'actually',
];

/**
 * Detect which extraction triggers a message fires.
 *
 * @param {string} text - the raw user message.
 * @param {{ recentUserText?: string, unansweredTokens?: number }} [context]
 *   - `recentUserText` is the last few turns, used to notice a topic the user
 *   keeps returning to; `unansweredTokens` is the batch fallback counter.
 * @returns {{
 *   extract: boolean,
 *   reasons: string[],
 *   explicit: boolean,
 *   commitment: boolean,
 *   correction: boolean,
 *   affect: boolean,
 * }}
 *   the decision and the evidence behind it.
 */
export function shouldExtract(text, context = {}) {
  const normalized = String(text ?? '').toLowerCase();
  const reasons = [];

  if (normalized.trim().length === 0) {
    return { extract: false, reasons: ['empty'], explicit: false, commitment: false, correction: false, affect: false };
  }

  const explicit = hits(normalized, EXPLICIT_REMEMBER);
  if (explicit) reasons.push('explicit');

  const disclosure = hits(normalized, SELF_DISCLOSURE);
  if (disclosure) reasons.push('self-disclosure');

  const relationship = hits(normalized, RELATIONSHIP_EVENT);
  if (relationship) reasons.push('relationship-event');

  const commitment = hits(normalized, COMMITMENT);
  if (commitment) reasons.push('commitment');

  const correction = hits(normalized, CORRECTION);
  if (correction) reasons.push('correction');

  const affect = detectAffect(normalized);
  if (affect !== null) reasons.push('affect');

  // Batch fallback: enough unprocessed text accumulates that a sweep is worth
  // it even without a specific signal.
  if ((context.unansweredTokens ?? 0) >= 2000) reasons.push('batch');

  return {
    extract: reasons.length > 0,
    reasons,
    explicit: explicit !== null,
    commitment: commitment !== null,
    correction: correction !== null,
    affect: affect !== null,
  };
}

/**
 * Find the first phrase from a list that occurs in the text.
 * @param {string} text - lowercased text.
 * @param {string[]} phrases - phrases to look for.
 * @returns {string | null} the matched phrase, or null.
 */
function hits(text, phrases) {
  for (const phrase of phrases) {
    if (text.includes(phrase)) return phrase;
  }
  return null;
}

/**
 * Negative-valence vocabulary, weighted by how strong the word is.
 *
 * Single-character entries are a hazard: 怕 matches 不怕 and 恐怕, 累 matches
 * 积累. They are kept anyway, because in Chinese the bare word is far more
 * common than the compound in first-person speech, and the cost of a false
 * positive here is one slightly over-weighted memory — while the cost of a
 * false negative is an emotionally important moment scoring as neutral.
 */
const NEGATIVE = new Map([
  ['难过', 0.7], ['伤心', 0.8], ['痛苦', 0.9], ['焦虑', 0.7], ['抑郁', 0.9],
  ['累', 0.4], ['烦', 0.5], ['生气', 0.6], ['害怕', 0.7], ['孤独', 0.8],
  ['失望', 0.7], ['崩溃', 0.9], ['哭', 0.7], ['压力', 0.6], ['失眠', 0.6],
  ['怕', 0.6], ['担心', 0.5], ['紧张', 0.5], ['慌', 0.6], ['委屈', 0.7],
  ['无助', 0.8], ['后悔', 0.6], ['心疼', 0.6], ['难受', 0.6], ['绝望', 1.0],
  ['sad', 0.7], ['anxious', 0.7], ['depressed', 0.9], ['tired', 0.4],
  ['angry', 0.6], ['lonely', 0.8], ['scared', 0.7], ['afraid', 0.7],
  ['worried', 0.5], ['nervous', 0.5], ['upset', 0.6],
]);

/** Positive-valence vocabulary. */
const POSITIVE = new Map([
  ['开心', 0.7], ['高兴', 0.7], ['快乐', 0.8], ['喜欢', 0.5], ['爱', 0.7],
  ['兴奋', 0.7], ['期待', 0.6], ['满意', 0.6], ['幸福', 0.9], ['放松', 0.5],
  ['舒服', 0.5], ['踏实', 0.6], ['安心', 0.6], ['骄傲', 0.6], ['感动', 0.7],
  ['happy', 0.7], ['excited', 0.7], ['love', 0.7], ['glad', 0.6],
  ['relieved', 0.6], ['proud', 0.6], ['grateful', 0.7],
]);

/** High-arousal vocabulary; independent of valence. */
const AROUSAL = new Map([
  ['太', 0.3], ['非常', 0.4], ['特别', 0.4], ['超级', 0.5], ['真的', 0.3],
  ['！', 0.3], ['!!', 0.5], ['急', 0.6], ['马上', 0.4], ['突然', 0.5],
  ['真的假的', 0.6], ['天啊', 0.7], ['崩溃', 0.8],
]);

/**
 * Cheap lexicon-based affect estimate.
 *
 * Deliberately not an LLM call: this runs on every message, and a 60-token
 * signal is not worth 400 tokens of inference. The estimate is used for
 * salience weighting only, so being coarse is acceptable.
 *
 * @param {string} text - lowercased text.
 * @returns {{ valence: number, arousal: number, salience: number } | null}
 *   `null` when no affect vocabulary is present at all.
 */
export function detectAffect(text) {
  let valence = 0;
  let arousal = 0;
  let intensity = 0;
  let found = false;
  for (const [word, weight] of NEGATIVE) {
    if (text.includes(word)) {
      valence -= weight;
      // Strong emotion is inherently arousing. Leaving arousal to intensifiers
      // alone meant "我妈住院了，我特别慌" scored the same as a merely emphatic
      // remark, because none of 慌/住院 appear in the AROUSAL table.
      intensity = Math.max(intensity, weight);
      found = true;
    }
  }
  for (const [word, weight] of POSITIVE) {
    if (text.includes(word)) {
      valence += weight;
      intensity = Math.max(intensity, weight * 0.8);
      found = true;
    }
  }
  for (const [word, weight] of AROUSAL) {
    if (text.includes(word)) arousal += weight;
  }
  if (!found) return null;
  // Clamp: a sentence listing five sad words is not five times as sad.
  const clamped = Math.max(-1, Math.min(1, valence / 2));
  // Intensity and intensifiers both feed arousal, and neither alone is enough:
  // a bare emotion word is still charged, while emphasis with no emotion word is
  // just loud punctuation.
  const rawArousal = arousal / 2 + intensity * 0.6;
  return {
    valence: clamped,
    arousal: Math.min(1, rawArousal),
    // Emotionally loaded content is remembered better; this is the single
    // strongest empirically-supported effect in the whole module.
    salience: 0.5 + Math.abs(clamped) * 0.4 + Math.min(1, rawArousal) * 0.2,
  };
}

/**
 * Detect whether the user is asking us to recall something, which licenses the
 * expensive third retrieval stage.
 * @param {string} text - the raw user message.
 * @returns {boolean} true when a deep recall is warranted.
 */
export function asksForRecall(text) {
  const normalized = String(text ?? '').toLowerCase();
  return [
    '你还记得', '记得吗', '记不记得', '之前说', '上次说', '我跟你说过',
    '以前说', '你说过', '我提过', '还记得',
    'do you remember', 'did i tell you', 'i told you', 'you said',
  ].some((phrase) => normalized.includes(phrase));
}

/**
 * Detect a request to forget or to stop tracking something.
 * @param {string} text - the raw user message.
 * @returns {boolean} true when a forget intent is present.
 */
export function asksToForget(text) {
  const normalized = String(text ?? '').toLowerCase();
  return [
    '忘掉', '忘记这个', '不要记', '别记', '删掉记忆', '清除记忆',
    'forget this', 'don\'t remember', 'delete that memory',
  ].some((phrase) => normalized.includes(phrase));
}

/**
 * Does this message tell a just-recalled memory that it was wrong?
 *
 * Narrower than {@link shouldExtract}'s correction signal on purpose. "其实" and
 * "actually" are ordinary discourse markers — "其实我挺喜欢" is not a correction
 * of anything — but in front of a memory that was just shown, "不是杭州" is
 * unmistakably a rejection of it. The cost of being wrong is asymmetric: a false
 * positive lowers the stability of a row that was merely mentioned, while a false
 * negative leaves a wrong memory looking well-rehearsed.
 *
 * @param {string | null | undefined} text - the raw message.
 * @returns {boolean} whether it reads as a correction.
 */
export function detectCorrectionIn(text) {
  const source = String(text ?? '').toLowerCase();
  if (source.trim().length === 0) return false;
  // "其实" and "actually" need a negator beside them to count.
  const hard = ['不对', '不是', '错了', '搞错', '记错', '弄错', '说反了', '记反', '你记错'];
  if (hard.some((phrase) => source.includes(phrase))) return true;
  return /(其实|actually)[^。！？]{0,6}(不|没|别再)/.test(source);
}

/**
 * Explicit trust signals, split by direction.
 *
 * Trust is the one relational scalar that must never be inferred from volume.
 * A companion that becomes more trusting because it has heard a lot of words is
 * a companion that mistakes intimacy for agreement. So it only moves when the
 * person says something that is *about* the relationship: a correction of the
 * agent's behaviour, a disclosure that assumes discretion, or an explicit
 * statement of comfort.
 *
 * @param {string} text - the raw user message.
 * @returns {{ delta: number, reason: string } | null} the trust change, if any.
 */
export function detectTrustSignal(text) {
  const normalized = String(text ?? '').toLowerCase();
  const repaired = [
    '你刚才不该', '你别这么说', '别这样说', '你不该', '你误会了', '我不是这个意思',
    '别安慰我', '不要说教', '不用劝我', '你太官方了',
    'that was not okay', 'you misunderstood', 'stop saying', 'don\'t patronize me',
  ];
  const disclosure = [
    '我只跟你说', '别告诉别人', '这话我没跟别人说', '只有你知道', '我信任你',
    '跟你说话很轻松', '和你说这些', '我不太跟别人讲',
    'i trust you', 'only you know', 'between us', 'i have not told anyone',
  ];
  const boundary = [
    '我们换个话题', '不想聊这个', '别问了', '这个不聊',
    'change the subject', 'i would rather not', 'drop it',
  ];
  if (repaired.some((phrase) => normalized.includes(phrase))) return { delta: 0.04, reason: 'repaired' };
  if (disclosure.some((phrase) => normalized.includes(phrase))) return { delta: 0.06, reason: 'disclosure' };
  if (boundary.some((phrase) => normalized.includes(phrase))) return { delta: -0.03, reason: 'boundary' };
  return null;
}
