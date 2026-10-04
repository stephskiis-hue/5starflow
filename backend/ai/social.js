/**
 * Social guardrails. The owner's autopilot instruction (Sept 27 2026) lets the social agent act
 * on its own WITHIN daily caps; this module is where the caps are enforced — in code, against the
 * action log, so a prompt can't talk its way past them.
 */
const prisma = require('../lib/prismaClient');
const { toDateString, dayBounds } = require('../lib/tz');

// per platform, per Winnipeg calendar day
const DAILY_CAPS = { comment: 10, dm: 5, like: 20, follow: 10, group_join: 5, group_post: 3, page_post: 2, story: 3 };
const UNCAPPED = new Set(['reply']);                 // replying to people who wrote to us is never capped
const PLATFORMS = ['facebook', 'instagram'];

class CapError extends Error {
  constructor(kind, platform, cap) { super(`Daily cap reached: ${cap} ${kind} per day on ${platform}`); this.code = 'CAP_REACHED'; this.kind = kind; this.cap = cap; }
}

async function getBudget(userId, { date } = {}) {
  const { start, end } = dayBounds(date || toDateString());
  const rows = await prisma.socialAction.groupBy({
    by: ['platform', 'kind'],
    where: { userId, status: 'done', createdAt: { gte: start, lt: end } },
    _count: { _all: true },
  });
  const used = {};
  for (const r of rows) (used[r.platform] ||= {})[r.kind] = r._count._all;
  const budget = {};
  for (const platform of PLATFORMS) {
    budget[platform] = {};
    for (const [kind, cap] of Object.entries(DAILY_CAPS)) {
      const u = used[platform]?.[kind] || 0;
      budget[platform][kind] = { used: u, cap, remaining: Math.max(0, cap - u) };
    }
  }
  return { date: date || toDateString(), caps: DAILY_CAPS, budget };
}

async function recordAction(userId, a) {
  const platform = PLATFORMS.includes(a.platform) ? a.platform : null;
  if (!platform) throw Object.assign(new Error(`platform must be one of ${PLATFORMS.join(', ')}`), { code: 'INVALID_ACTION' });
  if (!a.kind || (!DAILY_CAPS[a.kind] && !UNCAPPED.has(a.kind))) throw Object.assign(new Error(`unknown kind "${a.kind}"`), { code: 'INVALID_ACTION' });
  const status = ['done', 'failed', 'skipped'].includes(a.status) ? a.status : 'done';

  const data = { userId, platform, kind: a.kind, status, target: (a.target || '').slice(0, 200) || null, groupId: a.groupId || null, contentItemId: a.contentItemId || null, summary: (a.summary || '').slice(0, 500), url: (a.url || '').slice(0, 500) || null };
  let row;
  if (status === 'done' && DAILY_CAPS[a.kind]) {
    // count-then-insert under a transaction-scoped advisory lock so two parallel calls can't both slip under the cap
    const { start, end } = dayBounds();
    row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`social:${userId}:${platform}:${a.kind}`}))`;
      const used = await tx.socialAction.count({ where: { userId, platform, kind: a.kind, status: 'done', createdAt: { gte: start, lt: end } } });
      if (used >= DAILY_CAPS[a.kind]) throw new CapError(a.kind, platform, DAILY_CAPS[a.kind]);
      return tx.socialAction.create({ data });
    });
  } else {
    row = await prisma.socialAction.create({ data });
  }
  if (a.kind === 'group_post' && a.groupId && status === 'done') {
    await prisma.socialGroup.updateMany({ where: { id: a.groupId, userId }, data: { lastPostedAt: new Date(), postsCount: { increment: 1 } } });
  }
  return row;
}

/**
 * Next group worth posting to: a member group whose promo policy isn't banned and whose cooldown has passed,
 * best relevance first, longest-rested first. `promo: true` additionally excludes groups that restrict promos.
 */
async function nextGroups(userId, { promo = false, limit = 3 } = {}) {
  const groups = await prisma.socialGroup.findMany({ where: { userId, membership: 'member', promoPolicy: { not: 'banned' } } });
  const now = Date.now();
  return groups
    .filter((g) => (!promo || g.promoPolicy !== 'restricted'))
    .filter((g) => !g.lastPostedAt || now - g.lastPostedAt.getTime() >= g.cooldownDays * 86400000)
    .sort((a, b) => b.relevance - a.relevance || (a.lastPostedAt?.getTime() || 0) - (b.lastPostedAt?.getTime() || 0))
    .slice(0, limit);
}

module.exports = { DAILY_CAPS, getBudget, recordAction, nextGroups, CapError, PLATFORMS };
