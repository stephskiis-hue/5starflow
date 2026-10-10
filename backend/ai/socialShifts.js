/**
 * Social shifts: WHEN the MSI should run the Social agent. The server decides, so a PC that was off
 * (power cut, sleep, reboot) simply picks the missed shift up on its next 5 minute tick.
 *
 *   morning 7:30   inbox, leads, group joins and posts
 *   midday  12:30  engagement comments, likes, follows
 *   evening 18:30  inbox, follow-ups, whatever the day is still short of
 *   studio  Mon 10:30  builds the week's content (weekly)
 *
 * A shift stays due until its deadline, is tried at most MAX_ATTEMPTS times, and a claim that never
 * reports back is released after STALE_CLAIM_MIN so a crashed run can't block the day.
 */
const prisma = require('../lib/prismaClient');
const { toDateString, BUSINESS_TZ } = require('../lib/tz');

const SHIFTS = [
  { kind: 'morning', start: '07:30', deadline: '16:00' },
  { kind: 'midday', start: '12:30', deadline: '19:00' },
  { kind: 'evening', start: '18:30', deadline: '21:30' },
  { kind: 'studio', start: '10:30', deadline: '17:00', weekday: 1 },
];
const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MIN = 100;
const RETRY_GAP_MIN = 10;

const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: BUSINESS_TZ, weekday: 'short' });
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const localMinutes = (d) => minutes(timeFmt.format(d));
const localWeekday = (d) => WEEKDAYS[dayFmt.format(d)];

/** Pure: which shifts are open right now, given today's stored rows. `rows` = SocialShift[] for today. */
function openShifts(now, rows) {
  const nowMin = localMinutes(now);
  const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
  const out = [];
  for (const s of SHIFTS) {
    if (s.weekday !== undefined && localWeekday(now) !== s.weekday) continue;
    if (nowMin < minutes(s.start) || nowMin >= minutes(s.deadline)) continue;
    const r = byKind[s.kind];
    if (r && ['done', 'needs_owner'].includes(r.status)) continue;
    if (r && r.attempts >= MAX_ATTEMPTS && r.status !== 'running') continue;
    if (r && r.status === 'running' && now - new Date(r.claimedAt) < STALE_CLAIM_MIN * 60000) continue;
    if (r && r.status === 'failed' && r.finishedAt && now - new Date(r.finishedAt) < RETRY_GAP_MIN * 60000) continue;
    out.push({ kind: s.kind, start: s.start, attempts: r?.attempts || 0, late: nowMin - minutes(s.start) > 45 });
  }
  return out;
}

/** What should run now, with the day's remaining targets so the agent knows what is still short. */
async function shiftDue(userId, { now = new Date() } = {}) {
  const day = toDateString(now);
  const rows = await prisma.socialShift.findMany({ where: { userId, day } });
  return { day, due: openShifts(now, rows), shifts: rows };
}

/** Atomically take a shift. Returns the row, or null if someone else holds it or it is not open. */
async function claimShift(userId, kind, { now = new Date() } = {}) {
  const day = toDateString(now);
  const def = SHIFTS.find((s) => s.kind === kind);
  if (!def) throw Object.assign(new Error(`unknown shift "${kind}"`), { code: 'INVALID_ACTION' });
  await prisma.socialShift.upsert({ where: { userId_day_kind: { userId, day, kind } }, create: { userId, day, kind }, update: {} });
  const rows = await prisma.socialShift.findMany({ where: { userId, day } });
  if (!openShifts(now, rows).some((s) => s.kind === kind)) return null;
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MIN * 60000);
  const r = await prisma.socialShift.updateMany({
    where: { userId, day, kind, attempts: { lt: MAX_ATTEMPTS }, OR: [{ status: { in: ['due', 'failed'] } }, { status: 'running', claimedAt: { lt: staleBefore } }] },
    data: { status: 'running', claimedAt: now, finishedAt: null, error: null, attempts: { increment: 1 } },
  });
  if (!r.count) return null;
  return prisma.socialShift.findUnique({ where: { userId_day_kind: { userId, day, kind } } });
}

/** Close a shift. needs_owner (login / checkpoint) stops retries for the day; failed retries until MAX_ATTEMPTS. */
async function finishShift(userId, id, { status, summary, error } = {}) {
  if (!['done', 'failed', 'needs_owner'].includes(status)) throw Object.assign(new Error('status must be done, failed or needs_owner'), { code: 'INVALID_ACTION' });
  const row = await prisma.socialShift.findFirst({ where: { id, userId } });
  if (!row) return null;
  return prisma.socialShift.update({ where: { id }, data: { status, finishedAt: new Date(), summary: summary ? String(summary).slice(0, 2000) : row.summary, error: error ? String(error).slice(0, 1000) : null } });
}

module.exports = { SHIFTS, MAX_ATTEMPTS, openShifts, shiftDue, claimShift, finishShift };
