/**
 * Deterministic brand/QA linter for post copy — the cheap, non-Claude half of the QA agent.
 * Rules come straight from the design system README ("Content rules") and the owner's standing rules.
 * Returns { ok, errors[], warnings[] }: errors block auto-publishing, warnings go to the reviewer.
 */
const PHONE = '204-900-0438';
const BRAND = 'No-Bs Yardwork';
const BANNED = ['leverage', 'seamlessly', 'game-changer', 'game changer', 'cutting-edge', 'revolutionize', 'synergy', 'unlock'];
// A dash used mid-sentence (em/en dash, or a spaced hyphen) — "No dashes mid-sentence. Use a period or a comma."
const MID_DASH = /(\S\s*[—–]\s*\S)|(\S\s+-\s+\S)/;
const PRICE = /(\$\s?\d)|(\d\s?(dollars|bucks)\b)|(\bfrom\s+\d+\s*\/\s*(mo|month|visit))/i;
// Wrong spellings of the business name
const BAD_NAMES = [/no\s?bs\s+yard\s?work/i, /no[- ]?bs\s+yardwork/i, /nobs\s*yardwork/i, /no\s+b\.s\./i, /no-b\.s\./i];

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const flat = (v) => (Array.isArray(v) ? v.map(flat).join(' ') : v && typeof v === 'object' ? Object.values(v).map(flat).join(' ') : String(v ?? ''));

/**
 * @param {object} p
 * @param {object} [p.slots]    renderer slots (graphic text)
 * @param {string} [p.caption]  the post caption / group text
 * @param {string} [p.layout]
 * @param {string} [p.platform] facebook | instagram | group
 */
function lintContent({ slots = {}, caption = '', layout, platform } = {}) {
  const errors = []; const warnings = [];
  const graphicText = flat(Object.fromEntries(Object.entries(slots).filter(([k]) => !['photo', 'before', 'after'].includes(k))));
  const all = `${graphicText}\n${caption}`;

  if (PRICE.test(all)) errors.push('Contains a price. Never show or quote a price.');
  if (MID_DASH.test(all.replace(/https?:\/\/\S+/g, ''))) errors.push('Mid-sentence dash found. Use a period or a comma.');
  const withoutBrand = all.split(BRAND).join(' ');   // correct spellings don't count
  for (const re of BAD_NAMES) if (re.test(withoutBrand)) { errors.push(`Business name must be spelled exactly "${BRAND}".`); break; }
  const lower = all.toLowerCase();
  for (const b of BANNED) if (lower.includes(b)) errors.push(`Banned word: "${b}".`);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(graphicText) && !/^ReviewPost$/.test(layout || '')) {
    errors.push('Emoji on the graphic itself (brand rule: none on graphics).');
  }

  // Phone must be on the graphic footer (templates add it) — and in the caption unless it is a story/cover.
  const needsPhoneInCaption = platform && !['story'].includes(platform);
  if (caption && needsPhoneInCaption && !caption.includes(PHONE) && platform !== 'group_no_phone') {
    warnings.push(`Caption does not include ${PHONE}.`);
  }
  if (graphicText && graphicText.includes('204') && !graphicText.includes(PHONE) && /\d{3}-\d{3}-\d{4}/.test(graphicText)) {
    errors.push(`Wrong phone number on the graphic. It must be ${PHONE}.`);
  }

  if (graphicText && words(graphicText) > 46) warnings.push(`Graphic has ${words(graphicText)} words (target under about 40).`);
  const head = slots.headline || slots.title || slots.question || slots.answer_headline;
  if (head && (words(String(head).replace(/\[\[|\]\]/g, '')) < 2 || words(String(head).replace(/\[\[|\]\]/g, '')) > 14)) warnings.push('Headline should be roughly 2 to 7 words per line.');

  if (layout === 'ReviewPost' && slots.reviewer && /\s[A-Z][a-z]+\s+[A-Z][a-z]+/.test(String(slots.reviewer).split('·')[0].replace(/^[A-Z]+$/, ''))) {
    warnings.push('Reviewer line looks like it has a surname. First name and neighbourhood only.');
  }
  if (/\b(guarantee|guaranteed|best in winnipeg|#1|number one|cheapest)\b/i.test(all)) warnings.push('Unsubstantiated claim (guarantee / best / cheapest).');
  if (/(one[- ]time|per snowfall|single clear)/i.test(all) && /(yes|we do|available|offer)/i.test(all) && !/monthly/i.test(all)) {
    warnings.push('Snow offer mentions one-time clears. We do monthly contracts only.');
  }
  return { ok: errors.length === 0, errors, warnings };
}

module.exports = { lintContent, PHONE, BRAND };
