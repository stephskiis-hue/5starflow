/**
 * Routine heartbeat — deterministic (no Claude). Every 15 minutes it looks for routines that
 * should have reported by now and haven't. The motivating case: 7 of 9 Claude routines failed in
 * seconds on the plan's weekly limit and nobody noticed. A silent routine now becomes a Task.
 */
const prisma = require('../lib/prismaClient');
const { createTask } = require('./tasks');
const { recordActivity } = require('./ledger');

const GRACE = 1.5;          // alert after 1.5x the expected interval
const MIN_GAP_MIN = 10;

async function heartbeatTick({ userId }) {
  const now = Date.now();
  const routines = await prisma.routine.findMany({ where: { userId, enabled: true, expectedEveryMinutes: { not: null } } });
  let missed = 0;

  for (const r of routines) {
    if (r.slug === 'routine-heartbeat') continue; // can't watch itself
    const limitMs = Math.max(MIN_GAP_MIN, r.expectedEveryMinutes * GRACE) * 60000;
    const baseline = (r.lastRunAt || r.createdAt).getTime();
    if (now - baseline <= limitMs) continue;

    // one ledger row + one task per gap, not per heartbeat
    if (r.lastStatus === 'missed') continue;
    missed++;
    const hours = Math.round((now - baseline) / 3600000);
    await prisma.routineRun.create({ data: { routineId: r.id, userId, status: 'missed', trigger: 'heartbeat', source: 'backend', summary: `No run reported for ${hours}h (expected every ${r.expectedEveryMinutes} min)`, finishedAt: new Date() } });
    await prisma.routine.update({ where: { id: r.id }, data: { lastStatus: 'missed', lastSummary: `Missed: nothing for ${hours}h` } });
    const external = r.kind !== 'backend';
    await createTask(userId, {
      dedupKey: `routine-missed:${r.slug}`, title: `${r.name} hasn't run in ${hours}h`, source: 'routine', routineSlug: r.slug, agent: r.agent,
      urgency: external ? 'high' : 'urgent',
      reason: external
        ? 'A Claude routine went quiet. Most likely cause: the Claude plan weekly usage limit (runs get rejected in seconds), or the routine was paused.'
        : 'A backend scheduler stopped running — the server may have restarted into a crash loop.',
      whatNeeds: external ? 'Check the routine in Claude (Run now / usage). Consider fewer or lighter runs.' : 'Check Railway logs for this routine.',
      recommended: external ? 'Open Routines → this routine → recent runs.' : 'Redeploy or check logs.',
    });
    await recordActivity(userId, { agent: 'system', routineSlug: r.slug, action: 'routine missed', summary: `${r.name} silent for ${hours}h`, result: 'failed', source: 'heartbeat' });
  }

  return { items_found: routines.length, requires_attention: missed, summary: missed ? `${missed} routine(s) went quiet` : `${routines.length} routines on schedule` };
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
