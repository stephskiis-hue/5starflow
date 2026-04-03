/**
 * SMS Marketing Service — dispatch engine for bulk SMS campaigns.
 *
 * Reuses:
 *   - getTwilioCreds() + toE164() from smsService.js
 *   - jobberGraphQL() from jobberClient.js
 *   - Serial for-loop + sleep(300) pattern from weatherService.js batchNotify()
 *
 * Safety guards:
 *   - MAX_RECIPIENTS (500)         — rejects oversized audiences
 *   - Circuit breaker (10 fails)   — aborts on consecutive Twilio failures
 *   - Global timeout (10 min)      — aborts if dispatch takes too long
 *   - Duplicate send prevention    — re-reads each message before sending
 *   - Campaign lock                — won't dispatch if already sending/complete
 */

const twilio = require('twilio');
const prisma = require('../lib/prismaClient');
const { getTwilioCreds, toE164 } = require('./smsService');
const { jobberGraphQL } = require('./jobberClient');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Safety constants
// ---------------------------------------------------------------------------
const MAX_RECIPIENTS           = 500;
const MAX_CONSECUTIVE_FAILURES = 10;
const CAMPAIGN_TIMEOUT_MS      = 10 * 60 * 1000; // 10 minutes
const DELAY_BETWEEN_MESSAGES   = 300;             // ms

// ---------------------------------------------------------------------------
// Jobber client fetch (same paginated query as weatherService.fetchAllClients)
// ---------------------------------------------------------------------------
const GET_ALL_CLIENTS = `
  query GetAllClients($cursor: String) {
    clients(after: $cursor) {
      nodes {
        id
        name
        firstName
        emails { address primary }
        phones { number primary smsAllowed }
        tags { nodes { label } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchAllJobberClients(userId) {
  const allClients = [];
  let cursor  = null;
  let hasNext = true;

  while (hasNext) {
    const data     = await jobberGraphQL(GET_ALL_CLIENTS, { cursor }, userId);
    const nodes    = data?.clients?.nodes    ?? [];
    const pageInfo = data?.clients?.pageInfo ?? {};
    allClients.push(...nodes);
    hasNext = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor ?? null;
    if (hasNext) await sleep(500);
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
// Campaign dispatch — the core loop
// ---------------------------------------------------------------------------

/**
 * Dispatch all pending messages for a campaign.
 * Called asynchronously from the route handler (fire-and-forget).
 *
 * @param {string} campaignId
 * @param {string} userId
 */
async function dispatchCampaign(campaignId, userId) {
  const startTime = Date.now();
  let consecutiveFailures = 0;
  let sentCount   = 0;
  let failedCount = 0;

  try {
    // -----------------------------------------------------------------------
    // 1. Load & lock campaign
    // -----------------------------------------------------------------------
    const campaign = await prisma.marketingCampaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      console.error(`[marketing] Campaign ${campaignId} not found`);
      return;
    }

    // Lock check — prevent duplicate dispatch
    if (campaign.status !== 'pending') {
      console.warn(`[marketing] Campaign ${campaignId} status is "${campaign.status}", skipping dispatch`);
      return;
    }

    // -----------------------------------------------------------------------
    // 2. Mark as sending
    // -----------------------------------------------------------------------
    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data:  { status: 'sending', startedAt: new Date() },
    });

    // -----------------------------------------------------------------------
    // 3. Load all pending messages
    // -----------------------------------------------------------------------
    const messages = await prisma.marketingMessage.findMany({
      where: { campaignId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    });

    if (messages.length === 0) {
      console.log(`[marketing] Campaign ${campaignId}: no pending messages (all skipped)`);
      await prisma.marketingCampaign.update({
        where: { id: campaignId },
        data:  { status: 'complete', completedAt: new Date() },
      });
      return;
    }

    // -----------------------------------------------------------------------
    // 4. Get Twilio credentials once
    // -----------------------------------------------------------------------
    const creds = await getTwilioCreds(userId);
    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured — cannot send campaign');
    }

    const twilioClient = twilio(creds.accountSid, creds.authToken);
    const statusCallbackUrl = process.env.APP_URL
      ? `${process.env.APP_URL}/api/marketing/twilio-callback`
      : null;

    // -----------------------------------------------------------------------
    // 5. Serial dispatch loop
    // -----------------------------------------------------------------------
    let abortReason = null;

    for (const msg of messages) {
      // --- Timeout check ---
      if (Date.now() - startTime > CAMPAIGN_TIMEOUT_MS) {
        abortReason = 'Campaign timeout (10 min limit reached)';
        console.error(`[marketing] ${abortReason} — aborting campaign ${campaignId}`);
        break;
      }

      // --- Circuit breaker ---
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abortReason = `Circuit breaker: ${MAX_CONSECUTIVE_FAILURES} consecutive failures`;
        console.error(`[marketing] ${abortReason} — aborting campaign ${campaignId}`);
        break;
      }

      // --- Duplicate send prevention: re-read from DB ---
      const fresh = await prisma.marketingMessage.findUnique({ where: { id: msg.id } });
      if (!fresh || fresh.status !== 'pending') {
        continue; // already handled by another process or marked skipped
      }

      // --- Build message body ---
      const body = campaign.messageBody
        .replace(/\{firstName\}/g, fresh.firstName || 'there');

      // --- DRY_RUN ---
      if (process.env.DRY_RUN === 'true') {
        console.log(`[marketing] DRY RUN — would send to ${fresh.phone}: "${body.slice(0, 80)}..."`);
        await prisma.marketingMessage.update({
          where: { id: msg.id },
          data:  { status: 'sent', sentAt: new Date(), messageSid: 'dry-run' },
        });
        sentCount++;
        consecutiveFailures = 0;
        await sleep(DELAY_BETWEEN_MESSAGES);
        continue;
      }

      // --- Send via Twilio ---
      try {
        const phone = toE164(fresh.phone);
        const params = {
          body,
          from: creds.fromNumber,
          to:   phone,
        };
        if (statusCallbackUrl) {
          params.statusCallback = statusCallbackUrl;
        }

        const result = await twilioClient.messages.create(params);

        await prisma.marketingMessage.update({
          where: { id: msg.id },
          data:  { status: 'sent', messageSid: result.sid, sentAt: new Date() },
        });

        sentCount++;
        consecutiveFailures = 0;
        console.log(`[marketing] SMS sent to ${phone} | SID: ${result.sid}`);
      } catch (err) {
        consecutiveFailures++;
        failedCount++;

        await prisma.marketingMessage.update({
          where: { id: msg.id },
          data:  { status: 'failed', error: err.message?.slice(0, 500) || 'Unknown error' },
        });

        console.error(`[marketing] SMS failed for ${fresh.clientName} (${fresh.phone}): ${err.message}`);
      }

      await sleep(DELAY_BETWEEN_MESSAGES);
    }

    // -----------------------------------------------------------------------
    // 6. Mark remaining messages if loop aborted early
    // -----------------------------------------------------------------------
    if (abortReason) {
      const remaining = await prisma.marketingMessage.updateMany({
        where: { campaignId, status: 'pending' },
        data:  { status: 'failed', error: abortReason },
      });
      failedCount += remaining.count;
    }

    // -----------------------------------------------------------------------
    // 7. Finalize campaign
    // -----------------------------------------------------------------------
    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: {
        status:      abortReason ? 'failed' : 'complete',
        sentCount,
        failedCount,
        completedAt: new Date(),
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[marketing] Campaign ${campaignId} finished in ${elapsed}s — sent: ${sentCount}, failed: ${failedCount}`);

  } catch (outerErr) {
    // -----------------------------------------------------------------------
    // Catch-all: any unexpected crash marks campaign failed
    // -----------------------------------------------------------------------
    console.error(`[marketing] Campaign ${campaignId} crashed:`, outerErr.message);

    await prisma.marketingCampaign.update({
      where: { id: campaignId },
      data: {
        status:      'failed',
        sentCount,
        failedCount,
        completedAt: new Date(),
      },
    }).catch((dbErr) => {
      console.error(`[marketing] Failed to update campaign status after crash:`, dbErr.message);
    });

    // Mark any remaining pending messages as failed
    await prisma.marketingMessage.updateMany({
      where: { campaignId, status: 'pending' },
      data:  { status: 'failed', error: `Campaign crashed: ${outerErr.message?.slice(0, 200)}` },
    }).catch(() => {});
  }
}

module.exports = {
  fetchAllJobberClients,
  dispatchCampaign,
  MAX_RECIPIENTS,
};
