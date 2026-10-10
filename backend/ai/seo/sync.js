/**
 * seo-gsc-sync (daily): pulls Search Console into Postgres.
 *   SeoDailyTotal   [date]               14 days each run, 16 months on the first run (headline numbers)
 *   SeoQueryStat    [date, query, page]  the last 5 days each run, backfilled 30 days per run up to retentionDays
 *   SeoQueryMonth   [query, page]/month  months older than retention, 4 per run, back 16 months
 *   SeoPage.*28     [page] last 28 days
 * Then rescores the keyword roadmap. Search Console days are Pacific time and 2-3 days behind.
 */
const prisma = require('../../lib/prismaClient');
const { createTask, completeByDedupKey } = require('../tasks');
const { canonicalPath, kindForPath } = require('./urls');
const g = require('./google');

const DAY = 86400000;
const SLUG = 'seo-gsc-sync';
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY));
const asDate = (s) => new Date(`${s}T00:00:00Z`);
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const prevMonth = (m) => { const d = asDate(m); d.setUTCMonth(d.getUTCMonth() - 1); return ymd(d); };
const monthEnd = (m) => { const d = asDate(m); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return ymd(d); };

/** Pick the Search Console property: the configured one if visible, else the one that matches our site. */
async function resolveProperty(auth, seo) {
  const sites = await g.listSites(auth);
  const host = new URL(seo.origin).hostname.replace(/^www\./, '');
  const exact = sites.find((s) => s.siteUrl === seo.configuredProperty) || sites.find((s) => s.siteUrl === seo.property);
  const match = exact || sites.find((s) => s.siteUrl === `${seo.origin}/`) || sites.find((s) => s.siteUrl === `sc-domain:${host}`)
    || sites.find((s) => s.siteUrl.includes(host));
  return { sites, site: match || null };
}

/** Sum rows that collapse to the same canonical path (".html" and clean URL are one page). */
function mergeRows(rows, origin, keyFn) {
  const out = new Map();
  for (const r of rows) {
    const key = keyFn(r);
    if (!key) continue;
    const prev = out.get(key.id);
    if (!prev) out.set(key.id, { ...key, clicks: r.clicks, impressions: r.impressions, pw: r.position * r.impressions });
    else { prev.clicks += r.clicks; prev.impressions += r.impressions; prev.pw += r.position * r.impressions; }
  }
  return [...out.values()].map((x) => ({ ...x, position: x.impressions ? x.pw / x.impressions : 0 }));
}

async function syncDay(userId, auth, property, origin, day, final) {
  const { rows } = await g.queryAll(auth, property, { startDate: day, endDate: day, dimensions: ['query', 'page'] });
  const merged = mergeRows(rows, origin, (r) => {
    const page = canonicalPath(r.keys[1], origin);
    return page ? { id: `${r.keys[0]}\u0000${page}`, query: r.keys[0].slice(0, 300), page } : null;
  });
  await prisma.$transaction([
    prisma.seoQueryStat.deleteMany({ where: { userId, date: asDate(day) } }),
    prisma.seoQueryStat.createMany({ data: merged.map((m) => ({ userId, date: asDate(day), query: m.query, page: m.page, clicks: m.clicks, impressions: m.impressions, position: m.position, final })), skipDuplicates: true }),
  ]);
  return merged.length;
}

async function syncMonth(userId, auth, property, origin, month) {
  const { rows } = await g.queryAll(auth, property, { startDate: month, endDate: monthEnd(month), dimensions: ['query', 'page'], dataState: 'final' });
  const merged = mergeRows(rows, origin, (r) => {
    const page = canonicalPath(r.keys[1], origin);
    return page ? { id: `${r.keys[0]}\u0000${page}`, query: r.keys[0].slice(0, 300), page } : null;
  });
  await prisma.$transaction([
    prisma.seoQueryMonth.deleteMany({ where: { userId, month: asDate(month) } }),
    prisma.seoQueryMonth.createMany({ data: merged.map((m) => ({ userId, month: asDate(month), query: m.query, page: m.page, clicks: m.clicks, impressions: m.impressions, position: m.position })), skipDuplicates: true }),
  ]);
  return merged.length;
}

async function gscSyncTick(ctx) {
  const { userId } = ctx;
  const seo = await g.loadSeo(userId);
  const auth = await g.getAuth(seo);
  const setupTask = (whatHappened, whatNeeds) => createTask(userId, { dedupKey: 'seo:gsc-not-connected', source: 'seo', agent: 'research', routineSlug: SLUG, urgency: 'high',
    title: 'Connect Search Console to 5StarFlow', whatHappened, whatNeeds });
  if (!auth || auth.error) {
    await setupTask(auth?.error ? `The service account could not sign in: ${auth.error}` : 'No Google service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY) and no SEO Google login.',
      'Open SEO Growth in 5StarFlow and follow the setup card.');
    return { skipped: true, summary: 'Search Console not connected' };
  }
  let sites; let site;
  try {
    ({ sites, site } = await resolveProperty(auth, seo));
  } catch (err) {
    const link = g.apiDisabledLink(err);
    if (!link) throw err;
    await setupTask(`Google: ${err.message.replace(/^Search Console GET \/sites: /, '')}`,
      `1. Open ${link} (signed in as the owner of that Google Cloud project) and press Enable.\n2. Search Console > Settings > Users and permissions > Add user: ${auth.email} with permission "Full".`);
    await g.saveState(seo.row.id, { gsc: { via: auth.via, email: auth.email, property: seo.property, found: false, apiDisabled: link, checkedAt: new Date().toISOString() } });
    return { skipped: true, summary: 'Search Console API is turned off in the service account\'s Google Cloud project' };
  }
  // not a user yet: the service account verifies the site itself (homepage meta tag), no Search Console login needed
  let own = null;
  if (!site && auth.via === 'service_account') {
    own = await require('./siteAccess').ensureOwnership(userId, { apply: true }).catch((err) => ({ status: 'error', error: err.message }));
    if (own.status === 'verified') ({ sites, site } = await resolveProperty(auth, seo));
  }
  if (!site) {
    const ownNote = !own ? '' : own.status === 'api_disabled' ? `\nOr turn on the Site Verification API (${own.enableLink}) and 5StarFlow verifies the site itself.`
      : own.status === 'needs_tag' ? `\nOr: once the homepage carries ${own.tag} (seo_site.py nightly adds it on the PC), the next sync verifies the site itself.` : `\nSelf-verification: ${own.status}${own.error ? ` (${own.error})` : ''}.`;
    await setupTask(`The ${auth.via === 'service_account' ? `service account ${auth.email}` : 'Google login'} can see ${sites.length ? sites.map((s) => s.siteUrl).join(', ') : 'no Search Console properties'}, not ${seo.property}.`,
      (auth.via === 'service_account' ? `Search Console > Settings > Users and permissions > Add user: ${auth.email}, permission "Full".` : 'Reconnect Google with the account that owns the property.') + ownNote);
    await g.saveState(seo.row.id, { gsc: { via: auth.via, email: auth.email, property: seo.property, found: false, sites: sites.map((s) => s.siteUrl), checkedAt: new Date().toISOString() } });
    return { skipped: true, summary: `Search Console property ${seo.property} not visible to ${auth.email || 'the Google login'}` };
  }
  await completeByDedupKey(userId, 'seo:gsc-not-connected');
  const property = site.siteUrl;
  if (['siteOwner', 'siteFullUser'].includes(site.permissionLevel)) await completeByDedupKey(userId, 'seo:gsc-permission');
  const origin = seo.origin;
  const state = seo.state;
  const today = ymd(new Date());

  // 1. Daily totals (all queries incl. anonymized). First run: 16 months.
  const totalsFrom = state.totalsBackfilled ? addDays(today, -14) : addDays(today, -486);
  const totals = await g.queryAll(auth, property, { startDate: totalsFrom, endDate: today, dimensions: ['date'] });
  const firstIncomplete = totals.metadata?.firstIncompleteDate || totals.metadata?.first_incomplete_date || null;
  const isFinal = (day) => (firstIncomplete ? day < firstIncomplete : day <= addDays(today, -4));
  for (const r of totals.rows) {
    const day = r.keys[0];
    const data = { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, final: isFinal(day) };
    await prisma.seoDailyTotal.upsert({ where: { userId_date: { userId, date: asDate(day) } }, update: data, create: { userId, date: asDate(day), ...data } });
  }
  const dataThrough = totals.rows.length ? totals.rows.map((r) => r.keys[0]).sort().pop() : null;

  // 2. Query x page detail: re-fetch the last 5 days (still changing), then backfill older days.
  let rows = 0;
  const recent = [];
  for (let i = 5; i >= 1; i--) recent.push(addDays(today, -i));
  for (const day of recent) rows += await syncDay(userId, auth, property, origin, day, isFinal(day));
  const retention = seo.cfg.retentionDays;
  const oldestWanted = addDays(today, -retention);
  let backTo = state.detailBackfillTo || addDays(today, -5);
  let backDays = 0;
  while (backTo > oldestWanted && backDays < 30 && process.env.SEO_BACKFILL !== 'off') {
    backTo = addDays(backTo, -1);
    rows += await syncDay(userId, auth, property, origin, backTo, true);
    backDays++;
  }

  // 3. Monthly rollups for history older than the daily window (16 months back), 4 months per run.
  let monthCursor = state.monthBackfillTo || monthStart(oldestWanted);
  const oldestMonth = monthStart(addDays(today, -486));
  let months = 0;
  while (monthCursor > oldestMonth && months < 4 && process.env.SEO_BACKFILL !== 'off') {
    monthCursor = prevMonth(monthCursor);
    rows += await syncMonth(userId, auth, property, origin, monthCursor);
    months++;
  }

  // 4. Page totals for the last 28 days.
  const pageRes = await g.queryAll(auth, property, { startDate: addDays(today, -30), endDate: addDays(today, -3), dimensions: ['page'] });
  const pages = mergeRows(pageRes.rows, origin, (r) => { const page = canonicalPath(r.keys[0], origin); return page ? { id: page, page } : null; });
  const seen = new Set();
  for (const p of pages) {
    seen.add(p.page);
    const data = { clicks28: p.clicks, impressions28: p.impressions, position28: p.position };
    await prisma.seoPage.upsert({ where: { userId_path: { userId, path: p.page } }, update: data, create: { userId, path: p.page, kind: kindForPath(p.page), source: 'gsc', ...data } });
  }
  await prisma.seoPage.updateMany({ where: { userId, path: { notIn: [...seen] }, impressions28: { gt: 0 } }, data: { clicks28: 0, impressions28: 0, position28: null } });

  // 5. Retention.
  await prisma.seoQueryStat.deleteMany({ where: { userId, date: { lt: asDate(oldestWanted) } } });

  await g.saveState(seo.row.id, {
    totalsBackfilled: true, detailBackfillTo: backTo, monthBackfillTo: monthCursor, lastSyncAt: new Date().toISOString(), dataThrough, firstIncompleteDate: firstIncomplete,
    gsc: { via: auth.via, email: auth.email, property, permission: site.permissionLevel, found: true, sites: sites.map((s) => s.siteUrl), checkedAt: new Date().toISOString() },
  });

  const rescored = await require('./roadmap').rescore(userId);
  await require('./assign').releaseStale(userId);
  const fmt = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '?');
  return {
    items_found: rows,
    summary: `Data through ${fmt(dataThrough)}${firstIncomplete ? ` (from ${fmt(firstIncomplete)} preliminary)` : ''}; ${rows} query rows; ${pages.length} pages with impressions; ${rescored.keywords} keywords rescored${rescored.newIdeas ? `, ${rescored.newIdeas} new ideas` : ''}`,
    actions_taken: [backDays ? `backfilled ${backDays} day(s)` : null, months ? `rolled up ${months} month(s)` : null].filter(Boolean),
  };
}

module.exports = { gscSyncTick, resolveProperty, mergeRows };
