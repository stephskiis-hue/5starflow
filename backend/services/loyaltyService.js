const crypto = require('crypto');
const twilio = require('twilio');
const prisma  = require('../lib/prismaClient');
const { getTwilioCreds, toE164 } = require('./smsService');

const REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL || 'http://localhost:3001/r';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * "John Doe" → "John D."
 * "Mary" → "Mary"
 */
function buildDisplayName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  const first = parts[0] || 'Client';
  if (parts.length < 2) return first;
  return `${first} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

/**
 * "John Doe" → "jd-a8f3"
 */
function generateSlug(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  const f = (parts[0] || 'x').charAt(0).toLowerCase();
  const l = (parts[parts.length - 1] || 'x').charAt(0).toLowerCase();
  return `${f}${l}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Return a status tier label based on rank and total active clients.
 * Rank 1: "Top Fan"
 * Top 10% (min 10 clients): "Top 10% Fan"
 * Top 25% (min 4 clients): "Rising Star"
 * Otherwise: "Loyal Client"
 */
function getStatusTier(rank, total) {
  if (rank === 1) return 'Top Fan';
  if (total >= 10 && rank <= Math.ceil(total * 0.10)) return 'Top 10% Fan';
  if (total >= 4  && rank <= Math.ceil(total * 0.25)) return 'Rising Star';
  return 'Loyal Client';
}

// ---------------------------------------------------------------------------
// Main entry point — called by reviewRequester.js after a paid invoice
// ---------------------------------------------------------------------------

/**
 * Award points to a client for a paid invoice, then send a "close the loop" SMS.
 *
 * Rules:
 *   - First time a client appears: create LoyaltyClient row with 0 pts, then award.
 *   - hasPendingMultiplier=true → award 20 pts and clear the flag.
 *   - Otherwise → award 10 pts.
 *   - Opted-out clients are skipped entirely.
 *
 * @param {string} jobberClientId - Jobber encoded client ID
 * @param {string} clientName     - Full name from Jobber (e.g. "John Doe")
 * @param {string|null} phone     - Raw phone number from Jobber (any format)
 * @param {string|null} userId    - Portal user ID who owns this record
 */
async function awardPoints(jobberClientId, clientName, phone, userId) {
  const safeUserId = userId || '';

  // Generate a unique slug, retrying on collision (extremely unlikely but safe)
  let slug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateSlug(clientName);
    const collision = await prisma.loyaltyClient.findUnique({ where: { referralSlug: candidate } });
    if (!collision) { slug = candidate; break; }
  }
  if (!slug) slug = generateSlug(clientName + Date.now()); // guaranteed-unique fallback

  // Upsert: create on first invoice, leave existing record untouched on subsequent ones
  let record = await prisma.loyaltyClient.upsert({
    where:  { userId_jobberClientId: { userId: safeUserId, jobberClientId } },
    create: {
      userId:               safeUserId,
      jobberClientId,
      displayName:          buildDisplayName(clientName),
      totalPoints:          0,
      referralSlug:         slug,
      hasPendingMultiplier: false,
      optedOut:             false,
    },
    update: {}, // don't overwrite displayName or slug on repeat invoices
  });

  if (record.optedOut) {
    console.log(`[loyaltyService] SKIP: ${record.displayName} opted out — no points awarded`);
    return;
  }

  const pointsToAward = record.hasPendingMultiplier ? 20 : 10;

  record = await prisma.loyaltyClient.update({
    where: { id: record.id },
    data: {
      totalPoints:          { increment: pointsToAward },
      hasPendingMultiplier: false,
    },
  });

  // Compute rank: count clients with MORE points than this client (after update)
  const rank = await prisma.loyaltyClient.count({
    where: {
      userId:      safeUserId,
      optedOut:    false,
      totalPoints: { gt: record.totalPoints },
    },
  }) + 1;

  console.log(
    `[loyaltyService] +${pointsToAward} pts → ${record.displayName} | ` +
    `total: ${record.totalPoints} | rank: #${rank}`
  );

  // Send "close the loop" SMS
  if (!phone) {
    console.log(`[loyaltyService] No phone for ${record.displayName} — skipping loyalty SMS`);
    return;
  }

  const referralUrl = `${REFERRAL_BASE_URL}/${record.referralSlug}`;
  const msg =
    `Invoice paid. You just earned ${pointsToAward} pts. ` +
    `You're #${rank} on our leaderboard. ` +
    `Share your link to 2x your next job: ${referralUrl}`;

  if (process.env.DRY_RUN === 'true') {
    console.log(`[loyaltyService] DRY RUN — would SMS ${phone}: "${msg}"`);
    return;
  }

  try {
    const creds = await getTwilioCreds(userId);
    if (!creds.accountSid || !creds.authToken) {
      console.warn('[loyaltyService] Twilio creds not configured — skipping loyalty SMS');
      return;
    }
    const client = twilio(creds.accountSid, creds.authToken);
    const to = toE164(phone);
    const message = await client.messages.create({ body: msg, from: creds.fromNumber, to });
    console.log(`[loyaltyService] Loyalty SMS sent to ${to} | SID: ${message.sid}`);
  } catch (err) {
    console.error(`[loyaltyService] Failed to send loyalty SMS to ${record.displayName}:`, err.message);
  }
}

module.exports = { awardPoints, getStatusTier, buildDisplayName };
