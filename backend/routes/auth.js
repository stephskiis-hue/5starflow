/**
 * routes/auth.js
 * Jobber connection via browser-based login only.
 * OAuth developer app routes have been removed.
 *
 * To revert: copy routes/auth.backup.js back to routes/auth.js
 */

const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const { captureBrowserToken, saveJobberBrowserToken } = require('../services/browserAuth');

/**
 * POST /auth/browser-login
 * Launches system Chrome, waits for user to log into Jobber,
 * captures the Bearer token from network requests, and saves it.
 *
 * Returns immediately — Chrome opens async. Poll GET /api/status to
 * detect when the connection is live.
 */
router.post('/browser-login', (req, res) => {
  res.json({ success: true, message: 'Browser opening — log in to Jobber, then return here.' });

  captureBrowserToken()
    .then(token  => saveJobberBrowserToken(token))
    .then(info   => console.log(`[auth] Jobber connected — account: ${info.accountId}, expires: ${info.expiresAt}`))
    .catch(err   => console.error('[auth] Browser login failed:', err.message));
});

/**
 * POST /auth/disconnect
 * Clears all stored Jobber tokens and queued review data.
 */
router.post('/disconnect', async (req, res) => {
  try {
    await prisma.jobberAccount.deleteMany();
    await prisma.tokenRefreshLog.deleteMany();
    await prisma.reviewSent.deleteMany();
    await prisma.pendingReview.deleteMany();
    console.log('[auth] Jobber account disconnected — all data cleared');
    res.json({ success: true, message: 'Jobber account disconnected' });
  } catch (err) {
    console.error('[auth] Disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

module.exports = router;
