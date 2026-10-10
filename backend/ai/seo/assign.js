/**
 * Assignments: the daily blog run asks for one, writes it, then reports it published.
 * Locking uses the claimNext pattern (atomic updateMany on lockedUntil) so two runs never take the same keyword,
 * and a re-run after a crash gets the same reservation back.
 */
const prisma = require('../../lib/prismaClient');
const { recordActivity } = require('../ledger');
const { CLUSTERS, clusterById } = require('./config');
const kw = require('./keywords');
const { canonicalPath, toUrl, kindForPath } = require('./urls');
const { pickAssignment } = require('./assignPick');
const { pillarsFor } = require('./roadmap');
const g = require('./google');

const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PUBLISHED = ['published', 'indexed', 'ranking', 'page1', 'top3', 'stalled'];

const slugify = (s) => kw.normalizeKeyword(s).replace(/\b(in|the|a|an|of|for|to|my|your|does|do|is|how much)\b/g, ' ').trim().replace(/\s+/g, '-').slice(0, 70);

async function releaseStale(userId, now = new Date()) {
  await prisma.seoAssignment.updateMany({ where: { userId, status: 'reserved', expiresAt: { lt: now } }, data: { status: 'expired' } });
  const stale = await prisma.seoKeyword.findMany({ where: { userId, lockedUntil: { lt: now } }, select: { id: true, status: true, targetPath: true } });
  for (const k of stale) {
    await prisma.seoKeyword.update({ where: { id: k.id }, data: { lockedUntil: null, lockedBy: null, ...(k.status === 'assigned' ? { status: k.targetPath ? 'published' : 'planned' } : {}) } });
  }
}

async function context(userId, now) {
  const seo = await g.loadSeo(userId);
  const [keywords, pageRows, historyRows] = await Promise.all([
    prisma.seoKeyword.findMany({ where: { userId } }),
    prisma.seoPage.findMany({ where: { userId } }),
    prisma.seoAssignment.findMany({ where: { userId, createdAt: { gte: new Date(now - 30 * DAY) } }, orderBy: { createdAt: 'desc' } }),
  ]);
  const pages = Object.fromEntries(pageRows.map((p) => [p.path, p]));
  const history = historyRows.map((h) => ({ ...h, kind: h.brief?.kind }));
  return { seo, keywords, pages, history, pillars: pillarsFor(seo.state, pages), calib: seo.state.calib || 1 };
}

/** Is the weekly recap due? Every cfg.reportEveryDays days, once at least one post went out since the last one. */
async function reportStatus(userId, cfg) {
  const last = await prisma.seoProgressReport.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  const since = last?.createdAt || new Date(0);
  const postsSince = await prisma.seoAssignment.count({ where: { userId, status: 'published', publishedAt: { gt: since } } });
  // the first recap comes a week after the first post the engine saw
  const first = last ? null : await prisma.seoAssignment.findFirst({ where: { userId, status: 'published' }, orderBy: { publishedAt: 'asc' }, select: { publishedAt: true } });
  const anchor = last?.createdAt || first?.publishedAt;
  const daysSince = anchor ? (Date.now() - new Date(anchor)) / DAY : 0;
  const every = cfg.reportEveryDays || 7;
  return { due: postsSince > 0 && daysSince >= every - 0.25, postsSince, daysSince: Math.round(daysSince * 10) / 10, lastReportAt: last?.createdAt || null };
}

/** The frozen work order handed to the writer. */
async function buildBrief(userId, c, pick, now) {
  const { seo, keywords, pages, pillars } = c;
  const k = pick.keyword;
  const cluster = clusterById(k.cluster);
  const origin = seo.origin;
  const live = (p) => pages[p] && (pages[p].httpStatus || 200) === 200 && !pages[p].redirectTo;
  const pillarPath = pillars[k.cluster] || null;
  const siblings = keywords.filter((o) => o.id !== k.id && o.cluster === k.cluster && o.targetPath && live(o.targetPath) && pages[o.targetPath].kind === 'blog' && o.targetPath !== k.targetPath)
    .sort((a, b) => (b.impressions28 - a.impressions28) || (new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)));
  const internalLinks = [];
  if (pillarPath && live(pillarPath) && pillarPath !== k.targetPath) internalLinks.push({ url: toUrl(pillarPath, origin), anchor: `${(cluster?.head || k.cluster)} in Winnipeg`, required: true, why: 'the service page this cluster supports' });
  for (const s of siblings.slice(0, 3)) internalLinks.push({ url: toUrl(s.targetPath, origin), anchor: s.keyword.replace(/\s+winnipeg$/, ''), required: false, why: 'related post' });
  const avoidAll = [
    ...keywords.filter((o) => o.id !== k.id && o.cluster === k.cluster && o.targetPath && PUBLISHED.includes(o.status)).slice(0, 12)
      .map((o) => ({ keyword: o.keyword, url: toUrl(o.targetPath, origin), reason: 'another page already owns this search' })),
    ...(pick.mode !== 'page' ? keywords.filter((o) => o.cluster === k.cluster && (o.kind === 'service' || o.kind === 'area')).slice(0, 4).map((o) => ({ keyword: o.keyword, reason: 'reserved for the service/area page: do not target it in a blog post' })) : []),
  ];
  const avoid = avoidAll.filter((a, i) => avoidAll.findIndex((b) => b.keyword === a.keyword) === i);
  const month = Number(now.toLocaleDateString('en-CA', { timeZone: process.env.BUSINESS_TZ || 'America/Winnipeg', month: 'numeric' }));
  const peak = cluster?.peaks?.length ? cluster.peaks.map((m) => MONTHS[m - 1]).join(', ') : 'all season';
  const target = pick.mode === 'new' ? null : k.targetPath;
  const targetPage = target ? pages[target] : null;
  const suggestedSlug = pick.mode === 'page' ? (k.kind === 'service' && cluster?.plannedPillar ? cluster.plannedPillar.slice(1) : slugify(k.keyword))
    : pick.mode === 'new' ? `blog-${slugify(k.keyword)}` : null;
  const secondary = (k.scoreParts?.queries || []).map((q) => q.q).filter((q) => kw.matchKey(q) !== k.matchKey).slice(0, 5);
  const report = await reportStatus(userId, seo.cfg);
  return {
    mode: pick.mode, kind: pick.mode === 'page' ? k.kind : 'blog', keyword: k.keyword, secondary, questions: k.signals?.paaQuestions || [],
    cluster: k.cluster, clusterLabel: cluster?.label || k.cluster, intent: k.intent, area: k.area || null,
    pillarUrl: pillarPath ? toUrl(pillarPath, origin) : null,
    contentType: pick.contentType, contentTypeReason: pick.contentTypeReason,
    targetUrl: target ? toUrl(target, origin) : null,
    suggestedSlug, suggestedUrl: suggestedSlug ? toUrl(`/${suggestedSlug}`, origin) : null,
    evidence: { impressions28: k.impressions28, clicks28: k.clicks28, position28: k.position28 ? Math.round(k.position28 * 10) / 10 : null, serpPosition: k.serpPosition, mapPackPosition: k.mapPackPosition,
      score: pick.score, why: pick.why, queries: k.scoreParts?.queries || [], competitors: k.signals?.competitors || [] },
    internalLinks, avoid,
    seasonal: { month: MONTHS[month - 1], peakMonths: peak, calendar: '.claude/skills/nobs-content/seasonal-calendar.md' },
    onPage: { primaryIn: ['title', 'h1', 'first 100 words', 'meta description', pick.mode === 'refresh' ? 'keep the URL' : 'slug'], wordCount: pick.mode === 'page' ? [800, 1300] : [700, 950] },
    refresh: target ? { currentTitle: targetPage?.title || null, wordCount: targetPage?.wordCount || null, indexVerdict: targetPage?.indexVerdict || null, coverageState: targetPage?.coverageState || null,
      lowCtr: /few clicks/.test(pick.why), publishedAt: targetPage?.publishedAt || k.publishedAt } : null,
    reportDue: report.due, postsSinceReport: report.postsSince,
  };
}

/** GET /seo/assignment: the current reservation, or a new one. modes = what the writer supports. */
async function reserve(userId, { modes = ['new'], agent = 'content', fresh = false, now = new Date() } = {}) {
  await releaseStale(userId, now);
  if (!fresh) {
    const open = await prisma.seoAssignment.findFirst({ where: { userId, status: 'reserved', expiresAt: { gt: now } }, orderBy: { createdAt: 'desc' } });
    if (open) return { assignment: open, reused: true };
  }
  const c = await context(userId, now);
  const picks = pickAssignment({ keywords: c.keywords, pages: c.pages, history: c.history, cfg: c.seo.cfg, modes, now, calib: c.calib, pillars: c.pillars });
  const until = new Date(now.getTime() + c.seo.cfg.assignmentHours * 3600e3);
  for (const pick of picks.slice(0, 5)) {
    const won = await prisma.seoKeyword.updateMany({
      where: { id: pick.keyword.id, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
      data: { lockedUntil: until, lockedBy: String(agent).slice(0, 80), lastAssignedAt: now, status: 'assigned', statusChangedAt: now },
    });
    if (!won.count) continue;
    const brief = await buildBrief(userId, c, pick, now);
    const assignment = await prisma.seoAssignment.create({ data: {
      userId, keywordId: pick.keyword.id, keywordText: pick.keyword.keyword, cluster: pick.keyword.cluster, mode: pick.mode, contentType: pick.contentType,
      brief, targetPath: pick.mode === 'new' ? null : pick.keyword.targetPath, reservedBy: String(agent).slice(0, 80), expiresAt: until,
    } });
    await prisma.seoAssignment.update({ where: { id: assignment.id }, data: { brief: { ...brief, assignmentId: assignment.id, expiresAt: until.toISOString() } } });
    return { assignment: await prisma.seoAssignment.findUnique({ where: { id: assignment.id } }), reused: false };
  }
  return { assignment: null, reason: picks.length ? 'every candidate was locked by another run' : 'nothing worth writing right now: use your own topic and report it with POST /seo/published' };
}

async function skip(userId, id, reason) {
  const a = await prisma.seoAssignment.findFirst({ where: { id, userId, status: 'reserved' } });
  if (!a) return null;
  await prisma.seoAssignment.update({ where: { id }, data: { status: 'skipped', skipReason: String(reason || '').slice(0, 500) } });
  const k = await prisma.seoKeyword.findUnique({ where: { id: a.keywordId } });
  if (k) await prisma.seoKeyword.update({ where: { id: k.id }, data: { lockedUntil: null, lockedBy: null, ...(k.status === 'assigned' ? { status: k.targetPath ? 'published' : 'planned' } : {}) } });
  return a;
}

/**
 * POST /seo/published: the writer's report. Registers the page, moves the keyword to "published" with a baseline,
 * closes the assignment, and kicks a light index check (sitemaps + IndexNow) in the background.
 */
async function markPublished(userId, b, { agent = 'content', now = new Date() } = {}) {
  const seo = await g.loadSeo(userId);
  const path = canonicalPath(b.url, seo.origin);
  if (!path) { const e = new Error(`url must be on ${seo.origin}`); e.status = 400; throw e; }
  const assignment = b.assignmentId ? await prisma.seoAssignment.findFirst({ where: { id: String(b.assignmentId), userId } }) : null;
  const mode = ['new', 'refresh', 'page'].includes(b.mode) ? b.mode : assignment?.mode || 'new';
  const primary = String(b.primaryKeyword || assignment?.keywordText || '').slice(0, 120);
  if (!primary) { const e = new Error('primaryKeyword is required'); e.status = 400; throw e; }
  const d = kw.describeKeyword(primary);
  const kind = mode === 'page' ? (b.kind === 'area' || d.kind === 'area' ? 'area' : 'service') : (kindForPath(path) === 'blog' ? 'blog' : b.kind || 'blog');

  const prevPage = await prisma.seoPage.findUnique({ where: { userId_path: { userId, path } } });
  const pageData = {
    kind, title: b.title ? String(b.title).slice(0, 300) : prevPage?.title || null, primaryKeyword: d.keyword,
    secondaryKeywords: Array.isArray(b.secondaryKeywords) ? b.secondaryKeywords.slice(0, 10).map((s) => String(s).slice(0, 120)) : prevPage?.secondaryKeywords || undefined,
    cluster: d.cluster, contentType: b.contentType ? String(b.contentType).slice(0, 40) : assignment?.contentType || null,
    wordCount: Number.isFinite(Number(b.wordCount)) ? Number(b.wordCount) : prevPage?.wordCount || null, source: 'published',
    ...(mode === 'refresh' ? { refreshedAt: now } : { publishedAt: prevPage?.publishedAt || now }),
  };
  const page = prevPage ? await prisma.seoPage.update({ where: { id: prevPage.id }, data: pageData }) : await prisma.seoPage.create({ data: { userId, path, inSitemap: false, ...pageData } });

  let keyword = assignment ? await prisma.seoKeyword.findUnique({ where: { id: assignment.keywordId } }) : null;
  if (!keyword) keyword = await prisma.seoKeyword.findUnique({ where: { userId_matchKey: { userId, matchKey: d.matchKey } } });
  const kwData = { targetPath: path, status: 'published', statusChangedAt: now, lockedUntil: null, lockedBy: null,
    ...(mode !== 'refresh' ? { publishedAt: now, baselinePosition: keyword?.position28 || keyword?.serpPosition || null, baselineImpressions: keyword?.impressions28 || 0, baselineAt: now } : {}) };
  keyword = keyword ? await prisma.seoKeyword.update({ where: { id: keyword.id }, data: kwData })
    : await prisma.seoKeyword.create({ data: { userId, ...d, kind: kind === 'blog' ? 'blog' : kind, source: assignment ? 'seed' : 'claude', ...kwData } });

  // Secondary keywords the post also targets: claim the ones no page owns yet.
  for (const s of (pageData.secondaryKeywords || []).slice(0, 5)) {
    const sd = kw.describeKeyword(s);
    if (!sd.matchKey || sd.matchKey === d.matchKey || sd.kind !== 'blog') continue;
    const ex = await prisma.seoKeyword.findUnique({ where: { userId_matchKey: { userId, matchKey: sd.matchKey } } });
    if (!ex) await prisma.seoKeyword.create({ data: { userId, ...sd, source: 'claude', status: 'published', targetPath: path, publishedAt: now } });
    else if (!ex.targetPath) await prisma.seoKeyword.update({ where: { id: ex.id }, data: { targetPath: path, status: 'published', publishedAt: now } });
  }

  if (assignment && assignment.status !== 'published') {
    await prisma.seoAssignment.update({ where: { id: assignment.id }, data: { status: 'published', publishedAt: now, publishedPath: path } });
  } else if (!assignment) {
    await prisma.seoAssignment.create({ data: { userId, keywordId: keyword.id, keywordText: keyword.keyword, cluster: keyword.cluster, mode, contentType: pageData.contentType,
      brief: { mode, kind, keyword: keyword.keyword, unassigned: true }, targetPath: path, reservedBy: agent, expiresAt: now, status: 'published', publishedAt: now, publishedPath: path } });
  }
  // A new service page becomes its cluster's pillar, so later posts link up to it.
  if (mode === 'page' && kind === 'service' && d.cluster && d.cluster !== 'other') {
    const pillars = { ...(seo.state.pillars || {}) };
    let changed = false;
    for (const c of CLUSTERS) if (!pillars[c.id] && (c.id === d.cluster || c.plannedPillar === path)) { pillars[c.id] = path; changed = true; }
    if (changed) await g.saveState(seo.row.id, { pillars });
  }

  const verb = mode === 'refresh' ? 'Refreshed' : mode === 'page' ? `New ${kind} page` : 'New post';
  await recordActivity(userId, { agent, routineSlug: 'ext-blog-autopilot', action: `${verb}: ${pageData.title || path}`, summary: `${toUrl(path, seo.origin)} targets "${d.keyword}"`, result: 'ok', source: 'claude' });
  if (mode === 'page') {
    await require('../../lib/notify').notify(userId, { category: 'seo', title: `${verb} published: ${pageData.title || path}`, body: `Targets "${d.keyword}". See SEO Growth > Content log.`, link: '/seo-growth.html#content', routineSlug: 'ext-blog-autopilot' }).catch(() => {});
  }
  const report = await reportStatus(userId, seo.cfg);
  return { page, keyword, mode, reportDue: report.due, postsSinceReport: report.postsSince };
}

/** Dry run of the picker for the dashboard: what the next runs would get, without locking anything. */
async function preview(userId, { modes = ['new', 'refresh', 'page'], limit = 10, now = new Date() } = {}) {
  const c = await context(userId, now);
  return pickAssignment({ keywords: c.keywords, pages: c.pages, history: c.history, cfg: c.seo.cfg, modes, now, calib: c.calib, pillars: c.pillars })
    .slice(0, limit).map((p) => ({ id: p.keyword.id, keyword: p.keyword.keyword, cluster: p.keyword.cluster, kind: p.keyword.kind, mode: p.mode, contentType: p.contentType, score: p.score, why: p.why, targetPath: p.mode === 'new' ? null : p.keyword.targetPath }));
}

module.exports = { reserve, skip, markPublished, releaseStale, reportStatus, preview, buildBrief, slugify };
