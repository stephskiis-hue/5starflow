const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const prisma = require('../lib/prismaClient');
const { verifyToken } = require('../lib/auth');
const { captureBrowserToken, saveJobberBrowserToken } = require('../services/browserAuth');

/**
 * GET /auth/connect
 * Redirects the browser to Jobber's OAuth consent screen.
 * Embeds a signed userId in the state param so the callback can link the
 * Jobber account to the portal user who initiated the connection.
 */
router.get('/connect', (req, res) => {
  // Read portal session cookie — user should be logged in before connecting
  let userId = null;
  try {
    const token = req.cookies?.sf_session;
    if (token) {
      const payload = verifyToken(token);
      if (payload?.userId) userId = payload.userId;
    }
  } catch { /* no session is fine — state will carry 'anon' */ }

  // Build signed state: base64url( userId + ':' + timestamp + ':' + hmac[:16] )
  const ts  = Date.now();
  const raw = `${userId || 'anon'}:${ts}`;
  const hmac = crypto.createHmac('sha256', process.env.SESSION_SECRET)
                     .update(raw).digest('hex').slice(0, 16);
  const state = Buffer.from(`${raw}:${hmac}`).toString('base64url');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.JOBBER_CLIENT_ID,
    redirect_uri: process.env.JOBBER_REDIRECT_URI,
    state,
  });

  const authUrl = `${process.env.JOBBER_AUTH_URL}?${params.toString()}`;
  console.log('[auth] Redirecting to Jobber OAuth:', authUrl);
  res.redirect(authUrl);
});

/**
 * GET /auth/callback
 * Jobber redirects here after the user grants or denies access.
 * Exchanges the authorization code for access + refresh tokens.
 */
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5500';

  if (error || !code) {
    console.warn('[auth] OAuth callback error:', error || 'no code received');
    return res.redirect(`${frontendOrigin}/index.html?connected=false&reason=${encodeURIComponent(error || 'no_code')}`);
  }

  // Decode signed state to recover userId
  let userId = null;
  if (state) {
    try {
      const decoded = Buffer.from(state, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      // format: uid:ts:hmac  (uid itself may contain colons if it's a cuid — take last two as ts:hmac)
      const hmacPart = parts[parts.length - 1];
      const tsPart   = parts[parts.length - 2];
      const uidPart  = parts.slice(0, parts.length - 2).join(':');
      const raw      = `${uidPart}:${tsPart}`;
      const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET)
                             .update(raw).digest('hex').slice(0, 16);
      if (hmacPart === expected && uidPart !== 'anon') userId = uidPart;
    } catch { /* malformed state — proceed without userId */ }
  }

  try {
    const tokenRes = await axios.post(
      process.env.JOBBER_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.JOBBER_REDIRECT_URI,
        client_id: process.env.JOBBER_CLIENT_ID,
        client_secret: process.env.JOBBER_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token } = tokenRes.data;

    if (!access_token || !refresh_token) {
      throw new Error('Token response missing access_token or refresh_token');
    }

    // Jobber puts account_id and expiry inside the JWT, not in the response body
    const jwtPayload = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64').toString('utf8'));
    const accountId  = String(jwtPayload.account_id);
    const expiresAt  = new Date(jwtPayload.exp * 1000);

    // Upsert: if reconnecting, update tokens; if new connection, create row
    // userId links this Jobber org to the portal user who initiated the OAuth flow
    await prisma.jobberAccount.upsert({
      where: { accountId },
      update: {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        ...(userId ? { userId } : {}),
      },
      create: {
        accountId,
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt,
        userId,
      },
    });

    console.log(`[auth] Jobber account connected: ${accountId}${userId ? ` (portal user: ${userId})` : ''}. Expires: ${expiresAt.toISOString()}`);
    res.redirect(`${frontendOrigin}/index.html?connected=true`);
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    console.error('[auth] Token exchange failed:', detail);
    res.redirect(`${frontendOrigin}/index.html?connected=false&reason=token_exchange_failed`);
  }
});

/**
 * POST /auth/browser-login
 * Launches a visible Chromium browser, waits for the user to log into Jobber,
 * captures the Bearer token from network requests, and saves it.
 *
 * Returns immediately — the browser opens async. Poll GET /api/status to
 * check when the connection is established.
 */
router.post('/browser-login', (req, res) => {
  res.json({ success: true, message: 'Browser opening — log in to Jobber, then return here.' });

  // Fire async after response is sent
  captureBrowserToken()
    .then(token => saveJobberBrowserToken(token))
    .then(info => console.log(`[auth] Browser login complete — account: ${info.accountId}, expires: ${info.expiresAt}`))
    .catch(err => console.error('[auth] Browser login failed:', err.message));
});

/**
 * POST /auth/disconnect
 * Removes all stored Jobber tokens and review logs.
 * Called by the frontend "Disconnect" button.
 */
router.post('/disconnect', async (req, res) => {
  try {
    await prisma.jobberAccount.deleteMany();
    await prisma.tokenRefreshLog.deleteMany();
    await prisma.reviewSent.deleteMany();
    await prisma.pendingReview.deleteMany();
    console.log('[auth] Jobber account disconnected and all data cleared');
    res.json({ success: true, message: 'Jobber account disconnected' });
  } catch (err) {
    console.error('[auth] Disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
