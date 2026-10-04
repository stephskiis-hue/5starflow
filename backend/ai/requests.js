// Owner requests: the owner types "do X" on the dashboard home page, the request-inbox routine
// claims and acts on it. body is owner-written only; agents can write status/response/runId.
const prisma = require('../lib/prismaClient');
const { clip } = require('./constants');
const { recordAction } = require('./social');

const REQUEST_STATES = ['pending', 'working', 'done', 'needs_owner', 'failed', 'cancelled'];
const AGENT_REPORT_STATES = ['working', 'done', 'needs_owner', 'failed'];
const FINAL_STATES = ['done', 'needs_owner', 'failed', 'cancelled'];
const STALE_CLAIM_MINUTES = 60;
const BODY_MAX = 4000;
const RESPONSE_MAX = 4000;

const MAX_ATTACHMENTS = 6;

// Attach vault assets (uploaded through POST /assets) to a request. Unknown ids are rejected.
async function createRequest(userId, body, attachments = []) {
  const text = String(body || '').trim();
  const ids = [...new Set((Array.isArray(attachments) ? attachments : []).map(String))].slice(0, MAX_ATTACHMENTS);
  if (!text && !ids.length) throw new Error('Request is empty');
  if (ids.length) {
    const found = await prisma.contentAsset.count({ where: { userId, id: { in: ids } } });
    if (found !== ids.length) throw new Error('One of the attached files was not found');
  }
  return prisma.ownerRequest.create({ data: { userId, body: clip(text, BODY_MAX), attachments: ids.length ? ids : undefined } });
}

// Rows carry asset ids; the routine and the dashboard need name/type to show or download them.
async function withAttachments(userId, rows) {
  const ids = [...new Set(rows.flatMap((r) => (Array.isArray(r.attachments) ? r.attachments : [])))];
  const assets = ids.length ? await prisma.contentAsset.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true, mime: true, kind: true, size: true, private: true } }) : [];
  const byId = Object.fromEntries(assets.map((a) => [a.id, a]));
  return rows.map((r) => ({ ...r, attachments: (Array.isArray(r.attachments) ? r.attachments : []).map((id) => byId[id]).filter(Boolean) }));
}

async function listRequests(userId, { status, limit = 20 } = {}) {
  const where = { userId };
  if (status && REQUEST_STATES.includes(status)) where.status = status;
  return withAttachments(userId, await prisma.ownerRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }));
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
    if (res.count) return (await withAttachments(userId, [await prisma.ownerRequest.findUnique({ where: { id: next.id } })]))[0];
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

// After the routine posts a request's photo/video, log it as a published ContentItem so reach/leads can be
// tracked like any other post. One item per request; a second platform updates the same item.
async function recordPost(userId, id, { platform, postUrl, caption, captionIg } = {}) {
  if (!['facebook', 'instagram'].includes(platform)) throw new Error('platform must be facebook or instagram');
  const req = await prisma.ownerRequest.findFirst({ where: { id, userId } });
  if (!req) return null;
  const source = `request:${id}`;
  const at = new Date().toISOString();
  const existing = await prisma.contentItem.findFirst({ where: { userId, source } });
  const publishedOn = { ...(existing?.publishedOn || {}), [platform]: { postUrl: postUrl || null, at } };
  const platforms = Object.keys(publishedOn);
  const data = {
    platforms: JSON.stringify(platforms), publishedOn, status: 'published', publishedAt: existing?.publishedAt || new Date(),
    postUrl: existing?.postUrl || postUrl || null,
    ...(caption ? { caption: clip(caption, 5000) } : {}), ...(captionIg ? { captionIg: clip(captionIg, 2500) } : {}),
  };
  const item = existing
    ? await prisma.contentItem.update({ where: { id: existing.id }, data })
    : await createPostItem();
  await recordAction(userId, { platform, kind: 'owner_post', contentItemId: item.id, target: postUrl, url: postUrl, summary: clip(req.body || caption || 'Owner post', 200) });
  return item;

  function createPostItem() {
    return prisma.contentItem.create({ data: { userId, source, format: 'post', title: clip(req.body || caption || 'Owner post', 160), assetIds: Array.isArray(req.attachments) ? req.attachments : undefined, grounding: 'Owner request with the owner\'s own media', ...data } });
  }
}

module.exports = { REQUEST_STATES, createRequest, listRequests, pendingCount, claimNext, recordPost, reportRequest, cancelRequest };
