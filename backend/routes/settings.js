const express  = require('express');
const router   = express.Router();
const prisma   = require('../lib/prismaClient');
const { hashPassword } = require('../lib/auth');

// GET /api/settings/users — list all users
router.get('/users', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, email: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ users });
  } catch (err) {
    console.error('[settings] list users error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// POST /api/settings/users — create a new user
router.post('/users', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const hashed = hashPassword(password);
    const user   = await prisma.user.create({
      data: { email: email.trim().toLowerCase(), passwordHash: hashed },
      select: { id: true, email: true, createdAt: true },
    });
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('[settings] create user error:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// DELETE /api/settings/users/:id — delete a user (cannot delete yourself)
router.delete('/users/:id', async (req, res) => {
  const targetId = req.params.id;
  const selfId   = req.user?.userId;

  if (targetId === selfId) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  try {
    await prisma.user.delete({ where: { id: targetId } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error('[settings] delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ---------------------------------------------------------------------------
// Twilio credentials (per-user)
// ---------------------------------------------------------------------------

// GET /api/settings/credentials — return masked Twilio + Gmail creds for current user
router.get('/credentials', async (req, res) => {
  try {
    const [twilio, gmail] = await Promise.all([
      prisma.twilioCredential.findUnique({ where: { userId: req.user.userId } }),
      prisma.gmailCredential.findUnique({ where: { userId: req.user.userId } }),
    ]);

    res.json({
      twilio: twilio ? {
        configured:  true,
        accountSid:  twilio.accountSid.slice(0, 8) + '...',
        fromNumber:  twilio.fromNumber,
        updatedAt:   twilio.updatedAt,
      } : { configured: false },
      gmail: gmail ? {
        configured:  true,
        gmailUser:   gmail.gmailUser,
        fromName:    gmail.fromName,
        updatedAt:   gmail.updatedAt,
      } : { configured: false },
    });
  } catch (err) {
    console.error('[settings] /credentials error:', err.message);
    res.status(500).json({ error: 'Failed to load credentials' });
  }
});

// POST /api/settings/twilio — upsert Twilio credentials for current user
router.post('/twilio', async (req, res) => {
  const { accountSid, authToken, fromNumber } = req.body || {};

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(400).json({ error: 'accountSid, authToken, and fromNumber are required' });
  }

  try {
    const cred = await prisma.twilioCredential.upsert({
      where:  { userId: req.user.userId },
      update: { accountSid, authToken, fromNumber },
      create: { userId: req.user.userId, accountSid, authToken, fromNumber },
    });

    res.json({
      success: true,
      twilio: {
        configured:  true,
        accountSid:  cred.accountSid.slice(0, 8) + '...',
        fromNumber:  cred.fromNumber,
        updatedAt:   cred.updatedAt,
      },
    });
  } catch (err) {
    console.error('[settings] /twilio save error:', err.message);
    res.status(500).json({ error: 'Failed to save Twilio credentials' });
  }
});

// POST /api/settings/gmail — upsert Gmail credentials for current user
router.post('/gmail', async (req, res) => {
  const { gmailUser, appPassword, fromName } = req.body || {};

  if (!gmailUser || !appPassword) {
    return res.status(400).json({ error: 'gmailUser and appPassword are required' });
  }

  try {
    const cred = await prisma.gmailCredential.upsert({
      where:  { userId: req.user.userId },
      update: { gmailUser, appPassword, fromName: fromName || '' },
      create: { userId: req.user.userId, gmailUser, appPassword, fromName: fromName || '' },
    });

    res.json({
      success: true,
      gmail: {
        configured:  true,
        gmailUser:   cred.gmailUser,
        fromName:    cred.fromName,
        updatedAt:   cred.updatedAt,
      },
    });
  } catch (err) {
    console.error('[settings] /gmail save error:', err.message);
    res.status(500).json({ error: 'Failed to save Gmail credentials' });
  }
});

module.exports = router;
