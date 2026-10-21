/**
 * runJob(job, fn, opts): the Winnipeg Fence Pros job wrapper. Same idea as ai/runner.js (per-job mutex, a DB lease
 * so two server instances do not overlap, a ledger row with a summary) but its own WfpRun ledger, so nothing about
 * this business lands in the No-Bs routines, tasks, memory or owner notifications.
 *
 * fn(ctx) returns { summary, detail, skipped }. ctx.log(line) collects progress lines into detail.log.
 * runJob never throws.
 */
const prisma = require('../lib/prismaClient');

const LEASE_MIN = 30;
const inflight = new Map();

async function runJob(job, fn, { trigger = 'schedule' } = {}) {
  const started = inflight.get(job);
  if (started && Date.now() - started < LEASE_MIN * 60000) return { ok: true, skipped: 'already-running' };
  inflight.set(job, Date.now());
  let run = null;
  const log = [];
  try {
    const cutoff = new Date(Date.now() - LEASE_MIN * 60000);
    const live = await prisma.wfpRun.findFirst({ where: { job, status: 'running', startedAt: { gt: cutoff } } });
    if (live) return { ok: true, skipped: 'lease-held', runId: live.id };
    await prisma.wfpRun.updateMany({ where: { job, status: 'running', startedAt: { lte: cutoff } }, data: { status: 'failed', error: 'interrupted (restart or timeout)', finishedAt: new Date() } });
    run = await prisma.wfpRun.create({ data: { job, trigger } });
    const ctx = { runId: run.id, trigger, log: (line) => { log.push(String(line)); console.log(`[wfp:${job}] ${line}`); } };
    const out = (await fn(ctx)) || {};
    // a scheduled run with nothing to do (not set up, not a post day) leaves no row behind
    if (out.skipped && trigger === 'schedule') {
      await prisma.wfpRun.delete({ where: { id: run.id } });
      return { ok: true, skipped: out.summary || 'skipped' };
    }
    const updated = await prisma.wfpRun.update({
      where: { id: run.id },
      data: { status: out.skipped ? 'skipped' : 'completed', summary: (out.summary || '').slice(0, 1000) || null, detail: { ...(out.detail || {}), log: log.slice(-200) }, finishedAt: new Date() },
    });
    return { ok: true, run: updated, result: out };
  } catch (err) {
    console.error(`[wfp:${job}] FAILED:`, err.message);
    if (run) {
      await prisma.wfpRun.update({ where: { id: run.id }, data: { status: 'failed', error: String(err.message).slice(0, 2000), summary: `Failed: ${String(err.message).slice(0, 200)}`, detail: { log: log.slice(-200) }, finishedAt: new Date() } }).catch(() => {});
    }
    return { ok: false, error: err.message, runId: run?.id };
  } finally {
    inflight.delete(job);
  }
}

/** Small JSON state kept next to the settings (Serper budget, last sync window). Not editable from the page. */
async function getState(name) {
  const row = await prisma.wfpSetting.findUnique({ where: { key: `state:${name}` } });
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}

async function setState(name, value) {
  const v = JSON.stringify(value);
  await prisma.wfpSetting.upsert({ where: { key: `state:${name}` }, update: { value: v }, create: { key: `state:${name}`, value: v } });
}

async function note(author, kind, title, body) {
  return prisma.wfpNote.create({ data: { author, kind, title: String(title || '').slice(0, 200), body: String(body || '').slice(0, 20000) } });
}

module.exports = { runJob, getState, setState, note };
