const cron = require('node-cron');
const { jobberGraphQL } = require('./jobberClient');
const { handleInvoicePaid } = require('./reviewRequester');
const prisma = require('../lib/prismaClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Module-scope throttle guard
// When Jobber rate-limits us, set throttledUntil to a future timestamp.
// Every poll run checks this before doing any GraphQL calls.
// ---------------------------------------------------------------------------
let throttledUntil = 0;

// ---------------------------------------------------------------------------
// GraphQL query — fetches all invoices (paginated), filtered client-side by
// updatedAt. No server-side filter to avoid schema-version sensitivity.
// ---------------------------------------------------------------------------
const POLL_INVOICES = `
  query PollInvoices($cursor: String) {
    invoices(after: $cursor) {
      nodes {
        id
        invoiceNumber
        updatedAt
        client {
          id
          name
          emails { address primary }
          phones { number primary smsAllowed }
          tags { nodes { label } }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Main poll function
// ---------------------------------------------------------------------------

/**
 * Poll Jobber for recently-paid invoices and enqueue any that haven't been
 * processed yet. Lightweight reliability backstop for missed webhooks.
 *
 * Look-back window: poll interval + 5 minutes (e.g. 125 min for the default
 * 120-min interval) — ensures no gap even if a cron fires slightly late.
 */
async function pollPaidInvoices() {
  // Skip if currently in a throttle cooldown period
  if (Date.now() < throttledUntil) {
    const remainingSeconds = Math.ceil((throttledUntil - Date.now()) / 1000);
    console.log(`[invoicePoller] Skipping poll — throttle cooldown active (${remainingSeconds}s remaining)`);
    return;
  }

  // Skip if no Jobber account is connected yet
  const account = await prisma.jobberAccount.findFirst();
  if (!account) {
    console.log('[invoicePoller] No Jobber account connected — skipping poll');
    return;
  }

  const intervalMinutes   = parseInt(process.env.POLL_INTERVAL_MINUTES, 10) || 120;
  const pollWindowMinutes = parseInt(process.env.POLL_WINDOW_MINUTES, 10) || (intervalMinutes + 5);
  const pageDelayMs = parseInt(process.env.PAGE_DELAY_MS, 10) || 1000;
  const windowStart = new Date(Date.now() - pollWindowMinutes * 60 * 1000);

  console.log(`[invoicePoller] Polling for paid invoices updated since ${windowStart.toISOString()}`);

  let cursor = null;
  let pagesFetched = 0;
  let totalFound = 0;
  let totalQueued = 0;

  do {
    let result;
    try {
      result = await jobberGraphQL(POLL_INVOICES, { cursor });
    } catch (err) {
      const message = err.message || '';
      const isThrottled = message.includes('Throttled') || message.includes('429') || message.includes('throttl');

      if (isThrottled) {
        const cooldownSeconds = parseInt(process.env.THROTTLE_COOLDOWN_SECONDS, 10) || 120;
        throttledUntil = Date.now() + cooldownSeconds * 1000;
        console.warn(
          `[invoicePoller] Jobber GraphQL throttled — backing off for ${cooldownSeconds}s. ` +
          `Next poll skipped until ${new Date(throttledUntil).toISOString()}`
        );
        break;
      }

      console.error('[invoicePoller] GraphQL poll error:', message);
      break;
    }

    const { nodes, pageInfo } = result?.invoices || {};
    if (!nodes?.length) break;

    for (const invoice of nodes) {
      // Client-side date filter — only process invoices updated within the window
      if (invoice.updatedAt) {
        const invoiceUpdatedAt = new Date(invoice.updatedAt);
        if (invoiceUpdatedAt < windowStart) {
          continue;
        }
      }

      totalFound++;
      try {
        await handleInvoicePaid({ id: invoice.id });
        totalQueued++;
      } catch (err) {
        console.error(`[invoicePoller] handleInvoicePaid error for invoice ${invoice.id}:`, err.message);
      }
    }

    pagesFetched += 1;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;

    const maxPagesPerPoll = parseInt(process.env.MAX_PAGES_PER_POLL, 10) || 5;
    if (pagesFetched >= maxPagesPerPoll) {
      console.log(`[invoicePoller] Reached MAX_PAGES_PER_POLL (${maxPagesPerPoll}) — stopping pagination for this run.`);
      break;
    }

    // Delay between pages to avoid hitting rate limits
    if (cursor) {
      await sleep(pageDelayMs);
    }
  } while (cursor);

  console.log(`[invoicePoller] Poll complete — pages: ${pagesFetched}, found: ${totalFound}, newly queued: ${totalQueued}`);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Start the invoice poller cron job.
 * Default: every 120 minutes. Override with POLL_INTERVAL_MINUTES env var.
 * Startup poll is intentionally delayed 30s to let the server fully initialize
 * and avoid triggering Jobber rate limits immediately on restart.
 */
function startInvoicePoller() {
  const intervalMinutes = parseInt(process.env.POLL_INTERVAL_MINUTES, 10) || 120;
  const validIntervals = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60, 120, 240, 1440];
  const cronInterval = validIntervals.includes(intervalMinutes) ? intervalMinutes : 120;
  const cronPattern = cronInterval === 60 ? '0 * * * *' : `*/${cronInterval} * * * *`;

  console.log(`[invoicePoller] Starting invoice poller (every ${cronInterval} min)`);

  cron.schedule(cronPattern, async () => {
    await pollPaidInvoices().catch((err) => {
      console.error('[invoicePoller] Scheduled poll error:', err.message);
    });
  });

  // Delayed startup poll — wait 30s for server to fully initialize
  setTimeout(() => {
    pollPaidInvoices().catch((err) => {
      console.error('[invoicePoller] Startup poll error:', err.message);
    });
  }, 30 * 1000);
}

module.exports = { startInvoicePoller, pollPaidInvoices };
