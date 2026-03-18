const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const prisma  = require('../lib/prismaClient');
const { requireAuth } = require('../middleware/requireAuth');

// ---------------------------------------------------------------------------
// GET /api/gmail/auth
// Redirect current user to Google OAuth consent screen (gmail.send scope).
// Requires an active session.
// ---------------------------------------------------------------------------
router.get('/auth', requireAuth, (req, res) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send('GOOGLE_CLIENT_ID and GMAIL_REDIRECT_URI must be set in environment variables.');
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email');
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('prompt',        'consent');  // always ask — guarantees refresh_token
  url.searchParams.set('state',         req.user.userId); // passed back in callback

  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// GET /api/gmail/callback
// Google redirects here after user approves. Public — no session required.
// Exchanges code for tokens, fetches email address, saves to GmailCredential.
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  const userId = state || null;

  if (error) {
    console.error('[gmail] OAuth error from Google:', error);
    return res.redirect('/settings.html?gmail_error=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/settings.html?gmail_error=no_code');
  }
  if (!userId) {
    return res.redirect('/settings.html?gmail_error=missing_state');
  }

  try {
    // 1. Exchange code for tokens
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GMAIL_REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data;
    const tokenExpiry = new Date(Date.now() + (expires_in || 3600) * 1000);

    // 2. Fetch the user's Gmail address
    const userResp = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const gmailUser = userResp.data.email;

    if (!gmailUser) {
      return res.redirect('/settings.html?gmail_error=no_email');
    }

    // 3. Upsert GmailCredential
    await prisma.gmailCredential.upsert({
      where:  { userId },
      update: {
        gmailUser,
        accessToken:  access_token,
        // Only overwrite refreshToken if Google returned a new one
        ...(refresh_token && { refreshToken: refresh_token }),
        tokenExpiry,
      },
      create: {
        userId,
        gmailUser,
        accessToken:  access_token,
        refreshToken: refresh_token || null,
        tokenExpiry,
      },
    });

    console.log(`[gmail] OAuth connected for userId=${userId} → ${gmailUser}`);
    res.redirect('/settings.html?gmail_connected=1');

  } catch (err) {
    console.error('[gmail] callback error:', err.response?.data || err.message);
    res.redirect('/settings.html?gmail_error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
