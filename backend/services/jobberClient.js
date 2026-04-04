const axios = require('axios');
const prisma = require('../lib/prismaClient');

// Jobber requires this header on every GraphQL request.
// Override with JOBBER_API_VERSION env var if needed.
const JOBBER_API_VERSION = process.env.JOBBER_API_VERSION || '2026-03-10';

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------
// 429 = rate limit — do NOT retry, let the caller's throttle guard handle backoff
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRYABLE_CODES  = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND']);
const MAX_ATTEMPTS     = 3;
const BACKOFF_MS       = [0, 2000, 4000]; // delay before attempt 1, 2, 3

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isTransient(err) {
  const status = err.response?.status;
  if (status && RETRYABLE_STATUS.has(status)) return true;
  if (RETRYABLE_CODES.has(err.code)) return true;
  return false;
}

// Strip raw HTML (e.g. Cloudflare 504 page) from error bodies so logs stay readable
function sanitizeBody(data) {
  if (!data) return '';
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return s.trimStart().startsWith('<') ? '[HTML error page — likely temporary Jobber outage]' : s;
}


/**
 * Exchange a refresh token for a new access token.
 * Always stores the new refresh token too — Jobber may rotate it.
 *
 * @param {object} account - JobberAccount row from the database
 * @param {string} trigger - 'scheduler' | 'on-demand' (for log attribution)
 * @returns {string} new access token
 */
async function refreshAccessToken(account, trigger = 'on-demand') {
  // Browser-captured tokens have no refresh token — can't silently refresh
  if (!account.refreshToken) {
    const msg = 'Token expired. Please reconnect Jobber via "Login via Browser" on the Connections page.';
    await prisma.tokenRefreshLog.create({
      data: { accountId: account.accountId, success: false, message: msg, trigger },
    });
    console.warn(`[jobberClient] ${msg}`);
    throw new Error(msg);
  }

  let oauthRes;
  let lastOauthErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.warn(`[jobberClient] Token refresh transient error (attempt ${attempt - 1}/${MAX_ATTEMPTS - 1}), retrying in ${BACKOFF_MS[attempt - 1] / 1000}s…`);
      await sleep(BACKOFF_MS[attempt - 1]);
    }
    try {
      oauthRes = await axios.post(
        process.env.JOBBER_TOKEN_URL,
        new URLSearchParams({
          grant_type:    'refresh_token',
          refresh_token: account.refreshToken,
          client_id:     process.env.JOBBER_CLIENT_ID,
          client_secret: process.env.JOBBER_CLIENT_SECRET,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      lastOauthErr = null;
      break;
    } catch (err) {
      lastOauthErr = err;
      if (!isTransient(err)) break;
    }
  }

  try {
    if (lastOauthErr) throw lastOauthErr;
    const res = oauthRes;

    const { access_token, refresh_token } = res.data;

    // Jobber embeds expiry in the JWT itself, not as expires_in in the response body
    const jwtPayload    = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString('utf8'));
    const expiresAt     = new Date(jwtPayload.exp * 1000);
    // If Jobber doesn't rotate the refresh token, keep the existing one
    const newRefreshToken = refresh_token || account.refreshToken;

    await prisma.jobberAccount.update({
      where: { id: account.id },
      data: {
        accessToken: access_token,
        refreshToken: newRefreshToken,
        expiresAt,
      },
    });

    // Log success
    await prisma.tokenRefreshLog.create({
      data: {
        accountId: account.accountId,
        success: true,
        message: `Token refreshed successfully. New expiry: ${expiresAt.toISOString()}`,
        trigger,
      },
    });

    console.log(`[jobberClient] Token refreshed (${trigger}). Expires: ${expiresAt.toISOString()}`);
    return access_token;
  } catch (err) {
    const errorMsg = sanitizeBody(err.response?.data) || err.message;

    // Log failure — this powers the dashboard's red status indicator
    await prisma.tokenRefreshLog.create({
      data: {
        accountId: account.accountId,
        success: false,
        message: `Refresh failed (${trigger}): ${errorMsg}`,
        trigger,
      },
    });

    console.error(`[jobberClient] Token refresh FAILED (${trigger}):`, errorMsg);
    throw err;
  }
}

/**
 * Get a valid access token, refreshing on-demand if it's about to expire.
 * The proactive scheduler in tokenManager.js handles most cases — this is
 * a safety net for the 2-minute window before expiry.
 *
 * @param {string|null} userId - portal User.id to look up the right Jobber account
 *   (multi-tenant). Pass null / omit for background jobs — falls back to findFirst().
 * @returns {string} valid access token
 */
async function getValidAccessToken(userId = null) {
  const account = userId
    ? await prisma.jobberAccount.findFirst({ where: { userId } })
    : await prisma.jobberAccount.findFirst();

  if (!account) {
    const hint = userId ? `for portal user ${userId}` : '— visit /auth/connect to link your account';
    throw new Error(`No Jobber account connected ${hint}.`);
  }

  const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
  if (account.expiresAt <= twoMinutesFromNow) {
    console.log('[jobberClient] Token expiring soon — triggering on-demand refresh');
    return await refreshAccessToken(account, 'on-demand');
  }

  return account.accessToken;
}

/**
 * Execute a Jobber GraphQL query or mutation.
 *
 * @param {string} query - GraphQL query or mutation string
 * @param {object} variables - GraphQL variables object
 * @param {string|null} userId - portal User.id for multi-tenant account lookup
 * @returns {object} The `data` field of the GraphQL response
 */
async function jobberGraphQL(query, variables = {}, userId = null) {
  const accessToken = await getValidAccessToken(userId);

  let res;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.warn(`[jobberClient] GraphQL transient error (attempt ${attempt - 1}/${MAX_ATTEMPTS - 1}), retrying in ${BACKOFF_MS[attempt - 1] / 1000}s…`);
      await sleep(BACKOFF_MS[attempt - 1]);
    }
    try {
      res = await axios.post(
        process.env.JOBBER_GRAPHQL_URL,
        { query, variables },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'X-JOBBER-GRAPHQL-VERSION': JOBBER_API_VERSION,
          },
        }
      );
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) break;
    }
  }
  if (lastErr) {
    const body = sanitizeBody(lastErr.response?.data) || lastErr.message;
    throw new Error(`Jobber HTTP ${lastErr.response?.status ?? 'ERR'}: ${body}`);
  }

  if (res.data.errors?.length) {
    const msg = res.data.errors.map((e) => e.message).join('; ');
    throw new Error(`Jobber GraphQL error: ${msg}`);
  }

  return res.data.data;
}

module.exports = { jobberGraphQL, refreshAccessToken, getValidAccessToken };
