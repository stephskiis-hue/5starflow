/**
 * Routine heartbeat — deterministic (no Claude). Every 15 minutes it looks for routines that
 * should have reported by now and haven't. The motivating case: 7 of 9 Claude routines failed in
 * seconds on the plan's weekly limit and nobody noticed. A silent routine now becomes a Task.
 */
const prisma = require('../lib/prismaClient');
const { createTask } = require('./tasks');
const { recordActivity } = require('./ledger');
const { notify } = require('../lib/notify');
const { localHour, dayBounds, toDateString } = require('../lib/tz');
const requests = require('./requests');

const GRACE = 1.5;          // alert after 1.5x the expected interval
const MIN_GAP_MIN = 10;
const REQUEST_STUCK_MIN = 30;   // the MSI gate checks every 5 min, so 30 min means several checks missed it

async function heartbeatTick({ userId }) {
  const now = Date.now();
  const routines = await prisma.routine.findMany({ where: { userId, enabled: true, expectedEveryMinutes: { not: null } } });
  let missed = 0;

  for (const r of routines) {
    if (r.slug === 'routine-heartbeat') continue; // can't watch itself
    const limitMs = Math.max(MIN_GAP_MIN, r.expectedEveryMinutes * GRACE) * 60000;
    let baseline = (r.lastRunAt || r.createdAt).getTime();
    // Daytime-only routines (MSI Task Scheduler jobs) are silent overnight by design: outside their hours
    // nothing is due, and inside them the clock starts at the window opening, not at last night's run.
    const hours = r.config?.activeHours;
    if (Array.isArray(hours) && hours.length === 2) {
      const hour = localHour(new Date(now));
      if (hour < hours[0] || hour >= hours[1]) continue;
      baseline = Math.max(baseline, dayBounds(toDateString(new Date(now))).start.getTime() + hours[0] * 3600000);
    }
    if (now - baseline <= limitMs) continue;

    // one ledger row + one task per gap, not per heartbeat
    if (r.lastStatus === 'missed') continue;
    missed++;
    const silentH = Math.round((now - baseline) / 3600000);
    await prisma.routineRun.create({ data: { routineId: r.id, userId, status: 'missed', trigger: 'heartbeat', source: 'backend', summary: `No run reported for ${silentH}h (expected every ${r.expectedEveryMinutes} min)`, finishedAt: new Date() } });
    await prisma.routine.update({ where: { id: r.id }, data: { lastStatus: 'missed', lastSummary: `Missed: nothing for ${silentH}h` } });
    const external = r.kind !== 'backend';
    await createTask(userId, {
      dedupKey: `routine-missed:${r.slug}`, title: `${r.name} hasn't run in ${silentH}h`, source: 'routine', routineSlug: r.slug, agent: r.agent,
      urgency: external ? 'high' : 'urgent',
      reason: external
        ? 'A Claude routine went quiet. Most likely cause: the Claude plan weekly usage limit (runs get rejected in seconds), or the routine was paused.'
        : 'A backend scheduler stopped running — the server may have restarted into a crash loop.',
      whatNeeds: external ? 'Check the routine in Claude (Run now / usage). Consider fewer or lighter runs.' : 'Check Railway logs for this routine.',
      recommended: external ? 'Open Routines → this routine → recent runs.' : 'Redeploy or check logs.',
    });
    notify(userId, { category: 'routine', urgent: !external, routineSlug: r.slug, title: `${r.name} hasn't run in ${silentH}h`, body: external ? 'A Claude routine went quiet (plan usage limit or paused?).' : 'A backend scheduler stopped running.', link: '/ai.html#routines' });
    await recordActivity(userId, { agent: 'system', routineSlug: r.slug, action: 'routine missed', summary: `${r.name} silent for ${silentH}h`, result: 'failed', source: 'heartbeat' });
  }

  const stuck = await checkStuckRequests(userId, now);
  const attention = missed + (stuck ? 1 : 0);
  const summary = [missed ? `${missed} routine(s) went quiet` : `${routines.length} routines on schedule`, stuck && `${stuck} owner request(s) stuck`].filter(Boolean).join('; ');
  return { items_found: routines.length, requires_attention: attention, summary };
}

// The request inbox runs on the MSI PC (Task Scheduler, every 5 min 6 am to 10 pm) and is not heartbeat-watched
// like a routine, so a request sitting on "Waiting" is the signal that the gate or Claude on the MSI is down.
// Only during the gate's hours, so a request typed at night is not flagged before the first morning check.
async function checkStuckRequests(userId, now) {
  const hour = localHour(new Date(now));
  if (hour < 8 || hour >= 22) return 0;
  const { count, oldestAt } = await requests.oldestPending(userId);
  if (!count || now - oldestAt.getTime() < REQUEST_STUCK_MIN * 60000) return 0;

  const waited = Math.round((now - oldestAt.getTime()) / 3600000 * 10) / 10;
  const polled = requests.gateLastPolledAt();
  const gate = polled ? `The MSI request gate last checked in ${Math.round((now - polled.getTime()) / 60000)} min ago` : 'The MSI request gate has not checked in since the server last restarted';
  const title = `${count} request(s) stuck on Waiting (oldest ${waited}h)`;
  const { created } = await createTask(userId, {
    dedupKey: 'requests-stuck', title, source: 'routine', routineSlug: 'ext-request-inbox', agent: 'orchestrator', urgency: 'high',
    reason: `Nothing has claimed the owner's requests. ${gate}.`,
    whatHappened: `${gate}. ${count} pending, oldest since ${oldestAt.toISOString()}.`,
    whatNeeds: polled
      ? 'The gate sees the requests but Claude is not claiming them: check ~/.5starflow/request-gate.log on the MSI (Claude login, plan limit, Chrome closed).'
      : 'The gate is not running: check the MSI is on and logged in, and the "5StarFlow Request Inbox" task exists (re-run install-request-gate.ps1).',
    recommended: 'On the MSI, open ~/.5starflow/request-gate.log.',
  });
  if (created) {
    notify(userId, { category: 'request', urgent: true, routineSlug: 'ext-request-inbox', title, body: `${gate}.`, link: '/index.html#requests-card' });
    await recordActivity(userId, { agent: 'system', routineSlug: 'ext-request-inbox', action: 'requests stuck', summary: `${title}. ${gate}.`, result: 'failed', source: 'heartbeat' });
  }
  return count;
}

// Housekeeping so the ledger doesn't grow forever.
async function pruneOld(userId) {
  const d45 = new Date(Date.now() - 45 * 86400000);
  const d90 = new Date(Date.now() - 90 * 86400000);
  const runs = await prisma.routineRun.deleteMany({ where: { userId, startedAt: { lt: d45 }, status: { in: ['completed', 'skipped'] } } });
  const acts = await prisma.agentActivity.deleteMany({ where: { userId, createdAt: { lt: d90 } } });
  return { runs: runs.count, activity: acts.count };
}

module.exports = { heartbeatTick, pruneOld };
