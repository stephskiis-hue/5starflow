/**
 * portal.js — login / logout / user setup routes
 *
 * POST /auth/login       — validate email + password, set session cookie
 * POST /auth/logout      — clear session cookie
 * POST /auth/setup-user  — create the first portal user (protected by SETUP_TOKEN)
 */

const express  = require('express');
const router   = express.Router();
const prisma   = require('../lib/prismaClient');
const { hashPassword, verifyPassword, signToken, setCookie, clearCookie } = require('../lib/auth');

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
      // Generic message — don't reveal whether email exists
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ userId: user.id, email: user.email });
    setCookie(res, token);

    // JSON response so the login page JS can redirect
    return res.json({ success: true, redirect: '/index.html' });
  } catch (err) {
    console.error('[portal] /auth/login error:', err.message);
    return res.status(500).json({ error: 'Login failed — server error' });
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
// Protected by SETUP_TOKEN env var — only someone with access to the server
// config can create accounts.
//
// Body: { setupToken, email, password }
// ---------------------------------------------------------------------------
router.post('/setup-user', async (req, res) => {
  const { setupToken, email, password } = req.body || {};

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

  try {
    const passwordHash = hashPassword(password);
    const user = await prisma.user.upsert({
      where:  { email: email.toLowerCase().trim() },
      update: { passwordHash, isActive: true },
      create: { email: email.toLowerCase().trim(), passwordHash },
    });

    return res.json({ success: true, message: `User ${user.email} created/updated` });
  } catch (err) {
    console.error('[portal] /auth/setup-user error:', err.message);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

module.exports = router;
