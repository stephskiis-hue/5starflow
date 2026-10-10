/**
 * Google Search Console + IndexNow client for the SEO engine (axios + google-auth-library, no googleapis).
 *
 * Auth, best first:
 *   1. Service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY) with the full `webmasters` scope. It must be
 *      added in Search Console > Settings > Users and permissions as a FULL user to submit sitemaps.
 *   2. The SEO OAuth token on SeoSettings (refreshed by tokenManager). It was granted read-only, so it can read
 *      data and inspect URLs but not submit sitemaps.
 */
const axios = require('axios');
const { JWT } = require('google-auth-library');
const prisma = require('../../lib/prismaClient');
const { siteOrigin } = require('./urls');
const { mergeConfig } = require('./config');

const WM = 'https://searchconsole.googleapis.com/webmasters/v3';
const INSPECT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

let jwt = null;
function serviceAccount() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  if (!jwt) jwt = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/webmasters'] });
  return jwt;
}

/**
 * The owner's SEO settings, falling back to the global (userId null) row the weekly audit uses and to
 * GSC_SITE_URL. Creates the owner row so growthState has somewhere to live.
 */
async function loadSeo(userId) {
  let row = await prisma.seoSettings.findUnique({ where: { userId } });
  if (!row) row = await prisma.seoSettings.create({ data: { userId } });
  const global = await prisma.seoSettings.findFirst({ where: { userId: null } }).catch(() => null);
  const siteUrl = row.siteUrl || global?.siteUrl || process.env.GSC_SITE_URL || '';
  const origin = siteOrigin(process.env.GSC_SITE_URL || siteUrl);
  const state = row.growthState || {};
  const configured = process.env.GSC_SITE_URL || row.siteProperty || global?.siteProperty || `${origin}/`;
  // the sync found which property this account can really see (e.g. the URL-prefix one, not the sc-domain one): use it
  const property = state.gsc?.found && state.gsc.property ? state.gsc.property : configured;
  return { row, global, origin, property, configuredProperty: configured, cfg: mergeConfig(row.growthConfig), state };
}

async function saveState(rowId, patch) {
  const row = await prisma.seoSettings.findUnique({ where: { id: rowId }, select: { growthState: true } });
  const state = { ...(row?.growthState || {}), ...patch };
  await prisma.seoSettings.update({ where: { id: rowId }, data: { growthState: state } });
  return state;
}

/** { via, email, header } or null when nothing is connected. */
async function getAuth(seo) {
  const sa = serviceAccount();
  if (sa) {
    try {
      const { token } = await sa.getAccessToken();
      if (token) return { via: 'service_account', email: process.env.GOOGLE_CLIENT_EMAIL, header: `Bearer ${token}`, canWrite: true };
    } catch (err) {
      return { via: 'service_account', email: process.env.GOOGLE_CLIENT_EMAIL, error: err.message };
    }
  }
  for (const r of [seo.row, seo.global]) {
    if (r?.googleAccessToken && (!r.googleTokenExpiry || new Date(r.googleTokenExpiry) > new Date())) {
      return { via: 'oauth', email: null, header: `Bearer ${r.googleAccessToken}`, canWrite: false };
    }
  }
  return null;
}

async function call(auth, method, url, data) {
  try {
    const res = await axios({ method, url, data, headers: { Authorization: auth.header }, timeout: 30000 });
    return res.data;
  } catch (err) {
    const e = new Error(`Search Console ${method.toUpperCase()} ${url.replace(WM, '')}: ${err.response?.data?.error?.message || err.message}`);
    e.status = err.response?.status;
    throw e;
  }
}

const site = (property) => `${WM}/sites/${encodeURIComponent(property)}`;

const listSites = async (auth) => (await call(auth, 'get', `${WM}/sites`)).siteEntry || [];
const searchAnalytics = (auth, property, body) => call(auth, 'post', `${site(property)}/searchAnalytics/query`, body);
const listSitemaps = async (auth, property) => (await call(auth, 'get', `${site(property)}/sitemaps`)).sitemap || [];
const submitSitemap = (auth, property, feedUrl) => call(auth, 'put', `${site(property)}/sitemaps/${encodeURIComponent(feedUrl)}`);
const inspectUrl = async (auth, property, url) => (await call(auth, 'post', INSPECT, { inspectionUrl: url, siteUrl: property, languageCode: 'en-CA' })).inspectionResult;

/** All rows of a Search Analytics query, paging 25,000 at a time. */
async function queryAll(auth, property, body, maxRows = 200000) {
  const rows = [];
  let metadata = null;
  for (let startRow = 0; startRow < maxRows; startRow += 25000) {
    const r = await searchAnalytics(auth, property, { type: 'web', dataState: 'all', ...body, rowLimit: 25000, startRow });
    metadata = r.metadata || metadata;
    rows.push(...(r.rows || []));
    if (!r.rows || r.rows.length < 25000) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return { rows, metadata };
}

/** Bing + Yandex (Bing feeds ChatGPT search and Copilot). Needs the key file at https://<host>/<key>.txt. */
async function indexNow(origin, urls) {
  const key = process.env.INDEXNOW_KEY;
  if (!key || !urls.length) return { skipped: true };
  const host = new URL(origin).hostname;
  const res = await axios.post('https://api.indexnow.org/indexnow', { host, key, keyLocation: `${origin}/${key}.txt`, urlList: urls.slice(0, 10000) },
    { headers: { 'Content-Type': 'application/json; charset=utf-8' }, timeout: 20000, validateStatus: () => true });
  return { status: res.status, ok: res.status === 200 || res.status === 202 };
}

/** Google's "API has not been used in project N / it is disabled" error: the enable link, or null. */
function apiDisabledLink(err) {
  const msg = String(err?.message || err || '');
  if (!/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) return null;
  return msg.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/searchconsole\.googleapis\.com\/overview\?project=\d+/)?.[0]
    || 'https://console.cloud.google.com/apis/library/searchconsole.googleapis.com';
}

/** Outward writes (sitemap submit, IndexNow) respect DRY_RUN unless SEO_SUBMIT=on overrides it. */
const submitAllowed = () => process.env.SEO_SUBMIT === 'on' || (process.env.SEO_SUBMIT !== 'off' && process.env.DRY_RUN !== 'true');

module.exports = { apiDisabledLink, loadSeo, saveState, getAuth, listSites, searchAnalytics, queryAll, listSitemaps, submitSitemap, inspectUrl, indexNow, submitAllowed };
