/**
 * Keyword normalization and classification. matchKey() is how two phrasings of the same search
 * ("snow clearing winnipeg", "Snow removal in Winnipeg MB") collapse to one keyword row.
 */
const { CLUSTERS, AREAS, BRAND_TERMS } = require('./config');

const LOC = '@loc';
// Whole-phrase rewrites applied after normalization, longest first.
const SYNONYMS = [
  ['snow clearing', 'snow removal'], ['snow plowing', 'snow removal'], ['snow plow', 'snow removal'], ['snow ploughing', 'snow removal'],
  ['snow shoveling', 'snow removal'], ['grass cutting', 'lawn mowing'], ['lawn cutting', 'lawn mowing'], ['grass mowing', 'lawn mowing'],
  ['aerating', 'aeration'], ['aerate', 'aeration'], ['dethatching', 'power raking'], ['dethatch', 'power raking'], ['power rake', 'power raking'],
  ['clean up', 'cleanup'], ['clean ups', 'cleanup'], ['cleanups', 'cleanup'], ['yard waste', 'leaf'], ['fertilizing', 'fertilizer'], ['fertilize', 'fertilizer'],
  ['fencing', 'fence'], ['landscaper', 'landscaping'], ['landscapers', 'landscaping'], ['overseed', 'overseeding'],
  ['lawn aeration', 'aeration'], ['core aeration', 'aeration'], ['lawn power raking', 'power raking'], ['lawn overseeding', 'overseeding'],
  ['lawn weed control', 'weed control'], ['lawn fertilizer', 'fertilizer'],
  ['how much', 'cost'], ['prices', 'cost'], ['price', 'cost'], ['pricing', 'cost'], ['rates', 'cost'], ['costs', 'cost'],
];
const LOCATION_RE = /\b(near me|in winnipeg|winnipeg|wpg|manitoba|in mb|mb)\b/g;
const STOP = new Set('a an the to for of in on my your our is are am be do does did i you we it its and or with at by from this that there their should can could would will much me'.split(' '));
// Extra query words that do not change what the searcher wants ("best aeration winnipeg" = "aeration winnipeg").
const FILLER = new Set(['@loc', 'how', 'best', 'top', 'local', 'professional', 'residential', 'service', 'company', 'cheap', 'affordable', 'good', 'area', 'lawn', 'yard', 'grass']);
// Lawn problems are research, not hiring: "yellow grass winnipeg" wants an answer first.
const PROBLEM_RE = /\b(yellow|brown|dead|dying|patch|patches|patchy|mold|moss|grubs?|bugs?|pests?|bare|thin|damage|damaged|problem|problems|disease)\b/;
const QUESTION_RE = /\b(how|when|why|what|which|should|can|diy|tips|guide|ideas|signs|ways|steps|mistakes|best time|time to)\b/;

function normalizeKeyword(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function applySynonyms(n) {
  let out = ` ${n} `;
  for (const [from, to] of SYNONYMS) out = out.split(` ${from} `).join(` ${to} `);
  return out.trim();
}

const singular = (t) => (t.length > 4 && t.endsWith('ies') ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t) ? t.slice(0, -1) : t);

function tokens(s) {
  const n = applySynonyms(normalizeKeyword(s)).replace(LOCATION_RE, ` ${LOC} `);
  const seen = new Set();
  for (const raw of n.split(/\s+/)) {
    if (!raw || STOP.has(raw) || /^(19|20)\d\d$/.test(raw)) continue;   // "2026" is not part of the topic
    seen.add(raw === LOC ? LOC : singular(raw));
  }
  return [...seen];
}

// We are a local business: "snow removal cost" and "snow removal cost winnipeg" are the same search.
const keyTokens = (s) => { const t = tokens(s); return t.includes(LOC) ? t : [...t, LOC]; };
const matchKey = (s) => keyTokens(s).sort().join(' ');

const isBranded = (s, brand = BRAND_TERMS) => { const n = ` ${normalizeKeyword(s)} `; return brand.some((b) => n.includes(` ${b} `)); };

function areaFor(s) {
  const n = ` ${normalizeKeyword(s).replace(/\bsaint\b/g, 'st')} `;
  for (const a of AREAS) if (a.aliases.some((al) => n.includes(` ${al} `))) return a.name;
  return null;
}

function clusterFor(s) {
  if (isBranded(s)) return 'brand';
  const n = applySynonyms(normalizeKeyword(s));
  for (const c of CLUSTERS) {
    for (const t of c.terms) if (new RegExp(`\\b${applySynonyms(normalizeKeyword(t)).replace(/ /g, '\\s')}`).test(n)) return c.id;
  }
  return 'other';
}

function classifyIntent(s) {
  const n = normalizeKeyword(s);
  if (/\b(company|companies|services?|contractors?|hire|hiring|quotes?|near me|installers?|business|crew|book|booking|reviews?|rated)\b/.test(n)) return 'transactional';
  if (/\b(cost|costs|price|prices|pricing|how much|rates?|vs|versus|compare|cheap|affordable|worth)\b/.test(n)) return 'commercial';
  if (QUESTION_RE.test(n) || PROBLEM_RE.test(n)) return 'informational';
  // "aeration winnipeg", "snow removal st vital": a bare service + place is someone ready to hire
  const area = areaFor(s);
  if (clusterFor(s) === 'other' || !(tokens(s).includes(LOC) || area)) return 'informational';
  const areaWords = new Set(area ? AREAS.find((a) => a.name === area).aliases.join(' ').split(' ') : []);
  const core = tokens(s).filter((t) => t !== LOC && !FILLER.has(t) && !areaWords.has(t));
  return core.length <= 2 ? 'transactional' : 'informational';
}

/** Which kind of page should own the keyword. Blog posts never target "service + city" head terms. */
function kindFor(s) {
  const intent = classifyIntent(s);
  const question = QUESTION_RE.test(normalizeKeyword(s)) || /\b(cost|price|how much|vs|versus)\b/.test(normalizeKeyword(s));
  if (areaFor(s) && !question) return 'area';
  if (intent === 'transactional' && !question) return 'service';
  return 'blog';
}

function contentTypeFor(s) {
  const n = normalizeKeyword(s);
  if (/\b(cost|costs|price|prices|pricing|how much|rates?|quote)\b/.test(n)) return 'cost guide';
  if (/\b(vs|versus|or|compare|comparison|difference|better)\b/.test(n)) return 'comparison';
  if (/\b(when|best time|how early|how late|schedule|timing|too late|too early|season)\b/.test(n)) return 'timing guide';
  if (/\b(how to|diy|step|steps|guide)\b/.test(n)) return 'how-to';
  if (/\b(tips|ideas|mistakes|signs|ways|reasons|checklist)\b/.test(n)) return 'tips';
  return null;
}

/** One keyword row's fields for a new phrase. */
function describeKeyword(s) {
  const cluster = clusterFor(s);
  const info = CLUSTERS.find((c) => c.id === cluster)?.informational;
  return { keyword: normalizeKeyword(s), matchKey: matchKey(s), cluster, intent: info ? 'informational' : classifyIntent(s), kind: info ? 'blog' : kindFor(s), area: areaFor(s) };
}

/**
 * The keyword a search query belongs to. index: [{ id, matchKey }].
 * Exact key first; then the longest keyword whose tokens are all in the query when the query only adds
 * at most 2 filler words (place, "best", "company"); then token overlap (Jaccard) of at least 0.8.
 */
function matchQuery(query, index) {
  const qt = keyTokens(query);
  const qk = [...qt].sort().join(' ');
  let best = null;
  let bestLen = -1;
  let bestJ = 0;
  let jBest = null;
  const qs = new Set(qt);
  for (const k of index) {
    if (k.matchKey === qk) return k;
    const kt = k.tokens || k.matchKey.split(' ');
    if (!kt.length) continue;
    const inter = kt.filter((t) => qs.has(t)).length;
    if (inter === kt.length && kt.length > bestLen) {
      const extra = qt.filter((t) => !kt.includes(t));
      if (extra.length <= 2 && extra.every((t) => FILLER.has(t))) { best = k; bestLen = kt.length; }
    }
    const j = inter / (qt.length + kt.length - inter);
    if (j > bestJ) { bestJ = j; jBest = k; }
  }
  if (best) return best;
  return bestJ >= 0.8 ? jBest : null;
}

module.exports = { LOC, normalizeKeyword, tokens, matchKey, isBranded, areaFor, clusterFor, classifyIntent, kindFor, contentTypeFor, describeKeyword, matchQuery };
