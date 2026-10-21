/**
 * The keyword roadmap: which keywords exist, which page owns each, how they score and where they are in
 * their lifecycle.
 *   rescore(userId)  after every Search Console sync: map queries to keywords, add ideas, score, advance status
 *   roadmapTick(ctx) weekly (seo-roadmap): seed + import existing posts, Serper rank checks (Google + map pack)
 *                    for tracked keywords, Serper discovery of new ideas, then rescore
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../../lib/prismaClient');
const { createTask, completeByDedupKey } = require('../tasks');
const { OPEN_TASK_STATES } = require('../constants');
const { toDateString } = require('../../lib/tz');
const { CLUSTERS, AREAS, clusterById, isOffTopic } = require('./config');
const kw = require('./keywords');
const { calibrate, scoreKeyword, findCannibalization } = require('./scoring');
const { nextStatus } = require('./lifecycle');
const serper = require('./serper');
const g = require('./google');

const DAY = 86400000;
const SLUG = 'seo-roadmap';

/** Current pillar page per cluster: the config's, overridden by landing pages the engine published. */
function pillarsFor(state, pages) {
  const out = {};
  for (const c of CLUSTERS) {
    const own = state?.pillars?.[c.id];
    const p = own || c.pillarPath;
    if (p && (!pages || !pages[p] || (pages[p].httpStatus || 200) === 200)) out[c.id] = p;
  }
  return out;
}

async function addKeywords(userId, phrases, source, extra = {}) {
  const rows = [];
  const seen = new Set();
  for (const ph of phrases) {
    const d = kw.describeKeyword(ph);
    if (!d.matchKey || seen.has(d.matchKey) || d.cluster === 'brand' || d.keyword.length > 120) continue;
    seen.add(d.matchKey);
    rows.push({ userId, ...d, source, ...(typeof extra === 'function' ? extra(d) : extra) });
  }
  if (!rows.length) return 0;
  const r = await prisma.seoKeyword.createMany({ data: rows, skipDuplicates: true });
  return r.count;
}

/** Seed keywords: every service in Winnipeg (+ its cost), and the two main services in every neighbourhood. */
async function seedKeywords(userId) {
  const phrases = [];
  for (const c of CLUSTERS) if (!c.informational) phrases.push(`${c.head} winnipeg`, `${c.head} cost winnipeg`);
  const services = await addKeywords(userId, phrases, 'seed');
  const area = [];
  for (const a of AREAS) for (const s of ['lawn care', 'snow removal']) area.push(`${s} ${a.aliases[0]}`);
  const areas = await addKeywords(userId, area, 'seed');
  return services + areas;
}

const slugKeyword = (path) => path.replace(/^\/(blog-|blog\/)/i, '').replace(/[-_]+/g, ' ').trim();

/** Existing blog posts become "published" keywords (from their slug), so new posts never duplicate them. */
async function importExistingPages(userId) {
  const pages = await prisma.seoPage.findMany({ where: { userId, kind: 'blog', httpStatus: 200 } });
  const owned = new Set((await prisma.seoKeyword.findMany({ where: { userId, targetPath: { not: null } }, select: { targetPath: true } })).map((k) => k.targetPath));
  let n = 0;
  for (const p of pages) {
    if (owned.has(p.path)) continue;
    const d = kw.describeKeyword(slugKeyword(p.path));
    if (!d.matchKey) continue;
    const data = { targetPath: p.path, status: 'published', publishedAt: p.publishedAt || p.createdAt, kind: 'blog' };
    const existing = await prisma.seoKeyword.findUnique({ where: { userId_matchKey: { userId, matchKey: d.matchKey } } });
    // A post never takes over a service/area head term ("lawn aeration winnipeg"): that belongs to a landing page.
    if (existing) { if (!existing.targetPath && existing.kind === 'blog') { await prisma.seoKeyword.update({ where: { id: existing.id }, data }); n++; } }
    else { await prisma.seoKeyword.create({ data: { userId, ...d, intent: d.intent === 'transactional' ? 'informational' : d.intent, ...data, source: 'import' } }); n++; }
    if (!p.primaryKeyword) await prisma.seoPage.update({ where: { id: p.id }, data: { primaryKeyword: d.keyword, cluster: p.cluster || d.cluster } });
  }
  return n;
}

async function queryWindow(userId) {
  const max = await prisma.seoQueryStat.aggregate({ where: { userId }, _max: { date: true } });
  if (!max._max.date) return [];
  const from = new Date(max._max.date.getTime() - 27 * DAY);
  return prisma.$queryRaw(Prisma.sql`
    SELECT "query", "page", SUM("clicks")::int AS clicks, SUM("impressions")::int AS impressions,
           SUM("position" * "impressions") / NULLIF(SUM("impressions"), 0) AS position
    FROM "SeoQueryStat" WHERE "userId" = ${userId} AND "date" >= ${from}
    GROUP BY "query", "page"`);
}

function weekKey(now) { return serper.isoWeek(now); }

/** Recompute every keyword's numbers, owner page, score and status from the last 28 days of Search Console. */
async function rescore(userId, { now = new Date() } = {}) {
  const seo = await g.loadSeo(userId);
  const month = Number(toDateString(now).slice(5, 7));
  const pagesArr = await prisma.seoPage.findMany({ where: { userId } });
  const pages = Object.fromEntries(pagesArr.map((p) => [p.path, p]));
  const pillars = pillarsFor(seo.state, pages);
  const rows = (await queryWindow(userId)).map((r) => ({ ...r, position: Number(r.position) || 0 }));

  // per query totals (all pages) for matching and new ideas
  const byQuery = new Map();
  for (const r of rows) {
    const q = byQuery.get(r.query) || { query: r.query, clicks: 0, impressions: 0, pw: 0, pages: [] };
    q.clicks += r.clicks; q.impressions += r.impressions; q.pw += r.position * r.impressions; q.pages.push({ page: r.page, impressions: r.impressions, clicks: r.clicks });
    byQuery.set(r.query, q);
  }
  const calib = calibrate([...byQuery.values()].map((q) => ({ position: q.impressions ? q.pw / q.impressions : 99, impressions: q.impressions, clicks: q.clicks })));

  let keywords = await prisma.seoKeyword.findMany({ where: { userId } });
  const index = keywords.map((k) => ({ id: k.id, matchKey: k.matchKey }));
  const ideas = [];
  const agg = new Map();
  for (const q of [...byQuery.values()].sort((a, b) => b.impressions - a.impressions)) {
    if (kw.isBranded(q.query)) continue;
    let hit = kw.matchQuery(q.query, index);
    if (!hit && q.impressions >= 5 && ideas.length < 100 && !isOffTopic(q.query)) {
      const d = kw.describeKeyword(q.query);
      if (d.cluster !== 'other' && d.matchKey) { ideas.push(q.query); hit = { id: `new:${d.matchKey}`, matchKey: d.matchKey }; index.push(hit); }
    }
    if (!hit) continue;
    const a = agg.get(hit.id) || { clicks: 0, impressions: 0, pw: 0, pages: new Map(), queries: [] };
    a.clicks += q.clicks; a.impressions += q.impressions; a.pw += q.pw;
    for (const p of q.pages) a.pages.set(p.page, (a.pages.get(p.page) || 0) + p.impressions);
    if (a.queries.length < 8) a.queries.push({ q: q.query, imp: q.impressions, pos: Math.round((q.pw / Math.max(q.impressions, 1)) * 10) / 10 });
    agg.set(hit.id, a);
  }
  let newIdeas = 0;
  if (ideas.length) {
    newIdeas = await addKeywords(userId, ideas, 'gsc');
    keywords = await prisma.seoKeyword.findMany({ where: { userId } });
    for (const k of keywords) { const a = agg.get(`new:${k.matchKey}`); if (a) { agg.set(k.id, a); agg.delete(`new:${k.matchKey}`); } }
  }

  const week = weekKey(now);
  const cannibal = [];
  const updates = [];
  for (const k of keywords) {
    const a = agg.get(k.id);
    const impressions = a?.impressions || 0;
    const clicks = a?.clicks || 0;
    const position = impressions ? a.pw / impressions : null;
    const pageList = a ? [...a.pages.entries()].map(([page, imp]) => ({ page, impressions: imp })).sort((x, y) => y.impressions - x.impressions) : [];
    let targetPath = k.targetPath;
    if (!targetPath && (k.kind === 'service') && pillars[k.cluster]) targetPath = pillars[k.cluster];   // head terms belong to the service page
    if (!targetPath && pageList[0] && pageList[0].impressions >= 20 && pageList[0].impressions / impressions >= 0.5 && pages[pageList[0].page]?.kind !== 'home') targetPath = pageList[0].page;
    const can = findCannibalization(pageList);
    if (can && k.status !== 'retired') cannibal.push({ keyword: k.keyword, matchKey: k.matchKey, ...can });
    const cluster = clusterById(k.cluster);
    const pillar = pillars[k.cluster] ? pages[pillars[k.cluster]] : null;
    const clusterBoost = pillar?.position28 >= 4 && pillar.position28 <= 20 ? 1.25 : 1;
    const { score, parts } = scoreKeyword({ impressions, clicks, position, intent: k.intent, peaks: cluster?.peaks || [], signals: k.signals || {}, serpPosition: k.serpPosition }, { month, calib, clusterBoost });
    const page = targetPath ? pages[targetPath] : null;
    const locked = !!(k.lockedUntil && new Date(k.lockedUntil) > now);
    const status = nextStatus({ ...k, targetPath }, { score, planThreshold: seo.cfg.planThreshold, locked, indexed: page?.indexVerdict === 'PASS', position, impressions, serpPosition: k.serpPosition, lastChangedAt: page?.refreshedAt || page?.publishedAt }, now);
    const data = { clicks28: clicks, impressions28: impressions, position28: position, priority: score, scoreParts: { ...parts, queries: a?.queries || [] }, targetPath };
    if (status !== k.status) { data.status = status; data.statusChangedAt = now; }
    if (targetPath && !k.baselineAt && (impressions || k.serpPosition)) { data.baselinePosition = position || k.serpPosition; data.baselineImpressions = impressions; data.baselineAt = now; }
    if (position && impressions >= 10 && (!k.bestPosition || position < k.bestPosition)) { data.bestPosition = position; data.bestPositionAt = now; }
    const hist = Array.isArray(k.history) ? [...k.history] : [];
    const point = { w: week, pos: position ? Math.round(position * 10) / 10 : null, imp: impressions, clk: clicks, serp: k.serpPosition ?? null, map: k.mapPackPosition ?? null };
    if (hist.length && hist[hist.length - 1].w === week) hist[hist.length - 1] = point; else hist.push(point);
    data.history = hist.slice(-80);
    updates.push(prisma.seoKeyword.update({ where: { id: k.id }, data }));
  }
  for (let i = 0; i < updates.length; i += 50) await prisma.$transaction(updates.slice(i, i + 50));

  // Cannibalization: the worst 5 become tasks; the rest are listed on the dashboard.
  cannibal.sort((a, b) => b.severity - a.severity);
  const raised = new Set();
  for (const c of cannibal.slice(0, 5)) {
    const key = `seo:cannibalization:${c.matchKey}`.slice(0, 120);
    raised.add(key);
    await createTask(userId, { dedupKey: key, source: 'seo', agent: 'research', routineSlug: 'seo-gsc-sync', title: `Two pages compete for "${c.keyword}"`,
      whatHappened: c.pages.map((p) => `${p.page}: ${p.impressions} impressions (${p.share}%)`).join('\n'),
      whatNeeds: 'Pick one page to own this search. Refresh it, link to it from the other page, and if the other page adds nothing new, 301 it to the owner.' });
  }
  const open = await prisma.task.findMany({ where: { userId, status: { in: OPEN_TASK_STATES }, dedupKey: { startsWith: 'seo:cannibalization:' } }, select: { dedupKey: true } });
  for (const t of open) if (!raised.has(t.dedupKey)) await completeByDedupKey(userId, t.dedupKey);
  await g.saveState(seo.row.id, { cannibalization: cannibal.slice(0, 30), calib, lastRescoreAt: now.toISOString() });
  await require('./focus').advanceFocus(userId, { now }).catch((e) => console.warn('[seo] focus advance failed:', e.message));
  return { keywords: keywords.length, newIdeas, cannibalization: cannibal.length };
}

/** Keywords checked weekly in Google and the map pack: owner-pinned, service/area head terms, then the top published ones. */
async function pickRankTracked(userId, max) {
  const all = await prisma.seoKeyword.findMany({ where: { userId, status: { not: 'retired' }, cluster: { notIn: ['brand', 'other'] } }, orderBy: { priority: 'desc' } });
  const pick = [];
  const add = (k) => { if (pick.length < max && !pick.includes(k)) pick.push(k); };
  all.filter((k) => k.pinned || k.rankTrack).forEach(add);
  all.filter((k) => k.kind === 'service' && k.targetPath).forEach(add);
  all.filter((k) => k.targetPath && ['published', 'indexed', 'ranking', 'page1', 'top3', 'stalled'].includes(k.status)).forEach(add);
  return pick;
}

async function roadmapTick(ctx) {
  const { userId } = ctx;
  const now = new Date();
  const actions = [];
  const seo = await g.loadSeo(userId);
  const seeded = await seedKeywords(userId);
  // ideas found before the off-topic filter existed (or that slipped in from Search Console) are retired, never deleted
  const stray = (await prisma.seoKeyword.findMany({ where: { userId, status: { in: ['idea', 'planned'] }, source: { in: ['serper', 'gsc'] }, pinned: false } })).filter((k) => isOffTopic(k.keyword));
  if (stray.length) {
    await prisma.seoKeyword.updateMany({ where: { id: { in: stray.map((k) => k.id) } }, data: { status: 'retired', statusChangedAt: new Date(), notes: 'auto: off-topic (jobs, equipment, another city)' } });
    actions.push(`retired ${stray.length} off-topic idea(s)`);
  }
  const imported = await importExistingPages(userId);
  if (seeded) actions.push(`seeded ${seeded} keyword(s)`);
  if (imported) actions.push(`imported ${imported} existing post(s) as published keywords`);

  let tracked = 0; let discovered = 0; let calls = 0;
  if (serper.enabled()) {
    const b = serper.budget(seo.state, seo.cfg.serperWeeklyBudget, now);
    const host = new URL(seo.origin).hostname;
    const learn = (k, data) => prisma.seoKeyword.update({ where: { id: k.id }, data });

    // 1. Weekly rank check (Google organic + map pack for service/area searches).
    const track = await pickRankTracked(userId, seo.cfg.rankTrackMax);
    for (const k of track) {
      if (!b.take()) break;
      try {
        const data = await serper.search(k.keyword);
        const sig = serper.serpSignals(data, host);
        const patch = { serpPosition: sig.ourRank, serpCheckedAt: now, rankTrack: true, signals: { ...(k.signals || {}), paa: sig.paa.length > 0, paaQuestions: sig.paa, related: sig.related.length, relatedQueries: sig.related, competitors: sig.competitors, weakSerp: sig.weakSerp, checkedAt: now.toISOString() } };
        if ((k.kind === 'service' || k.kind === 'area') && b.take()) patch.mapPackPosition = serper.ourPlacesRank(await serper.places(k.keyword), host);
        await learn(k, patch);
        tracked++;
      } catch (err) { actions.push(`Serper failed on "${k.keyword}": ${err.response?.status || err.message}`); if (err.response?.status === 403 || err.response?.status === 401) break; }
    }

    // 2. Discovery: what people search around each service, in-season services first.
    const { seasonFactor } = require('./scoring');
    const month = Number(toDateString(now).slice(5, 7));
    const clusters = [...CLUSTERS].sort((a, c) => seasonFactor(month, c.peaks) - seasonFactor(month, a.peaks));
    const ideas = [];
    const markAuto = new Set();
    for (const c of clusters) {
      if (b.left() < 2) break;
      try {
        b.take();
        const ac = await serper.autocomplete(`${c.head} `);
        const sugg = (ac.suggestions || []).map((s) => s.value || s).filter((s) => typeof s === 'string');
        sugg.forEach((s) => { ideas.push(s); markAuto.add(kw.matchKey(s)); });
        b.take();
        const res = await serper.search(`${c.head} winnipeg`);
        const sig = serper.serpSignals(res, host);
        ideas.push(...sig.related, ...sig.paa);
        const head = await prisma.seoKeyword.findUnique({ where: { userId_matchKey: { userId, matchKey: kw.matchKey(`${c.head} winnipeg`) } } });
        if (head) await learn(head, { signals: { ...(head.signals || {}), paa: sig.paa.length > 0, paaQuestions: sig.paa, related: sig.related.length, relatedQueries: sig.related, competitors: sig.competitors, weakSerp: sig.weakSerp, checkedAt: now.toISOString() }, ...(head.rankTrack ? {} : { serpPosition: sig.ourRank, serpCheckedAt: now }) });
      } catch (err) { actions.push(`Serper discovery failed for ${c.id}: ${err.response?.status || err.message}`); if ([401, 403].includes(err.response?.status)) break; }
    }
    // 3. A few neighbourhood searches a week: does Google suggest them (real demand) or not?
    const areaSeeds = await prisma.seoKeyword.findMany({ where: { userId, kind: 'area', status: { in: ['idea', 'planned'] } }, orderBy: [{ serpCheckedAt: { sort: 'asc', nulls: 'first' } }, { keyword: 'asc' }], take: 8 });
    for (const k of areaSeeds) {
      if (!b.take()) break;
      try {
        const ac = await serper.autocomplete(k.keyword);
        const sugg = (ac.suggestions || []).map((s) => s.value || s).filter((s) => typeof s === 'string');
        const auto = sugg.some((s) => kw.matchKey(s) === k.matchKey || kw.normalizeKeyword(s).startsWith(kw.normalizeKeyword(k.keyword)));
        await learn(k, { serpCheckedAt: now, signals: { ...(k.signals || {}), autocomplete: auto, checkedAt: now.toISOString() } });
        ideas.push(...sugg.filter((s) => kw.areaFor(s)));
      } catch (err) { actions.push(`Serper area check failed: ${err.response?.status || err.message}`); break; }
    }
    const index = (await prisma.seoKeyword.findMany({ where: { userId }, select: { id: true, matchKey: true } }));
    const usable = ideas.filter((s) => {
      const d = kw.describeKeyword(s);
      if (d.cluster === 'other' || d.cluster === 'brand' || isOffTopic(s) || d.matchKey.split(' ').length > 7) return false;
      const hit = kw.matchQuery(s, index);
      if (hit) { if (markAuto.has(d.matchKey)) markAuto.add(hit.matchKey); return false; }   // a variant of a keyword we already track
      index.push({ id: d.matchKey, matchKey: d.matchKey });
      return true;
    });
    discovered = await addKeywords(userId, usable.slice(0, 60), 'serper', (d) => (markAuto.has(d.matchKey) ? { signals: { autocomplete: true } } : {}));
    for (const mk of markAuto) {
      const k = await prisma.seoKeyword.findUnique({ where: { userId_matchKey: { userId, matchKey: mk } } });
      if (k && !k.signals?.autocomplete) await learn(k, { signals: { ...(k.signals || {}), autocomplete: true } });
    }
    calls = b.snapshot().calls;
    await g.saveState(seo.row.id, { serper: b.snapshot() });
  } else {
    actions.push('SERPER_API_KEY not set: discovery and rank checks skipped (Search Console only)');
  }

  const r = await rescore(userId, { now });
  await g.saveState(seo.row.id, { lastRoadmapAt: now.toISOString() });
  return {
    items_found: r.keywords,
    summary: `${r.keywords} keywords; ${tracked} rank-checked; ${discovered} new from Serper; ${r.newIdeas} new from Search Console; ${calls} Serper calls this week`,
    actions_taken: actions,
    learnings: discovered ? [{ scope: 'agent:research', key: `seo-discovery-${weekKey(now)}`, value: `Serper found ${discovered} new keyword ideas this week; ${tracked} tracked keywords checked in Google and the map pack.`, confidence: 0.7 }] : [],
  };
}

module.exports = { rescore, roadmapTick, seedKeywords, importExistingPages, pillarsFor, slugKeyword, addKeywords, SLUG };
