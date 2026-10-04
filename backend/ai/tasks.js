// Task system. createTask is idempotent on (userId, dedupKey): a repeat report bumps
// timesFlagged/lastFlaggedAt instead of creating a duplicate ("never create duplicate tasks").
const prisma = require('../lib/prismaClient');
const { OPEN_TASK_STATES, TASK_STATES, URGENCIES, LIMITS, clip } = require('./constants');

const URGENCY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

async function createTask(userId, t) {
  if (!userId) throw new Error('createTask: userId required');
  if (!t?.title) throw new Error('createTask: title required');
  const dedupKey = clip(t.dedupKey || `${t.source || 'task'}:${t.title}`.toLowerCase(), LIMITS.key);
  const urgency = URGENCIES.includes(t.urgency) ? t.urgency : 'normal';

  const existing = await prisma.task.findUnique({ where: { userId_dedupKey: { userId, dedupKey } } });
  if (existing) {
    const data = { timesFlagged: { increment: 1 }, lastFlaggedAt: new Date() };
    // Reopen a task that was completed/dismissed ONLY if it was completed (the problem came back);
    // a dismissal is the owner saying "stop raising this" — respect it.
    if (existing.status === 'COMPLETED') { data.status = 'NEW'; data.completedAt = null; }
    if (URGENCY_RANK[urgency] > URGENCY_RANK[existing.urgency]) data.urgency = urgency;
    if (t.whatHappened) data.whatHappened = clip(t.whatHappened, LIMITS.text);
    if (t.context) data.context = t.context;
    const task = await prisma.task.update({ where: { id: existing.id }, data });
    return { task, created: false };
  }

  const task = await prisma.task.create({
    data: {
      userId, dedupKey,
      title: clip(t.title, LIMITS.title),
      reason: clip(t.reason || '', LIMITS.text),
      source: clip(t.source || 'system', 40),
      customerName: clip(t.customerName, 120) || null,
      customerKey: clip(t.customerKey, 120) || null,
      context: t.context || undefined,
      whatHappened: clip(t.whatHappened || '', LIMITS.text),
      whatNeeds: clip(t.whatNeeds || '', LIMITS.text),
      recommended: clip(t.recommended || '', LIMITS.text),
      proposedResponse: clip(t.proposedResponse || '', LIMITS.text),
      urgency,
      status: TASK_STATES.includes(t.status) ? t.status : 'NEW',
      agent: clip(t.agent, 40) || null,
      routineSlug: clip(t.routineSlug, 80) || null,
      dueAt: t.dueAt ? new Date(t.dueAt) : null,
    },
  });
  return { task, created: true };
}

async function updateTask(userId, id, patch) {
  const data = {};
  if (patch.status) {
    if (!TASK_STATES.includes(patch.status)) throw new Error(`invalid status ${patch.status}`);
    data.status = patch.status;
    data.completedAt = ['COMPLETED', 'DISMISSED'].includes(patch.status) ? new Date() : null;
  }
  if (patch.urgency && URGENCIES.includes(patch.urgency)) data.urgency = patch.urgency;
  for (const f of ['title', 'reason', 'whatHappened', 'whatNeeds', 'recommended', 'proposedResponse']) {
    if (patch[f] !== undefined) data[f] = clip(patch[f], f === 'title' ? LIMITS.title : LIMITS.text);
  }
  if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
  const res = await prisma.task.updateMany({ where: { id, userId }, data });
  if (res.count === 0) return null;
  return prisma.task.findUnique({ where: { id } });
}

// Resolve a task by its dedupKey (used when a routine run recovers, e.g. a "missed run" task).
async function completeByDedupKey(userId, dedupKey) {
  return prisma.task.updateMany({
    where: { userId, dedupKey, status: { in: OPEN_TASK_STATES } },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
}

async function listTasks(userId, { status, urgency, limit = 50 } = {}) {
  const where = { userId };
  if (status === 'open') where.status = { in: OPEN_TASK_STATES };
  else if (status) where.status = status;
  if (urgency) where.urgency = urgency;
  const rows = await prisma.task.findMany({ where, take: 500, orderBy: [{ updatedAt: 'desc' }] });
  return rows.sort((a, b) => (URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency]) || (b.updatedAt - a.updatedAt)).slice(0, Math.min(limit, 200));
}

module.exports = { createTask, updateTask, completeByDedupKey, listTasks, URGENCY_RANK };
