const express  = require('express');
const router   = express.Router();
const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../lib/auth');

const prisma = new PrismaClient();

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
      data: { email: email.trim().toLowerCase(), password: hashed },
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
  const targetId = parseInt(req.params.id, 10);
  const selfId   = req.user?.userId;

  if (isNaN(targetId)) {
    return res.status(400).json({ error: 'Invalid user ID' });
  }
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

module.exports = router;
