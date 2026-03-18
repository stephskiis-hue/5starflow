const cron = require('node-cron');
const prisma = require('../lib/prismaClient');
const { refreshAccessToken } = require('./jobberClient');

/**
 * Find all accounts whose access tokens expire within the next 15 minutes
 * and proactively refresh them.
 *
 * Scheduling math:
 *   - Tokens typically expire every 60 minutes
 *   - Scheduler runs every 5 minutes
 *   - Refreshes anything expiring within 15 minutes
 *   - Gives at least 2 retry chances before actual expiry
 */
async function refreshExpiringTokens() {
  const fifteenMinutesFromNow = new Date(Date.now() + 15 * 60 * 1000);

  const accounts = await prisma.jobberAccount.findMany({
    where: {
      expiresAt:    { lte: fifteenMinutesFromNow },
      refreshToken: { not: '' },  // Skip browser-login tokens — they have no refresh token
    },
  });

  if (accounts.length === 0) {
    console.log('[tokenManager] All tokens healthy — no refresh needed.');
    return { refreshed: 0, failed: 0 };
  }

  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    try {
      await refreshAccessToken(account, 'scheduler');
      refreshed++;
    } catch (err) {
      failed++;
      await sendRefreshFailureAlert(account, err);
    }
  }

  console.log(`[tokenManager] Refresh cycle complete. Refreshed: ${refreshed}, Failed: ${failed}`);
  return { refreshed, failed };
}

/**
 * Alert handler for refresh failures.
 * Logs a prominent console warning. Extend this to send email/Slack/SMS.
 */
async function sendRefreshFailureAlert(account, err) {
  const errorMsg = err.response?.data
    ? JSON.stringify(err.response.data)
    : err.message;

  const lines = [
    '============================================================',
    '[ALERT] Jobber token refresh FAILED',
    `Account ID  : ${account.accountId}`,
    `Token expiry: ${account.expiresAt.toISOString()}`,
    `Error       : ${errorMsg}`,
    `Action      : Click "Login via Browser" at ${process.env.FRONTEND_ORIGIN || 'http://localhost:3001'}/connections.html`,
    '============================================================',
  ];
  console.error(lines.join('\n'));

  // --- Extension point ---
  // Uncomment and configure one of these to get alerts beyond the console:
  //
  // Email via nodemailer:
  // await sendEmail({
  //   to: process.env.ALERT_EMAIL,
  //   subject: '[5StarFlow] Jobber Token Refresh Failed — Action Required',
  //   text: lines.join('\n'),
  // });
  //
  // Slack webhook:
  // await axios.post(process.env.SLACK_WEBHOOK_URL, { text: lines.join('\n') });
}

/**
 * Start the proactive token refresh scheduler.
 * Called once on server startup from server.js.
 *
 * Cron pattern: every 5 minutes (node-cron string is "star-slash-5 star star star star").
 */
function startTokenRefreshScheduler() {
  console.log('[tokenManager] Starting token refresh scheduler (every 5 minutes)');

  cron.schedule('*/5 * * * *', async () => {
    console.log(`[tokenManager] [${new Date().toISOString()}] Running scheduled refresh check...`);
    await refreshExpiringTokens().catch((err) => {
      console.error('[tokenManager] Unexpected scheduler error:', err.message);
    });
  });

  // Run immediately on startup — catches any tokens that expired while server was down
  console.log('[tokenManager] Running initial refresh check on startup...');
  refreshExpiringTokens().catch((err) => {
    console.error('[tokenManager] Initial refresh check error:', err.message);
  });
}

module.exports = { startTokenRefreshScheduler, refreshExpiringTokens };
