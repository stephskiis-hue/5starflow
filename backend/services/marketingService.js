/**
 * SMS Marketing Service — bulletproof dispatch engine for bulk SMS campaigns.
 *
 * Reliability guarantees (design goals):
 *   1. Every send attempt is checkpointed to the DB (no in-memory counters).
 *   2. A mid-campaign Railway redeploy is safe — resumeAllPending() on boot
 *      picks up where we left off.
 *   3. Transient Twilio failures (429, 5xx, network) are auto-retried via cron
 *      with exponential backoff. Permanent failures (21211, 21610, etc.) are
 *      marked `failed` immediately — never retried until the user clicks
 *      "Retry failed" manually.
 *   4. `status='sent'` rows are NEVER resent — idempotent by construction.
 *   5. Every send attempt lands in AppLog with structured context.
 *
 * States (MarketingMessage.status):
 *   pending   — not yet attempted; dispatch loop will pick it up
 *   retrying  — transient failure, scheduled for retry at `nextRetryAt`
 *   sent      — successfully handed to Twilio (final)
 *   failed    — permanent failure or retry cap reached (final, unless user resets)
 *   skipped   — not eligible (no phone, smsAllowed=false, or opted out)
 *
 * Reuses:
 *   - getTwilioCreds() + toE164() + sendSmsSafely() from smsService.js
 *   - jobberGraphQL() from jobberClient.js
 *
 * Safety guards:
 *   - MAX_RECIPIENTS (500)         — rejects oversized audiences (enforced at route)
 *   - Circuit breaker (10 fails)   — pauses dispatch if 10 consecutive sends fail
 *   - Global timeout (10 min)      — dispatch loop hands off remaining to retry worker
 */

const twilio = require('twilio');
const prisma = require('../lib/prismaClient');
const logger = require('../lib/logger');
const { getTwilioCreds, toE164, sendSmsSafely } = require('./smsService');
const { jobberGraphQL } = require('./jobberClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Safety + retry constants
// ---------------------------------------------------------------------------
const MAX_RECIPIENTS            = 500;
const MAX_CONSECUTIVE_FAILURES  = 10;
const CAMPAIGN_TIMEOUT_MS       = 10 * 60 * 1000; // 10 minutes per dispatch pass
const DELAY_BETWEEN_MESSAGES    = 300;             // ms between sends
const MAX_ATTEMPTS              = 5;               // after this many transient failures, flip to 'failed'
// Exponential backoff schedule (milliseconds) — index = attempt number already made
const BACKOFF_SCHEDULE_MS       = [
  30 * 1000,        // after attempt 1 failed → wait 30s
  2  * 60 * 1000,   // after 2 → 2 min
  10 * 60 * 1000,   // after 3 → 10 min
  30 * 60 * 1000,   // after 4 → 30 min
  60 * 60 * 1000,   // after 5 → 1 hour  (only used if MAX_ATTEMPTS raised)
];
const RETRY_WORKER_INTERVAL_MS  = 60 * 1000;       // every 60s the worker picks up retrying rows

// Track in-flight campaign IDs so we don't double-dispatch the same campaign
// from both the HTTP handler and the retry worker / boot resume.
const inFlight = new Set();

// ---------------------------------------------------------------------------
// Jobber client fetch (unchanged from previous revision)
// ---------------------------------------------------------------------------
const GET_ALL_CLIENTS = `
  query GetAllClients($cursor: String) {
    clients(first: 50, after: $cursor) {
      nodes {
        id
        name
        firstName
        phones { number primary smsAllowed }
        tags(first: 10) { nodes { label } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchAllJobberClients(userId) {
  const allClients = [];
  let cursor  = null;
  let hasNext = true;
  const EST_PAGE_COST = 1100;

  while (hasNext) {
    const { data, extensions } = await jobberGraphQL(GET_ALL_CLIENTS, { cursor }, userId, { returnExtensions: true });
    const nodes    = data?.clients?.nodes    ?? [];
    const pageInfo = data?.clients?.pageInfo ?? {};
    allClients.push(...nodes);
    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor ?? null;

    if (hasNext) {
      const throttle = extensions?.cost?.throttleStatus;
      if (throttle) {
        const { currentlyAvailable, restoreRate, actualQueryCost } = throttle;
        const nextCost = actualQueryCost || EST_PAGE_COST;
        const safeThreshold = nextCost * 1.5;
        if (currentlyAvailable < safeThreshold) {
          const waitMs = Math.ceil((safeThreshold - currentlyAvailable) / restoreRate * 1000) + 250;
          await logger.info('jobber', 'Throttle buffer low — waiting', { currentlyAvailable, waitMs }, userId);
          await sleep(waitMs);
        } else {
          await sleep(500);
        }
      } else {
        await sleep(parseInt(process.env.JOBBER_PAGE_DELAY_MS, 10) || 1500);
      }
    }
  }

  return allClients.map((c) => {
    const primaryPhone = c.phones?.find((p) => p.primary) ?? c.phones?.[0] ?? null;
    return {
      id:         c.id,
      name:       c.name,
      firstName:  c.firstName || c.name?.split(' ')[0] || 'there',
      phone:      primaryPhone?.number   ?? null,
      smsAllowed: primaryPhone?.smsAllowed ?? false,
      tags:       (c.tags?.nodes || []).map((t) => t.label),
    };
  });
}

// ---------------------------------------------------------------------------
// Helper: compute next retry time from attempts-so-far
// ---------------------------------------------------------------------------
function computeNextRetryAt(attemptsSoFar) {
  const idx = Math.max(0, Math.min(attemptsSoFar - 1, BACKOFF_SCHEDULE_MS.length - 1));
  return new Date(Date.now() + BACKOFF_SCHEDULE_MS[idx]);
}

// ---------------------------------------------------------------------------
// Core: send one MarketingMessage row. Checkpoints status after every attempt.
// Always returns — never throws. Use this everywhere (initial dispatch + retry worker).
// ---------------------------------------------------------------------------
async function sendOneMessage({ msg, creds, twilioClient, statusCallbackUrl, isDryRun }) {
  // Re-read to prevent double-send race (another worker may have claimed this row).
  const fresh = await prisma.marketingMessage.findUnique({ where: { id: msg.id } });
  if (!fresh || (fresh.status !== 'pending' && fresh.status !== 'retrying')) {
    return { skipped: true, reason: `status=${fresh?.status}` };
  }
  if (!fresh.phone) {
    await prisma.marketingMessage.update({
      where: { id: msg.id },
      data: {
        status: 'failed',
        error:  'No phone number',
        lastAttemptAt: new Date(),
      },
    });
    return { ok: false, permanent: true };
  }

  // Resolve body (prefer stored body; fall back to campaign template for legacy rows)
  let body = fresh.body;
  if (!body) {
    const camp = await prisma.marketingCampaign.findUnique({ where: { id: fresh.campaignId } });
    body = (camp?.messageBody || '').replace(/\{firstName\}/gi, fresh.firstName || 'there');
    // Freeze it for future retries
    await prisma.marketingMessage.update({
      where: { id: msg.id },
      data:  { body },
    });
  }

  const attemptsSoFar = fresh.attempts + 1;
  const phone = toE164(fresh.phone);

  // DRY_RUN short-circuit
  if (isDryRun) {
    await prisma.marketingMessage.update({
      where: { id: msg.id },
      data: {
        status:        'sent',
        sentAt:        new Date(),
        messageSid:    'dry-run',
        attempts:      attemptsSoFar,
        lastAttemptAt: new Date(),
        nextRetryAt:   null,
        error:         null,
      },
    });
    await logger.info('sms', 'DRY_RUN send recorded', {
      campaignId: fresh.campaignId, phone, attempts: attemptsSoFar,
    }, fresh.userId);
    return { ok: true, sid: 'dry-run' };
  }

  // Real send — use hardened helper
  const result = await sendSmsSafely({
    to:            phone,
    from:          creds.fromNumber,
    body,
    client:        twilioClient,
    userId:        fresh.userId,
    statusCallback: statusCallbackUrl,
  });

  if (result.ok) {
    await prisma.marketingMessage.update({
      where: { id: msg.id },
      data: {
        status:        'sent',
        messageSid:    result.sid,
        sentAt:        new Date(),
        attempts:      attemptsSoFar,
        lastAttemptAt: new Date(),
        nextRetryAt:   null,
        error:         null,
      },
    });
    await logger.info('campaign', 'Message sent', {
      campaignId: fresh.campaignId, phone, sid: result.sid, attempts: attemptsSoFar,
    }, fresh.userId);
    return { ok: true, sid: result.sid };
  }

  // Failure path
  const permanent = !!result.permanent;
  const retryCapReached = attemptsSoFar >= MAX_ATTEMPTS;
  const shouldRetry = !permanent && !retryCapReached;

  const errorText = `[${result.errorCode}] ${result.errorMessage || 'Unknown error'}`.slice(0, 500);

  await prisma.marketingMessage.update({
    where: { id: msg.id },
    data: {
      status:        shouldRetry ? 'retrying' : 'failed',
      attempts:      attemptsSoFar,
      lastAttemptAt: new Date(),
      nextRetryAt:   shouldRetry ? computeNextRetryAt(attemptsSoFar) : null,
      error:         errorText,
    },
  });

  await logger.warn('campaign', shouldRetry ? 'Message scheduled for retry' : 'Message marked failed', {
    campaignId: fresh.campaignId,
    phone,
    attempts: attemptsSoFar,
    errorCode: result.errorCode,
    errorMessage: result.errorMessage,
    permanent,
    retryCapReached,
  }, fresh.userId);

  return { ok: false, permanent, shouldRetry };
}

// ---------------------------------------------------------------------------
// Dispatch a campaign — processes all `pending` rows once.
// Can be called multiple times safely (idempotent; won't double-send).
// ---------------------------------------------------------------------------
async function dispatchCampaign(campaignId, userId) {
  if (inFlight.has(campaignId)) {
    await logger.warn('campaign', 'Dispatch already in flight — skipping duplicate trigger', { campaignId }, userId);
    return;
  }
  inFlight.add(campaignId);

  const startTime = Date.now();
  let consecutiveFailures = 0;

  try {
    const campaign = await prisma.marketingCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      await logger.error('campaign', 'Campaign not found', { campaignId }, userId);
      return;
    }

    // Allow dispatch from: pending (first run) or sending (resume after crash)
    if (!['pending', 'sending'].includes(campaign.status)) {
      await logger.info('campaign', 'Skipping dispatch (terminal status)', { campaignId, status: campaign.status }, userId);
      return;
    }

    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data:  { status: 'sending', startedAt: campaign.startedAt || new Date() },
    });

    const creds = await getTwilioCreds(userId);
    if (!creds.accountSid || !creds.authToken) {
      await logger.error('campaign', 'Twilio creds missing — marking campaign failed', { campaignId }, userId);
      await prisma.marketingCampaign.update({
        where: { id: campaignId },
        data:  { status: 'failed', completedAt: new Date() },
      });
      return;
    }

    const twilioClient = twilio(creds.accountSid, creds.authToken);
    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/marketing/twilio-callback`
      : null;
    const isDryRun = process.env.DRY_RUN === 'true';

    await logger.info('campaign', 'Dispatch started', {
      campaignId, userId, dryRun: isDryRun,
    }, userId);

    // Process in small batches so that a long-running dispatch doesn't hold one huge in-memory list
    let abortReason = null;
    let processed = 0;

    while (true) {
      if (Date.now() - startTime > CAMPAIGN_TIMEOUT_MS) {
        abortReason = 'Dispatch loop timeout (10 min)';
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abortReason = `Circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`;
        break;
      }

      const batch = await prisma.marketingMessage.findMany({
        where:   { campaignId, status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take:    25,
      });
      if (batch.length === 0) break;

      for (const msg of batch) {
        const result = await sendOneMessage({
          msg, creds, twilioClient, statusCallbackUrl, isDryRun,
        });
        processed++;
        if (result.ok)                consecutiveFailures = 0;
        else if (!result.skipped)     consecutiveFailures++;

        await sleep(DELAY_BETWEEN_MESSAGES);

        if (Date.now() - startTime > CAMPAIGN_TIMEOUT_MS) break;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
    }

    await finalizeCampaignStatus(campaignId, userId, abortReason, processed);

  } catch (outerErr) {
    await logger.error('campaign', 'Dispatch crashed', {
      campaignId, message: outerErr.message, stack: outerErr.stack?.split('\n').slice(0, 5).join('\n'),
    }, userId);

    // Don't mark the campaign failed outright — leave rows in their current state so the
    // retry worker (or the next manual dispatch) can pick them up.
    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data:  { status: 'pending' },     // back to pending so retry worker sees it
    }).catch(() => {});
  } finally {
    inFlight.delete(campaignId);
  }
}

// ---------------------------------------------------------------------------
// Tally + mark campaign as complete/failed/pending based on row states.
// ---------------------------------------------------------------------------
async function finalizeCampaignStatus(campaignId, userId, abortReason, processedThisPass) {
  const groupedRows = await prisma.marketingMessage.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(groupedRows.map((r) => [r.status, r._count._all]));
  const sentCount    = counts.sent     || 0;
  const failedCount  = counts.failed   || 0;
  const skippedCount = counts.skipped  || 0;
  const pendingCount = counts.pending  || 0;
  const retryingCount = counts.retrying || 0;

  // Terminal if no pending AND no retrying rows remain
  const terminal = pendingCount === 0 && retryingCount === 0;

  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data: {
      status:       terminal ? (failedCount > 0 && sentCount === 0 ? 'failed' : 'complete') : 'sending',
      sentCount,
      failedCount,
      skippedCount,
      completedAt:  terminal ? new Date() : null,
    },
  });

  await logger.info('campaign', 'Dispatch pass finished', {
    campaignId,
    processedThisPass,
    sentCount,
    failedCount,
    skippedCount,
    pendingCount,
    retryingCount,
    abortReason,
    terminal,
  }, userId);
}

// ---------------------------------------------------------------------------
// Retry worker — runs every 60s. Picks up `retrying` rows whose nextRetryAt
// has passed and re-sends them. Safe to run alongside dispatchCampaign.
// ---------------------------------------------------------------------------
let retryTimer = null;

async function retryWorkerTick() {
  try {
    const now = new Date();
    const due = await prisma.marketingMessage.findMany({
      where: {
        status:      'retrying',
        nextRetryAt: { lte: now },
      },
      orderBy: { nextRetryAt: 'asc' },
      take:    50, // cap per tick
    });
    if (due.length === 0) return;

    // Group by userId so we reuse one Twilio client per user per tick
    const byUser = new Map();
    for (const row of due) {
      if (!row.userId) continue; // legacy row without userId — skip; manual retry only
      const arr = byUser.get(row.userId) || [];
      arr.push(row);
      byUser.set(row.userId, arr);
    }

    const isDryRun = process.env.DRY_RUN === 'true';
    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/marketing/twilio-callback`
      : null;

    for (const [userId, rows] of byUser.entries()) {
      const creds = await getTwilioCreds(userId);
      if (!creds.accountSid || !creds.authToken) {
        await logger.error('campaign', 'Retry worker: Twilio creds missing', { userId, rowCount: rows.length }, userId);
        continue;
      }
      const twilioClient = twilio(creds.accountSid, creds.authToken);

      for (const msg of rows) {
        await sendOneMessage({
          msg, creds, twilioClient, statusCallbackUrl, isDryRun,
        });
        await sleep(DELAY_BETWEEN_MESSAGES);
      }
    }

    // Finalize any campaigns whose last pending/retrying row just resolved
    const affectedCampaignIds = [...new Set(due.map((r) => r.campaignId))];
    for (const cid of affectedCampaignIds) {
      const camp = await prisma.marketingCampaign.findUnique({ where: { id: cid } });
      if (camp) await finalizeCampaignStatus(cid, camp.userId, null, 0);
    }
  } catch (err) {
    await logger.error('campaign', 'Retry worker tick crashed', { message: err.message });
  }
}

function startRetryWorker() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    retryWorkerTick().catch((err) => console.error('[retryWorker] unhandled:', err.message));
  }, RETRY_WORKER_INTERVAL_MS);
  // Also run once at startup
  setTimeout(() => retryWorkerTick().catch(() => {}), 10_000);
  console.log(`[marketing] Retry worker started (tick every ${RETRY_WORKER_INTERVAL_MS / 1000}s)`);
}

// ---------------------------------------------------------------------------
// Resume-on-startup: find any campaigns that were mid-flight when the server
// died (status=sending or any campaigns with pending rows) and kick them again.
// ---------------------------------------------------------------------------
async function resumeAllPending() {
  try {
    const campaigns = await prisma.marketingCampaign.findMany({
      where: {
        OR: [
          { status: 'sending' },
          { status: 'pending', messages: { some: { status: { in: ['pending', 'retrying'] } } } },
        ],
      },
      select: { id: true, userId: true, status: true },
    });
    if (campaigns.length === 0) {
      console.log('[marketing] Resume: no mid-flight campaigns found');
      return;
    }
    await logger.info('campaign', 'Resuming mid-flight campaigns after boot', {
      count: campaigns.length,
      campaigns: campaigns.map((c) => ({ id: c.id, status: c.status })),
    });
    for (const c of campaigns) {
      // Fire-and-forget
      dispatchCampaign(c.id, c.userId).catch(() => {});
    }
  } catch (err) {
    await logger.error('campaign', 'Resume on boot failed', { message: err.message });
  }
}

// ---------------------------------------------------------------------------
// Manual "Retry failed" helper — reset all failed rows in a campaign to retrying now.
// Called by POST /api/marketing/campaigns/:id/retry-failed.
// ---------------------------------------------------------------------------
async function resetFailedForRetry(campaignId, userId) {
  const result = await prisma.marketingMessage.updateMany({
    where: { campaignId, status: 'failed' },
    data: {
      status:      'retrying',
      attempts:    0,
      nextRetryAt: new Date(),
      error:       null,
    },
  });
  await prisma.marketingCampaign.update({
    where: { id: campaignId },
    data:  { status: 'sending', completedAt: null },
  }).catch(() => {});
  await logger.info('campaign', 'Retry failed — reset failed rows', {
    campaignId, rowsReset: result.count,
  }, userId);
  return result.count;
}

module.exports = {
  fetchAllJobberClients,
  dispatchCampaign,
  resumeAllPending,
  startRetryWorker,
  resetFailedForRetry,
  MAX_RECIPIENTS,
};
