/**
 * Serper (google.serper.dev): the engine's main source for new keyword ideas and for weekly Google + map-pack
 * rank checks from Winnipeg. Every call is counted against growthConfig.serperWeeklyBudget (ISO week).
 */
const axios = require('axios');

const BASE = 'https://google.serper.dev';
const LOCATION = 'Winnipeg, Manitoba, Canada';

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/** A budget counter over growthState.serper = { week, calls }. */
function budget(state, weekly, now = new Date()) {
  const week = isoWeek(now);
  const used = state?.serper?.week === week ? state.serper.calls : 0;
  let calls = used;
  return {
    left: () => Math.max(0, weekly - calls),
    take() { if (calls >= weekly) return false; calls += 1; return true; },
    snapshot: () => ({ week, calls }),
  };
}

const enabled = () => !!process.env.SERPER_API_KEY;

async function post(path, body) {
  const res = await axios.post(`${BASE}${path}`, { gl: 'ca', hl: 'en', location: LOCATION, ...body },
    { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
  return res.data || {};
}

const search = (q, num = 20) => post('/search', { q, num });
const places = (q) => post('/places', { q });
const autocomplete = (q) => post('/autocomplete', { q });

const DIRECTORIES = /(yelp|homestars|houzz|facebook|kijiji|reddit|yellowpages|angi|thumbtack|bbb\.org|nextdoor|instagram|tiktok|youtube|pinterest|quora|threebestrated|expertise\.com)/i;

/** Our organic rank in a /search response (1-based), or null. */
function ourOrganicRank(data, host) {
  const bare = host.replace(/^www\./, '');
  const hit = (data.organic || []).find((r) => { try { return new URL(r.link).hostname.replace(/^www\./, '') === bare; } catch { return false; } });
  return hit ? hit.position || (data.organic.indexOf(hit) + 1) : null;
}

/** Our map-pack rank in a /places response, matched by website host or business name. */
const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function ourPlacesRank(data, host, names = ['nobsyardwork']) {
  const bare = host.replace(/^www\./, '');
  const list = data.places || [];
  const i = list.findIndex((p) => (p.website && p.website.includes(bare)) || names.some((n) => squash(p.title).includes(n)));
  return i >= 0 ? (list[i].position || i + 1) : null;
}

/** What a results page tells us about a keyword: questions, related searches, who ranks and how strong they are. */
function serpSignals(data, host) {
  const organic = data.organic || [];
  const top5 = organic.slice(0, 5);
  return {
    paa: (data.peopleAlsoAsk || []).map((p) => p.question).filter(Boolean).slice(0, 6),
    related: (data.relatedSearches || []).map((r) => r.query).filter(Boolean).slice(0, 8),
    competitors: organic.slice(0, 3).map((r) => ({ title: r.title, link: r.link })),
    weakSerp: top5.filter((r) => DIRECTORIES.test(r.link || '')).length >= 2,
    ourRank: ourOrganicRank(data, host),
  };
}

module.exports = { enabled, budget, isoWeek, search, places, autocomplete, ourOrganicRank, ourPlacesRank, serpSignals };
