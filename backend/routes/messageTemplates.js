const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');

// GET /api/message-templates?type=sms|email
router.get('/', async (req, res) => {
  const { type } = req.query;
  try {
    const where = { userId: req.user.userId };
    if (type) where.type = type;
    const templates = await prisma.messageTemplate.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    res.json({ templates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/message-templates  { name, type, content }
router.post('/', async (req, res) => {
  const { name, type, content } = req.body || {};
  if (!name || !type || !content) {
    return res.status(400).json({ error: 'name, type, and content are required' });
  }
  if (!['sms', 'email'].includes(type)) {
    return res.status(400).json({ error: 'type must be sms or email' });
  }
  try {
    const template = await prisma.messageTemplate.create({
      data: { userId: req.user.userId, name, type, content },
    });
    res.json({ success: true, template });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/message-templates/:id
router.delete('/:id', async (req, res) => {
  try {
    const tpl = await prisma.messageTemplate.findUnique({ where: { id: req.params.id } });
    if (!tpl || tpl.userId !== req.user.userId) {
      return res.status(404).json({ error: 'Not found' });
    }
    await prisma.messageTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
