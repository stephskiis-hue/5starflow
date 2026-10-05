const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const { getSettings } = require('../lib/notify');

// GET /api/notifications — latest 50 (+ unread count)
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    res.json({ items, unread, settings: await getSettings(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notifications/read  { ids?: string[] } — no ids = mark everything read
router.post('/read', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    await prisma.notification.updateMany({ where: { userId: req.user.userId, readAt: null, ...(ids ? { id: { in: ids } } : {}) }, data: { readAt: new Date() } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/notifications/settings
router.put('/settings', async (req, res) => {
  try {
    const { digestMode, digestDay, digestHour, urgentSms } = req.body || {};
    const data = {};
    if (['weekly', 'off'].includes(digestMode)) data.digestMode = digestMode;
    if (Number.isInteger(digestDay) && digestDay >= 0 && digestDay <= 6) data.digestDay = digestDay;
    if (Number.isInteger(digestHour) && digestHour >= 0 && digestHour <= 23) data.digestHour = digestHour;
    if (typeof urgentSms === 'boolean') data.urgentSms = urgentSms;
    const userId = req.user.userId;
    await prisma.notificationSettings.upsert({ where: { userId }, update: data, create: { userId, ...data } });
    res.json({ success: true, settings: await getSettings(userId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
