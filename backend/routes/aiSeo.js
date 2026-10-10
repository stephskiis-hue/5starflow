/**
 * /api/ai/seo/* — the SEO Growth Engine (backend/ai/seo). Mounted inside routes/ai.js, so it shares its auth:
 * the daily blog run (bearer AI_TOKEN) and the SEO Growth page (owner session).
 */
const express = require('express');
const router = express.Router();

const prisma = require('../lib/prismaClient');
const { runRoutine } = require('../ai/runner');
const assign = require('../ai/seo/assign');
const { buildProgress, createReport } = require('../ai/seo/progress');
const { describeKeyword } = require('../ai/seo/keywords');
const { STATUSES } = require('../ai/seo/lifecycle');
const { DEFAULT_GROWTH_CONFIG } = require('../ai/seo/config');
const g = require('../ai/seo/google');

['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const orig = router[method].bind(router);
  router[method] = (path, ...handlers) => orig(path, ...handlers.map((h) =>
    (typeof h === 'function' && h.constructor.name === 'AsyncFunction') ? (req, res, next) => h(req, res, next).catch(next) : h));
});
const ownerOnly = (req, res, next) => (req.ai.actor === 'owner' ? next() : res.status(403).json({ error: 'Owner session required' }));
const int = (v, d, max = 200) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);
const agentOf = (req) => (req.ai.actor === 'owner' ? 'owner' : req.ai.agent || 'content');
const fail = (res, err) => res.status(err.status || 500).json({ error: err.message });

/** Kick a light index check (sitemaps + IndexNow + newest inspections) without making the caller wait. */
function lightCheck(userId, trigger = 'api') {
  setTimeout(() => {
    runRoutine('seo-index-watch', (ctx) => require('../ai/seo/indexWatch').indexWatchTick(ctx, { light: true }), { trigger, userId })
      .catch((e) => console.warn('[seo] light index check failed:', e.message));
  }, 1500);
}

// --------------------------------------------------------------------------- the writer's loop
router.get('/assignment', async (req, res) => {
  const modes = String(req.query.modes || 'new').split(',').map((s) => s.trim()).filter((m) => ['new', 'refresh', 'page'].includes(m));
  const out = await assign.reserve(req.ai.userId, { modes, agent: agentOf(req), fresh: req.query.fresh === '1' });
  if (!out.assignment) return res.json({ assignment: null, reason: out.reason });
  res.json({ assignment: { ...out.assignment.brief, assignmentId: out.assignment.id, expiresAt: out.assignment.expiresAt }, reused: out.reused });
});

router.post('/assignment/:id/skip', async (req, res) => {
  const a = await assign.skip(req.ai.userId, req.params.id, req.body?.reason);
  if (!a) return res.status(404).json({ error: 'No open assignment with that id' });
  res.json({ ok: true });
});

router.post('/published', async (req, res) => {
  try {
    const out = await assign.markPublished(req.ai.userId, req.body || {}, { agent: agentOf(req) });
    lightCheck(req.ai.userId);
    res.status(201).json({ ok: true, path: out.page.path, keyword: out.keyword.keyword, mode: out.mode, reportDue: out.reportDue, postsSinceReport: out.postsSinceReport });
  } catch (err) { fail(res, err); }
});

// --------------------------------------------------------------------------- keywords + pages
router.get('/keywords', async (req, res) => {
  const where = { userId: req.ai.userId };
  if (req.query.status && STATUSES.includes(req.query.status)) where.status = req.query.status;
  if (req.query.cluster) where.cluster = String(req.query.cluster);
  if (req.query.q) where.keyword = { contains: String(req.query.q).toLowerCase() };
  res.json(await prisma.seoKeyword.findMany({ where, orderBy: { priority: 'desc' }, take: int(req.query.limit, 100, 500) }));
});

// Agents may add ideas (Claude research); the owner may add anything and pin it straight away.
router.post('/keywords', async (req, res) => {
  const list = Array.isArray(req.body?.keywords) ? req.body.keywords : [req.body?.keyword].filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'keyword (or keywords[]) required' });
  const owner = req.ai.actor === 'owner';
  const created = [];
  for (const raw of list.slice(0, 50)) {
    const d = describeKeyword(typeof raw === 'string' ? raw : raw.keyword);
    if (!d.matchKey || d.cluster === 'brand') continue;
    const extra = owner ? { pinned: !!req.body.pin, source: 'owner', ...(req.body.pin ? { status: 'planned' } : {}) } : { source: 'claude' };
    const notes = typeof raw === 'object' && raw.notes ? String(raw.notes).slice(0, 500) : '';
    const row = await prisma.seoKeyword.upsert({ where: { userId_matchKey: { userId: req.ai.userId, matchKey: d.matchKey } }, update: owner && req.body.pin ? { pinned: true } : {}, create: { userId: req.ai.userId, ...d, ...extra, notes } });
    created.push({ id: row.id, keyword: row.keyword, cluster: row.cluster, kind: row.kind });
  }
  res.status(201).json({ ok: true, keywords: created });
});

router.patch('/keywords/:id', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const data = {};
  for (const f of ['pinned', 'rankTrack']) if (typeof b[f] === 'boolean') data[f] = b[f];
  if (b.status === 'retired') { data.status = 'retired'; data.statusChangedAt = new Date(); }
  if (b.status === 'idea' || b.status === 'planned') { data.status = b.status; data.statusChangedAt = new Date(); }
  if (['blog', 'service', 'area'].includes(b.kind)) data.kind = b.kind;
  if (typeof b.cluster === 'string') data.cluster = b.cluster.slice(0, 40);
  if (b.targetPath === null || typeof b.targetPath === 'string') data.targetPath = b.targetPath ? b.targetPath.slice(0, 300) : null;
  if (typeof b.notes === 'string') data.notes = b.notes.slice(0, 1000);
  if (data.pinned && !data.status) data.status = 'planned';
  const r = await prisma.seoKeyword.updateMany({ where: { id: req.params.id, userId: req.ai.userId }, data });
  if (!r.count) return res.status(404).json({ error: 'Unknown keyword' });
  res.json({ ok: true });
});

router.get('/pages', async (req, res) => {
  const where = { userId: req.ai.userId };
  if (req.query.kind) where.kind = String(req.query.kind);
  res.json(await prisma.seoPage.findMany({ where, orderBy: [{ impressions28: 'desc' }, { path: 'asc' }], take: int(req.query.limit, 300, 1000) }));
});

router.patch('/pages/:id', ownerOnly, async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (typeof b.excluded === 'boolean') data.excluded = b.excluded;
  if (['home', 'service', 'area', 'blog', 'hub', 'other'].includes(b.kind)) { data.kind = b.kind; data.source = 'owner'; }
  if (typeof b.primaryKeyword === 'string') data.primaryKeyword = b.primaryKeyword.slice(0, 120);
  const r = await prisma.seoPage.updateMany({ where: { id: req.params.id, userId: req.ai.userId }, data });
  if (!r.count) return res.status(404).json({ error: 'Unknown page' });
  res.json({ ok: true });
});

// --------------------------------------------------------------------------- progress + weekly recap
router.get('/progress', async (req, res) => res.json(await buildProgress(req.ai.userId, { view: req.query.view })));

router.get('/reports', async (req, res) => res.json(await prisma.seoProgressReport.findMany({ where: { userId: req.ai.userId }, orderBy: { createdAt: 'desc' }, take: int(req.query.limit, 12, 52) })));

router.post('/reports', async (req, res) => {
  try {
    const row = await createReport(req.ai.userId, { narrative: req.body?.narrative, nextFocus: req.body?.nextFocus, author: agentOf(req) });
    res.status(201).json({ ok: true, id: row.id });
  } catch (err) { fail(res, err); }
});

// --------------------------------------------------------------------------- sitemaps + Search Console
// After a deploy (_deploy.py) or a publish: re-read the live sitemaps, submit changes. full=1 (owner) re-crawls the site.
router.post('/sitemaps/check', async (req, res) => {
  const full = req.query.full === '1' && req.ai.actor === 'owner';
  const out = await runRoutine('seo-index-watch', (ctx) => require('../ai/seo/indexWatch').indexWatchTick(ctx, { light: !full }), { trigger: req.ai.actor === 'owner' ? 'manual' : 'api', userId: req.ai.userId });
  res.status(out.ok ? 200 : 500).json(out);
});

router.get('/gsc-status', async (req, res) => {
  const seo = await g.loadSeo(req.ai.userId);
  const auth = await g.getAuth(seo);
  const email = process.env.GOOGLE_CLIENT_EMAIL || null;
  const out = { auth: auth ? { via: auth.via, email: auth.email, error: auth.error || null, canWrite: !!auth.canWrite } : null, serviceAccountEmail: email,
    configuredProperty: seo.property, origin: seo.origin, sites: [], propertyFound: false, permissionLevel: null, canSubmit: false,
    submitAllowed: g.submitAllowed(), dryRun: process.env.DRY_RUN === 'true', serper: !!process.env.SERPER_API_KEY, indexNow: !!process.env.INDEXNOW_KEY,
    lastSync: { at: seo.state.lastSyncAt || null, dataThrough: seo.state.dataThrough || null, firstIncompleteDate: seo.state.firstIncompleteDate || null },
    inspectionsToday: seo.state.inspections?.date === new Date().toISOString().slice(0, 10) ? seo.state.inspections.n : 0, instructions: [] };
  if (auth?.header) {
    try {
      const { sites, site } = await require('../ai/seo/sync').resolveProperty(auth, seo);
      out.sites = sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
      if (site) Object.assign(out, { propertyFound: true, property: site.siteUrl, permissionLevel: site.permissionLevel, canSubmit: !!auth.canWrite && ['siteOwner', 'siteFullUser'].includes(site.permissionLevel) });
    } catch (err) { out.error = err.message; }
  }
  const steps = out.instructions;
  const disabled = g.apiDisabledLink(out.error);
  if (disabled) { out.apiDisabled = disabled; steps.push(`Turn on the Search Console API: open ${disabled} and press Enable (signed in as the owner of that Google Cloud project).`); }
  if (!email) steps.push('Create a Google Cloud service account (console.cloud.google.com > IAM & Admin > Service Accounts), add a JSON key, and set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY on Railway.', 'In the same Google Cloud project, enable the "Google Search Console API".');
  else if (auth?.error) steps.push(`The service account could not sign in (${auth.error}). Check GOOGLE_PRIVATE_KEY on Railway (keep the \\n line breaks).`);
  if (email && !out.propertyFound) steps.push(`Search Console > Settings > Users and permissions > Add user: ${email} — permission "Full".`);
  if (out.propertyFound && !out.canSubmit) steps.push(`Change ${email || 'the account'} to "Full" (it is ${out.permissionLevel}); Restricted users cannot submit sitemaps.`);
  if (!out.submitAllowed) steps.push('DRY_RUN is on, so sitemap submits are only logged. Set SEO_SUBMIT=on on Railway to let them through.');
  if (!out.serper) steps.push('Set SERPER_API_KEY on Railway for keyword discovery and weekly Google + map-pack rank checks.');
  res.json(out);
});

// --------------------------------------------------------------------------- owner knobs
router.patch('/config', ownerOnly, async (req, res) => {
  const seo = await g.loadSeo(req.ai.userId);
  const b = req.body || {};
  const next = { ...(seo.row.growthConfig || {}) };
  for (const [k, def] of Object.entries(DEFAULT_GROWTH_CONFIG)) {
    if (!(k in b)) continue;
    if (Array.isArray(def)) { if (Array.isArray(b[k])) next[k] = b[k].filter((m) => ['new', 'refresh', 'page'].includes(m)); }
    else if (Number.isFinite(Number(b[k])) && Number(b[k]) >= 0) next[k] = Number(b[k]);
  }
  await prisma.seoSettings.update({ where: { id: seo.row.id }, data: { growthConfig: next } });
  res.json({ ok: true, config: next });
});

module.exports = router;
