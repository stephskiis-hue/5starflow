/**
 * Everything seo-growth.html shows, and the numbers snapshot stored with each weekly recap
 * (the server computes the numbers; Claude only writes the words around them).
 */
const prisma = require('../../lib/prismaClient');
const { OPEN_TASK_STATES } = require('../constants');
const { CLUSTERS } = require('./config');
const { seasonFactor } = require('./scoring');
const { isoWeek } = require('./serper');
const { toDateString } = require('../../lib/tz');
const { pillarsFor } = require('./roadmap');
const { preview, reportStatus } = require('./assign');
const { toUrl } = require('./urls');
const g = require('./google');

const DAY = 86400000;
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

function sumTotals(rows) {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const pw = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return { clicks, impressions, ctr: impressions ? r1((clicks / impressions) * 100) : null, position: impressions ? r1(pw / impressions) : null, days: rows.length };
}

async function kpis(userId) {
  const finals = await prisma.seoDailyTotal.findMany({ where: { userId, final: true }, orderBy: { date: 'desc' }, take: 56 });
  const prelim = await prisma.seoDailyTotal.findMany({ where: { userId, final: false }, orderBy: { date: 'asc' } });
  const cur = sumTotals(finals.slice(0, 28));
  const prev = sumTotals(finals.slice(28, 56));
  const delta = (a, b) => (a == null || b == null || !prev.days ? null : r1(a - b));
  return {
    current: cur, previous: prev,
    change: { clicks: delta(cur.clicks, prev.clicks), impressions: delta(cur.impressions, prev.impressions), position: delta(cur.position, prev.position), ctr: delta(cur.ctr, prev.ctr) },
    dataThrough: finals[0]?.date?.toISOString().slice(0, 10) || null,
    preliminary: prelim.map((p) => p.date.toISOString().slice(0, 10)),
  };
}

async function weekly(userId, weeks = 26) {
  const since = new Date(Date.now() - weeks * 7 * DAY);
  const days = await prisma.seoDailyTotal.findMany({ where: { userId, date: { gte: since } }, orderBy: { date: 'asc' } });
  const posts = await prisma.seoAssignment.findMany({ where: { userId, status: 'published', publishedAt: { gte: since } }, select: { publishedAt: true, mode: true } });
  const pages = await prisma.seoPage.findMany({ where: { userId, kind: 'blog', publishedAt: { gte: since } }, select: { publishedAt: true } });
  const map = new Map();
  for (const d of days) {
    const w = isoWeek(d.date);
    const x = map.get(w) || { week: w, start: d.date.toISOString().slice(0, 10), clicks: 0, impressions: 0, posts: 0, refreshes: 0, final: true };
    x.clicks += d.clicks; x.impressions += d.impressions; x.final = x.final && d.final;
    map.set(w, x);
  }
  const bump = (date, field) => { const w = isoWeek(date); if (map.has(w)) map.get(w)[field] += 1; };
  for (const p of posts) bump(p.publishedAt, p.mode === 'refresh' ? 'refreshes' : 'posts');
  if (!posts.length) for (const p of pages) bump(p.publishedAt, 'posts');
  return [...map.values()];
}

function trackedCounts(keywords, weeksAgo = 0) {
  const pos = (k) => {
    if (!weeksAgo) return (k.impressions28 >= 10 && k.position28) || k.serpPosition || null;
    const h = Array.isArray(k.history) ? k.history : [];
    const p = h[h.length - 1 - weeksAgo];
    return p ? (p.imp >= 10 && p.pos) || p.serp || null : null;
  };
  const owned = keywords.filter((k) => k.targetPath && k.status !== 'retired' && k.cluster !== 'brand');
  const c = { top3: 0, top10: 0, top20: 0 };
  for (const k of owned) { const p = pos(k); if (!p) continue; if (p <= 3) c.top3++; if (p <= 10) c.top10++; if (p <= 20) c.top20++; }
  return c;
}

function movers(keywords, weeks = 4) {
  return keywords.map((k) => {
    const h = Array.isArray(k.history) ? k.history : [];
    const now = h[h.length - 1]; const then = h[h.length - 1 - weeks];
    const a = now && ((now.imp >= 10 && now.pos) || now.serp); const b = then && ((then.imp >= 10 && then.pos) || then.serp);
    return a && b ? { keyword: k.keyword, from: r1(b), to: r1(a), change: r1(b - a), targetPath: k.targetPath } : null;
  }).filter(Boolean).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, 10);
}

async function buildProgress(userId, { view } = {}) {
  const seo = await g.loadSeo(userId);
  const [k, keywords, pages, sitemaps, tasks, reports, assignments] = await Promise.all([
    kpis(userId),
    prisma.seoKeyword.findMany({ where: { userId }, orderBy: { priority: 'desc' } }),
    prisma.seoPage.findMany({ where: { userId } }),
    prisma.seoSitemap.findMany({ where: { userId }, orderBy: { url: 'asc' } }),
    prisma.task.findMany({ where: { userId, status: { in: OPEN_TASK_STATES }, dedupKey: { startsWith: 'seo:' } }, orderBy: { updatedAt: 'desc' }, take: 50 }),
    prisma.seoProgressReport.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 12 }),
    prisma.seoAssignment.findMany({ where: { userId, status: { in: ['published', 'reserved'] } }, orderBy: { createdAt: 'desc' }, take: 60 }),
  ]);
  const pageBy = Object.fromEntries(pages.map((p) => [p.path, p]));
  const indexable = pages.filter((p) => p.inSitemap && !p.excluded && p.httpStatus === 200 && !p.redirectTo && !p.noindex);
  const coverage = { inSitemap: indexable.length, indexed: indexable.filter((p) => p.indexVerdict === 'PASS').length,
    notIndexed: indexable.filter((p) => p.indexVerdict && p.indexVerdict !== 'PASS').length, unknown: indexable.filter((p) => !p.indexVerdict).length };
  const statusCounts = {};
  for (const kw of keywords) statusCounts[kw.status] = (statusCounts[kw.status] || 0) + 1;
  const report = await reportStatus(userId, seo.cfg);
  const tracked = { now: trackedCounts(keywords), fourWeeksAgo: trackedCounts(keywords, 4) };

  if (view === 'report') {
    const last = reports[0];
    const since = last?.createdAt || new Date(Date.now() - 7 * DAY);
    const recent = assignments.filter((a) => a.status === 'published' && a.publishedAt > since)
      .map((a) => ({ mode: a.mode, keyword: a.keywordText, url: a.publishedPath ? toUrl(a.publishedPath, seo.origin) : null, publishedAt: a.publishedAt }));
    return { kpis: k, tracked, coverage, movers: movers(keywords), postsSinceLastReport: recent, openIssues: tasks.map((t) => t.title).slice(0, 10),
      nextUp: await preview(userId, { limit: 5 }), lastReport: last ? { createdAt: last.createdAt, nextFocus: last.nextFocus } : null, reportDue: report };
  }

  const month = Number(toDateString().slice(5, 7));
  const pillars = pillarsFor(seo.state, pageBy);
  const clusters = CLUSTERS.map((c) => {
    const ks = keywords.filter((x) => x.cluster === c.id);
    const counts = {};
    for (const x of ks) counts[x.status] = (counts[x.status] || 0) + 1;
    const pillar = pillars[c.id] ? pageBy[pillars[c.id]] : null;
    return { id: c.id, label: c.label, season: seasonFactor(month, c.peaks), peaks: c.peaks, pillarPath: pillars[c.id] || null, plannedPillar: pillars[c.id] ? null : c.plannedPillar || null,
      pillarPosition: r1(pillar?.position28), pillarIndexed: pillar?.indexVerdict || null, keywords: ks.length, counts,
      posts: pages.filter((p) => p.kind === 'blog' && p.cluster === c.id).length, impressions28: ks.reduce((s, x) => s + x.impressions28, 0) };
  });
  const focus = keywords.filter((x) => x.status !== 'retired' && x.cluster !== 'brand' && (x.pinned || x.rankTrack || x.targetPath || x.priority >= seo.cfg.planThreshold))
    .slice(0, 60).map((x) => ({ id: x.id, keyword: x.keyword, cluster: x.cluster, kind: x.kind, intent: x.intent, status: x.status, pinned: x.pinned, rankTrack: x.rankTrack,
      priority: x.priority, why: x.scoreParts?.why || '', targetPath: x.targetPath, baseline: r1(x.baselinePosition), position: r1(x.position28), best: r1(x.bestPosition),
      current: r1((x.impressions28 >= 10 && x.position28) || x.serpPosition || x.position28), currentFrom: x.impressions28 >= 10 && x.position28 ? 'search console' : x.serpPosition ? 'serper' : null,
      impressions28: x.impressions28, clicks28: x.clicks28, serp: x.serpPosition, map: x.mapPackPosition, serpCheckedAt: x.serpCheckedAt,
      history: (Array.isArray(x.history) ? x.history : []).slice(-12) }));
  const content = assignments.filter((a) => a.status === 'published').slice(0, 40).map((a) => {
    const p = a.publishedPath ? pageBy[a.publishedPath] : null;
    const kwRow = keywords.find((x) => x.id === a.keywordId);
    return { id: a.id, mode: a.mode, kind: a.brief?.kind || 'blog', keyword: a.keywordText, contentType: a.contentType, publishedAt: a.publishedAt, path: a.publishedPath,
      url: a.publishedPath ? toUrl(a.publishedPath, seo.origin) : null, title: p?.title || null, indexVerdict: p?.indexVerdict || null, coverageState: p?.coverageState || null,
      lastCrawlTime: p?.lastCrawlTime || null, inSitemap: p?.inSitemap ?? null, position: r1(kwRow?.position28), serp: kwRow?.serpPosition ?? null, impressions28: kwRow?.impressions28 ?? 0, unassigned: !!a.brief?.unassigned };
  });
  const reserved = assignments.find((a) => a.status === 'reserved' && a.expiresAt > new Date());
  const ideas = keywords.filter((x) => ['idea', 'planned'].includes(x.status) && x.cluster !== 'brand').slice(0, 40)
    .map((x) => ({ id: x.id, keyword: x.keyword, cluster: x.cluster, kind: x.kind, status: x.status, source: x.source, priority: x.priority, why: x.scoreParts?.why || '', pinned: x.pinned }));
  return {
    origin: seo.origin, property: seo.property, gsc: seo.state.gsc || null, submit: { allowed: g.submitAllowed(), dryRun: process.env.DRY_RUN === 'true', override: process.env.SEO_SUBMIT || null },
    serper: { enabled: !!process.env.SERPER_API_KEY, week: seo.state.serper || null, budget: seo.cfg.serperWeeklyBudget },
    sync: { lastSyncAt: seo.state.lastSyncAt || null, lastIndexWatchAt: seo.state.lastIndexWatchAt || null, lastRoadmapAt: seo.state.lastRoadmapAt || null, dataThrough: seo.state.dataThrough || null },
    kpis: k, weekly: await weekly(userId), tracked, coverage, statusCounts, keywordsTotal: keywords.length,
    focus, ideas, roadmap: await preview(userId, { limit: 10 }), reserved: reserved ? { keyword: reserved.keywordText, mode: reserved.mode, expiresAt: reserved.expiresAt } : null,
    clusters, content, movers: movers(keywords),
    sitemaps: sitemaps.map((s) => ({ url: s.url, isIndex: s.isIndex, urlCount: s.urlCount, httpStatus: s.httpStatus, hashChangedAt: s.hashChangedAt, lastSubmittedAt: s.lastSubmittedAt,
      gscLastDownloaded: s.gscLastDownloaded, gscIsPending: s.gscIsPending, gscErrors: s.gscErrors, gscWarnings: s.gscWarnings, gscSubmittedUrls: s.gscSubmittedUrls, lastError: s.lastError })),
    issues: tasks.map((t) => ({ id: t.id, dedupKey: t.dedupKey, title: t.title, urgency: t.urgency, whatHappened: t.whatHappened, whatNeeds: t.whatNeeds, recommended: t.recommended, updatedAt: t.updatedAt })),
    cannibalization: seo.state.cannibalization || [],
    reports: reports.map((r) => ({ id: r.id, createdAt: r.createdAt, periodStart: r.periodStart, periodEnd: r.periodEnd, narrative: r.narrative, nextFocus: r.nextFocus, metrics: r.metrics, author: r.author })),
    reportDue: report, config: seo.cfg,
  };
}

/** POST /seo/reports: the weekly recap. The server snapshots the numbers so the narrative cannot invent them. */
async function createReport(userId, { narrative, nextFocus, author = 'content' }) {
  if (!narrative || String(narrative).trim().length < 40) { const e = new Error('narrative is required (40+ characters)'); e.status = 400; throw e; }
  const last = await prisma.seoProgressReport.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  if (last && Date.now() - last.createdAt < 2 * DAY) { const e = new Error('a recap was posted in the last 2 days'); e.status = 409; throw e; }
  const metrics = await buildProgress(userId, { view: 'report' });
  delete metrics.nextUp;
  const row = await prisma.seoProgressReport.create({ data: {
    userId, periodStart: last?.createdAt || new Date(Date.now() - 7 * DAY), periodEnd: new Date(), metrics,
    narrative: String(narrative).slice(0, 4000), nextFocus: String(nextFocus || '').slice(0, 1000), author: String(author).slice(0, 40),
  } });
  await require('../../lib/notify').notify(userId, { category: 'seo', title: 'Weekly SEO recap is ready', body: String(narrative).slice(0, 180), link: '/seo-growth.html#report', routineSlug: 'ext-blog-autopilot' }).catch(() => {});
  return row;
}

module.exports = { buildProgress, createReport, kpis };
