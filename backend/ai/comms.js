// Deterministic communication facts for the Inbox monitor and the daily brief (no Claude needed).
// Today "who is waiting" is computed from InboundSMS vs outbound MarketingMessage rows. Review/rain/loyalty
// texts aren't stored yet — the CommMessage ledger (M3) closes that gap.
const prisma = require('../lib/prismaClient');

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

/**
 * Customers whose most recent inbound text has no outbound reply after it.
 * STOP/opt-out messages and plain Y/N campaign answers are excluded (nothing to reply to).
 */
async function getUnansweredSms(userId, { sinceDays = 14, limit = 50 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000);
  const inbound = await prisma.inboundSMS.findMany({
    where: { userId, receivedAt: { gte: since } },
    orderBy: { receivedAt: 'desc' },
    take: 1000,
  });
  const latestByPhone = new Map();
  for (const m of inbound) {
    const k = last10(m.from);
    if (k && !latestByPhone.has(k)) latestByPhone.set(k, m);
  }
  const candidates = [...latestByPhone.values()].filter((m) => m.response !== 'optout');
  if (!candidates.length) return [];

  const phones = candidates.map((m) => m.from);
  const outbound = await prisma.marketingMessage.findMany({
    where: { userId, phone: { in: phones }, status: { notIn: ['failed', 'skipped'] }, createdAt: { gte: since } },
    select: { phone: true, createdAt: true, sentAt: true, campaignId: true },
  });
  const lastOut = new Map();
  for (const o of outbound) {
    const k = last10(o.phone);
    const t = (o.sentAt || o.createdAt).getTime();
    if (!lastOut.has(k) || t > lastOut.get(k)) lastOut.set(k, t);
  }

  const now = Date.now();
  return candidates
    .filter((m) => !(lastOut.get(last10(m.from)) > m.receivedAt.getTime()))
    .map((m) => ({
      id: m.id,
      phone: m.from,
      clientName: m.clientName,
      jobberClientId: m.jobberClientId,
      lastMessage: m.body.slice(0, 300),
      sentiment: m.sentiment,
      isYesNo: m.isResponse,
      receivedAt: m.receivedAt,
      waitingMinutes: Math.round((now - m.receivedAt.getTime()) / 60000),
      read: m.read,
    }))
    .sort((a, b) => b.waitingMinutes - a.waitingMinutes)
    .slice(0, limit);
}

/**
 * One combined view of a customer from everything stored locally.
 * Resolve by jobberClientId, phone (last-10 match), email (review queue only today) or a name fragment.
 */
async function getCustomerContext(userId, { jobberClientId, phone, email, q } = {}) {
  let client = null;
  if (jobberClientId) client = await prisma.cachedJobberClient.findFirst({ where: { userId, jobberClientId } });
  if (!client && phone) {
    const l10 = last10(phone);
    if (l10.length === 10) client = await prisma.cachedJobberClient.findFirst({ where: { userId, phone: { endsWith: l10 } } });
  }
  if (!client && q) client = await prisma.cachedJobberClient.findFirst({ where: { userId, name: { contains: q, mode: 'insensitive' } } });

  const phoneKey = client?.phone || phone || null;
  const l10 = last10(phoneKey);
  const clientId = client?.jobberClientId || jobberClientId || null;

  if (!client && !phoneKey && !email) {
    return { found: false, hint: 'Pass jobberClientId, phone, email or q (name fragment).' };
  }

  const [inbound, outbound, review, pending, loyalty, rain, tasks, memory] = await Promise.all([
    l10 ? prisma.inboundSMS.findMany({ where: { userId, from: { endsWith: l10 } }, orderBy: { receivedAt: 'desc' }, take: 15 }) : [],
    l10 ? prisma.marketingMessage.findMany({ where: { userId, phone: { endsWith: l10 }, status: { not: 'skipped' } }, orderBy: { createdAt: 'desc' }, take: 15, select: { body: true, status: true, deliveryStatus: true, sentAt: true, createdAt: true, campaign: { select: { name: true } } } }) : [],
    clientId ? prisma.reviewSent.findUnique({ where: { clientId } }) : null,
    clientId || email ? prisma.pendingReview.findMany({ where: { userId, OR: [clientId ? { clientId } : undefined, email ? { email } : undefined].filter(Boolean) }, orderBy: { createdAt: 'desc' }, take: 5 }) : [],
    clientId ? prisma.loyaltyClient.findFirst({ where: { userId, jobberClientId: clientId } }) : null,
    clientId ? prisma.rainMessage.findMany({ where: { userId, clientId }, orderBy: { sentAt: 'desc' }, take: 5 }) : [],
    prisma.task.findMany({ where: { userId, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'] }, OR: [clientId ? { customerKey: clientId } : undefined, phoneKey ? { customerKey: phoneKey } : undefined, client?.name ? { customerName: client.name } : undefined].filter(Boolean) }, take: 10 }),
    clientId ? prisma.memory.findMany({ where: { userId, scope: `customer:${clientId}` }, take: 20 }) : [],
  ]);

  // merge both directions into one timeline, newest first
  const timeline = [
    ...inbound.map((m) => ({ dir: 'in', at: m.receivedAt, body: m.body, sentiment: m.sentiment })),
    ...outbound.map((m) => ({ dir: 'out', at: m.sentAt || m.createdAt, body: m.body, status: m.deliveryStatus || m.status, campaign: m.campaign?.name })),
  ].sort((a, b) => b.at - a.at).slice(0, 20);

  const lastIn = inbound[0]?.receivedAt;
  const lastOut = outbound.find((m) => m.status !== 'failed');
  const lastOutAt = lastOut ? (lastOut.sentAt || lastOut.createdAt) : null;

  return {
    found: !!client || timeline.length > 0,
    customer: client ? { jobberClientId: client.jobberClientId, name: client.name, firstName: client.firstName, phone: client.phone, smsAllowed: client.smsAllowed, optedOut: client.optedOut, tags: safeJson(client.tags) } : { phone: phoneKey },
    sms: { waitingOnUs: !!lastIn && (!lastOutAt || lastIn > lastOutAt), lastInboundAt: lastIn || null, lastOutboundAt: lastOutAt, timeline },
    reviews: { sent: !!review, sentAt: review?.sentAt || null, queued: pending.map((p) => ({ invoiceId: p.invoiceId, processed: p.processed, channel: p.channel, scheduledAt: p.scheduledAt })) },
    loyalty: loyalty ? { points: loyalty.totalPoints, optedOut: loyalty.optedOut } : null,
    rainNotices: rain.map((r) => ({ at: r.sentAt, channel: r.channel, status: r.status })),
    openTasks: tasks.map((t) => ({ id: t.id, title: t.title, urgency: t.urgency, status: t.status })),
    memory: memory.map((m) => ({ key: m.key, value: m.value })),
    gaps: ['Gmail threads are not indexed yet', 'Jobber jobs/quotes are not included yet'],
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = { getUnansweredSms, getCustomerContext, last10 };
