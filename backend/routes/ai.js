/**
 * /api/ai/* — the AI OS tool layer.
 *
 * Two callers, one surface:
 *   • Claude routines  → "Authorization: Bearer <AI_TOKEN>" (falls back to OPERATOR_TOKEN); acts as the owner user.
 *   • The dashboard    → normal session cookie, admin role only.
 * Owner-only mutations (toggle routines, approve, delete memory) refuse bearer callers.
 *
 * Mounted BEFORE the global requireAuth in server.js because routines have no session.
 */
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const prisma  = require('../lib/prismaClient');
const logger  = require('../lib/logger');
const { verifyToken, getTokenFromCookies } = require('../lib/auth');
const { resolveOwnerId } = require('../ai/owner');
const { recordExternalRun, runRoutine } = require('../ai/runner');
const { recordActivity } = require('../ai/ledger');
const { createTask, updateTask, listTasks } = require('../ai/tasks');
const requests = require('../ai/requests');
const { saveMemory, searchMemory } = require('../ai/memory');
const { buildBrief } = require('../ai/brief');
const { notify } = require('../lib/notify');
const { getUnansweredSms, getCustomerContext } = require('../ai/comms');
const { RUNNABLE } = require('../ai');
const { AGENTS, TASK_STATES } = require('../ai/constants');
const op = require('../services/operatorService');
const vault = require('../ai/vault');
const content = require('../ai/content');
const social = require('../ai/social');
const { Prisma } = require('@prisma/client');
const { renderPost, RenderError } = require('../ai/design/renderer');
const { describeLayouts } = require('../ai/design/layouts');
const { lintContent } = require('../ai/design/qa');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Express 4: forward async rejections to the global error handler instead of hanging the request.
['get', 'post', 'put', 'patch', 'delete'].forEach((method) => {
  const orig = router[method].bind(router);
  router[method] = (path, ...handlers) => orig(path, ...handlers.map((h) =>
    (typeof h === 'function' && h.constructor.name === 'AsyncFunction') ? (req, res, next) => h(req, res, next).catch(next) : h));
});

async function aiAuth(req, res, next) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (m) {
    const expected = process.env.AI_TOKEN || process.env.OPERATOR_TOKEN;
    if (!expected) return res.status(503).json({ error: 'AI_TOKEN not configured on server' });
    if (!safeEq(m[1], expected)) return res.status(401).json({ error: 'Invalid bearer token' });
    const userId = await resolveOwnerId();
    if (!userId) return res.status(503).json({ error: 'No owner user configured (set OPERATOR_USER_ID)' });
    req.ai = { userId, actor: 'agent', admin: false, agent: AGENTS.includes(req.get('x-agent')) ? req.get('x-agent') : null };
    return next();
  }
  const payload = verifyToken(getTokenFromCookies(req.cookies));
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  req.ai = { userId: payload.userId, actor: 'owner', agent: null, admin: payload.role === 'admin' };
  next();
}
const ownerOnly = (req, res, next) => (req.ai.actor === 'owner' ? next() : res.status(403).json({ error: 'Owner session required' }));
// routines run shared, business-wide jobs (sends, syncs): administrators only
const adminOnly = (req, res, next) => (req.ai.admin ? next() : res.status(403).json({ error: 'Administrator access required' }));

router.use(aiAuth);
router.use(express.json({ limit: '20mb' }));      // assets arrive as base64

const int = (v, d, max = 200) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);

// --------------------------------------------------------------------------- status + brief
router.get('/status', async (req, res) => {
  const { userId } = req.ai;
  const [routines, openTasks, pending, pendingRequests] = await Promise.all([
    prisma.routine.count({ where: { userId } }),
    prisma.task.count({ where: { userId, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'] } } }),
    prisma.operatorProposal.count({ where: { userId, status: 'pending' } }),
    prisma.ownerRequest.count({ where: { userId, status: 'pending' } }),
  ]);
  res.json({ ok: true, actor: req.ai.actor, dryRun: process.env.DRY_RUN === 'true', routines, openTasks, pendingApprovals: pending, pendingRequests });
});

router.get('/brief', async (req, res) => {
  const agent = AGENTS.includes(req.query.agent) ? req.query.agent : req.ai.agent;
  res.json(await buildBrief(req.ai.userId, { agent }));
});

// --------------------------------------------------------------------------- routines + runs
router.get('/routines', async (req, res) => {
  const rows = await prisma.routine.findMany({ where: { userId: req.ai.userId }, orderBy: [{ agent: 'asc' }, { name: 'asc' }] });
  res.json(rows.map((r) => ({ ...r, runnable: !!RUNNABLE[r.slug] })));
});

router.get('/routines/:slug', async (req, res) => {
  const routine = await prisma.routine.findUnique({ where: { userId_slug: { userId: req.ai.userId, slug: req.params.slug } } });
  if (!routine) return res.status(404).json({ error: 'Unknown routine' });
  const runs = await prisma.routineRun.findMany({ where: { routineId: routine.id }, orderBy: { startedAt: 'desc' }, take: 20 });
  res.json({ routine: { ...routine, runnable: !!RUNNABLE[routine.slug] }, runs });
});

router.patch('/routines/:slug', ownerOnly, adminOnly, async (req, res) => {
  const { enabled, autonomy, expectedEveryMinutes, approvalRequired, learningEnabled, researchEnabled } = req.body || {};
  const data = {};
  if (typeof enabled === 'boolean') data.enabled = enabled;
  if (['read', 'draft', 'approve', 'execute'].includes(autonomy)) data.autonomy = autonomy;
  if (expectedEveryMinutes === null || Number.isFinite(Number(expectedEveryMinutes))) data.expectedEveryMinutes = expectedEveryMinutes === null ? null : Math.max(5, Number(expectedEveryMinutes));
  for (const [k, v] of Object.entries({ approvalRequired, learningEnabled, researchEnabled })) if (typeof v === 'boolean') data[k] = v;
  const r = await prisma.routine.updateMany({ where: { userId: req.ai.userId, slug: req.params.slug }, data });
  if (!r.count) return res.status(404).json({ error: 'Unknown routine' });
  await recordActivity(req.ai.userId, { agent: 'orchestrator', routineSlug: req.params.slug, action: 'routine settings changed', summary: JSON.stringify(data), result: 'ok', approval: 'owner' });
  res.json({ ok: true });
});

// "Run now": the same function the cron calls, through the same mutex/ledger. Agents may only trigger safe ones.
router.post('/routines/:slug/run', async (req, res) => {
  if (req.ai.actor === 'owner' && !req.ai.admin) return res.status(403).json({ error: 'Administrator access required' });
  const def = RUNNABLE[req.params.slug];
  if (!def) return res.status(400).json({ error: 'This routine cannot be run from here (it is a Claude routine or event-driven)' });
  if (req.ai.actor !== 'owner' && def.risk !== 'safe') return res.status(403).json({ error: `"${req.params.slug}" has side effects (${def.risk}); only the owner can run it` });
  const out = await runRoutine(req.params.slug, def.fn, { trigger: req.ai.actor === 'owner' ? 'manual' : 'api', userId: req.ai.userId });
  res.status(out.ok ? 200 : 500).json(out);
});

// A Claude routine reporting how its run went (and any tasks/activity/memory it produced).
router.post('/runs', async (req, res) => {
  const b = req.body || {};
  if (!b.slug) return res.status(400).json({ error: 'slug required' });
  let out;
  try { out = await recordExternalRun(req.ai.userId, String(b.slug), b); }
  catch (e) { return res.status(e.code === 'UNKNOWN_ROUTINE' ? 404 : 400).json({ error: e.message }); }

  const created = { tasks: 0, memory: 0, activity: 0 };
  for (const t of Array.isArray(b.tasks) ? b.tasks.slice(0, 20) : []) {
    try { await createTask(req.ai.userId, { agent: out.routine.agent, routineSlug: b.slug, source: 'routine', ...t }); created.tasks++; } catch (e) { console.warn('[ai] task skipped:', e.message); }
  }
  for (const m of Array.isArray(b.memory) ? b.memory.slice(0, 20) : []) {
    try { await saveMemory(req.ai.userId, { agent: out.routine.agent, source: `run:${out.run.id}`, ...m }); created.memory++; } catch (e) { /* invalid memory is dropped on purpose */ }
  }
  for (const a of Array.isArray(b.activity) ? b.activity.slice(0, 30) : []) {
    await recordActivity(req.ai.userId, { agent: out.routine.agent, routineSlug: b.slug, runId: out.run.id, ...a }); created.activity++;
  }
  res.json({ ok: true, runId: out.run.id, created });
});

router.get('/runs', async (req, res) => {
  const where = { userId: req.ai.userId };
  if (req.query.status) where.status = String(req.query.status);
  if (req.query.slug) { const r = await prisma.routine.findUnique({ where: { userId_slug: { userId: req.ai.userId, slug: String(req.query.slug) } }, select: { id: true } }); where.routineId = r?.id || 'none'; }
  const runs = await prisma.routineRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: int(req.query.limit, 50), include: { routine: { select: { slug: true, name: true, agent: true } } } });
  res.json(runs);
});

// --------------------------------------------------------------------------- tasks
router.get('/tasks', async (req, res) => {
  res.json(await listTasks(req.ai.userId, { status: req.query.status || 'open', urgency: req.query.urgency, limit: int(req.query.limit, 50) }));
});

router.post('/tasks', async (req, res) => {
  try {
    const { task, created } = await createTask(req.ai.userId, { agent: req.ai.agent, ...req.body });
    res.status(created ? 201 : 200).json({ task, created });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/tasks/:id', async (req, res) => {
  if (req.body?.status && !TASK_STATES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of ${TASK_STATES.join(', ')}` });
  const task = await updateTask(req.ai.userId, req.params.id, req.body || {});
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

// --------------------------------------------------------------------------- owner requests
// The owner types requests on the home page; the request-inbox routine claims, acts, reports.
router.get('/requests/pending-count', async (req, res) => {
  res.json({ pending: await requests.pendingCount(req.ai.userId) });
});

router.get('/requests', async (req, res) => {
  res.json(await requests.listRequests(req.ai.userId, { status: req.query.status, limit: int(req.query.limit, 20, 100) }));
});

// Claude routines drop updates in the Notification Centre. urgent=true also texts the owner now; use it only when they must act today.
router.post('/notify', async (req, res) => {
  if (req.ai.actor !== 'agent') return res.status(403).json({ error: 'Only routines post notifications' });
  const { title, body, category, urgent, link, routineSlug } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const n = await notify(req.ai.userId, { title, body, category: category || 'routine', urgent: !!urgent, link, routineSlug });
  res.status(201).json({ ok: !!n, id: n?.id });
});

router.post('/requests', ownerOnly, async (req, res) => {
  try {
    const r = await requests.createRequest(req.ai.userId, req.body?.body, req.body?.attachments);
    await recordActivity(req.ai.userId, { agent: 'orchestrator', action: 'owner request added', summary: (r.body || '(photo/video only)').slice(0, 300), source: 'owner', result: 'pending' });
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/requests/claim', async (req, res) => {
  if (req.ai.actor !== 'agent') return res.status(403).json({ error: 'Only routines claim requests' });
  res.json({ request: await requests.claimNext(req.ai.userId, req.body?.slug || 'ext-request-inbox') });
});

// The owner asked to be told when a request is finished or stuck. Never lets a text failure break the report.
// Done lands in the Notification Centre only; stuck/failed ones are texted.
function notifyRequestOutcome(userId, r) {
  const label = { done: 'Done', needs_owner: 'Needs you', failed: 'FAILED' }[r.status];
  const what = (r.body || 'your photo/video post').replace(/\s+/g, ' ').slice(0, 60);
  notify(userId, { category: 'request', urgent: r.status !== 'done', title: `${label}: ${what}`, body: (r.response || '').replace(/\s+/g, ' ').slice(0, 200), link: '/index.html#requests-card' });
}

// After a post goes live: one call logs it (content item for metrics, an owner_post action, activity). Owner posts don't use the daily caps.
router.post('/requests/:id/posted', async (req, res) => {
  if (req.ai.actor !== 'agent') return res.status(403).json({ error: 'Only routines log posts' });
  try {
    const item = await requests.recordPost(req.ai.userId, req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Request not found' });
    await recordActivity(req.ai.userId, { agent: req.ai.agent || 'social', action: `posted to ${req.body.platform}`, summary: `${item.title} ${req.body.postUrl || ''}`.trim(), source: req.body.platform, result: 'ok' });
    res.json({ ok: true, contentItemId: item.id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/requests/:id', async (req, res) => {
  const { userId } = req.ai;
  if (req.ai.actor === 'owner') {
    if (req.body?.status !== 'cancelled') return res.status(400).json({ error: 'The owner can only cancel a request' });
    if (!(await requests.cancelRequest(userId, req.params.id))) return res.status(409).json({ error: 'Only a pending request can be cancelled' });
    return res.json({ ok: true });
  }
  try {
    const r = await requests.reportRequest(userId, req.params.id, req.body || {});
    if (!r) return res.status(404).json({ error: 'Request not found (or cancelled)' });
    if (r.status !== 'working') {
      notifyRequestOutcome(userId, r);
      await recordActivity(userId, { agent: req.ai.agent || 'orchestrator', routineSlug: r.claimedBy, runId: r.runId, action: `owner request ${r.status}`, summary: `${r.body.slice(0, 150)} → ${r.response.slice(0, 300)}`, source: 'owner', result: r.status });
    }
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// --------------------------------------------------------------------------- memory
router.get('/memory', async (req, res) => {
  res.json(await searchMemory(req.ai.userId, { scope: req.query.scope, q: req.query.q, limit: int(req.query.limit, 30, 100) }));
});

router.post('/memory', async (req, res) => {
  try {
    const b = { ...req.body };
    if (req.ai.actor === 'agent') {
      // Agents read untrusted text (customer SMS, email, Facebook). They may add learnings, but not redefine the
      // owner's rules, forge provenance, or overwrite what the owner wrote.
      if (['rule', 'brand'].includes(b.scope)) return res.status(403).json({ error: `Only the owner can write "${b.scope}" memory` });
      const existing = await prisma.memory.findUnique({ where: { userId_scope_key: { userId: req.ai.userId, scope: String(b.scope), key: String(b.key) } } });
      if (existing && existing.source === 'owner') return res.status(403).json({ error: 'This memory was written by the owner and cannot be changed by an agent' });
      b.source = `agent:${req.ai.agent || 'unknown'}`;
      b.agent = req.ai.agent || null;
      b.confidence = Math.min(Number(b.confidence ?? 0.8), 0.9);
    } else { b.source = 'owner'; }
    res.status(201).json(await saveMemory(req.ai.userId, b));
  } catch (e) { res.status(e.code === 'INVALID_MEMORY' ? 422 : 400).json({ error: e.message }); }
});

router.delete('/memory/:id', ownerOnly, async (req, res) => {
  const r = await prisma.memory.deleteMany({ where: { id: req.params.id, userId: req.ai.userId } });
  res.status(r.count ? 200 : 404).json({ ok: !!r.count });
});

// --------------------------------------------------------------------------- activity
router.get('/activity', async (req, res) => {
  const where = { userId: req.ai.userId };
  if (req.query.agent) where.agent = String(req.query.agent);
  res.json(await prisma.agentActivity.findMany({ where, orderBy: { createdAt: 'desc' }, take: int(req.query.limit, 60) }));
});

router.post('/activity', async (req, res) => {
  const row = await recordActivity(req.ai.userId, { agent: req.ai.agent || 'system', ...req.body });
  res.status(row ? 201 : 400).json(row || { error: 'could not record' });
});

// --------------------------------------------------------------------------- approvals
router.get('/approvals', async (req, res) => {
  const { userId } = req.ai;
  const [ops, seo] = await Promise.all([
    prisma.operatorProposal.findMany({ where: { userId, status: { in: ['pending', 'approved'] }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.seoProposal.findMany({ where: { userId, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 10 }),
  ]);
  res.json({
    items: [
      ...ops.map((p) => ({ type: 'operator', id: p.id, code: p.shortCode, category: p.category, tier: p.tier, summary: p.summary, payload: p.payload, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt, actionable: p.status === 'pending' && p.category !== 'rain_reschedule', note: p.category === 'rain_reschedule' ? 'Reply YES <day> by text, or use Rain Alerts' : null })),
      ...seo.map((p) => ({ type: 'seo', id: p.id, category: 'seo', summary: p.title, status: p.status, createdAt: p.createdAt, actionable: false, href: '/seo-dashboard.html', note: 'Review the file changes on the SEO page' })),
    ],
  });
});

router.post('/approvals/:id/respond', ownerOnly, async (req, res) => {
  const { userId } = req.ai;
  const decision = req.body?.decision;
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  const p = await prisma.operatorProposal.findFirst({ where: { id: req.params.id, userId } });
  if (!p) return res.status(404).json({ error: 'Proposal not found' });
  if (p.category === 'rain_reschedule') return res.status(409).json({ error: 'Rain reschedules need a day — reply YES <day> by text or use Rain Alerts' });
  const claimed = await prisma.operatorProposal.updateMany({
    where: { id: p.id, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: decision === 'approve' ? 'approved' : 'declined', respondedAt: new Date(), respondedVia: 'dashboard' },
  });
  if (!claimed.count) return res.status(409).json({ error: `Proposal is already ${p.status} or expired` });
  await recordActivity(userId, { agent: 'orchestrator', action: `${decision}d approval #${p.shortCode}`, summary: p.summary, result: 'ok', approval: decision === 'approve' ? 'approved' : 'rejected', source: 'dashboard' });
  let execution = null;
  if (decision === 'approve') execution = await op.executeProposal(p.id).catch((e) => ({ ok: false, error: e.message }));
  res.json({ ok: true, execution: execution && { ok: execution.ok, error: execution.error } });
});

// --------------------------------------------------------------------------- inbox + customers
router.get('/inbox/unanswered-sms', async (req, res) => {
  res.json(await getUnansweredSms(req.ai.userId, { sinceDays: int(req.query.days, 14, 60), limit: int(req.query.limit, 50) }));
});

router.post('/inbox/:phone/reply', async (req, res) => {
  const out = await require('../ai/reply').sendAiReply(req.ai.userId, { phone: req.params.phone, body: req.body?.body, reason: req.body?.reason });
  res.status(out.sent ? 200 : out.code === 'SEND_FAILED' ? 502 : 409).json(out);
});

router.get('/whoami', (req, res) => res.json({ ok: true, actor: req.ai.actor, agent: req.ai.agent }));

router.get('/customers/context', async (req, res) => {
  res.json(await getCustomerContext(req.ai.userId, { jobberClientId: req.query.jobberClientId, phone: req.query.phone, email: req.query.email, q: req.query.q }));
});


// --------------------------------------------------------------------------- vault (photos + graphics)
const parseBase64 = (b64) => Buffer.from(String(b64 || '').replace(/^data:[^;]+;base64,/, ''), 'base64');

router.post('/assets', async (req, res) => {
  try {
    const { asset, duplicate } = await vault.saveAsset(req.ai.userId, {
      kind: ['photo', 'graphic', 'reference', 'screenshot', 'logo', 'video'].includes(req.body?.kind) ? req.body.kind : 'photo',
      name: req.body?.name, buffer: parseBase64(req.body?.base64), tags: req.body?.tags, notes: req.body?.notes, source: req.ai.actor === 'agent' ? 'import' : 'upload',
    });
    res.status(duplicate ? 200 : 201).json({ asset: { ...asset, tags: JSON.parse(asset.tags || '[]') }, duplicate });
  } catch (e) { res.status(e.code === 'INVALID_ASSET' ? 422 : 400).json({ error: e.message }); }
});

router.get('/assets', async (req, res) => {
  res.json(await vault.listAssets(req.ai.userId, { kind: req.query.kind, tag: req.query.tag, q: req.query.q, limit: int(req.query.limit, 60), minQuality: req.query.minQuality, usable: req.query.usable === 'true', uncurated: req.query.uncurated === 'true', pair: req.query.pair, source: req.query.source }));
});

router.get('/assets/:id', async (req, res) => {
  const a = await vault.getAssetBytes(req.ai.userId, req.params.id);
  if (!a) return res.status(404).json({ error: 'Asset not found' });
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${a.name.replace(/"/g, '')}"` });
  res.send(Buffer.from(a.bytes));
});

// Re-enhance a Drive-imported photo from its original: { straighten, rotate, crop:{x,y,w,h}, brightness, saturation, tone } or { revert: true }
router.post('/assets/:id/edit', async (req, res) => {
  try {
    const asset = await vault.editAsset(req.ai.userId, req.params.id, req.body || {});
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset: { ...asset, tags: JSON.parse(asset.tags || '[]'), edits: JSON.parse(asset.edits || 'null') } });
  } catch (e) { res.status(e.code === 'INVALID_ASSET' ? 422 : 400).json({ error: e.message }); }
});

router.patch('/assets/:id', async (req, res) => {
  const ok = await vault.updateAsset(req.ai.userId, req.params.id, req.body || {});
  res.status(ok ? 200 : 404).json({ ok });
});

router.delete('/assets/:id', ownerOnly, async (req, res) => {
  const a = await prisma.contentAsset.findFirst({ where: { id: req.params.id, userId: req.ai.userId }, select: { originalId: true, driveFileId: true } });
  if (a?.originalId) await prisma.contentAsset.deleteMany({ where: { id: a.originalId, userId: req.ai.userId, kind: 'original' } });
  // a deleted Drive photo leaves an empty marker so the nightly import doesn't bring it back
  if (a?.driveFileId) return res.json({ ok: !!(await prisma.contentAsset.update({ where: { id: req.params.id }, data: { kind: 'skipped', bytes: Buffer.alloc(0), size: 0, originalId: null } })) });
  const r = await prisma.contentAsset.deleteMany({ where: { id: req.params.id, userId: req.ai.userId } });
  res.status(r.count ? 200 : 404).json({ ok: !!r.count });
});

// --------------------------------------------------------------------------- content engine
const renderErr = (res, e) => {
  if (e instanceof RenderError) return res.status(e.code === 'RENDERER_UNAVAILABLE' ? 503 : 422).json({ error: e.message, code: e.code, details: e.details });
  if (e.code === 'REEL_UNAVAILABLE') return res.status(503).json({ error: e.message, code: e.code });
  if (['INVALID_PHOTO', 'INVALID_CONTENT'].includes(e.code)) return res.status(422).json({ error: e.message });
  if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
  if (e.code === 'BAD_STATE') return res.status(409).json({ error: e.message });
  if (e.code === 'CAP_REACHED') return res.status(409).json({ error: e.message, code: e.code, kind: e.kind, cap: e.cap });
  throw e;
};
const isAutopilot = async (userId) => {
  const r = await prisma.routine.findUnique({ where: { userId_slug: { userId, slug: 'ext-social-daily' } }, select: { autonomy: true } });
  return r?.autonomy === 'execute';
};

router.get('/content/layouts', (req, res) => res.json(describeLayouts()));

router.post('/content/lint', (req, res) => res.json(lintContent(req.body || {})));

// One-off preview render (no item, nothing stored): returns the PNG.
router.post('/content/preview', async (req, res) => {
  try {
    const { layout, slots, size, photos } = req.body || {};
    const r = await renderPost({ layout, slots: slots || {}, size: size || 'feed', photos: await vault.resolvePhotos(req.ai.userId, photos || {}) });
    res.set({ 'Content-Type': 'image/png', 'X-Fit-Steps': String(r.fitSteps), 'X-Overflow': String(r.overflow) }).send(r.png);
  } catch (e) { renderErr(res, e); }
});

router.get('/content', async (req, res) => {
  const where = { userId: req.ai.userId };
  if (req.query.status) where.status = String(req.query.status);
  const rows = await prisma.contentItem.findMany({ where, orderBy: { updatedAt: 'desc' }, take: int(req.query.limit, 60) });
  // which rendered assets are videos (reels), so the dashboard and the Social agent know what to post
  const ids = rows.flatMap((r) => (Array.isArray(r.assetIds) ? r.assetIds : []));
  const videos = new Set(ids.length ? (await prisma.contentAsset.findMany({ where: { id: { in: ids }, kind: 'video' }, select: { id: true } })).map((a) => a.id) : []);
  res.json(rows.map((r) => ({ ...r, platforms: JSON.parse(r.platforms || '[]'), videoAssetIds: (Array.isArray(r.assetIds) ? r.assetIds : []).filter((id) => videos.has(id)) })));
});

router.get('/content/performance', async (req, res) => res.json(await content.performanceSummary(req.ai.userId, { days: int(req.query.days, 60, 365) })));

router.get('/content/queue', async (req, res) => {
  const autopilot = await isAutopilot(req.ai.userId);
  res.json({ autopilot, items: await content.publishQueue(req.ai.userId, { platform: req.query.platform, autopilot, limit: int(req.query.limit, 10, 30) }) });
});

router.post('/content', async (req, res) => {
  try {
    const item = await content.createContent(req.ai.userId, { source: req.ai.agent, ...req.body });
    let result = { item };
    if (req.body?.render) result = await content.renderContent(req.ai.userId, item.id);
    res.status(201).json(result);
  } catch (e) { renderErr(res, e); }
});

router.patch('/content/:id', async (req, res) => {
  const b = req.body || {}; const data = {};
  for (const k of ['title', 'caption', 'captionIg', 'pillar', 'layout', 'grounding', 'note']) if (typeof b[k] === 'string') data[k] = b[k].slice(0, 5000);
  if (b.slots && typeof b.slots === 'object') data.slots = b.slots;
  if (typeof b.format === 'string') { if (!content.FORMATS.includes(b.format)) return res.status(422).json({ error: `format must be one of ${content.FORMATS.join(', ')}` }); data.format = b.format; }
  if (Array.isArray(b.platforms)) data.platforms = JSON.stringify(b.platforms);
  if (b.scheduledFor !== undefined) data.scheduledFor = b.scheduledFor ? new Date(b.scheduledFor) : null;
  if (Object.keys(data).some((k) => ['slots', 'layout', 'caption', 'captionIg', 'format', 'platforms', 'pillar'].includes(k))) { data.status = 'draft'; data.assetIds = Prisma.DbNull; data.qa = Prisma.DbNull; } // edited → must re-render + re-QA (Json null needs DbNull)
  const r = await prisma.contentItem.updateMany({ where: { id: req.params.id, userId: req.ai.userId, status: { notIn: ['published'] } }, data });
  res.status(r.count ? 200 : 404).json({ ok: !!r.count });
});

router.post('/content/:id/render', async (req, res) => {
  try { res.json(await content.renderContent(req.ai.userId, req.params.id)); } catch (e) { renderErr(res, e); }
});

router.post('/content/:id/approve', ownerOnly, async (req, res) => {
  try {
    const item = await content.transition(req.ai.userId, req.params.id, 'approve', { scheduledFor: req.body?.scheduledFor });
    await recordActivity(req.ai.userId, { agent: 'orchestrator', action: 'approved content', summary: item.title, result: 'ok', approval: 'approved', source: 'dashboard' });
    res.json(item);
  } catch (e) { renderErr(res, e); }
});

router.post('/content/:id/reject', ownerOnly, async (req, res) => {
  try {
    const item = await content.transition(req.ai.userId, req.params.id, 'reject', { note: req.body?.note });
    if (req.body?.note) await saveMemory(req.ai.userId, { scope: 'agent:content', key: `rejected:${item.id}`, value: `Owner rejected "${item.title}" (${item.layout || item.format}): ${req.body.note}`, confidence: 0.9, source: 'owner', agent: 'content' }).catch(() => {});
    res.json(item);
  } catch (e) { renderErr(res, e); }
});

router.post('/content/:id/published', async (req, res) => {
  try { res.json(await content.markPublished(req.ai.userId, req.params.id, req.body || {})); } catch (e) { renderErr(res, e); }
});

router.post('/content/:id/metrics', async (req, res) => {
  const ok = await content.recordMetrics(req.ai.userId, req.params.id, req.body || {});
  res.status(ok ? 200 : 404).json({ ok });
});

// --------------------------------------------------------------------------- social
router.get('/social/budget', async (req, res) => res.json(await social.getBudget(req.ai.userId, { date: req.query.date })));

router.get('/social/actions', async (req, res) => {
  res.json(await prisma.socialAction.findMany({ where: { userId: req.ai.userId }, orderBy: { createdAt: 'desc' }, take: int(req.query.limit, 50) }));
});

router.post('/social/actions', async (req, res) => {
  try {
    const row = await social.recordAction(req.ai.userId, req.body || {});
    await recordActivity(req.ai.userId, { agent: 'social', action: `${row.kind.replace('_', ' ')} on ${row.platform}`, summary: [row.target, row.summary].filter(Boolean).join(': '), result: row.status === 'done' ? 'ok' : row.status, source: row.platform });
    res.status(201).json(row);
  } catch (e) {
    if (e.code === 'CAP_REACHED') return res.status(409).json({ error: e.message, code: e.code, kind: e.kind, cap: e.cap });
    if (e.code === 'INVALID_ACTION') return res.status(422).json({ error: e.message });
    throw e;
  }
});

router.get('/social/groups', async (req, res) => {
  res.json(await prisma.socialGroup.findMany({ where: { userId: req.ai.userId }, orderBy: [{ membership: 'asc' }, { relevance: 'desc' }, { name: 'asc' }], take: 300 }));
});

router.get('/social/groups/next', async (req, res) => {
  res.json(await social.nextGroups(req.ai.userId, { promo: req.query.promo === 'true', limit: int(req.query.limit, 3, 10) }));
});

router.post('/social/groups', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const platform = b.platform || 'facebook';
  const fields = {};
  for (const k of ['url', 'location', 'audience', 'rules', 'promoNotes', 'topics', 'notes']) if (typeof b[k] === 'string') fields[k] = b[k].slice(0, 3000);
  if (['unknown', 'requested', 'member', 'declined', 'left', 'banned'].includes(b.membership)) fields.membership = b.membership;
  if (['unknown', 'allowed', 'restricted', 'banned'].includes(b.promoPolicy)) fields.promoPolicy = b.promoPolicy;
  if (Number.isFinite(Number(b.relevance))) fields.relevance = Math.min(5, Math.max(1, Number(b.relevance)));
  if (Number.isFinite(Number(b.cooldownDays))) fields.cooldownDays = Math.min(60, Math.max(1, Number(b.cooldownDays)));
  if (b.leadsDelta) fields.leads = { increment: Math.max(0, parseInt(b.leadsDelta, 10) || 0) };
  fields.lastCheckedAt = new Date();
  const row = await prisma.socialGroup.upsert({
    where: { userId_platform_name: { userId: req.ai.userId, platform, name: String(b.name).slice(0, 160) } },
    update: fields, create: { userId: req.ai.userId, platform, name: String(b.name).slice(0, 160), ...fields, leads: typeof fields.leads === 'number' ? fields.leads : 0 },
  });
  res.status(201).json(row);
});

router.use((err, req, res, next) => {
  logger.error('ai', `${req.method} ${req.originalUrl}: ${err.message}`, null, req.ai?.userId).catch(() => {});
  res.status(500).json({ error: err.message });
});

module.exports = router;
