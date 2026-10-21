/**
 * Search Console + Serper clients for Winnipeg Fence Pros. Credentials come from the page's settings:
 * its own service account JSON, else the server's shared service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).
 * Either way the account only sees the properties it was added to, so No-Bs data can not show up here.
 */
const axios = require('axios');
const { JWT } = require('google-auth-library');

const WM = 'https://searchconsole.googleapis.com/webmasters/v3';
const SCOPES = ['https://www.googleapis.com/auth/webmasters'];

const jwts = new Map();
function serviceAccount(cfg) {
  let email = process.env.GOOGLE_CLIENT_EMAIL;
  let key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  let via = 'server';
  if (cfg.GOOGLE_SA_JSON) {
    try {
      const j = JSON.parse(cfg.GOOGLE_SA_JSON);
      email = j.client_email; key = j.private_key; via = 'page';
    } catch { return { error: 'The service account JSON on the Settings tab is not valid JSON' }; }
  }
  if (!email || !key) return { error: 'No Google service account: paste one on the Settings tab' };
  const id = `${email}:${key.length}`;
  if (!jwts.has(id)) jwts.set(id, new JWT({ email, key, scopes: SCOPES }));
  return { email, via, jwt: jwts.get(id) };
}

async function auth(cfg) {
  const sa = serviceAccount(cfg);
  if (sa.error) return sa;
  try {
    const { token } = await sa.jwt.getAccessToken();
    return { email: sa.email, via: sa.via, header: `Bearer ${token}` };
  } catch (err) {
    return { email: sa.email, via: sa.via, error: `Google sign-in failed: ${err.message}` };
  }
}

async function call(a, method, url, data) {
  try {
    const res = await axios({ method, url, data, headers: { Authorization: a.header }, timeout: 30000 });
    return res.data;
  } catch (err) {
    const e = new Error(`Search Console: ${err.response?.data?.error?.message || err.message}`);
    e.status = err.response?.status;
    throw e;
  }
}

const sitePath = (property) => `${WM}/sites/${encodeURIComponent(property)}`;

/** All rows of a Search Analytics query (25,000 per page). */
async function query(a, property, body, maxRows = 100000) {
  const rows = [];
  for (let startRow = 0; startRow < maxRows; startRow += 25000) {
    const r = await call(a, 'post', `${sitePath(property)}/searchAnalytics/query`, { type: 'web', dataState: 'all', ...body, rowLimit: 25000, startRow });
    rows.push(...(r.rows || []));
    if (!r.rows || r.rows.length < 25000) break;
  }
  return rows;
}

const listSites = async (a) => (await call(a, 'get', `${WM}/sites`)).siteEntry || [];
const submitSitemap = (a, property, feedUrl) => call(a, 'put', `${sitePath(property)}/sitemaps/${encodeURIComponent(feedUrl)}`);

/** Outward writes (sitemap submit) follow DRY_RUN like the rest of 5StarFlow, unless SEO_SUBMIT says otherwise. */
const submitAllowed = () => process.env.SEO_SUBMIT === 'on' || (process.env.SEO_SUBMIT !== 'off' && process.env.DRY_RUN !== 'true');

// ── Serper (google.serper.dev): discovery + weekly rank checks, counted against SERPER_WEEKLY_BUDGET ──

function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

/** Budget over the stored {week, calls}; snapshot() is what to save back. */
function serperBudget(stored, weekly, now = new Date()) {
  const week = isoWeek(now);
  let calls = stored?.week === week ? stored.calls : 0;
  return { left: () => Math.max(0, weekly - calls), take() { if (calls >= weekly) return false; calls += 1; return true; }, snapshot: () => ({ week, calls }) };
}

async function serper(cfg, path, body) {
  const res = await axios.post(`https://google.serper.dev${path}`, { gl: 'ca', hl: 'en', location: `${cfg.CITY}, ${cfg.REGION}, Canada`, ...body },
    { headers: { 'X-API-KEY': cfg.SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 });
  return res.data || {};
}

const bareHost = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function organicRank(data, host) {
  const list = data.organic || [];
  const i = list.findIndex((r) => bareHost(r.link) === host);
  return i >= 0 ? list[i].position || i + 1 : null;
}

const squash = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function placesRank(data, host, name) {
  const list = data.places || [];
  const n = squash(name);
  const i = list.findIndex((p) => (p.website && bareHost(p.website) === host) || (n && squash(p.title).includes(n)));
  return i >= 0 ? list[i].position || i + 1 : null;
}

module.exports = { auth, query, listSites, submitSitemap, submitAllowed, serviceAccount, isoWeek, serperBudget, serper, organicRank, placesRank, bareHost };
