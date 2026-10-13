/**
 * Social guardrails. The owner's autopilot instruction (Sept 27 2026) lets the social agent act
 * on its own WITHIN daily caps; this module is where the caps are enforced — in code, against the
 * action log, so a prompt can't talk its way past them.
 *
 * Every outward action goes reserve → act → confirm:
 *   reserveAction()  server lints the exact text, checks the cap / group cooldown / duplicates and only then returns an id
 *   (the agent acts in Chrome)
 *   confirmAction()  marks it done with the link to what we posted, or failed with the reason
 * A reservation counts against the cap straight away and expires after 15 minutes if never confirmed.
 */
const prisma = require('../lib/prismaClient');
const { toDateString, dayBounds } = require('../lib/tz');
const { lintContent, PHONE } = require('./design/qa');
const { lintOutreach, lintKindFor } = require('./outreachLint');

// per platform, per Winnipeg calendar day
const DAILY_CAPS = { comment: 10, dm: 5, like: 20, follow: 10, group_join: 5, group_post: 3, page_post: 2, story: 3 };
// What a good day looks like, so the shifts keep working until the day is full (never above the cap).
const SOCIAL_TARGETS = {
  facebook: { comment: 6, like: 12, follow: 3, group_join: 3, group_post: 3, page_post: 1, story: 1 },
  instagram: { comment: 4, like: 8, follow: 7, page_post: 1, story: 1 },
};
const UNCAPPED = new Set(['reply', 'owner_post']);   // replies, and posts the owner explicitly asked for (logged, but they don't use the autopilot budget)
const PLATFORMS = ['facebook', 'instagram'];
const RESERVE_MINUTES = 15;
const NEEDS_TEXT = new Set(['comment', 'dm', 'reply', 'group_post', 'page_post']);
const NEEDS_TARGET = new Set(['comment', 'dm', 'like', 'follow', 'group_join', 'reply']);
const ONCE_PER_TARGET = new Set(['comment', 'dm', 'like', 'follow']);
const REPLY_FOLLOWUP_MS = 48 * 3600000;
// Competitor pages/handles: read-only, never comment or reply there (extra handles via SOCIAL_COMPETITOR_HANDLES, comma-separated).
const COMPETITORS = ['3seasonslandscaping', 'emeraldislelawncare', 'fivestarlawns', 'grounds_guys_winnipeg', 'groundsguys',
  ...String(process.env.SOCIAL_COMPETITOR_HANDLES || '').split(',').map((h) => h.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)];
const isCompetitorTarget = (target) => { const t = String(target || '').toLowerCase(); return COMPETITORS.some((c) => t.includes(c)); };

class CapError extends Error {
  constructor(kind, platform, cap) { super(`Daily cap reached: ${cap} ${kind} per day on ${platform}`); this.code = 'CAP_REACHED'; this.kind = kind; this.cap = cap; }
}

class RefusedError extends Error {
  constructor(reasons) { super(`Refused: ${reasons.join(' ')}`); this.code = 'REFUSED'; this.reasons = reasons; }
}

const invalid = (msg) => Object.assign(new Error(msg), { code: 'INVALID_ACTION' });
const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Rows that count against today's cap: finished ones, plus reservations that haven't expired yet.
const countsNow = (now = new Date()) => ({ OR: [{ status: 'done' }, { status: 'reserved', expiresAt: { gt: now } }] });

async function expireReservations(userId, db = prisma) {
  await db.socialAction.updateMany({ where: { userId, status: 'reserved', expiresAt: { lte: new Date() } }, data: { status: 'skipped', summary: 'reservation expired without confirmation' } });
}

async function getBudget(userId, { date } = {}) {
  await expireReservations(userId);
  const { start, end } = dayBounds(date || toDateString());
  const rows = await prisma.socialAction.groupBy({
    by: ['platform', 'kind'],
    where: { userId, createdAt: { gte: start, lt: end }, ...countsNow() },
    _count: { _all: true },
  });
  const used = {};
  for (const r of rows) (used[r.platform] ||= {})[r.kind] = r._count._all;
  const budget = {};
  for (const platform of PLATFORMS) {
    budget[platform] = {};
    for (const [kind, cap] of Object.entries(DAILY_CAPS)) {
      const u = used[platform]?.[kind] || 0;
      const target = Math.min(cap, SOCIAL_TARGETS[platform]?.[kind] || 0);
      budget[platform][kind] = { used: u, cap, remaining: Math.max(0, cap - u), target, toTarget: Math.max(0, target - u) };
    }
  }
  return { date: date || toDateString(), caps: DAILY_CAPS, targets: SOCIAL_TARGETS, budget };
}

/**
 * The pure rulebook. `ctx` is everything the database knows that matters:
 *   used          rows already counted today for this platform + kind
 *   group         the SocialGroup row (or null)
 *   groupTexts    texts already posted/reserved in that group
 *   priorOnTarget the earlier done/reserved action of the same kind on the same target (or null)
 *   now           Date
 * Returns the list of reasons to refuse; empty means go ahead.
 */
function checkReservation(a, ctx = {}) {
  const reasons = [];
  const now = ctx.now || new Date();
  if (!PLATFORMS.includes(a.platform)) return [`platform must be one of ${PLATFORMS.join(', ')}`];
  if (!a.kind || (!DAILY_CAPS[a.kind] && !UNCAPPED.has(a.kind))) return [`unknown kind "${a.kind}"`];
  const text = String(a.text || '').trim();

  if (NEEDS_TEXT.has(a.kind) && !text) reasons.push(`"${a.kind}" needs the exact text you will post.`);
  if (NEEDS_TARGET.has(a.kind) && !a.target) reasons.push(`"${a.kind}" needs a target link so it can be checked and never repeated.`);

  if ((a.kind === 'comment' || a.kind === 'reply') && isCompetitorTarget(a.target)) reasons.push("Never comment on a competitor's posts (Facebook or Instagram). Read only.");

  if (text) {
    // two linters, both must pass: the content pipeline's brand rules and the stricter outreach gate ported from HQ qa.py
    const lint = lintContent({ caption: text, platform: 'group_no_phone' });
    const outreach = lintOutreach(text, lintKindFor(a.kind, a.platform));
    reasons.push(...new Set([...lint.errors, ...outreach.errors]));
    const promo = a.kind === 'group_post' || a.kind === 'page_post' || (a.kind === 'comment' && a.promo === true);
    if (promo && !text.includes(PHONE)) reasons.push(`Promo text must include ${PHONE}.`);
    if (a.kind === 'comment' && a.promo !== true && /\d{3}[-. ]\d{3}[-. ]\d{4}/.test(text)) reasons.push('Casual engagement comments must not include a phone number (set promo: true for lead comments).');
  }

  if (a.platform === 'instagram') {
    if (a.kind === 'page_post' && a.format !== 'reel') reasons.push('Instagram feed posts are reels only (format: "reel").');
    if (a.kind === 'group_join' || a.kind === 'group_post') reasons.push('Groups are Facebook only.');
  }

  if (DAILY_CAPS[a.kind] && ctx.used >= DAILY_CAPS[a.kind]) return Object.assign([`Daily cap reached: ${DAILY_CAPS[a.kind]} ${a.kind} per day on ${a.platform}`], { cap: true });

  if (ONCE_PER_TARGET.has(a.kind) && ctx.priorOnTarget) {
    const age = now - new Date(ctx.priorOnTarget.createdAt);
    const okFollowUp = a.followUp === true && age >= REPLY_FOLLOWUP_MS && a.kind !== 'like' && a.kind !== 'follow';
    if (!okFollowUp) reasons.push(`Already did a ${a.kind} on this target${a.followUp ? ' (a follow-up needs the first one to be 2+ days old)' : ''}.`);
  }

  if (a.kind === 'group_post') {
    const g = ctx.group;
    if (!a.groupId || !g) reasons.push('group_post needs a known groupId.');
    else {
      if (g.membership !== 'member') reasons.push(`Not a member of "${g.name}" (membership: ${g.membership}).`);
      if (g.promoPolicy === 'banned' || g.promoPolicy === 'restricted') reasons.push(`"${g.name}" does not allow promo posts (${g.promoPolicy}).`);
      if (g.lastPostedAt && now - new Date(g.lastPostedAt) < g.cooldownDays * 86400000) reasons.push(`"${g.name}" is in its ${g.cooldownDays} day cooldown.`);
      if (text && (ctx.groupTexts || []).some((t) => norm(t) === norm(text))) reasons.push(`This exact text was already posted in "${g.name}". Rewrite it.`);
    }
  }
  return reasons;
}

/** Ask permission for one action. Returns the reserved row (its id goes to confirmAction) or throws CapError / RefusedError. */
async function reserveAction(userId, a, { db = prisma } = {}) {
  const platform = PLATFORMS.includes(a.platform) ? a.platform : null;
  if (!platform) throw invalid(`platform must be one of ${PLATFORMS.join(', ')}`);
  if (!a.kind || (!DAILY_CAPS[a.kind] && !UNCAPPED.has(a.kind))) throw invalid(`unknown kind "${a.kind}"`);
  const { start, end } = dayBounds();
  const now = new Date();

  return db.$transaction(async (tx) => {
    // one reserve at a time per user+platform+kind, so two parallel calls can't both slip under the cap
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`social:${userId}:${platform}:${a.kind}`}))`;
    await expireReservations(userId, tx);
    const ctx = { now };
    if (DAILY_CAPS[a.kind]) ctx.used = await tx.socialAction.count({ where: { userId, platform, kind: a.kind, createdAt: { gte: start, lt: end }, ...countsNow(now) } });
    if (a.groupId) {
      ctx.group = await tx.socialGroup.findFirst({ where: { id: a.groupId, userId } });
      if (a.kind === 'group_post') {
        const rows = await tx.socialAction.findMany({ where: { userId, groupId: a.groupId, kind: 'group_post', ...countsNow(now) }, select: { text: true }, take: 200 });
        ctx.groupTexts = rows.map((r) => r.text).filter(Boolean);
      }
    }
    if (ONCE_PER_TARGET.has(a.kind) && a.target) {
      ctx.priorOnTarget = await tx.socialAction.findFirst({ where: { userId, platform, kind: a.kind, target: String(a.target).slice(0, 200), ...countsNow(now) }, orderBy: { createdAt: 'desc' } });
    }
    const reasons = checkReservation({ ...a, platform }, ctx);
    if (reasons.length) {
      if (reasons.cap) throw new CapError(a.kind, platform, DAILY_CAPS[a.kind]);
      throw new RefusedError(reasons);
    }
    return tx.socialAction.create({
      data: {
        userId, platform, kind: a.kind, status: 'reserved', expiresAt: new Date(now.getTime() + RESERVE_MINUTES * 60000),
        target: (a.target || '').slice(0, 200) || null, groupId: a.groupId || null, contentItemId: a.contentItemId || null,
        text: String(a.text || '').slice(0, 4000) || null, summary: (a.summary || '').slice(0, 500), shiftId: a.shiftId || null,
      },
    });
  });
}

/** Close a reservation: done (with the link to what we posted) or failed (with why). */
async function confirmAction(userId, id, { status, url, summary } = {}, { db = prisma } = {}) {
  if (!['done', 'failed'].includes(status)) throw invalid('status must be "done" or "failed"');
  if (status === 'done' && !url) throw invalid('a done action needs url: the link to the comment, post or group you acted on');
  const row = await db.socialAction.findFirst({ where: { id, userId } });
  if (!row) throw Object.assign(new Error('No such action'), { code: 'NOT_FOUND' });
  if (row.status !== 'reserved') throw Object.assign(new Error(`Action is already ${row.status}`), { code: 'ALREADY_CLOSED' });
  const out = await db.socialAction.update({ where: { id }, data: { status, url: url ? String(url).slice(0, 500) : row.url, summary: (summary || row.summary || '').slice(0, 500) } });
  if (out.kind === 'group_post' && out.groupId && status === 'done') {
    await db.socialGroup.updateMany({ where: { id: out.groupId, userId }, data: { lastPostedAt: new Date(), postsCount: { increment: 1 } } });
  }
  return out;
}

/** Direct logging of an action already taken (replies, or older callers). New work should reserve first. */
async function recordAction(userId, a) {
  const platform = PLATFORMS.includes(a.platform) ? a.platform : null;
  if (!platform) throw invalid(`platform must be one of ${PLATFORMS.join(', ')}`);
  if (!a.kind || (!DAILY_CAPS[a.kind] && !UNCAPPED.has(a.kind))) throw invalid(`unknown kind "${a.kind}"`);
  const status = ['done', 'failed', 'skipped'].includes(a.status) ? a.status : 'done';

  const data = { userId, platform, kind: a.kind, status, target: (a.target || '').slice(0, 200) || null, groupId: a.groupId || null, contentItemId: a.contentItemId || null, summary: (a.summary || '').slice(0, 500), url: (a.url || '').slice(0, 500) || null, text: (a.text || '').slice(0, 4000) || null, shiftId: a.shiftId || null };
  let row;
  if (status === 'done' && DAILY_CAPS[a.kind]) {
    // count-then-insert under a transaction-scoped advisory lock so two parallel calls can't both slip under the cap
    const { start, end } = dayBounds();
    row = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`social:${userId}:${platform}:${a.kind}`}))`;
      const used = await tx.socialAction.count({ where: { userId, platform, kind: a.kind, createdAt: { gte: start, lt: end }, ...countsNow() } });
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

module.exports = { DAILY_CAPS, SOCIAL_TARGETS, getBudget, recordAction, reserveAction, confirmAction, checkReservation, isCompetitorTarget, nextGroups, CapError, RefusedError, PLATFORMS };
