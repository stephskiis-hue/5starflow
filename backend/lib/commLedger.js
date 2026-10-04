/**
 * Communication ledger helpers. logComm() is best-effort and NEVER throws: recording a message must
 * not be able to break sending one. See the CommMessage model for the meaning of `source`.
 */
const prisma = require('./prismaClient');

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

async function logComm(userId, m) {
  if (!userId || !m) return null;
  try {
    const data = {
      userId, channel: m.channel || 'sms', direction: m.direction, phone: m.phone || null, phoneKey: last10(m.phone) || null,
      email: m.email ? String(m.email).toLowerCase() : null, jobberClientId: m.jobberClientId || null, clientName: m.clientName || null,
      body: String(m.body || '').slice(0, 2000), source: m.source || 'system', sourceId: m.sourceId || null,
      providerId: m.providerId || null, status: m.status || null, at: m.at || new Date(),
    };
    if (data.providerId) {
      return await prisma.commMessage.upsert({
        where: { userId_channel_direction_providerId: { userId, channel: data.channel, direction: data.direction, providerId: data.providerId } },
        update: { status: data.status ?? undefined }, create: data,
      });
    }
    return await prisma.commMessage.create({ data });
  } catch (err) {
    console.warn('[commLedger] write failed:', err.message);
    return null;
  }
}

/** One-time import of history so "who is waiting" works from day one. Idempotent (provider ids dedupe). */
async function backfillComm(userId) {
  const inbound = await prisma.inboundSMS.findMany({ where: { userId }, orderBy: { receivedAt: 'asc' }, take: 5000 });
  let n = 0;
  for (const m of inbound) {
    const r = await logComm(userId, { direction: 'in', phone: m.from, body: m.body, source: 'inbound', sourceId: m.id, providerId: m.messageSid, jobberClientId: m.jobberClientId, clientName: m.clientName, at: m.receivedAt });
    if (r) n++;
  }
  const out = await prisma.marketingMessage.findMany({
    where: { userId, messageSid: { not: null }, status: { notIn: ['failed', 'skipped', 'pending'] } },
    orderBy: { createdAt: 'asc' }, take: 20000, include: { campaign: { select: { templateId: true } } },
  });
  for (const m of out) {
    const r = await logComm(userId, { direction: 'out', phone: m.phone, body: m.body || '', source: m.campaign?.templateId === 'direct' ? 'manual' : 'campaign', sourceId: m.id, providerId: m.messageSid, jobberClientId: m.jobberClientId, clientName: m.clientName, status: m.deliveryStatus || m.status, at: m.sentAt || m.createdAt });
    if (r) n++;
  }
  return n;
}

module.exports = { logComm, backfillComm, last10 };
