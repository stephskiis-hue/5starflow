/**
 * Keyword logic for Winnipeg Fence Pros (pure, no database). The services, neighbourhoods and brand words come from
 * the page's settings, so nothing here knows about No-Bs.
 */
const STOP = new Set('a an the to for of in on my your our is are am be do does did i you we it its and or with at by from this that there their should can could would will me'.split(' '));
const LOCATION_RE = /\b(near me|in winnipeg|winnipeg|wpg|manitoba|in mb|mb)\b/g;
const SYNONYMS = [['fencing', 'fence'], ['fences', 'fence'], ['installer', 'installation'], ['installers', 'installation'], ['install', 'installation'],
  ['contractors', 'contractor'], ['companies', 'company'], ['how much', 'cost'], ['prices', 'cost'], ['price', 'cost'], ['pricing', 'cost'], ['costs', 'cost'],
  ['chainlink', 'chain link'], ['pvc', 'vinyl'], ['gates', 'gate'], ['decks', 'deck']];
// Searches that look like ours but are not customers: jobs, shopping for materials, other cities.
const OFF_TOPIC = /\b(jobs?|hiring|careers?|salary|employment|resume|home depot|rona|lowes|costco|canadian tire|kijiji|marketplace|reddit|amazon|walmart|toronto|calgary|edmonton|regina|saskatoon|brandon|vancouver|ottawa|montreal|minneapolis|fargo|for sale|used)\b/i;

function normalize(s) {
  let n = ` ${String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  for (const [from, to] of SYNONYMS) n = n.split(` ${from} `).join(` ${to} `);
  return n.trim();
}

const singular = (t) => (t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t);

/** "fence cost winnipeg", "How much does a fence cost in Winnipeg MB" -> the same key. Location words drop out. */
function matchKey(s) {
  const toks = new Set();
  for (const t of normalize(s).replace(LOCATION_RE, ' ').split(/\s+/)) {
    if (!t || STOP.has(t) || /^(19|20)\d\d$/.test(t)) continue;
    toks.add(singular(t));
  }
  return [...toks].sort().join(' ');
}

const isBranded = (s, brandTerms = []) => { const n = ` ${normalize(s)} `; return brandTerms.some((b) => b && n.includes(` ${normalize(b)} `)); };
const isOffTopic = (s) => OFF_TOPIC.test(String(s || ''));

/** The first configured service whose words all appear, longest service first ("vinyl fence" beats "fence"). */
const GENERIC = new Set(['installation', 'building', 'service', 'company', 'contractor']);
function serviceFor(s, services = []) {
  const k = ` ${matchKey(s)} `;
  const sorted = services.map((svc) => ({ svc, words: matchKey(svc).split(' ').filter((w) => w && !GENERIC.has(w)) }))
    .sort((a, b) => b.words.length - a.words.length);
  for (const { svc, words } of sorted) if (words.length && words.every((w) => k.includes(` ${w} `))) return svc;
  return null;
}

function areaFor(s, areas = []) {
  const n = ` ${normalize(s).replace(/\bsaint\b/g, 'st')} `;
  for (const a of areas) if (n.includes(` ${normalize(a).replace(/\bsaint\b/g, 'st')} `)) return a;
  return null;
}

function intentFor(s) {
  const n = normalize(s);
  if (/\b(company|contractor|services?|near me|installation company|hire|quote|quotes|builders?|best)\b/.test(n)) return 'transactional';
  if (/\b(cost|cheap|affordable|vs|versus|compare|worth|rates?)\b/.test(n)) return 'commercial';
  return 'informational';
}

function contentTypeFor(s) {
  const n = normalize(s);
  if (/\b(cost|quote|budget|rates?)\b/.test(n)) return 'cost guide';
  if (/\b(vs|versus|or|compare|comparison|difference|better)\b/.test(n)) return 'comparison';
  if (/\b(when|best time|season|winter|spring|fall|frost|permit|bylaw|rules|height)\b/.test(n)) return 'rules and timing guide';
  if (/\b(how to|diy|step|steps|guide|repair|fix)\b/.test(n)) return 'how-to';
  if (/\b(ideas|tips|mistakes|signs|ways|styles|types|designs)\b/.test(n)) return 'ideas and tips';
  return 'guide';
}

// Expected click-through rate by Google position (organic, local service searches).
const CTR = [0.28, 0.15, 0.10, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.017];
function ctrAt(pos) {
  if (pos == null || !Number.isFinite(pos)) return 0;
  const p = Math.max(1, Math.round(pos));
  if (p <= 10) return CTR[p - 1];
  if (p <= 20) return 0.01;
  return 0.003;
}

// Fences sell April to October in Winnipeg; planning searches start in March.
const seasonFactor = (month) => ([3, 4, 5, 6, 7, 8, 9].includes(month) ? 1.2 : 0.9);
const SOURCE_BASE = { owner: 3, claude: 2.5, focus: 2.5, serper: 2, gsc: 1 };
const INTENT_W = { transactional: 1.5, commercial: 1.3, informational: 1 };

/**
 * Priority = the extra clicks a month this keyword would bring at position 3 (from Search Console), or a small base
 * by source when there is no data yet, times intent and season.
 */
function scoreKeyword(k, now = new Date()) {
  const upside = (k.impressions28 || 0) * Math.max(0, ctrAt(3) - ctrAt(k.position28 ?? 50));
  const base = upside >= 0.5 ? upside : (SOURCE_BASE[k.source] ?? 1) + Math.min(2, (k.impressions28 || 0) / 20);
  return Math.round(base * (INTENT_W[k.intent] || 1) * seasonFactor(now.getMonth() + 1) * 100) / 100;
}

const ORDER = ['idea', 'planned', 'published', 'indexed', 'ranking', 'page1', 'top3'];
/** Lifecycle after a published keyword gets Search Console / Serper numbers. Never moves an unpublished one. */
function statusFor(k) {
  if (!['published', 'indexed', 'ranking', 'page1', 'top3'].includes(k.status)) return k.status;
  const positions = [k.position28, k.serpPosition].filter((p) => p != null && Number.isFinite(p));
  const best = positions.length ? Math.min(...positions) : null;
  if (best != null && best <= 3) return 'top3';
  if (best != null && best <= 10) return 'page1';
  if (best != null && best <= 30) return 'ranking';
  if ((k.impressions28 || 0) > 0) return 'indexed';
  return 'published';
}

const statusRank = (s) => ORDER.indexOf(s);

/** Impression-weighted position over Search Console rows. */
function weightedPosition(rows, field = 'position', impField = 'impressions') {
  const imp = rows.reduce((a, r) => a + (r[impField] || 0), 0);
  if (!imp) return null;
  return Math.round((rows.reduce((a, r) => a + (r[field] || 0) * (r[impField] || 0), 0) / imp) * 10) / 10;
}

/**
 * Why a keyword deserves a focus campaign this week, from the real numbers. Returns { reason, score, why } or null.
 * k: keyword row with Search Console numbers; hasPost: a post already targets it.
 */
function recommendation(k, { hasPost = false } = {}) {
  const imp = k.impressions28 || 0;
  const pos = k.position28;
  const prev = k.prevImpressions28 || 0;
  const q = `"${k.keyword}"`;
  if (pos != null && pos >= 8 && pos <= 20 && imp >= 10) {
    return { reason: 'page2', score: imp * (ctrAt(5) - ctrAt(pos)) + 2,
      why: `You show up on page 2 (average position ${pos}) for ${q}: ${imp} searches in 28 days. A focused post plus supporting posts can push it onto page 1.` };
  }
  if (pos != null && pos >= 4 && pos < 8 && imp >= 10) {
    return { reason: 'close', score: imp * (ctrAt(2) - ctrAt(pos)) + 1.5,
      why: `${q} sits at position ${pos} with ${imp} searches in 28 days. A refresh and a few links could move it into the top 3, where most clicks go.` };
  }
  if (imp >= 10 && prev > 0 && imp >= prev * 1.5) {
    return { reason: 'rising', score: imp * 0.05 + 1,
      why: `Searches for ${q} are rising: ${imp} in the last 28 days against ${prev} the 28 days before. Getting a page up now catches the demand.` };
  }
  if (imp >= 10 && !hasPost) {
    return { reason: 'no_page', score: imp * 0.04 + 1,
      why: `${imp} searches in 28 days for ${q} and no post of its own${k.topPage ? ` (Google shows ${k.topPage} instead)` : ''}. A page that answers it exactly should rank better.` };
  }
  if (!hasPost && imp === 0 && ['serper', 'claude', 'owner'].includes(k.source) && (k.signals?.autocomplete || k.source !== 'serper')) {
    return { reason: 'demand', score: 0.8,
      why: `People type ${q} into Google (${k.source === 'serper' ? 'it shows in Google autocomplete' : `suggested by ${k.source}`}) and the site has no page for it yet.` };
  }
  return null;
}

/** Pick up to max recommendations, at most 2 per service, best score first. */
function pickRecommendations(cands, max = 5) {
  const perService = {};
  const out = [];
  for (const c of [...cands].sort((a, b) => b.rec.score - a.rec.score)) {
    const s = c.service || 'other';
    if ((perService[s] || 0) >= 2) continue;
    perService[s] = (perService[s] || 0) + 1;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function describe(s, cfg) {
  return { keyword: normalize(s).replace(/\s+/g, ' '), matchKey: matchKey(s), service: serviceFor(s, cfg.services), intent: intentFor(s) };
}

/** Slug for a post: lowercase words, no stop words at the edges, max 8 words. */
function slugify(s) {
  const words = normalize(s).split(' ').filter(Boolean);
  while (words.length && STOP.has(words[0])) words.shift();
  return words.slice(0, 8).join('-').replace(/-+/g, '-').slice(0, 70) || 'post';
}

module.exports = { normalize, matchKey, isBranded, isOffTopic, serviceFor, areaFor, intentFor, contentTypeFor, ctrAt, seasonFactor, scoreKeyword, statusFor, statusRank, weightedPosition, recommendation, pickRecommendations, describe, slugify };
