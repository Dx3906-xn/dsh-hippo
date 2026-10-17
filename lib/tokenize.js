/**
 * Tokenization for mixed Chinese/English text.
 *
 * Why this module exists: SQLite's FTS5 `unicode61` tokenizer splits on
 * whitespace and punctuation, so a whole Chinese sentence becomes ONE token.
 * Searching `加班` against `我最近老是加班` returns nothing. We therefore
 * pre-segment text into bigrams ourselves and store the segmented form in the
 * FTS index, then segment the query the same way.
 *
 * Measured on this machine (Node 24.15.0 / node:sqlite): unicode61 returns 0
 * rows for a Chinese substring query; bigram segmentation matches correctly.
 *
 * @module dsh-hippo/tokenize
 */

/** CJK ideographs we segment (BMP main block plus extension A). */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Characters that never carry memory content on their own. */
const STOP_CHARS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '和', '与', '就', '都', '也', '还', '又', '而', '但', '或',
  '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '嘛', '么', '着',
  '有', '没', '不', '很', '太', '这', '那', '哪', '什', '怎',
]);

/** English stop words dropped from the index and from queries. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'for',
  'from', 'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in',
  'is', 'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'she', 'so', 'that', 'the', 'their', 'them', 'then', 'there', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'will', 'with', 'you', 'your',
]);

/**
 * Normalize text before segmentation: NFKC folds full-width forms and
 * compatibility ideographs, lowercase folds case, and collapsing whitespace
 * keeps the segmented column compact.
 * @param {string} text - raw text.
 * @returns {string} normalized text.
 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split normalized text into index terms.
 *
 * Chinese runs become overlapping bigrams (a lone character stays a unigram so
 * single-syllable queries still hit). Latin/digit runs become whole words.
 *
 * @param {string} text - raw or normalized text.
 * @param {{ keepStop?: boolean }} [options] - `keepStop` keeps stop words,
 *   which is correct for indexing (they carry position information) and wrong
 *   for query construction.
 * @returns {string[]} terms in text order.
 */
export function tokenize(text, options = {}) {
  const keepStop = options.keepStop === true;
  const normalized = normalize(text);
  const terms = [];
  let cjkRun = '';
  let wordRun = '';

  const flushCjk = () => {
    if (cjkRun.length === 0) return;
    if (cjkRun.length === 1) {
      if (keepStop || !STOP_CHARS.has(cjkRun)) terms.push(cjkRun);
    } else {
      for (let i = 0; i + 1 < cjkRun.length; i++) {
        const bigram = cjkRun.slice(i, i + 2);
        if (keepStop || !STOP_CHARS.has(bigram[0]) || !STOP_CHARS.has(bigram[1])) {
          terms.push(bigram);
        }
      }
    }
    cjkRun = '';
  };

  const flushWord = () => {
    if (wordRun.length === 0) return;
    if (keepStop || !STOP_WORDS.has(wordRun)) terms.push(wordRun);
    wordRun = '';
  };

  for (const ch of normalized) {
    if (CJK.test(ch)) {
      flushWord();
      cjkRun += ch;
    } else if (/[a-z0-9_]/.test(ch)) {
      flushCjk();
      wordRun += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return terms;
}

/**
 * Build the segmented string stored in the FTS index.
 * @param {string} text - raw text.
 * @returns {string} space-joined index terms.
 */
export function segment(text) {
  return tokenize(text, { keepStop: true }).join(' ');
}

/**
 * Build an FTS5 MATCH expression from free text.
 *
 * Terms are OR-ed: a memory should surface when it shares *any* content word
 * with the cue, and the scorer decides how much that matters. Every term is
 * quoted so FTS5 syntax characters inside user text cannot break the query.
 *
 * @param {string} text - the cue text.
 * @returns {string | null} a MATCH expression, or null when the cue has no
 *   usable terms (empty query, punctuation only, stop words only).
 */
export function matchExpression(text) {
  const terms = [...new Set(tokenize(text))].filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * Rough token estimate used for budget accounting. Chinese characters cost
 * about one token each; Latin text costs about one token per four characters.
 * It is deliberately cheap and monotone rather than exact — budgets only ever
 * compare magnitudes.
 * @param {string} text - text to measure.
 * @returns {number} estimated tokens.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk++;
  const rest = s.length - cjk;
  return cjk + Math.ceil(rest / 4);
}
