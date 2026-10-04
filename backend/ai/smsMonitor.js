/**
 * SMS monitor — deterministic (no Claude). Every 10 minutes: find customers waiting on a human reply,
 * keep exactly one Task per conversation (dedupKey sms:<last10>), escalate with age, text the owner once
 * for urgent ones during the day, and close the Task when somebody answers. "Draft a reply" is the
 * Communication agent's job (Inbox Watch) — it reads these tasks.
 */
const prisma = require('../lib/prismaClient');
const { getConversationStates, NEEDS_US, business } = require('./comms');
const { createTask, updateTask, completeByDedupKey, URGENCY_RANK } = require('./tasks');
const { logComm } = require('../lib/commLedger');
const { recordActivity } = require('./ledger');

const CREATE_AFTER_MIN = 10;     // give the owner a moment before raising a task
const NOTIFY_AFTER_MIN = 60;     // text the owner once when someone has waited this long (waking hours only)

const waitLabel = (m) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);

function urgencyFor(c) {
  let u = c.urgency;
  // "we asked something days ago" is a nudge, not an emergency: never escalate it by age
  if (c.state === 'FOLLOW_UP_REQUIRED') return 'normal';
  if (c.waitingMinutes > 24 * 60) u = 'urgent';
  else if (c.waitingMinutes > 120 && URGENCY_RANK[u] < URGENCY_RANK.high) u = 'high';
  return u;
}

async function smsMonitorTick({ userId }) {
  const convs = await getConversationStates(userId, { sinceDays: 14 });
  const needing = convs.filter((c) => NEEDS_US.has(c.state));
  const waiting = needing.filter((c) => c.waitingMinutes >= CREATE_AFTER_MIN);
  // Tasks stay open for EVERY conversation still waiting on us — including a fresh follow-up text that is only
  // minutes old (it must not be mistaken for "answered" just because it's below the raise-a-task threshold).
  const waitingKeys = new Set(needing.map((c) => `sms:${c.phoneKey}`));
  let created = 0; let updated = 0; let notified = 0;

  for (const c of waiting) {
    const dedupKey = `sms:${c.phoneKey}`;
    const urgency = urgencyFor(c);
    const who = c.clientName || c.phone;
    const existing = await prisma.task.findUnique({ where: { userId_dedupKey: { userId, dedupKey } } });
    const happened = `Texted ${waitLabel(c.waitingMinutes)} ago: "${String(c.lastMessage).slice(0, 220)}"`;

    // a returning customer who texts again after we closed/dismissed the task is a NEW need
    const reopen = existing && ['COMPLETED', 'DISMISSED'].includes(existing.status) && existing.completedAt && c.receivedAt > existing.completedAt;
    if (!existing || reopen) {
      if (reopen) await prisma.task.update({ where: { id: existing.id }, data: { status: 'NEW', completedAt: null, timesFlagged: { increment: 1 }, lastFlaggedAt: new Date() } });
      const { created: isNew } = await createTask(userId, {
        dedupKey, title: `${who} is waiting on a reply`, source: 'sms', agent: 'communication', customerName: c.clientName, customerKey: c.jobberClientId || c.phone,
        urgency, reason: c.reason, whatHappened: happened, whatNeeds: 'Reply to the customer.',
        recommended: c.state === 'NEW' ? 'New contact: answer, ask for their address and best number, offer a quote.' : c.state === 'ESCALATION_REQUIRED' ? 'Handle personally. Do not send an automated or drafted reply.' : 'Reply from the Inbox.',
        context: { phoneKey: c.phoneKey, phone: c.phone, state: c.state },
      });
      if (isNew) created++;
    } else if (!['COMPLETED', 'DISMISSED'].includes(existing.status)) {
      const patch = {};
      if (URGENCY_RANK[urgency] > URGENCY_RANK[existing.urgency]) patch.urgency = urgency;
      if (existing.whatHappened !== happened) patch.whatHappened = happened;
      if (Object.keys(patch).length) { await updateTask(userId, existing.id, patch); updated++; }
    }

    // one SMS to the owner per conversation episode, only when it has waited a while and it's waking hours
    const task = await prisma.task.findUnique({ where: { userId_dedupKey: { userId, dedupKey } } });
    const ctx = task?.context || {};
    const taskOpen = task && ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'].includes(task.status);   // done/dismissed = the owner has it
    if (taskOpen && c.state !== 'FOLLOW_UP_REQUIRED' && !ctx.notifiedAt && c.waitingMinutes >= NOTIFY_AFTER_MIN && business() && URGENCY_RANK[urgencyFor(c)] >= URGENCY_RANK.high) {
      const msg = `5StarFlow: ${who} texted ${waitLabel(c.waitingMinutes)} ago and is still waiting: "${String(c.lastMessage).slice(0, 90)}". Reply from the Inbox.`;
      const r = await require('../services/operatorService').notifyOwner(userId, msg).catch((e) => ({ ok: false, error: e.message }));
      if (r && (r.ok || r.dryRun)) {
        await prisma.task.update({ where: { id: task.id }, data: { context: { ...ctx, notifiedAt: new Date().toISOString() } } });
        notified++;
        await recordActivity(userId, { agent: 'communication', action: 'texted the owner', summary: `${who} waiting ${waitLabel(c.waitingMinutes)}`, result: r.dryRun ? 'skipped' : 'ok', source: 'sms' });
      }
    }
  }

  // close tasks for conversations that are no longer waiting on us (someone replied, or it resolved)
  const open = await prisma.task.findMany({ where: { userId, source: 'sms', dedupKey: { startsWith: 'sms:' }, status: { in: ['NEW', 'IN_PROGRESS', 'WAITING', 'APPROVAL'] } }, select: { dedupKey: true } });
  let closed = 0;
  for (const t of open) {
    if (!waitingKeys.has(t.dedupKey)) { const r = await completeByDedupKey(userId, t.dedupKey); closed += r.count; }
  }

  return {
    items_found: waiting.length,
    requires_attention: waiting.filter((c) => URGENCY_RANK[urgencyFor(c)] >= URGENCY_RANK.high).length,
    high_priority: waiting.filter((c) => urgencyFor(c) === 'urgent').length,
    actions_taken: [created && `Raised ${created} customer-waiting task(s)`, notified && `Texted the owner about ${notified}`, closed && `Closed ${closed} answered conversation(s)`].filter(Boolean),
    summary: waiting.length ? `${waiting.length} customer(s) waiting on a reply` : 'Nobody waiting on a reply',
  };
}

/**
 * Pull outbound messages from Twilio's own log and add any the app didn't send itself. Unknown outbound texts from
 * our number (Twilio console, another integration) are treated as human replies so those threads count as answered.
 */
async function reconcileTwilioTick({ userId }) {
  const creds = await require('../services/smsService').getTwilioCreds(userId).catch(() => null);
  if (!creds?.accountSid || !creds?.authToken || !creds.fromNumber) return { skipped: true, summary: 'Twilio not configured' };
  const client = require('twilio')(creds.accountSid, creds.authToken);
  const since = new Date(Date.now() - 3 * 86400000);
  const msgs = await client.messages.list({ from: creds.fromNumber, dateSentAfter: since, limit: 500 });
  let added = 0;
  for (const m of msgs) {
    if (m.direction !== 'outbound-api' && m.direction !== 'outbound-call' && m.direction !== 'outbound-reply') continue;
    const have = await prisma.commMessage.findFirst({ where: { userId, direction: 'out', providerId: m.sid }, select: { id: true } });
    if (have) continue;
    const r = await logComm(userId, { direction: 'out', phone: m.to, body: m.body, source: 'owner', providerId: m.sid, status: m.status, at: m.dateSent || m.dateCreated });
    if (r) added++;
  }
  return { items_found: msgs.length, actions_taken: added ? [`Added ${added} text(s) sent outside the app`] : [], summary: `${msgs.length} in Twilio log, ${added} new` };
}

module.exports = { smsMonitorTick, reconcileTwilioTick };
