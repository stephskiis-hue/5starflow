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
    return;
  }

  const accounts = await prisma.jobberAccount.findMany();

  if (accounts.length === 0) {
    console.log('[jobberClientSync] No Jobber accounts connected — skipping sync');
    return;
  }

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
          `[jobberClientSync] Jobber throttled — backing off 120s. ` +
          `Stopped after account ${account.id} (userId=${account.userId}).`
        );
        break; // stop iterating accounts; resume on next scheduled run
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
}

// ---------------------------------------------------------------------------
// Start the scheduler
// ---------------------------------------------------------------------------
function startJobberClientSyncScheduler() {
  console.log('[jobberClientSync] Scheduler started (every 60 min)');

  // Hourly cron
  cron.schedule('0 * * * *', () => {
    syncAllAccounts().catch((err) =>
      console.error('[jobberClientSync] Cron error:', err.message)
    );
  });

  // Startup sync — 90s delay lets token refresh scheduler run first
  // (avoids API burst on cold boot where multiple services start simultaneously)
  setTimeout(() => {
    syncAllAccounts().catch((err) =>
      console.error('[jobberClientSync] Startup sync error:', err.message)
    );
  }, 90_000);
}

module.exports = { startJobberClientSyncScheduler, syncAllAccounts };
