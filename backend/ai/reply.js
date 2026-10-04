/**
 * Customer replies from the Communication agent. Everything that makes this safe is enforced HERE, in code:
 * a prompt can't talk its way past it. See POST /api/ai/inbox/:phone/reply.
 *
 *   • only conversations that are actually waiting on us (never double-answer a human reply)
 *   • complaints / escalations are never answered by the AI
 *   • money topics (amounts, price questions, invoices, refunds) get ONE holding reply + a task for the owner's daily digest
 *   • opt-out, waking hours, brand lint, length, 1 AI reply per conversation per 2 h, DRY_RUN
 */
const prisma = require('../lib/prismaClient');
const { classifyConversation, NEEDS_US, last10 } = require('./comms');
const { isMoneyTopic, quotesAmount } = require('./money');
const { lintContent } = require('./design/qa');
const { createTask, completeByDedupKey } = require('./tasks');
const { recordActivity } = require('./ledger');
const { localHour } = require('../lib/tz');

const HOLDING = "Thanks for reaching out! Steph will get back to you today with the details.";
const MAX_LEN = 320;

async function sendAiReply(userId, { phone, body, reason }) {
  const key = last10(phone);
  if (key.length !== 10) return { sent: false, code: 'BAD_PHONE', error: 'phone must have 10 digits' };

  const msgs = await prisma.commMessage.findMany({ where: { userId, channel: 'sms', phoneKey: key, at: { gte: new Date(Date.now() - 14 * 86400000) } }, orderBy: { at: 'asc' }, take: 200 });
  if (!msgs.length) return { sent: false, code: 'NO_CONVERSATION', error: 'no recent conversation with that number' };

  const conv = classifyConversation(msgs);
  if (!NEEDS_US.has(conv.state)) return { sent: false, code: 'NOT_WAITING', error: `conversation is ${conv.state}: nothing to answer` };
  if (conv.state === 'ESCALATION_REQUIRED') {
    await createTask(userId, { dedupKey: `sms:${key}`, title: `${msgs[0].clientName || phone} needs you personally`, source: 'sms', agent: 'communication', urgency: 'urgent', reason: conv.reason, whatHappened: String(conv.lastMessage).slice(0, 300), whatNeeds: 'Handle personally. The AI does not answer complaints.' });
    return { sent: false, code: 'ESCALATION', error: 'complaint or dispute: left for the owner' };
  }

  const lastAi = [...msgs].reverse().find((m) => m.direction === 'out' && m.source === 'ai');
  if (lastAi && Date.now() - lastAi.at.getTime() < 2 * 3600 * 1000) return { sent: false, code: 'RATE_LIMIT', error: 'already replied to this conversation in the last 2 hours' };

  const h = localHour(new Date());
  if (h < 8 || h >= 21) return { sent: false, code: 'QUIET_HOURS', error: 'texts go out 8 am to 9 pm Winnipeg time' };

  // everything the customer said since the last human/AI answer
  const lastAnswer = [...msgs].reverse().find((m) => m.direction === 'out' && ['manual', 'owner', 'ai'].includes(m.source));
  const unanswered = msgs.filter((m) => m.direction === 'in' && (!lastAnswer || m.at > lastAnswer.at)).map((m) => m.body).join(' ');
  const money = isMoneyTopic(unanswered) || quotesAmount(body);

  let text = String(body || '').trim();
  let kind = 'reply';
  if (money) {
    // pricing autonomy per service is added by ai/learning/pricing.js; until a service is enabled the AI never discusses money
    kind = 'holding';
    text = HOLDING;
  } else {
    if (!text) return { sent: false, code: 'EMPTY', error: 'body required' };
    if (text.length > MAX_LEN) return { sent: false, code: 'TOO_LONG', error: `max ${MAX_LEN} characters` };
    const lint = lintContent({ caption: text, platform: 'sms' });
    if (!lint.ok) return { sent: false, code: 'LINT', error: lint.errors.join(' ') };
  }

  const smsService = require('../services/smsService');
  const to = smsService.toE164(phone);
  if (await smsService.isOptedOut(userId, to)) return { sent: false, code: 'OPTED_OUT', error: 'customer sent STOP' };

  let result;
  if (process.env.DRY_RUN === 'true') {
    result = { ok: true, dryRun: true };
  } else {
    const creds = await smsService.getTwilioCreds(userId);
    if (!creds.accountSid || !creds.authToken) return { sent: false, code: 'NO_TWILIO', error: 'Twilio is not configured' };
    result = await smsService.sendSmsSafely({ to, ...smsService.senderParams(creds), body: text, client: require('twilio')(creds.accountSid, creds.authToken), userId, source: 'ai' });
    if (!result.ok) return { sent: false, code: 'SEND_FAILED', error: result.errorMessage };
  }

  const who = msgs.find((m) => m.clientName)?.clientName || phone;
  if (money) {
    await createTask(userId, {
      dedupKey: `sms:${key}`, title: `${who} asked about money`, source: 'sms', agent: 'communication', urgency: 'high', status: 'APPROVAL',
      customerName: msgs.find((m) => m.clientName)?.clientName, customerKey: phone, reason: 'Money topic: the AI sent a holding reply and left the answer to you.',
      whatHappened: `Customer said: "${unanswered.slice(0, 240)}"`, whatNeeds: 'Reply with the details (price, quote, payment).', proposedResponse: String(body || '').slice(0, 300),
      context: { money: true, phoneKey: key, phone },
    });
    await prisma.task.updateMany({ where: { userId, dedupKey: `sms:${key}` }, data: { status: 'APPROVAL', context: { money: true, phoneKey: key, phone } } });
  } else {
    await completeByDedupKey(userId, `sms:${key}`);
  }
  await recordActivity(userId, { agent: 'communication', action: kind === 'holding' ? 'sent holding reply (money topic)' : 'replied to customer', summary: `${who}: ${text.slice(0, 120)}`, result: result.dryRun ? 'skipped' : 'ok', source: 'sms', approval: kind === 'holding' ? 'pending' : 'auto', customerRef: key });
  return { sent: true, kind, dryRun: !!result.dryRun, body: text };
}

module.exports = { sendAiReply, HOLDING };
