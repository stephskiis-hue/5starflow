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
const { saveMemory, searchMemory } = require('../ai/memory');
const { buildBrief } = require('../ai/brief');
const { getUnansweredSms, getCustomerContext } = require('../ai/comms');
const { RUNNABLE } = require('../ai');
const { AGENTS, TASK_STATES } = require('../ai/constants');
const op = require('../services/operatorService');

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

router.use(express.json({ limit: '2mb' }));

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
    req.ai = { userId, actor: 'agent', agent: AGENTS.includes(req.get('x-agent')) ? req.get('x-agent') : null };
    return next();
  }
  const payload = verifyToken(getTokenFromCookies(req.cookies));
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  if ((payload.role || 'client') !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.ai = { userId: payload.userId, actor: 'owner', agent: null };
  next();
}
const ownerOnly = (req, res, next) => (req.ai.actor === 'owner' ? next() : res.status(403).json({ error: 'Owner session required' }));

router.use(aiAuth);

const int = (v, d, max = 200) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);

// --------------------------------------------------------------------------- status + brief
router.get('/status', async (req, res) => {
  const { userId } = req.ai;
  const [routines, openTasks, pending] = await Promise.all([
    prisma.routine.count({ where: { userId } }),
    prisma.task.count({ where: { userId, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'] } } }),
    prisma.operatorProposal.count({ where: { userId, status: 'pending' } }),
  ]);
  res.json({ ok: true, actor: req.ai.actor, dryRun: process.env.DRY_RUN === 'true', routines, openTasks, pendingApprovals: pending });
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

router.patch('/routines/:slug', ownerOnly, async (req, res) => {
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

// --------------------------------------------------------------------------- memory
router.get('/memory', async (req, res) => {
  res.json(await searchMemory(req.ai.userId, { scope: req.query.scope, q: req.query.q, limit: int(req.query.limit, 30, 100) }));
});

router.post('/memory', async (req, res) => {
  try { res.status(201).json(await saveMemory(req.ai.userId, { agent: req.ai.agent, ...req.body })); }
  catch (e) { res.status(e.code === 'INVALID_MEMORY' ? 422 : 400).json({ error: e.message }); }
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

router.get('/customers/context', async (req, res) => {
  res.json(await getCustomerContext(req.ai.userId, { jobberClientId: req.query.jobberClientId, phone: req.query.phone, email: req.query.email, q: req.query.q }));
});

router.use((err, req, res, next) => {
  logger.error('ai', `${req.method} ${req.originalUrl}: ${err.message}`, null, req.ai?.userId).catch(() => {});
  res.status(500).json({ error: err.message });
});

module.exports = router;
