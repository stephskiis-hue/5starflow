// Owner requests: the owner types "do X" on the dashboard home page, the request-inbox routine
// claims and acts on it. body is owner-written only; agents can write status/response/runId.
const prisma = require('../lib/prismaClient');
const { clip } = require('./constants');

const REQUEST_STATES = ['pending', 'working', 'done', 'needs_owner', 'failed', 'cancelled'];
const AGENT_REPORT_STATES = ['working', 'done', 'needs_owner', 'failed'];
const FINAL_STATES = ['done', 'needs_owner', 'failed', 'cancelled'];
const STALE_CLAIM_MINUTES = 60;
const BODY_MAX = 4000;
const RESPONSE_MAX = 4000;

async function createRequest(userId, body) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Request is empty');
  return prisma.ownerRequest.create({ data: { userId, body: clip(text, BODY_MAX) } });
}

async function listRequests(userId, { status, limit = 20 } = {}) {
  const where = { userId };
  if (status && REQUEST_STATES.includes(status)) where.status = status;
  return prisma.ownerRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
}

// A run that crashed mid-request leaves it "working"; after an hour it is fair game again.
async function releaseStale(userId) {
  return prisma.ownerRequest.updateMany({
    where: { userId, status: 'working', claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MINUTES * 60000) } },
    data: { status: 'pending', claimedAt: null, claimedBy: null },
  });
}

// The MSI gate polls this every 10 minutes: one count query, no Claude tokens.
async function pendingCount(userId) {
  await releaseStale(userId);
  return prisma.ownerRequest.count({ where: { userId, status: 'pending' } });
}

// Atomically move the oldest pending request to working. A concurrent claim loses the
// updateMany race (count 0) and tries the next one.
async function claimNext(userId, slug) {
  await releaseStale(userId);
  for (let i = 0; i < 5; i++) {
    const next = await prisma.ownerRequest.findFirst({ where: { userId, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    if (!next) return null;
    const res = await prisma.ownerRequest.updateMany({
      where: { id: next.id, status: 'pending' },
      data: { status: 'working', claimedAt: new Date(), claimedBy: clip(slug || 'agent', 80) },
    });
    if (res.count) return prisma.ownerRequest.findUnique({ where: { id: next.id } });
  }
  return null;
}

async function reportRequest(userId, id, { status, response, runId } = {}) {
  if (!AGENT_REPORT_STATES.includes(status)) throw new Error(`invalid status ${status}`);
  const data = { status, completedAt: FINAL_STATES.includes(status) ? new Date() : null };
  if (response !== undefined) data.response = clip(response, RESPONSE_MAX);
  if (runId) data.runId = clip(runId, 80);
  const res = await prisma.ownerRequest.updateMany({ where: { id, userId, status: { not: 'cancelled' } }, data });
  if (!res.count) return null;
  return prisma.ownerRequest.findUnique({ where: { id } });
}

async function cancelRequest(userId, id) {
  const res = await prisma.ownerRequest.updateMany({
    where: { id, userId, status: 'pending' },
    data: { status: 'cancelled', completedAt: new Date() },
  });
  return res.count > 0;
}

module.exports = { REQUEST_STATES, createRequest, listRequests, pendingCount, claimNext, reportRequest, cancelRequest };
