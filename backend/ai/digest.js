/**
 * The weekly owner summary: one text, Saturday 3 pm Winnipeg by default (day/hour/off are set in the Notification Centre).
 * Everything non-urgent collected in the Notification Centre this week, plus money questions the AI held,
 * customers still waiting and routines that keep failing. Urgent things are texted when they happen, not here.
 */
const prisma = require('../lib/prismaClient');
const { toDateString, localHour, BUSINESS_TZ } = require('../lib/tz');
const { getConversationStates, NEEDS_US } = require('./comms');
const { recordActivity } = require('./ledger');
const { getSettings } = require('../lib/notify');

const MEMORY = { scope: 'routine:owner-daily-digest', key: 'last-sent' };
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, weekday: 'short' });
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function buildDigest(userId) {
  const money = await prisma.task.findMany({ where: { userId, status: 'APPROVAL' }, orderBy: { updatedAt: 'desc' }, take: 20 });
  const moneyHolds = money.filter((t) => t.context?.money);
  const convs = await getConversationStates(userId, { sinceDays: 3 });
  const waiting = convs.filter((c) => NEEDS_US.has(c.state) && c.waitingMinutes >= 240 && c.waitingMinutes <= 48 * 60);
  const failing = await prisma.routine.findMany({ where: { userId, enabled: true, consecutiveFailures: { gte: 3 } }, select: { name: true } });
  const feed = await prisma.notification.findMany({ where: { userId, sentVia: 'none', createdAt: { gte: new Date(Date.now() - 8 * 86400000) } }, orderBy: { createdAt: 'desc' }, take: 100 });
  return { moneyHolds, waiting, failing, feed };
}

function compose({ moneyHolds, waiting, failing, feed }) {
  const parts = [];
  if (moneyHolds.length) parts.push(`${moneyHolds.length} money question${moneyHolds.length > 1 ? 's' : ''} (${moneyHolds.slice(0, 3).map((t) => (t.customerName || 'customer').split(' ')[0]).join(', ')}${moneyHolds.length > 3 ? '…' : ''})`);
  if (waiting.length) parts.push(`${waiting.length} customer${waiting.length > 1 ? 's' : ''} waiting 4h+`);
  if (failing.length) parts.push(`${failing.length} routine${failing.length > 1 ? 's' : ''} failing`);
  if (feed.length) parts.push(`${feed.length} other update${feed.length > 1 ? 's' : ''} in your Notification Centre`);
  return parts.length ? `5StarFlow weekly: ${parts.join(', ')}. Open the 5StarFlow home page. Everything else was handled.` : null;
}

// Hourly cron entry: only the hour the owner picked actually runs (and sends).
async function digestDue(userId, now = new Date()) {
  const s = await getSettings(userId);
  if (s.digestMode === 'off') return false;
  return DAYS.indexOf(weekdayFmt.format(now)) === s.digestDay && localHour(now) === s.digestHour;
}

async function digestTick({ userId }) {
  if (process.env.OWNER_SMS === 'off') return { skipped: true, summary: 'Owner texts are turned off (OWNER_SMS=off)' };
  const s = await getSettings(userId);
  if (s.digestMode === 'off') return { skipped: true, summary: 'Weekly summary is turned off in the Notification Centre' };
  const today = toDateString();
  const last = await prisma.memory.findUnique({ where: { userId_scope_key: { userId, ...MEMORY } } });
  if (last?.value && (Date.now() - new Date(`${last.value}T12:00:00Z`).getTime()) < 5 * 86400000) return { skipped: true, summary: `Already sent on ${last.value}` };

  const d = await buildDigest(userId);
  const msg = compose(d);
  if (!msg) return { items_found: 0, summary: 'Nothing needs the owner this week (no text sent)' };

  const r = await require('../services/operatorService').notifyOwner(userId, msg);
  if (r && (r.ok || r.dryRun)) {
    await prisma.memory.upsert({ where: { userId_scope_key: { userId, ...MEMORY } }, update: { value: today }, create: { userId, ...MEMORY, value: today, confidence: 1, source: 'system' } });
    if (d.feed.length) await prisma.notification.updateMany({ where: { id: { in: d.feed.map((n) => n.id) } }, data: { sentVia: 'digest' } });
    await recordActivity(userId, { agent: 'orchestrator', action: 'sent the weekly summary text', summary: msg, result: r.dryRun ? 'skipped' : 'ok' });
  }
  return { items_found: d.moneyHolds.length + d.waiting.length + d.failing.length + d.feed.length, actions_taken: [`Weekly summary: ${msg}`], summary: msg };
}

module.exports = { digestTick, digestDue, buildDigest, compose };
