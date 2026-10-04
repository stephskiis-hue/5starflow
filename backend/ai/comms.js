// Deterministic communication facts for the Inbox monitor and the daily brief (no Claude needed).
// Today "who is waiting" is computed from InboundSMS vs outbound MarketingMessage rows. Review/rain/loyalty
// texts aren't stored yet — the CommMessage ledger (M3) closes that gap.
const prisma = require('../lib/prismaClient');
const { localHour } = require('../lib/tz');

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// ---------------------------------------------------------------------------------------------
// Conversation states (deterministic). Only a HUMAN reply (source manual/owner) answers a customer:
// campaigns, review requests, rain notices and loyalty texts are automated and never count.
// ---------------------------------------------------------------------------------------------
const HUMAN = new Set(['manual', 'owner', 'ai']);   // 'ai' = a reply sent by the Communication agent through /inbox/:phone/reply
const ACK = /^(thanks?( you)?( so much)?|thx|ty|ok(ay)?|k|great|perfect|awesome|sounds good|got it|will do|👍|🙏)[\s.!,]*$/i;
const PRAISE = /\b(thank(s| you)|appreciate\w*|amazing|great job|awesome|fantastic|love(d)? (it|the)|looks great|well done)\b/i;
const REQUESTISH = /\b(please|instead|can you|could you|would you|need|want|when|reschedul\w*|move|change|cancel|call me|text me|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|doesn'?t work|won'?t work|unable)\b/i;
const COMPLAINT = /\b(refund|lawyer|sue|suing|damag\w*|complain\w*|unacceptable|disappointed|terrible|horrible|angry|furious|ruined|never again|report you|bbb)\b/i;
const URGENT = /\b(today|asap|urgent|emergency|right away|immediately|flood\w*|tree (is )?down|leak\w*)\b/i;
const QUOTE_REQ = /\b(quote|estimate|how much|price|pricing|cost|availab\w*|book|schedule|can you (come|do)|do you (do|offer))\b/i;

const business = () => { const h = localHour(new Date()); return h >= 7 && h < 21; };

/**
 * @param {Array} msgs  one phone's CommMessage rows, any order
 * @returns {{state, urgency, reason, waitingMinutes, lastIn, lastMessage}}
 *   state: NEW | WAITING_ON_NOBS | WAITING_ON_CUSTOMER | FOLLOW_UP_REQUIRED | RESOLVED | ESCALATION_REQUIRED
 */
function classifyConversation(msgs, now = Date.now()) {
  const sorted = [...msgs].sort((a, b) => a.at - b.at);
  const ins = sorted.filter((m) => m.direction === 'in');
  const lastIn = ins[ins.length - 1];
  if (!lastIn) return { state: 'RESOLVED', urgency: 'low', reason: 'no inbound messages', waitingMinutes: 0 };

  const delivered = (m) => !['failed', 'undelivered', 'canceled'].includes(String(m.status || '').toLowerCase());
  const humanOutAfter = sorted.find((m) => m.direction === 'out' && HUMAN.has(m.source) && delivered(m) && m.at > lastIn.at);
  const body = lastIn.body.trim();
  const waitingMinutes = Math.round((now - lastIn.at.getTime()) / 60000);

  if (/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(body)) return { state: 'RESOLVED', urgency: 'low', reason: 'opt-out', waitingMinutes, lastIn, lastMessage: body };

  const complaint = COMPLAINT.test(body);
  const urgent = URGENT.test(body);

  if (humanOutAfter) {
    const sinceOut = (now - humanOutAfter.at.getTime()) / 3600000;
    const askedSomething = /\?|let me know|send (me|us)|confirm|which|what time/i.test(humanOutAfter.body);
    if (askedSomething && sinceOut > 72) return { state: 'FOLLOW_UP_REQUIRED', urgency: 'normal', reason: `we asked something ${Math.round(sinceOut / 24)}d ago, no answer`, waitingMinutes: Math.round(sinceOut * 60), lastIn, lastMessage: body };
    return { state: 'WAITING_ON_CUSTOMER', urgency: 'low', reason: 'we replied', waitingMinutes: Math.round(sinceOut * 60), lastIn, lastMessage: body };
  }

  if (lastIn.sentiment === 'neutral' || !lastIn.sentiment) { /* fallthrough */ }
  // praise / thanks with no question or request needs no reply (a good moment for a review request, not a task)
  if (!complaint && !/\?/.test(body) && !QUOTE_REQ.test(body) && !REQUESTISH.test(body) && body.split(/\s+/).length <= 20 && (lastIn.sentiment === 'promoter' || PRAISE.test(body))) {
    return { state: 'RESOLVED', urgency: 'low', reason: 'thanks or praise, nothing to answer', waitingMinutes, lastIn, lastMessage: body };
  }
  if (ACK.test(body) && !complaint) return { state: 'RESOLVED', urgency: 'low', reason: 'acknowledgement, nothing to answer', waitingMinutes, lastIn, lastMessage: body };
  if (/^(n|no)$/i.test(body)) {
    // "NO" only closes a thread when it answers an AUTOMATED message (campaign / review request). After a human
    // question it is an answer the owner has to read.
    const prevOut = [...sorted].reverse().find((m) => m.direction === 'out' && m.at < lastIn.at);
    if (prevOut && !HUMAN.has(prevOut.source)) return { state: 'RESOLVED', urgency: 'low', reason: 'declined an automated message', waitingMinutes, lastIn, lastMessage: body };
  }

  if (complaint || (lastIn.sentiment === 'detractor')) return { state: 'ESCALATION_REQUIRED', urgency: 'urgent', reason: complaint ? 'complaint language' : 'negative sentiment', waitingMinutes, lastIn, lastMessage: body };
  if (waitingMinutes > 48 * 60) return { state: 'WAITING_ON_NOBS', urgency: 'low', reason: 'old thread, probably handled elsewhere', waitingMinutes, lastIn, lastMessage: body };
  if (waitingMinutes > 24 * 60) return { state: 'ESCALATION_REQUIRED', urgency: 'high', reason: 'unanswered for over a day', waitingMinutes, lastIn, lastMessage: body };

  const firstEver = ins.length === 1 && !sorted.some((m) => m.direction === 'out' && !m.source.startsWith('opt'));
  const urgency = urgent ? 'high' : QUOTE_REQ.test(body) ? 'high' : 'normal';
  return { state: firstEver ? 'NEW' : 'WAITING_ON_NOBS', urgency, reason: urgent ? 'urgent wording' : QUOTE_REQ.test(body) ? 'asking for a quote or availability' : 'customer is waiting', waitingMinutes, lastIn, lastMessage: body };
}

/** All conversations active in the window with their state. Owner/approver phones are excluded. */
async function getConversationStates(userId, { sinceDays = 14 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000);
  const rows = await prisma.commMessage.findMany({ where: { userId, channel: 'sms', at: { gte: since } }, orderBy: { at: 'asc' }, take: 20000 });
  const ownerPhones = await require('../services/operatorService').getApproverPhonesLast10(userId).catch(() => new Set());
  const sentiments = await prisma.inboundSMS.findMany({ where: { userId, receivedAt: { gte: since } }, select: { id: true, sentiment: true } });
  const sentById = new Map(sentiments.map((s) => [s.id, s.sentiment]));

  const byPhone = new Map();
  for (const m of rows) {
    if (!m.phoneKey || ownerPhones.has(m.phoneKey)) continue;
    if (m.direction === 'in') m.sentiment = sentById.get(m.sourceId) || null;
    (byPhone.get(m.phoneKey) || byPhone.set(m.phoneKey, []).get(m.phoneKey)).push(m);
  }
  const out = [];
  for (const [phoneKey, msgs] of byPhone) {
    const c = classifyConversation(msgs);
    const last = msgs.filter((m) => m.direction === 'in').pop();
    out.push({ phoneKey, phone: last?.phone || msgs[0].phone, clientName: msgs.find((m) => m.clientName)?.clientName || null, jobberClientId: msgs.find((m) => m.jobberClientId)?.jobberClientId || null, ...c, lastIn: undefined, receivedAt: c.lastIn?.at || null, sourceId: c.lastIn?.sourceId || null, sentiment: c.lastIn?.sentiment || null });
  }
  return out;
}

const NEEDS_US = new Set(['NEW', 'WAITING_ON_NOBS', 'ESCALATION_REQUIRED', 'FOLLOW_UP_REQUIRED']);

/** Customers waiting on us, oldest first (shape kept for the dashboard + brief). */
async function getUnansweredSms(userId, { sinceDays = 14, limit = 50 } = {}) {
  const convs = await getConversationStates(userId, { sinceDays });
  const reads = await prisma.inboundSMS.findMany({ where: { userId, receivedAt: { gte: new Date(Date.now() - sinceDays * 86400000) } }, select: { id: true, read: true } });
  const readById = new Map(reads.map((r) => [r.id, r.read]));
  return convs.filter((c) => NEEDS_US.has(c.state)).map((c) => ({
    id: c.sourceId, phone: c.phone, clientName: c.clientName, jobberClientId: c.jobberClientId, lastMessage: String(c.lastMessage || '').slice(0, 300),
    sentiment: c.sentiment, state: c.state, urgency: c.urgency, reason: c.reason, receivedAt: c.receivedAt, waitingMinutes: c.waitingMinutes, read: readById.get(c.sourceId) ?? false,
  })).sort((a, b) => b.waitingMinutes - a.waitingMinutes).slice(0, limit);
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
  // ReviewSent has no tenant column: only look it up for a client that THIS tenant owns (never a caller-supplied id)
  const clientId = client?.jobberClientId || null;

  if (!client && !phoneKey && !email) {
    return { found: false, hint: 'Pass jobberClientId, phone, email or q (name fragment).' };
  }

  const [ledger, review, pending, loyalty, rain, tasks, memory] = await Promise.all([
    l10 ? prisma.commMessage.findMany({ where: { userId, channel: 'sms', phoneKey: l10 }, orderBy: { at: 'desc' }, take: 40 }) : [],
    clientId ? prisma.reviewSent.findUnique({ where: { clientId } }) : null,
    clientId || email ? prisma.pendingReview.findMany({ where: { userId, OR: [clientId ? { clientId } : undefined, email ? { email } : undefined].filter(Boolean) }, orderBy: { createdAt: 'desc' }, take: 5 }) : [],
    clientId ? prisma.loyaltyClient.findFirst({ where: { userId, jobberClientId: clientId } }) : null,
    clientId ? prisma.rainMessage.findMany({ where: { userId, clientId }, orderBy: { sentAt: 'desc' }, take: 5 }) : [],
    prisma.task.findMany({ where: { userId, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'] }, OR: [clientId ? { customerKey: clientId } : undefined, phoneKey ? { customerKey: phoneKey } : undefined, client?.name ? { customerName: client.name } : undefined].filter(Boolean) }, take: 10 }),
    clientId ? prisma.memory.findMany({ where: { userId, scope: `customer:${clientId}` }, take: 20 }) : [],
  ]);

  // one timeline from the ledger (both directions, with WHO sent each outbound text)
  const timeline = ledger.slice(0, 20).map((m) => ({ dir: m.direction === 'in' ? 'in' : 'out', at: m.at, body: m.body, source: m.source, status: m.status }));
  const conv = ledger.length ? classifyConversation(ledger.map((m) => ({ ...m, sentiment: null }))) : null;

  return {
    found: !!client || timeline.length > 0,
    customer: client ? { jobberClientId: client.jobberClientId, name: client.name, firstName: client.firstName, phone: client.phone, smsAllowed: client.smsAllowed, optedOut: client.optedOut, tags: safeJson(client.tags) } : { phone: phoneKey },
    sms: { state: conv?.state || null, reason: conv?.reason || null, waitingOnUs: conv ? NEEDS_US.has(conv.state) : false, waitingMinutes: conv?.waitingMinutes || 0, timeline },
    reviews: { sent: !!review, sentAt: review?.sentAt || null, queued: pending.map((p) => ({ invoiceId: p.invoiceId, processed: p.processed, channel: p.channel, scheduledAt: p.scheduledAt })) },
    loyalty: loyalty ? { points: loyalty.totalPoints, optedOut: loyalty.optedOut } : null,
    rainNotices: rain.map((r) => ({ at: r.sentAt, channel: r.channel, status: r.status })),
    openTasks: tasks.map((t) => ({ id: t.id, title: t.title, urgency: t.urgency, status: t.status })),
    memory: memory.map((m) => ({ key: m.key, value: m.value })),
    gaps: ['Gmail threads are not indexed yet', 'Jobber jobs/quotes are not included yet'],
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return []; } }

module.exports = { getUnansweredSms, getConversationStates, classifyConversation, getCustomerContext, last10, NEEDS_US, business };
