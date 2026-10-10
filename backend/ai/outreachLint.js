/**
 * Hard text gate for everything the Social agent posts or sends (comments, DMs, group and page posts, stories).
 * A faithful port of HQ/tools/qa.py (the rules the HQ routines ran on), so retiring HQ does not loosen anything.
 * Rules: never a price, discount, percentage or guarantee; "free" only for a free quote; no dashes mid-sentence;
 * the name spelled exactly "No-Bs Yardwork"; only our phone number; emoji and length limits per kind.
 * Returns { errors[], warnings[] }. Errors block the action at POST /api/ai/social/actions/reserve.
 */
const PHONE = '204-900-0438';
const BRAND = 'No-Bs Yardwork';

const LIMITS = { // kind: [max emoji, max chars]
  comment: [1, 600], dm: [1, 900], fb_post: [2, 1500], ig_caption: [2, 2200], story: [1, 250], group_post: [2, 1500],
};
// U+2605 (the star used for Google ratings) is allowed; everything else pictographic counts.
const EMOJI = /[\u{1F300}-\u{1FAFF}☀-☄☆-➿⭐⬆↔-↪]/gu;

/** Map a SocialAction kind (and platform) to the lint kind. */
function lintKindFor(kind, platform) {
  if (kind === 'page_post') return platform === 'instagram' ? 'ig_caption' : 'fb_post';
  if (kind === 'reply') return 'comment';
  return LIMITS[kind] ? kind : 'comment';
}

function lintOutreach(text, kind = 'comment') {
  const errors = []; const warnings = [];
  const t = String(text || '');
  // strip URLs so page handles like No.BS.Yardworks do not trip the name check
  const body = t.replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|ca)\S*/gi, ' ');

  if (/\$\s?\d|\d\s?\$|\b\d+(\.\d+)?\s?(dollars|bucks|cad)\b/i.test(body)) errors.push('Mentions a price. Never show or quote a price.');
  if (/\b\d+\s?%\s?(off)?|\bpercent off\b|\bdiscount|\bcoupon|\bpromo code/i.test(body)) errors.push('Mentions a discount or percentage.');
  if (/\bguarantee/i.test(body)) errors.push('Mentions a guarantee (none approved).');
  if (/\bfree\b(?!\s+(quote|quotes|estimate|estimates))/i.test(body)) errors.push('Says "free" about something other than a quote.');
  if (/\b(cheapest|lowest price|best price|price match)\b/i.test(body)) errors.push('Price comparison language.');

  if (/[–—‒―]/.test(body)) errors.push('En or em dash present. Use a period or a comma.');
  if (/\s-{1,2}\s|\w--\w/.test(body)) errors.push('Spaced hyphen used as a dash. Use a period or a comma.');

  for (const m of body.matchAll(/no[\s.\-_]*bs[\s.\-_]*yard\s*works?/gi)) {
    if (m[0] !== BRAND) errors.push(`Name spelled "${m[0]}" (must be "${BRAND}").`);
  }
  for (const m of body.matchAll(/\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g)) {
    if (m[0].replace(/\D/g, '') !== PHONE.replace(/\D/g, '')) errors.push(`Phone number "${m[0]}" is not ours (${PHONE}).`);
    else if (m[0] !== PHONE) warnings.push(`Write the phone as ${PHONE}.`);
  }

  const [maxEmoji, maxChars] = LIMITS[kind] || [1, null];
  const emoji = (t.match(EMOJI) || []).length;
  if (emoji > maxEmoji) errors.push(`${emoji} emoji (max ${maxEmoji} for ${kind}).`);
  if (maxChars && t.length > maxChars) warnings.push(`${t.length} chars (limit ${maxChars} for ${kind}).`);
  if (/#\w+/.test(t) && kind !== 'ig_caption') warnings.push('Hashtags belong on Instagram captions only.');
  return { errors, warnings };
}

module.exports = { lintOutreach, lintKindFor, PHONE, BRAND, LIMITS };
