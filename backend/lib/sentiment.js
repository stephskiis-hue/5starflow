/**
 * lib/sentiment — dependency-free rule-based sentiment classifier for inbound
 * client SMS replies. Returns "promoter" | "neutral" | "detractor".
 *
 * Intentionally simple and transparent (no ML/API call in the webhook hot path).
 * Good enough to segment clients for loyalty/upsell + flag unhappy replies fast.
 * Can be upgraded to a Claude call later behind the same function signature.
 */

const POSITIVE = [
  'love', 'loved', 'loving', 'great', 'awesome', 'amazing', 'excellent', 'perfect',
  'thank', 'thanks', 'thx', 'appreciate', 'appreciated', 'happy', 'fantastic',
  'wonderful', 'beautiful', 'best', 'incredible', 'outstanding', 'superb',
  'recommend', 'pleased', 'satisfied', 'good job', 'great job', 'nice job',
  'well done', 'looks good', 'looks great', 'looks amazing', '5 star', 'five star',
];

const NEGATIVE = [
  'bad', 'terrible', 'awful', 'horrible', 'disappointed', 'disappointing',
  'unhappy', 'poor', 'worst', 'slow', 'late', 'missed', 'unacceptable', 'refund',
  'complaint', 'complain', 'angry', 'upset', 'ridiculous', 'frustrated', 'frustrating',
  'mess', 'messy', 'damage', 'damaged', 'ruined', 'rude', 'overpriced', 'overcharged',
  'not happy', 'not good', 'not great', 'never again', 'waste',
];

const POSITIVE_EMOJI = ['👍', '❤', '🙏', '⭐', '😊', '😀', '😁', '🤩', '🥰', '💚', ':)', ':-)'];
const NEGATIVE_EMOJI = ['👎', '😡', '😠', '😤', '🤬', '😞', '😢', '☹', ':(', ':-('];

const NEGATORS = ["not", "no", "never", "dont", "don't", "didnt", "didn't", "wasnt",
  "wasn't", "isnt", "isn't", "wont", "won't", "cant", "can't", "couldnt", "couldn't",
  "wouldnt", "wouldn't", "hardly", "barely"];

function countOccurrences(haystack, needles) {
  let n = 0;
  for (const w of needles) {
    if (!w) continue;
    let idx = haystack.indexOf(w);
    while (idx !== -1) { n++; idx = haystack.indexOf(w, idx + w.length); }
  }
  return n;
}

/**
 * @param {string} body - raw inbound SMS text
 * @returns {'promoter'|'neutral'|'detractor'}
 */
function classifySentiment(body) {
  const text = String(body || '').toLowerCase().trim();
  if (!text) return 'neutral';

  let pos = countOccurrences(text, POSITIVE) + countOccurrences(text, POSITIVE_EMOJI);
  let neg = countOccurrences(text, NEGATIVE) + countOccurrences(text, NEGATIVE_EMOJI);

  // Basic negation: a negator within 2 words before a positive word flips it
  // ("not great", "didn't love it") → treat as a negative signal instead.
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/[^a-z']/g, '');
    if (POSITIVE.includes(t)) {
      const prev = [tokens[i - 1], tokens[i - 2]].map((x) => (x || '').replace(/[^a-z']/g, ''));
      if (prev.some((p) => NEGATORS.includes(p))) { pos--; neg++; }
    }
  }

  if (pos > neg) return 'promoter';
  if (neg > pos) return 'detractor';
  return 'neutral';
}

module.exports = { classifySentiment };
