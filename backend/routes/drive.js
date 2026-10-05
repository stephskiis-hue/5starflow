const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');
const prisma  = require('../lib/prismaClient');
const { requireAuth } = require('../middleware/requireAuth');

// Read-only Google Drive connection for the vault photo import (ai/driveImport.js).
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email';

// state = userId.hmac so the public callback can't be pointed at someone else's account
const sign = (userId) => `${userId}.${crypto.createHmac('sha256', process.env.SESSION_SECRET || '').update(`drive:${userId}`).digest('hex').slice(0, 32)}`;
function verifyState(state) {
  const userId = String(state || '').split('.')[0];
  const a = Buffer.from(String(state || '')), b = Buffer.from(sign(userId));
  return userId && a.length === b.length && crypto.timingSafeEqual(a, b) ? userId : null;
}

// GET /api/drive/auth — send the signed-in user to Google's consent screen
router.get('/auth', requireAuth, (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID, redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;
  if (!clientId || !redirectUri) return res.status(500).send('GOOGLE_CLIENT_ID and GOOGLE_DRIVE_REDIRECT_URI must be set in environment variables.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         SCOPE);
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('prompt',        'consent');   // always ask — guarantees refresh_token
  url.searchParams.set('state',         sign(req.user.userId));
  res.redirect(url.toString());
});

// GET /api/drive/callback — public: Google redirects here without a session
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const back = (q) => res.redirect('/connections.html?' + q);
  if (error) return back('drive_error=' + encodeURIComponent(error));
  const userId = verifyState(state);
  if (!code || !userId) return back('drive_error=invalid_request');
  try {
    const { data: tok } = await axios.post('https://oauth2.googleapis.com/token', {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_DRIVE_REDIRECT_URI, grant_type: 'authorization_code',
    });
    if (!String(tok.scope || '').includes('drive.readonly')) return back('drive_error=' + encodeURIComponent('Drive access was not granted. Tick the Google Drive box on the consent screen.'));
    const { data: who } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const tokenExpiry = new Date(Date.now() + (tok.expires_in || 3600) * 1000);
    await prisma.driveCredential.upsert({
      where:  { userId },
      update: { email: who.email || '', accessToken: tok.access_token, ...(tok.refresh_token && { refreshToken: tok.refresh_token }), tokenExpiry, lastError: null },
      create: { userId, email: who.email || '', accessToken: tok.access_token, refreshToken: tok.refresh_token || null, tokenExpiry },
    });
    console.log(`[drive] connected for userId=${userId} → ${who.email}`);
    back('drive_connected=1');
  } catch (err) {
    console.error('[drive] callback error:', err.response?.data || err.message);
    back('drive_error=' + encodeURIComponent(err.response?.data?.error_description || err.message));
  }
});

// GET /api/drive/status
router.get('/status', requireAuth, async (req, res) => {
  const c = await prisma.driveCredential.findUnique({ where: { userId: req.user.userId } });
  res.json(c ? { connected: true, email: c.email, lastSyncAt: c.lastSyncAt, importedCount: c.importedCount, backfillDone: c.backfillDone, lastError: c.lastError } : { connected: false });
});

// POST /api/drive/import — run the import now (same code path as the nightly cron)
router.post('/import', requireAuth, async (req, res) => {
  const { runRoutine } = require('../ai/runner');
  const { driveImportTick } = require('../ai/driveImport');
  const r = await runRoutine('vault-drive-import', driveImportTick, { trigger: 'manual', userId: req.user.userId });
  res.status(r.ok ? 200 : 502).json(r);
});

// POST /api/drive/disconnect — forget the tokens (imported photos stay in the vault)
router.post('/disconnect', requireAuth, async (req, res) => {
  const c = await prisma.driveCredential.findUnique({ where: { userId: req.user.userId } });
  if (c?.refreshToken) await axios.post('https://oauth2.googleapis.com/revoke', null, { params: { token: c.refreshToken } }).catch(() => {});
  await prisma.driveCredential.deleteMany({ where: { userId: req.user.userId } });
  res.json({ ok: true });
});

module.exports = router;
