/**
 * Jobber Client Sync Service
 *
 * Background scheduler that proactively mirrors all Jobber clients into the
 * local CachedJobberClient table. The audience builder reads from this table
 * instead of calling the Jobber API live — eliminating throttling and the
 * userId-mismatch problem at import time.
 *
 * Pattern: identical to tokenManager.js (iterate all accounts) +
 *          invoicePoller.js (throttle guard + cron schedule).
 *
 * Schedule: every 60 minutes (0 * * * *)
 * Startup:  first sync runs 30 seconds after server boot
 */

const cron  = require('node-cron');
const prisma = require('../lib/prismaClient');
const { fetchAllJobberClients } = require('./marketingService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Module-level throttle guard — set when Jobber returns 429
let syncThrottledUntil = 0;

// Module-level sync state — polled by GET /api/marketing/sync-status
let syncState = { status: 'idle', startedAt: null, completedAt: null, synced: 0, error: null };

function getSyncStatus() { return { ...syncState }; }

// ---------------------------------------------------------------------------
// Sync one account's clients into CachedJobberClient
// ---------------------------------------------------------------------------
async function syncAccountClients(account) {
  const userId = account.userId;

  if (!userId) {
    console.warn(
      `[jobberClientSync] Skipping account ${account.id} — userId is null. ` +
      `Re-connect Jobber OAuth while logged in as a portal user to fix this.`
    );
    return { synced: 0, skipped: true };
  }

  console.log(`[jobberClientSync] Syncing clients for userId=${userId}...`);

  const clients = await fetchAllJobberClients(userId);

  // Full replace: delete stale rows then bulk-insert fresh data.
  // This ensures clients removed from Jobber disappear from the cache.
  await prisma.cachedJobberClient.deleteMany({ where: { userId } });

  if (clients.length > 0) {
    await prisma.cachedJobberClient.createMany({
      data: clients.map((c) => ({
        userId,
        jobberClientId: c.id,
        name:           c.name,
        firstName:      c.firstName,
        phone:          c.phone   || null,
        smsAllowed:     Boolean(c.smsAllowed),
        tags:           JSON.stringify(c.tags || []),
        syncedAt:       new Date(),
      })),
    });
  }

  console.log(`[jobberClientSync] Synced ${clients.length} clients for userId=${userId}`);
  return { synced: clients.length };
}

// ---------------------------------------------------------------------------
// Sync all connected Jobber accounts
// ---------------------------------------------------------------------------
async function syncAllAccounts() {
  if (Date.now() < syncThrottledUntil) {
    const remainingSeconds = Math.ceil((syncThrottledUntil - Date.now()) / 1000);
    console.log(
      `[jobberClientSync] Throttle cooldown active — skipping (${remainingSeconds}s remaining)`
    );
    syncState = { ...syncState, status: 'error', error: `Throttle cooldown — ${remainingSeconds}s remaining` };
    return;
  }

  const accounts = await prisma.jobberAccount.findMany();

  if (accounts.length === 0) {
    console.log('[jobberClientSync] No Jobber accounts connected — skipping sync');
    syncState = { status: 'idle', startedAt: null, completedAt: null, synced: 0, error: null };
    return;
  }

  syncState = { status: 'running', startedAt: new Date(), completedAt: null, synced: 0, error: null };

  let totalSynced = 0;
  let totalFailed = 0;

  for (const account of accounts) {
    try {
      const result = await syncAccountClients(account);
      if (!result.skipped) {
        totalSynced += result.synced;
        await sleep(3000); // breathing room between accounts to avoid burst
      }
    } catch (err) {
      const isThrottled = /429|throttl/i.test(err.message);
      if (isThrottled) {
        syncThrottledUntil = Date.now() + 600_000; // 10-minute cooldown
        console.warn(
          `[jobberClientSync] Jobber throttled — backing off 600s. ` +
          `Stopped after account ${account.id} (userId=${account.userId}).`
        );
        syncState = { ...syncState, status: 'error', completedAt: new Date(), synced: totalSynced, error: 'Jobber rate-limited — will retry in 10 minutes' };
        return;
      }
      totalFailed++;
      console.error(
        `[jobberClientSync] Sync failed for account ${account.id} (userId=${account.userId}):`,
        err.message
      );
    }
  }

  console.log(
    `[jobberClientSync] Sync complete — synced: ${totalSynced} clients, failed accounts: ${totalFailed}`
  );
  syncState = { status: 'done', startedAt: syncState.startedAt, completedAt: new Date(), synced: totalSynced, error: totalFailed > 0 ? `${totalFailed} account(s) failed` : null };
}

// ---------------------------------------------------------------------------
// Start the scheduler
// ---------------------------------------------------------------------------
function startJobberClientSyncScheduler() {
  // Every 4 hours at :15 past the hour — clients change infrequently,
  // and the :15 offset avoids overlap with invoicePoller which runs at :00.
  console.log('[jobberClientSync] Scheduler started (every 4 hours at :15)');

  cron.schedule('15 */4 * * *', () => {
    syncAllAccounts().catch((err) =>
      console.error('[jobberClientSync] Cron error:', err.message)
    );
  });

  // Startup sync — 3-minute delay lets invoicePoller (30s) and token manager
  // finish their startup bursts before we hit the Jobber API.
  setTimeout(() => {
    syncAllAccounts().catch((err) =>
      console.error('[jobberClientSync] Startup sync error:', err.message)
    );
  }, 180_000);
}

module.exports = { startJobberClientSyncScheduler, syncAllAccounts, getSyncStatus };
