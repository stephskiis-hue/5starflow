/**
 * portal.js — login / logout / user setup / admin user management routes
 *
 * POST /auth/login             — validate email + password, set session cookie
 * POST /auth/logout            — clear session cookie
 * POST /auth/setup-user        — create the first portal user (protected by SETUP_TOKEN)
 *
 * GET  /api/admin/me           — return current user's email + role (any authenticated user)
 * GET  /api/admin/users        — list all portal users          (admin only)
 * POST /api/admin/users        — create a new portal user       (admin only)
 * PATCH /api/admin/users/:id   — update role / isActive / password (admin only)
 * DELETE /api/admin/users/:id  — deactivate a user (soft delete) (admin only)
 */

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const prisma   = require('../lib/prismaClient');
const { hashPassword, verifyPassword, signToken, setCookie, clearCookie } = require('../lib/auth');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

// ---------------------------------------------------------------------------
// GET /auth/google — redirect to Google OAuth consent screen
// ---------------------------------------------------------------------------
router.get('/google', (req, res) => {
  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_LOGIN_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send('GOOGLE_CLIENT_ID and GOOGLE_LOGIN_REDIRECT_URI must be set.');
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         'openid email profile https://www.googleapis.com/auth/gmail.send');
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('prompt',        'consent');

  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// GET /auth/google/callback — exchange code, create session
// ---------------------------------------------------------------------------
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    console.error('[portal] Google OAuth error:', error);
    return res.redirect('/login.html?error=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/login.html?error=no_code');
  }

  try {
    // 1. Exchange code for tokens
    const tokenResp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_LOGIN_REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = tokenResp.data;
    const tokenExpiry = new Date(Date.now() + (expires_in || 3600) * 1000);

    // 2. Fetch Google user info
    const userResp = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { id: googleId, email, name } = userResp.data;

    if (!email) {
      return res.redirect('/login.html?error=no_email');
    }

    // 3. Find-or-create User by googleId, fallback to email match
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId }, { email: email.toLowerCase() }] },
    });

    if (user) {
      if (!user.isActive) {
        return res.redirect('/login.html?error=account_inactive');
      }
      if (!user.googleId) {
        user = await prisma.user.update({ where: { id: user.id }, data: { googleId } });
      }
    } else {
      user = await prisma.user.create({
        data: { email: email.toLowerCase(), googleId, role: 'client' },
      });
    }

    // 4. Upsert GmailCredential so emails send from this Google account
    await prisma.gmailCredential.upsert({
      where:  { userId: user.id },
      update: {
        gmailUser:   email,
        accessToken: access_token,
        ...(refresh_token && { refreshToken: refresh_token }),
        tokenExpiry,
      },
      create: {
        userId:       user.id,
        gmailUser:    email,
        fromName:     name || '',
        accessToken:  access_token,
        refreshToken: refresh_token || null,
        tokenExpiry,
      },
    });

    // 5. Create session cookie
    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    setCookie(res, token);

    console.log(`[portal] Google login: userId=${user.id} email=${user.email}`);
    res.redirect('/index.html');

  } catch (err) {
    console.error('[portal] Google callback error:', err.response?.data || err.message);
    res.redirect('/login.html?error=' + encodeURIComponent('Login failed — please try again'));
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  clearCookie(res);
  return res.json({ success: true, redirect: '/login.html' });
});

// ---------------------------------------------------------------------------
// POST /auth/setup-user
// Creates the first (or any) portal user.
// Protected by SETUP_TOKEN env var.
// Body: { setupToken, email, password, role }
// ---------------------------------------------------------------------------
router.post('/setup-user', async (req, res) => {
  const { setupToken, email, password, role } = req.body || {};

  const configuredToken = process.env.SETUP_TOKEN;
  if (!configuredToken || configuredToken.startsWith('<')) {
    return res.status(503).json({ error: 'SETUP_TOKEN not configured in .env' });
  }

  if (!setupToken || setupToken !== configuredToken) {
    return res.status(403).json({ error: 'Invalid setup token' });
  }

  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) are required' });
  }

  const userRole = role === 'admin' ? 'admin' : 'client';

  try {
    const passwordHash = hashPassword(password);
    const user = await prisma.user.upsert({
      where:  { email: email.toLowerCase().trim() },
      update: { passwordHash, isActive: true, role: userRole },
      create: { email: email.toLowerCase().trim(), passwordHash, role: userRole },
    });

    return res.json({ success: true, message: `User ${user.email} created/updated with role: ${user.role}` });
  } catch (err) {
    console.error('[portal] /auth/setup-user error:', err.message);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/me — current user info (any authenticated user)
// ---------------------------------------------------------------------------
router.get('/admin/me', requireAuth, (req, res) => {
  return res.json({ userId: req.user.userId, email: req.user.email, role: req.user.role });
});

// ---------------------------------------------------------------------------
// GET /api/admin/users — list all portal users (admin only)
// ---------------------------------------------------------------------------
router.get('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ users });
  } catch (err) {
    console.error('[portal] GET /api/admin/users error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/admin/users — create a new portal user (admin only)
// Body: { email, password, role }
// ---------------------------------------------------------------------------
router.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const { email, password, role } = req.body || {};

  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and password (min 8 chars) are required' });
  }

  const userRole = role === 'admin' ? 'admin' : 'client';

  try {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }

    const passwordHash = hashPassword(password);
    const user = await prisma.user.create({
      data: { email: email.toLowerCase().trim(), passwordHash, role: userRole },
      select: { id: true, email: true, role: true, isActive: true, createdAt: true },
    });

    return res.status(201).json({ user });
  } catch (err) {
    console.error('[portal] POST /api/admin/users error:', err.message);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/:id — update role / isActive / password (admin only)
// Body: { role?, isActive?, password? }
// ---------------------------------------------------------------------------
router.patch('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { role, isActive, password } = req.body || {};

  // Prevent admin from deactivating their own account
  if (id === req.user.userId && isActive === false) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  const data = {};
  if (role === 'admin' || role === 'client') data.role = role;
  if (typeof isActive === 'boolean') data.isActive = isActive;
  if (password && password.length >= 8) data.passwordHash = hashPassword(password);

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, role: true, isActive: true, createdAt: true },
    });
    return res.json({ user });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    console.error('[portal] PATCH /api/admin/users error:', err.message);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:id — deactivate user (soft delete) (admin only)
// ---------------------------------------------------------------------------
router.delete('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;

  if (id === req.user.userId) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' });
  }

  try {
    await prisma.user.update({ where: { id }, data: { isActive: false } });
    return res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    console.error('[portal] DELETE /api/admin/users error:', err.message);
    return res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
