const cron = require('node-cron');
const axios = require('axios');
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
  const THRESHOLD_MINUTES = 15;
  const thresholdTime = new Date(Date.now() + THRESHOLD_MINUTES * 60 * 1000);

  const allAccounts = await prisma.jobberAccount.findMany({
    where: { refreshToken: { not: '' } },
  });

  if (allAccounts.length === 0) {
    console.log('[tokenManager] No accounts with refresh tokens found.');
    return { refreshed: 0, failed: 0 };
  }

  const now = new Date();
  const toRefresh = [];

  for (const acct of allAccounts) {
    const minsLeft = Math.round((acct.expiresAt - now) / 60000);
    const willRefresh = acct.expiresAt <= thresholdTime;
    console.log(
      `[tokenManager] Account ${acct.accountId}: ${minsLeft}m left. ` +
      `Threshold: ${THRESHOLD_MINUTES}m. Refreshing: ${willRefresh}`
    );
    if (willRefresh) toRefresh.push(acct);
  }

  if (toRefresh.length === 0) {
    console.log('[tokenManager] All tokens healthy — no refresh needed.');
    return { refreshed: 0, failed: 0 };
  }

  let refreshed = 0;
  let failed = 0;

  for (const account of toRefresh) {
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
  const raw = err.response?.data ? JSON.stringify(err.response.data) : err.message;
  const errorMsg = (raw || '').includes('<')
    ? '[Jobber returned an HTML error page — likely temporary outage]'
    : raw;

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

// ---------------------------------------------------------------------------
// Gmail OAuth2 token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh Gmail access tokens that are expiring within 10 minutes.
 */
async function refreshExpiringGmailTokens() {
  const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);

  const creds = await prisma.gmailCredential.findMany({
    where: {
      refreshToken: { not: null },
      tokenExpiry:  { lte: tenMinutesFromNow },
    },
  });

  if (creds.length === 0) return;

  console.log(`[tokenManager] Refreshing ${creds.length} Gmail token(s)...`);

  for (const cred of creds) {
    try {
      const resp = await axios.post('https://oauth2.googleapis.com/token', {
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: cred.refreshToken,
        grant_type:    'refresh_token',
      });

      const { access_token, expires_in } = resp.data;
      const tokenExpiry = new Date(Date.now() + (expires_in || 3600) * 1000);

      await prisma.gmailCredential.update({
        where: { id: cred.id },
        data:  { accessToken: access_token, tokenExpiry },
      });

      console.log(`[tokenManager] Gmail token refreshed for userId=${cred.userId} (${cred.gmailUser})`);
    } catch (err) {
      console.error(`[tokenManager] Gmail token refresh failed for userId=${cred.userId}:`, err.response?.data || err.message);
    }
  }
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
    await refreshExpiringGmailTokens().catch((err) => {
      console.error('[tokenManager] Gmail refresh error:', err.message);
    });
  });

  // Run immediately on startup — catches any tokens that expired while server was down
  console.log('[tokenManager] Running initial refresh check on startup...');
  refreshExpiringTokens().catch((err) => {
    console.error('[tokenManager] Initial refresh check error:', err.message);
  });
  refreshExpiringGmailTokens().catch((err) => {
    console.error('[tokenManager] Initial Gmail refresh error:', err.message);
  });
}

module.exports = { startTokenRefreshScheduler, refreshExpiringTokens };
