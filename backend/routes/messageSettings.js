const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');

const DEFAULT_SMS_TEMPLATE =
  'Hi {firstName}! We hope you\'re loving the look of your property! ' +
  'We put in the sweat so you didn\'t have to—we\'d love to hear what you think of the results. 🫡 \n\n' +
  '{reviewLink} — Much appreciated! ⭐️⭐️⭐️⭐️⭐️';

const DEFAULT_EMAIL_SUBJECT = 'How did we do? 🌿 Leave us a quick review';

/**
 * GET /api/message-settings
 * Returns the user's saved templates (or defaults if not set).
 */
router.get('/', async (req, res) => {
  try {
    const row = await prisma.messageSettings.findUnique({
      where: { userId: req.user.userId },
    });
    res.json({
      smsTemplate:          row?.smsTemplate  || null,
      emailSubject:         row?.emailSubject || null,
      smsDefault:           DEFAULT_SMS_TEMPLATE,
      emailSubjectDefault:  DEFAULT_EMAIL_SUBJECT,
      updatedAt:            row?.updatedAt    || null,
    });
  } catch (err) {
    console.error('[messageSettings] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/message-settings
 * Saves the user's SMS template and/or email subject.
 * Body: { smsTemplate?, emailSubject? }
 */
router.post('/', async (req, res) => {
  const { smsTemplate, emailSubject } = req.body || {};
  try {
    const data = {};
    if (smsTemplate  !== undefined) data.smsTemplate  = smsTemplate  || null;
    if (emailSubject !== undefined) data.emailSubject = emailSubject || null;

    const row = await prisma.messageSettings.upsert({
      where:  { userId: req.user.userId },
      update: data,
      create: { userId: req.user.userId, ...data },
    });
    res.json({ success: true, updatedAt: row.updatedAt });
  } catch (err) {
    console.error('[messageSettings] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
