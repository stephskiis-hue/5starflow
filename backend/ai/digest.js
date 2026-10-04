/**
 * The ONLY text 5StarFlow sends the owner: one summary a day (5 pm Winnipeg), and only when something needs them.
 * Money questions the AI held, customers still waiting after hours, routines that keep failing.
 */
const prisma = require('../lib/prismaClient');
const { toDateString } = require('../lib/tz');
const { getConversationStates, NEEDS_US } = require('./comms');
const { recordActivity } = require('./ledger');

const MEMORY = { scope: 'routine:owner-daily-digest', key: 'last-sent' };

async function buildDigest(userId) {
  const money = await prisma.task.findMany({ where: { userId, status: 'APPROVAL' }, orderBy: { updatedAt: 'desc' }, take: 20 });
  const moneyHolds = money.filter((t) => t.context?.money);
  const convs = await getConversationStates(userId, { sinceDays: 3 });
  const waiting = convs.filter((c) => NEEDS_US.has(c.state) && c.waitingMinutes >= 240 && c.waitingMinutes <= 48 * 60);
  const failing = await prisma.routine.findMany({ where: { userId, enabled: true, consecutiveFailures: { gte: 3 } }, select: { name: true } });
  return { moneyHolds, waiting, failing };
}

function compose({ moneyHolds, waiting, failing }) {
  const parts = [];
  if (moneyHolds.length) parts.push(`${moneyHolds.length} money question${moneyHolds.length > 1 ? 's' : ''} (${moneyHolds.slice(0, 3).map((t) => (t.customerName || 'customer').split(' ')[0]).join(', ')}${moneyHolds.length > 3 ? '…' : ''})`);
  if (waiting.length) parts.push(`${waiting.length} customer${waiting.length > 1 ? 's' : ''} waiting 4h+`);
  if (failing.length) parts.push(`${failing.length} routine${failing.length > 1 ? 's' : ''} failing`);
  return parts.length ? `5StarFlow today: ${parts.join(', ')}. Open AI Command > Tasks. Everything else was handled.` : null;
}

async function digestTick({ userId }) {
  if (process.env.OWNER_SMS === 'off') return { skipped: true, summary: 'Owner texts are turned off (OWNER_SMS=off)' };
  const today = toDateString();
  const last = await prisma.memory.findUnique({ where: { userId_scope_key: { userId, ...MEMORY } } });
  if (last?.value === today) return { skipped: true, summary: 'Already sent today' };

  const d = await buildDigest(userId);
  const msg = compose(d);
  if (!msg) return { items_found: 0, summary: 'Nothing needs the owner today (no text sent)' };

  const r = await require('../services/operatorService').notifyOwner(userId, msg);
  if (r && (r.ok || r.dryRun)) {
    await prisma.memory.upsert({ where: { userId_scope_key: { userId, ...MEMORY } }, update: { value: today }, create: { userId, ...MEMORY, value: today, confidence: 1, source: 'system' } });
    await recordActivity(userId, { agent: 'orchestrator', action: 'sent the daily summary text', summary: msg, result: r.dryRun ? 'skipped' : 'ok' });
  }
  return { items_found: d.moneyHolds.length + d.waiting.length + d.failing.length, actions_taken: [`Daily summary: ${msg}`], summary: msg };
}

module.exports = { digestTick, buildDigest, compose };
