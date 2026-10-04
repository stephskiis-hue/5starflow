/**
 * runRoutine(slug, tick, opts) — the one wrapper every background job and manual trigger goes through.
 *
 *   TRIGGER → LOAD CONTEXT → EXECUTE → ANALYZE RESULT → LEARN → STORE RESULT
 *
 * It does NOT change what a job does: `tick` is the job's existing function. The wrapper adds
 *   • an in-process mutex per routine (a slow cron tick can't overlap itself → no double sends)
 *   • a DB lease (a still-"running" row younger than maxRuntime blocks a second instance)
 *   • a RoutineRun ledger row with the standard structured result
 *   • error classification, consecutive-failure tracking and auto-created Tasks
 *   • learnings → Memory (selective)
 *
 * `quiet: true` is for high-frequency jobs (every minute): they only write a ledger row when
 * something happened (items found, actions taken, or an error); otherwise just the heartbeat.
 * runRoutine never throws — callers' existing .catch() handlers keep working.
 */
const prisma = require('../lib/prismaClient');
const logger = require('../lib/logger');
const { resolveOwnerId } = require('./owner');
const { classifyError, normalizeResult, recordActivity } = require('./ledger');
const { createTask, completeByDedupKey } = require('./tasks');
const { saveMemory } = require('./memory');

const FAILURE_TASK_THRESHOLD = 3;
const DEFAULT_MAX_RUNTIME_MIN = 20;

const inflight = new Set();
const routineIdCache = new Map(); // `${userId}:${slug}` -> routine id

async function ensureRoutine(userId, slug, defaults = {}) {
  const key = `${userId}:${slug}`;
  if (routineIdCache.has(key)) return routineIdCache.get(key);
  const row = await prisma.routine.upsert({
    where: { userId_slug: { userId, slug } },
    update: {},
    create: { userId, slug, name: defaults.name || slug, kind: defaults.kind || 'backend', agent: defaults.agent || 'system' },
    select: { id: true },
  });
  routineIdCache.set(key, row.id);
  return row.id;
}

async function applyLearnings(userId, slug, agent, runId, learnings) {
  for (const l of learnings || []) {
    if (!l || typeof l !== 'object') continue; // plain-string "learnings" are ignored: only structured, durable facts are kept
    try {
      await saveMemory(userId, { scope: l.scope || `routine:${slug}`, key: l.key, value: l.value, confidence: l.confidence, source: `run:${runId}`, agent });
    } catch (e) {
      if (e.code !== 'INVALID_MEMORY') console.warn('[ai.runner] learning not saved:', e.message);
    }
  }
}

async function runRoutine(slug, tick, opts = {}) {
  const trigger = opts.trigger || 'schedule';
  let userId;
  try { userId = opts.userId || await resolveOwnerId(); } catch { userId = null; }

  // No owner/DB yet (fresh install, tests): behave exactly like the bare job.
  const bare = async () => {
    try { return { ok: true, result: normalizeResult(await tick({ runId: null, trigger, actions: [], learn() {} })) }; }
    catch (err) { console.error(`[ai.runner:${slug}]`, err.message); return { ok: false, error: err.message }; }
  };
  if (!userId) return bare();

  if (inflight.has(slug)) return { ok: true, skipped: 'already-running' };
  inflight.add(slug);

  const t0 = Date.now();
  let routineId, runId = null, routine;
  try {
    routineId = await ensureRoutine(userId, slug, opts.defaults);
    routine = await prisma.routine.findUnique({ where: { id: routineId } });
    const quiet = opts.quiet ?? routine?.config?.quiet ?? false;
    const maxMin = routine?.config?.maxRuntimeMinutes || opts.maxRuntimeMinutes || DEFAULT_MAX_RUNTIME_MIN;

    if (!quiet) {
      const cutoff = new Date(Date.now() - maxMin * 60000);
      const live = await prisma.routineRun.findFirst({ where: { routineId, status: 'running', startedAt: { gt: cutoff } } });
      if (live) return { ok: true, skipped: 'lease-held', runId: live.id };
      // anything still "running" past its lease died with a deploy/crash
      await prisma.routineRun.updateMany({
        where: { routineId, status: 'running', startedAt: { lte: cutoff } },
        data: { status: 'failed', errorClass: 'unknown', error: 'interrupted (process restarted or timed out)', finishedAt: new Date() },
      });
      const run = await prisma.routineRun.create({ data: { routineId, userId, trigger, source: 'backend', status: 'running' } });
      runId = run.id;
    }

    const ctx = { runId, userId, trigger, actions: [], learnings: [], learn(l) { this.learnings.push(l); } };
    let result;
    try {
      const out = await tick(ctx);
      result = normalizeResult(out);
      if (ctx.actions.length) result.actions_taken = [...result.actions_taken, ...ctx.actions];
      if (ctx.learnings.length) result.learnings = [...result.learnings, ...ctx.learnings];
      if (out && out.skipped) result.status = 'skipped';
    } catch (err) {
      return await finishFailure({ err, userId, slug, routineId, routine, runId, trigger, t0 });
    }

    const noteworthy = result.items_found > 0 || result.actions_taken.length > 0 || result.requires_attention > 0 || trigger !== 'schedule';
    const durationMs = Date.now() - t0;
    const finishedAt = new Date();
    const data = {
      status: result.status === 'skipped' ? 'skipped' : 'completed', finishedAt, durationMs,
      summary: result.summary || null, itemsFound: result.items_found, requiresAttention: result.requires_attention, result,
    };
    if (runId) {
      await prisma.routineRun.update({ where: { id: runId }, data });
    } else if (noteworthy) {
      const row = await prisma.routineRun.create({ data: { routineId, userId, trigger, source: 'backend', startedAt: new Date(t0), ...data } });
      runId = row.id;
    }

    const recovered = (routine?.consecutiveFailures || 0) > 0;
    await prisma.routine.update({
      where: { id: routineId },
      data: { lastRunAt: finishedAt, lastStatus: data.status, lastSummary: result.summary || null, lastError: null, consecutiveFailures: 0 },
    });
    if (recovered) await completeByDedupKey(userId, `routine-failing:${slug}`);
    if (recovered || routine?.lastStatus === 'missed') await completeByDedupKey(userId, `routine-missed:${slug}`);
    for (const a of result.actions_taken.slice(0, 20)) {
      await recordActivity(userId, { agent: routine?.agent || 'system', routineSlug: slug, runId, action: typeof a === 'string' ? a : a.action || 'action', summary: typeof a === 'string' ? a : a.summary || JSON.stringify(a), result: 'ok', source: 'backend' });
    }
    if (routine?.learningEnabled !== false) await applyLearnings(userId, slug, routine?.agent, runId, result.learnings);
    return { ok: true, runId, result };
  } catch (err) {
    // ledger itself failed (DB down?) — don't take the job down with it
    console.error(`[ai.runner:${slug}] ledger error:`, err.message);
    return { ok: false, error: err.message };
  } finally {
    inflight.delete(slug);
  }
}

async function finishFailure({ err, userId, slug, routineId, routine, runId, trigger, t0 }) {
  const errorClass = classifyError(err);
  const finishedAt = new Date();
  console.error(`[ai.runner:${slug}] FAILED (${errorClass}):`, err.message);
  const data = { status: 'failed', finishedAt, durationMs: Date.now() - t0, errorClass, error: String(err.message).slice(0, 1000), summary: `Failed: ${String(err.message).slice(0, 200)}` };
  if (runId) await prisma.routineRun.update({ where: { id: runId }, data });
  else await prisma.routineRun.create({ data: { routineId, userId, trigger, source: 'backend', startedAt: new Date(t0), ...data } });

  const failures = (routine?.consecutiveFailures || 0) + 1;
  await prisma.routine.update({
    where: { id: routineId },
    data: { lastRunAt: finishedAt, lastStatus: 'failed', lastError: data.error, lastSummary: data.summary, consecutiveFailures: failures },
  });
  await recordActivity(userId, { agent: routine?.agent || 'system', routineSlug: slug, runId, action: 'routine failed', summary: `${routine?.name || slug}: ${data.error}`, result: 'failed', error: errorClass });
  if (failures >= FAILURE_TASK_THRESHOLD) {
    await createTask(userId, {
      dedupKey: `routine-failing:${slug}`, title: `${routine?.name || slug} keeps failing (${failures}x in a row)`, source: 'routine', routineSlug: slug, agent: routine?.agent,
      urgency: errorClass === 'auth' ? 'urgent' : 'high',
      reason: `Last error (${errorClass}): ${data.error}`,
      whatNeeds: errorClass === 'auth' ? 'Reconnect the integration (token refresh is failing).' : 'Check the error; the routine may need a different method.',
      recommended: 'Open Routines → this routine → last error.',
    });
    try { await saveMemory(userId, { scope: `routine:${slug}`, key: 'last-failure', value: `${errorClass}: ${data.error}`, confidence: 0.9, source: 'runner', agent: routine?.agent }); } catch {}
  }
  logger.warn('routine', `${slug} failed`, { errorClass, failures, error: data.error }, userId).catch(() => {});
  return { ok: false, runId, error: err.message, errorClass };
}

/** Record a run reported from OUTSIDE the backend (a Claude routine calling POST /api/ai/runs). */
async function recordExternalRun(userId, slug, rep) {
  const routine = await prisma.routine.findUnique({ where: { userId_slug: { userId, slug } } });
  if (!routine) { const e = new Error(`unknown routine "${slug}" — register it first`); e.code = 'UNKNOWN_ROUTINE'; throw e; }
  const status = ['completed', 'failed', 'skipped'].includes(rep.status) ? rep.status : 'completed';
  const startedAt = rep.startedAt ? new Date(rep.startedAt) : new Date();
  const finishedAt = rep.finishedAt ? new Date(rep.finishedAt) : new Date();
  const result = normalizeResult(rep.result || { summary: rep.summary }, status);
  const errorClass = status === 'failed' ? classifyError(rep.error) : null;
  const run = await prisma.routineRun.create({
    data: {
      routineId: routine.id, userId, status, trigger: rep.trigger || 'schedule', source: 'claude', startedAt, finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt), summary: (rep.summary || result.summary || '').slice(0, 500) || null,
      itemsFound: result.items_found, requiresAttention: result.requires_attention, result, errorClass, error: rep.error ? String(rep.error).slice(0, 1000) : null,
    },
  });
  const failures = status === 'failed' ? routine.consecutiveFailures + 1 : 0;
  await prisma.routine.update({
    where: { id: routine.id },
    data: { lastRunAt: finishedAt, lastStatus: status, lastSummary: run.summary, lastError: run.error, consecutiveFailures: failures },
  });
  if (status !== 'failed' && routine.consecutiveFailures > 0) {
    await completeByDedupKey(userId, `routine-failing:${slug}`);
  }
  await completeByDedupKey(userId, `routine-missed:${slug}`);
  if (status === 'failed' && failures >= FAILURE_TASK_THRESHOLD) {
    await createTask(userId, { dedupKey: `routine-failing:${slug}`, title: `${routine.name} keeps failing (${failures}x in a row)`, source: 'routine', routineSlug: slug, agent: routine.agent, urgency: errorClass === 'rate_limit' ? 'high' : 'high', reason: `Last error (${errorClass}): ${run.error}` });
  }
  for (const a of result.actions_taken.slice(0, 30)) {
    await recordActivity(userId, { agent: routine.agent, routineSlug: slug, runId: run.id, action: typeof a === 'string' ? a : a.action || 'action', summary: typeof a === 'string' ? a : a.summary || JSON.stringify(a), result: 'ok', source: typeof a === 'object' ? a.source : null });
  }
  if (routine.learningEnabled) await applyLearnings(userId, slug, routine.agent, run.id, result.learnings);
  return { run, routine };
}

module.exports = { runRoutine, ensureRoutine, recordExternalRun, FAILURE_TASK_THRESHOLD };
