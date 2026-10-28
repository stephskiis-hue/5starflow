/**
 * /api/wfp/*: the Winnipeg Fence Pros page (/Winnipeg-Fence-Pros) and its Claude routine. No portal login.
 * If WFP_ACCESS_KEY is set (server env only), every request needs it as `x-wfp-key`, `Authorization: Bearer` or
 * `?key=`. Secrets are write-only: no endpoint returns a password, key or service account.
 */
const crypto = require('crypto');
const express = require('express');
const prisma = require('../lib/prismaClient');
const settings = require('../wfp/settings');
const { run } = require('../wfp');
const { startFocus, stopFocus, focusBoard } = require('../wfp/focus');
const { roadmap, nextPiece, LIVE } = require('../wfp/plan');
const { busyKeywords, publishPost } = require('../wfp/publisher');
const { getAssignment, skipAssignment, submitPost, postsThisWeek } = require('../wfp/assign');
const { testFtp, testGsc } = require('../wfp/health');
const { templateFromPage } = require('../wfp/template');
const { addKeywords } = require('../wfp/research');
const g = require('../wfp/google');
const kw = require('../wfp/keywords');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
router.use((req, res, next) => {
  const key = process.env.WFP_ACCESS_KEY;
  if (!key) return next();
  const given = req.get('x-wfp-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key || '';
  return same(given, key) ? next() : res.status(401).json({ error: 'Access key required', needKey: true });
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error('[wfp:api]', err.message);
  res.status(err.status || 500).json({ error: err.message, ...(err.details || {}) });
});

const MANUAL_JOBS = new Set(['gsc-sync', 'research', 'health', 'migrate-wordpress']);
/** Start a job without waiting (the page polls /runs). */
function startJob(job, trigger, opts) {
  run(job, trigger, opts).catch((e) => console.error(`[wfp:${job}]`, e.message));
}
const triggerOf = (req) => (req.get('x-wfp-source') === 'claude' || req.body?.source === 'claude' ? 'claude' : 'manual');

async function latestHealth() {
  return prisma.wfpRun.findFirst({ where: { job: 'health', status: 'completed' }, orderBy: { startedAt: 'desc' } });
}

async function overview() {
  const cfg = await settings.getConfig();
  const since = new Date(Date.now() - 92 * 86400000);
  const [daily, counts, health, runs, notes, posts, keywords, busy] = await Promise.all([
    prisma.wfpDaily.findMany({ where: { date: { gte: since } }, orderBy: { date: 'asc' } }),
    prisma.wfpKeyword.groupBy({ by: ['status'], _count: true }),
    latestHealth(),
    prisma.wfpRun.findMany({ orderBy: { startedAt: 'desc' }, take: 15 }),
    prisma.wfpNote.findMany({ where: { done: false }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.wfpPost.findMany({ orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, title: true, status: true, url: true, publishedAt: true, createdAt: true, error: true } }),
    prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } } }),
    busyKeywords(),
  ]);
  const last28 = daily.slice(-28);
  const prev28 = daily.slice(-56, -28);
  const sum = (rows, f) => rows.reduce((s, r) => s + r[f], 0);
  const piece = nextPiece(keywords, { busy });
  const sa = g.serviceAccount(cfg);
  return {
    business: cfg.BUSINESS_NAME, site: cfg.SITE_URL, autopilot: cfg.autopilot, publishMode: cfg.publishMode, postDays: cfg.postDays, postHour: cfg.postHour,
    missing: settings.missing(cfg), dryRun: process.env.DRY_RUN === 'true', serviceAccountEmail: sa.email || null,
    totals: { clicks: sum(last28, 'clicks'), impressions: sum(last28, 'impressions'), prevClicks: sum(prev28, 'clicks'), prevImpressions: sum(prev28, 'impressions') },
    daily: daily.map((d) => ({ date: d.date.toISOString().slice(0, 10), clicks: d.clicks, impressions: d.impressions, position: d.position })),
    keywordCounts: Object.fromEntries(counts.map((c) => [c.status, c._count])),
    health: health ? { at: health.startedAt, summary: health.summary, checks: health.detail?.checks || [] } : null,
    runs, notes, posts,
    next: piece ? { mode: piece.mode, keyword: piece.keyword.keyword, why: piece.why } : null,
    assignment: await prisma.wfpAssignment.findFirst({ where: { status: 'reserved', expiresAt: { gt: new Date() } }, select: { id: true, keyword: true, mode: true, createdAt: true, expiresAt: true } }),
    week: { posts: await postsThisWeek(new Date()), days: cfg.postDays, hour: cfg.postHour },
    routineUrl: cfg.WRITER_ROUTINE_URL || null,
    checkRoutineUrl: cfg.CHECK_ROUTINE_URL || null,
  };
}

router.get('/status', wrap(async (req, res) => res.json(await overview())));

// ── settings ──────────────────────────────────────────────────────────────────
router.get('/settings', wrap(async (req, res) => {
  const cfg = await settings.getConfig();
  res.json({ fields: await settings.publicView(), serviceAccountEmail: g.serviceAccount(cfg).email || null, accessKey: !!process.env.WFP_ACCESS_KEY });
}));
router.put('/settings', wrap(async (req, res) => {
  const n = await settings.saveSettings(req.body?.values || {}, req.body?.clear || []);
  res.json({ ok: true, saved: n, fields: await settings.publicView() });
}));

/** Test with the form's unsaved values on top of the saved ones (blank secrets = the saved secret). */
async function cfgWith(values = {}) {
  const cfg = await settings.getConfig();
  const raw = { ...cfg };
  for (const [k, v] of Object.entries(values || {})) if (v !== undefined && v !== null && String(v) !== '') raw[k] = String(v);
  return settings.toConfig(raw);
}
router.post('/settings/test-ftp', wrap(async (req, res) => {
  const cfg = await cfgWith(req.body?.values);
  if (!cfg.FTP_HOST || !cfg.FTP_USER || !cfg.FTP_PASS) return res.json({ ok: false, detail: 'Fill in host, user and password first' });
  res.json(await testFtp(cfg));
}));
router.post('/settings/test-gsc', wrap(async (req, res) => res.json(await testGsc(await cfgWith(req.body?.values)))));
router.post('/settings/test-sitemap', wrap(async (req, res) => {
  const cfg = await cfgWith(req.body?.values);
  const pages = await require('../wfp/sitepages').sitePages(cfg, 5000);
  res.json({ ok: pages.length > 0, detail: pages.length ? `${pages.length} URLs, e.g. ${pages.slice(0, 3).join(', ')}` : `Could not read ${cfg.SITEMAP_URL || '(no sitemap URL)'}` });
}));
router.post('/settings/import-template', wrap(async (req, res) => {
  const cfg = await settings.getConfig();
  const file = String(req.body?.file || '').replace(/^\/+/, '');
  if (!file || file.includes('..')) return res.status(400).json({ error: 'Give the file name of a page on the site, e.g. blog-some-post.html' });
  const ftp = require('basic-ftp');
  const { PassThrough } = require('stream');
  const client = new ftp.Client(20000);
  try {
    await client.access({ host: cfg.FTP_HOST, port: cfg.ftpPort, user: cfg.FTP_USER, password: cfg.FTP_PASS, secure: cfg.ftpSecure });
    const chunks = [];
    const sink = new PassThrough();
    sink.on('data', (c) => chunks.push(c));
    await client.downloadTo(sink, `${(cfg.FTP_PATH || '').replace(/\/+$/, '')}/${file}`);
    const out = templateFromPage(Buffer.concat(chunks).toString('utf8'));
    if (!out.template) return res.status(422).json({ error: out.error });
    res.json({ ok: true, template: out.template, replaced: out.replaced });
  } finally {
    client.close();
  }
}));

// ── keywords ──────────────────────────────────────────────────────────────────
router.get('/keywords', wrap(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = String(req.query.status);
  else if (req.query.all !== '1') where.status = { not: 'retired' };
  if (req.query.q) where.keyword = { contains: String(req.query.q).toLowerCase() };
  if (req.query.service) where.service = String(req.query.service);
  const rows = await prisma.wfpKeyword.findMany({ where, orderBy: [{ focus: 'desc' }, { priority: 'desc' }], take: 600 });
  res.json({ keywords: rows, recommendations: rows.filter((k) => k.recommended).sort((a, b) => b.priority - a.priority) });
}));
router.post('/keywords', wrap(async (req, res) => {
  const cfg = await settings.getConfig();
  const list = (Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword]).map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50);
  if (!list.length) return res.status(400).json({ error: 'keyword required' });
  const source = triggerOf(req) === 'claude' ? 'claude' : 'owner';
  const supportsId = req.body?.supportsId || null;
  const created = await addKeywords(list.map((k) => ({ keyword: k, source, notes: String(req.body?.notes || '').slice(0, 2000), supportsId, status: supportsId ? 'planned' : 'idea' })), cfg);
  await require('../wfp/research').rescore(cfg);
  res.json({ ok: true, created, skipped: list.length - created });
}));
router.patch('/keywords/:id', wrap(async (req, res) => {
  const data = {};
  const b = req.body || {};
  if (['idea', 'planned', 'retired'].includes(b.status)) { data.status = b.status; data.statusChangedAt = new Date(); }
  if (typeof b.rankTrack === 'boolean') data.rankTrack = b.rankTrack;
  if (typeof b.notes === 'string') data.notes = b.notes.slice(0, 2000);
  if (typeof b.keyword === 'string' && b.keyword.trim()) Object.assign(data, kw.describe(b.keyword, await settings.getConfig()));
  res.json(await prisma.wfpKeyword.update({ where: { id: req.params.id }, data }));
}));
router.delete('/keywords/:id', wrap(async (req, res) => {
  const k = await prisma.wfpKeyword.findUnique({ where: { id: req.params.id } });
  if (!k) return res.status(404).json({ error: 'not found' });
  if (LIVE.has(k.status) || k.focus) return res.status(409).json({ error: 'This keyword has a post or a focus campaign: retire it instead' });
  await prisma.wfpKeyword.updateMany({ where: { supportsId: k.id }, data: { supportsId: null } });
  await prisma.wfpKeyword.delete({ where: { id: k.id } });
  res.json({ ok: true });
}));
router.post('/keywords/:id/focus', wrap(async (req, res) => res.json(await startFocus(req.params.id, Number(req.body?.goal) === 10 ? 10 : 3))));
router.delete('/keywords/:id/focus', wrap(async (req, res) => res.json(await stopFocus(req.params.id))));
// a correction: the writer refreshes this article next, with the reason in its brief (owner, weekly check routine)
router.post('/keywords/:id/refresh', wrap(async (req, res) => {
  const k = await prisma.wfpKeyword.findUnique({ where: { id: req.params.id } });
  if (!k) return res.status(404).json({ error: 'not found' });
  if (!LIVE.has(k.status) || !k.targetUrl) return res.status(409).json({ error: 'Only a keyword with a live article can be refreshed' });
  const reason = String(req.body?.reason || '').trim().slice(0, 1000);
  if (!reason) return res.status(400).json({ error: 'reason required: say what the refresh must fix' });
  res.json(await prisma.wfpKeyword.update({ where: { id: k.id }, data: { refreshAsked: new Date(), refreshReason: `${reason}${triggerOf(req) === 'claude' ? ' (weekly check)' : ''}` } }));
}));
router.delete('/keywords/:id/refresh', wrap(async (req, res) => {
  res.json(await prisma.wfpKeyword.update({ where: { id: req.params.id }, data: { refreshAsked: null, refreshReason: null } }));
}));
router.post('/keywords/:id/dismiss', wrap(async (req, res) => {
  res.json(await prisma.wfpKeyword.update({ where: { id: req.params.id }, data: { recommended: false, dismissedUntil: new Date(Date.now() + 56 * 86400000) } }));
}));
// ── the writer routine (claude.ai): one assignment, then the finished post ──
router.get('/assignment', wrap(async (req, res) => res.json(await getAssignment())));
router.post('/assignment/:id/skip', wrap(async (req, res) => res.json(await skipAssignment(req.params.id, req.body?.reason))));
router.post('/publish', express.json({ limit: '2mb' }), wrap(async (req, res) => {
  if (!req.body?.assignmentId) return res.status(400).json({ error: 'assignmentId required' });
  res.json(await submitPost(req.body.assignmentId, req.body));
}));
router.get('/queries', wrap(async (req, res) => {
  res.json(await prisma.wfpQuery.findMany({ orderBy: { impressions: 'desc' }, take: Math.min(500, Number(req.query.limit) || 200) }));
}));

// ── focus, roadmap, rankings ──────────────────────────────────────────────────
router.get('/focus', wrap(async (req, res) => {
  const cfg = await settings.getConfig();
  res.json({ focusMax: cfg.focusMax, campaigns: await focusBoard() });
}));
router.get('/roadmap', wrap(async (req, res) => {
  const cfg = await settings.getConfig();
  const keywords = await prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } } });
  const upcoming = roadmap(keywords, cfg, { busy: await busyKeywords(), n: Math.min(20, Number(req.query.n) || 10) });
  const recent = await prisma.wfpPost.findMany({ where: { status: { in: ['published', 'replaced'] } }, orderBy: { publishedAt: 'desc' }, take: 20, select: { id: true, title: true, url: true, keyword: true, mode: true, publishedAt: true } });
  const pipeline = Object.fromEntries(['idea', 'planned', 'published', 'indexed', 'ranking', 'page1', 'top3'].map((s) => [s, keywords.filter((k) => k.status === s).length]));
  res.json({ upcoming, recent, pipeline, schedule: { autopilot: cfg.autopilot, days: cfg.postDays, hour: cfg.postHour } });
}));
router.get('/rankings', wrap(async (req, res) => {
  const rows = await prisma.wfpKeyword.findMany({ where: { OR: [{ rankTrack: true }, { impressions28: { gt: 0 } }], status: { not: 'retired' } }, orderBy: [{ focus: 'desc' }, { impressions28: 'desc' }], take: 300 });
  res.json(rows.map((k) => ({ id: k.id, keyword: k.keyword, status: k.status, focus: k.focus && k.focusStatus === 'active', rankTrack: k.rankTrack, position28: k.position28, prevPosition28: k.prevPosition28, impressions28: k.impressions28, clicks28: k.clicks28, serpPosition: k.serpPosition, mapPackPosition: k.mapPackPosition, serpCheckedAt: k.serpCheckedAt, serpTop: k.serpTop, targetUrl: k.targetUrl, topPage: k.topPage, history: k.history || [] })));
}));

// ── posts ─────────────────────────────────────────────────────────────────────
router.get('/posts', wrap(async (req, res) => {
  res.json(await prisma.wfpPost.findMany({ orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, keyword: true, keywordId: true, mode: true, slug: true, title: true, metaDescription: true, excerpt: true, category: true, readTime: true, status: true, url: true, error: true, log: true, sources: true, publishedAt: true, createdAt: true } }));
}));
router.get('/posts/:id/preview', wrap(async (req, res) => {
  const p = await prisma.wfpPost.findUnique({ where: { id: req.params.id }, select: { html: true } });
  if (!p) return res.status(404).send('Not found');
  // sandboxed: the page runs as its own opaque origin, so nothing in it can reach this API
  res.set('Content-Security-Policy', 'sandbox allow-popups');
  res.type('html').send(p.html || '<p>Not written yet.</p>');
}));
router.post('/posts/:id/publish', wrap(async (req, res) => {
  const id = req.params.id;
  const { runJob } = require('../wfp/runner');
  runJob('publish', (ctx) => publishPost(id, ctx), { trigger: triggerOf(req) }).catch(() => {});
  res.status(202).json({ ok: true, started: 'publish' });
}));
router.delete('/posts/:id', wrap(async (req, res) => {
  const p = await prisma.wfpPost.findUnique({ where: { id: req.params.id } });
  if (!p) return res.status(404).json({ error: 'not found' });
  if (!['draft', 'failed'].includes(p.status)) return res.status(409).json({ error: 'Only drafts and failed posts can be deleted here (a published post stays on the site)' });
  await prisma.wfpPost.delete({ where: { id: p.id } });
  res.json({ ok: true });
}));

// ── jobs, notes ───────────────────────────────────────────────────────────────
router.get('/runs', wrap(async (req, res) => {
  const where = req.query.job ? { job: String(req.query.job) } : {};
  res.json(await prisma.wfpRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: Math.min(100, Number(req.query.limit) || 30) }));
}));
router.post('/jobs/:job/run', wrap(async (req, res) => {
  const job = req.params.job;
  if (!MANUAL_JOBS.has(job)) return res.status(404).json({ error: `unknown job ${job}` });
  const opts = job === 'migrate-wordpress' ? { dryRun: !!req.body?.dryRun, overwrite: !!req.body?.overwrite, redirects: req.body?.redirects !== false } : {};
  startJob(job, triggerOf(req), opts);
  res.status(202).json({ ok: true, started: job });
}));
router.get('/notes', wrap(async (req, res) => {
  const where = req.query.all === '1' ? {} : { done: false };
  if (req.query.kind) where.kind = String(req.query.kind);
  res.json(await prisma.wfpNote.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }));
}));
router.post('/notes', wrap(async (req, res) => {
  const b = req.body || {};
  if (!String(b.body || '').trim()) return res.status(400).json({ error: 'body required' });
  const author = triggerOf(req) === 'claude' ? 'claude' : 'owner';
  const kind = ['note', 'report', 'instruction', 'learning'].includes(b.kind) ? b.kind : 'note';
  res.json(await prisma.wfpNote.create({ data: { author, kind, title: String(b.title || '').slice(0, 200), body: String(b.body).slice(0, 20000) } }));
}));
router.patch('/notes/:id', wrap(async (req, res) => {
  res.json(await prisma.wfpNote.update({ where: { id: req.params.id }, data: { done: !!req.body?.done } }));
}));

/** The Claude routine's work packet: everything it needs in one call, no secrets. */
router.get('/brief', wrap(async (req, res) => {
  const o = await overview();
  const cfg = await settings.getConfig();
  const keywords = await prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } }, orderBy: { priority: 'desc' } });
  const movers = keywords.filter((k) => k.position28 != null && k.prevPosition28 != null).map((k) => ({ keyword: k.keyword, now: k.position28, before: k.prevPosition28, change: Math.round((k.prevPosition28 - k.position28) * 10) / 10 }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 10);
  res.json({
    business: { name: cfg.BUSINESS_NAME, site: cfg.SITE_URL, city: cfg.CITY, services: cfg.services.map((s) => ({ name: s.name, page: s.path })), areas: cfg.areas },
    setup: { missing: o.missing, autopilot: o.autopilot, publishMode: o.publishMode, dryRun: o.dryRun },
    health: o.health, totals: o.totals, next: o.next,
    focus: (await focusBoard()).map((f) => ({ id: f.id, keyword: f.keyword, status: f.focusStatus, goal: f.focusGoal, position28: f.position28, serp: f.serpPosition, map: f.mapPackPosition, url: f.targetUrl, supports: f.supports.map((s) => ({ keyword: s.keyword, status: s.status })) })),
    recommendations: keywords.filter((k) => k.recommended).map((k) => ({ id: k.id, keyword: k.keyword, why: k.why, impressions28: k.impressions28, position28: k.position28 })),
    topKeywords: keywords.slice(0, 25).map((k) => ({ id: k.id, keyword: k.keyword, status: k.status, priority: k.priority, impressions28: k.impressions28, position28: k.position28, serp: k.serpPosition, source: k.source })),
    movers,
    roadmap: roadmap(keywords, cfg, { busy: await busyKeywords(), n: 6 }),
    // every live article with its numbers: what the weekly check judges and learns from
    articles: keywords.filter((k) => LIVE.has(k.status) && k.targetUrl).map((k) => ({
      keywordId: k.id, keyword: k.keyword, service: k.service, url: k.targetUrl, status: k.status, publishedAt: k.publishedAt, refreshedAt: k.refreshedAt,
      position28: k.position28, prevPosition28: k.prevPosition28, impressions28: k.impressions28, clicks28: k.clicks28,
      ctr: k.impressions28 ? Math.round((k.clicks28 / k.impressions28) * 1000) / 10 : null, google: k.serpPosition, mapPack: k.mapPackPosition,
      correction: k.refreshAsked ? k.refreshReason : null,
    })).sort((a, b) => (b.impressions28 || 0) - (a.impressions28 || 0)).slice(0, 60),
    focusSlots: Math.max(0, cfg.focusMax - (await prisma.wfpKeyword.count({ where: { focus: true, focusStatus: 'active' } }))),
    learnings: (await prisma.wfpNote.findMany({ where: { kind: 'learning', done: false }, orderBy: { createdAt: 'desc' }, take: 30 })).map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.createdAt })),
    lastWeek: { posts: await postsThisWeek(new Date()) },
    posts: await prisma.wfpPost.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * 86400000) } }, orderBy: { createdAt: 'desc' }, select: { title: true, keyword: true, status: true, url: true, error: true, publishedAt: true } }),
    failedRuns: o.runs.filter((r) => r.status === 'failed').map((r) => ({ job: r.job, at: r.startedAt, error: r.error })),
    openNotes: o.notes.map((n) => ({ id: n.id, author: n.author, kind: n.kind, title: n.title, body: n.body.slice(0, 500), at: n.createdAt })),
  });
}));

module.exports = router;
