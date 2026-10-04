/**
 * The work packet. One compact JSON a Claude routine fetches FIRST so it doesn't have to crawl
 * Jobber/Gmail/SMS itself — the main lever for staying under the plan's usage limit.
 */
const prisma = require('../lib/prismaClient');
const { listTasks } = require('./tasks');
const { getUnansweredSms } = require('./comms');
const { OPEN_TASK_STATES } = require('./constants');

const TZ = process.env.BUSINESS_TZ || 'America/Winnipeg';

function localNow() {
  const d = new Date();
  const fmt = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...o }).format(d);
  return {
    iso: d.toISOString(),
    date: fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d),
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(d),
    tz: TZ,
  };
}

const MEMORY_SCOPES = (agent) => ['rule', 'business', 'brand', agent ? `agent:${agent}` : null, agent === 'social' ? 'channel:facebook' : null].filter(Boolean);

async function buildBrief(userId, { agent } = {}) {
  const [tasks, approvals, approvalCount, openCount, urgentCount, routines, unanswered, memory] = await Promise.all([
    listTasks(userId, { status: 'open', limit: 40 }),
    prisma.operatorProposal.findMany({ where: { userId, status: 'pending', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.operatorProposal.count({ where: { userId, status: 'pending', expiresAt: { gt: new Date() } } }),
    prisma.task.count({ where: { userId, status: { in: OPEN_TASK_STATES } } }),
    prisma.task.count({ where: { userId, status: { in: OPEN_TASK_STATES }, urgency: { in: ['high', 'urgent'] } } }),
    prisma.routine.findMany({ where: { userId }, select: { slug: true, name: true, agent: true, kind: true, enabled: true, lastStatus: true, lastRunAt: true, lastSummary: true, consecutiveFailures: true } }),
    getUnansweredSms(userId, { sinceDays: 7, limit: 200 }),
    prisma.memory.findMany({ where: { userId, scope: { in: MEMORY_SCOPES(agent) } }, orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }], take: 25, select: { scope: true, key: true, value: true } }),
  ]);

  const mine = agent ? tasks.filter((t) => !t.agent || t.agent === agent) : tasks;
  const unhealthy = routines.filter((r) => r.enabled && (r.lastStatus === 'failed' || r.lastStatus === 'missed'));

  return {
    now: localNow(),
    dryRun: process.env.DRY_RUN === 'true',
    agent: agent || null,
    tasks: {
      open: openCount,
      urgent: urgentCount,
      top: mine.slice(0, 12).map((t) => ({ id: t.id, title: t.title, urgency: t.urgency, status: t.status, customer: t.customerName, flagged: t.timesFlagged, agent: t.agent })),
    },
    approvals: {
      pending: approvalCount,
      items: approvals.map((a) => ({ id: a.id, code: a.shortCode, category: a.category, summary: a.summary, expiresAt: a.expiresAt })),
    },
    routines: {
      total: routines.length,
      unhealthy: unhealthy.map((r) => ({ slug: r.slug, name: r.name, status: r.lastStatus, summary: r.lastSummary, failures: r.consecutiveFailures })),
    },
    inbound: {
      unansweredSms: unanswered.length,
      oldestWaitingMinutes: unanswered[0]?.waitingMinutes || 0,
      items: unanswered.slice(0, 5).map((u) => ({ phone: u.phone, name: u.clientName, minutes: u.waitingMinutes, last: u.lastMessage.slice(0, 120) })),
    },
    memory,
    openTaskStates: OPEN_TASK_STATES,
  };
}

module.exports = { buildBrief, localNow };
