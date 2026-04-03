const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const { dispatchCampaign, MAX_RECIPIENTS } = require('../services/marketingService');
const { toE164 } = require('../services/smsService');

// ---------------------------------------------------------------------------
// Templates CRUD
// ---------------------------------------------------------------------------

// GET /api/marketing/templates
router.get('/templates', async (req, res) => {
  try {
    const templates = await prisma.marketingTemplate.findMany({
      where:   { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ templates });
  } catch (err) {
    console.error('[marketing] GET /templates error:', err.message);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /api/marketing/templates
router.post('/templates', async (req, res) => {
  try {
    const { name, body } = req.body;
    if (!name || !body) {
      return res.status(400).json({ error: 'Name and body are required' });
    }
    if (name.length > 100) {
      return res.status(400).json({ error: 'Template name must be 100 characters or less' });
    }
    if (body.length > 1600) {
      return res.status(400).json({ error: 'Message body must be 1600 characters or less (SMS limit)' });
    }

    const template = await prisma.marketingTemplate.create({
      data: { userId: req.user.userId, name: name.trim(), body: body.trim() },
    });
    res.json({ template });
  } catch (err) {
    console.error('[marketing] POST /templates error:', err.message);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PUT /api/marketing/templates/:id
router.put('/templates/:id', async (req, res) => {
  try {
    const existing = await prisma.marketingTemplate.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const { name, body } = req.body;
    if (name && name.length > 100) {
      return res.status(400).json({ error: 'Template name must be 100 characters or less' });
    }
    if (body && body.length > 1600) {
      return res.status(400).json({ error: 'Message body must be 1600 characters or less (SMS limit)' });
    }

    const data = {};
    if (name) data.name = name.trim();
    if (body) data.body = body.trim();

    const template = await prisma.marketingTemplate.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ template });
  } catch (err) {
    console.error('[marketing] PUT /templates error:', err.message);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/marketing/templates/:id
router.delete('/templates/:id', async (req, res) => {
  try {
    const existing = await prisma.marketingTemplate.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    await prisma.marketingTemplate.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[marketing] DELETE /templates error:', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ---------------------------------------------------------------------------
// Audiences
// ---------------------------------------------------------------------------

// GET /api/marketing/audiences
router.get('/audiences', async (req, res) => {
  try {
    const audiences = await prisma.audienceList.findMany({
      where:   { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { contacts: true } } },
    });
    res.json({ audiences });
  } catch (err) {
    console.error('[marketing] GET /audiences error:', err.message);
    res.status(500).json({ error: 'Failed to load audiences' });
  }
});

// GET /api/marketing/audiences/:id
router.get('/audiences/:id', async (req, res) => {
  try {
    const audience = await prisma.audienceList.findFirst({
      where:   { id: req.params.id, userId: req.user.userId },
      include: { contacts: { orderBy: { clientName: 'asc' } } },
    });
    if (!audience) return res.status(404).json({ error: 'Audience not found' });
    res.json({ audience });
  } catch (err) {
    console.error('[marketing] GET /audiences/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load audience' });
  }
});

// POST /api/marketing/audiences
router.post('/audiences', async (req, res) => {
  try {
    const { name, contacts } = req.body;
    if (!name || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'Name and at least one contact are required' });
    }
    if (contacts.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Audience cannot exceed ${MAX_RECIPIENTS} contacts` });
    }

    const audience = await prisma.audienceList.create({
      data: {
        userId: req.user.userId,
        name:   name.trim(),
        contacts: {
          create: contacts.map((c) => ({
            jobberClientId: c.jobberClientId,
            clientName:     c.clientName,
            firstName:      c.firstName,
            phone:          c.phone || null,
            smsAllowed:     Boolean(c.smsAllowed),
          })),
        },
      },
      include: { _count: { select: { contacts: true } } },
    });

    res.json({ audience });
  } catch (err) {
    console.error('[marketing] POST /audiences error:', err.message);
    res.status(500).json({ error: 'Failed to create audience' });
  }
});

// DELETE /api/marketing/audiences/:id
router.delete('/audiences/:id', async (req, res) => {
  try {
    const existing = await prisma.audienceList.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!existing) return res.status(404).json({ error: 'Audience not found' });

    await prisma.audienceList.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[marketing] DELETE /audiences error:', err.message);
    res.status(500).json({ error: 'Failed to delete audience' });
  }
});

// ---------------------------------------------------------------------------
// Jobber client cache (reads from local DB — populated by jobberClientSync.js)
// ---------------------------------------------------------------------------

// GET /api/marketing/jobber-clients — instant DB read, no live Jobber call
router.get('/jobber-clients', async (req, res) => {
  try {
    const userId = req.user.userId;
    const cached = await prisma.cachedJobberClient.findMany({
      where:   { userId },
      orderBy: { name: 'asc' },
    });

    if (cached.length === 0) {
      return res.json({
        clients:  [],
        syncedAt: null,
        warning:  'No cached clients — click "Sync Clients" to import from Jobber.',
      });
    }

    res.json({
      clients: cached.map((c) => ({
        id:         c.jobberClientId,
        name:       c.name,
        firstName:  c.firstName,
        phone:      c.phone,
        smsAllowed: c.smsAllowed,
        tags:       JSON.parse(c.tags || '[]'),
      })),
      syncedAt: cached[0].syncedAt,
    });
  } catch (err) {
    console.error('[marketing] GET /jobber-clients error:', err.message);
    res.status(500).json({ error: 'Failed to load cached clients' });
  }
});

// POST /api/marketing/sync-clients — triggers a manual background sync
router.post('/sync-clients', async (req, res) => {
  try {
    const { syncAllAccounts } = require('../services/jobberClientSync');
    syncAllAccounts().catch((err) =>
      console.error('[marketing] Manual sync error:', err.message)
    );
    res.json({ message: 'Sync started — refresh clients in 15–30 seconds.' });
  } catch (err) {
    console.error('[marketing] POST /sync-clients error:', err.message);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// GET /api/marketing/jobber-account-status — diagnostic: shows linked Jobber account
router.get('/jobber-account-status', async (req, res) => {
  try {
    const userId  = req.user.userId;
    const account = await prisma.jobberAccount.findFirst({
      where:  { userId },
      select: { id: true, userId: true, accountId: true, createdAt: true },
    });
    const clientCount = await prisma.cachedJobberClient.count({ where: { userId } });
    res.json({ account, clientCount });
  } catch (err) {
    console.error('[marketing] GET /jobber-account-status error:', err.message);
    res.status(500).json({ error: 'Failed to load account status' });
  }
});

// ---------------------------------------------------------------------------
// Notify phone setting (admin's personal mobile for Y/N reply alerts)
// ---------------------------------------------------------------------------

// GET /api/marketing/notify-phone
router.get('/notify-phone', async (req, res) => {
  try {
    const cred = await prisma.twilioCredential.findUnique({
      where:  { userId: req.user.userId },
      select: { notifyPhone: true },
    });
    res.json({ notifyPhone: cred?.notifyPhone || null });
  } catch (err) {
    console.error('[marketing] GET /notify-phone error:', err.message);
    res.status(500).json({ error: 'Failed to load notify phone' });
  }
});

// PATCH /api/marketing/notify-phone
router.patch('/notify-phone', async (req, res) => {
  try {
    const { phone } = req.body;
    await prisma.twilioCredential.updateMany({
      where: { userId: req.user.userId },
      data:  { notifyPhone: phone ? phone.trim() : null },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] PATCH /notify-phone error:', err.message);
    res.status(500).json({ error: 'Failed to update notify phone' });
  }
});

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

// GET /api/marketing/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await prisma.marketingCampaign.findMany({
      where:   { userId: req.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ campaigns });
  } catch (err) {
    console.error('[marketing] GET /campaigns error:', err.message);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// GET /api/marketing/campaigns/:id
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await prisma.marketingCampaign.findFirst({
      where:   { id: req.params.id, userId: req.user.userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) {
    console.error('[marketing] GET /campaigns/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load campaign' });
  }
});

// POST /api/marketing/campaigns/send — create + dispatch async
router.post('/campaigns/send', async (req, res) => {
  try {
    const { name, templateId, audienceListId } = req.body;
    const userId = req.user.userId;

    if (!name || !templateId || !audienceListId) {
      return res.status(400).json({ error: 'Name, templateId, and audienceListId are required' });
    }

    // Validate template ownership
    const template = await prisma.marketingTemplate.findFirst({
      where: { id: templateId, userId },
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    // Validate audience ownership + load contacts
    const audience = await prisma.audienceList.findFirst({
      where:   { id: audienceListId, userId },
      include: { contacts: true },
    });
    if (!audience) return res.status(404).json({ error: 'Audience not found' });

    if (audience.contacts.length === 0) {
      return res.status(400).json({ error: 'Audience has no contacts' });
    }
    if (audience.contacts.length > MAX_RECIPIENTS) {
      return res.status(400).json({ error: `Audience exceeds ${MAX_RECIPIENTS} recipient safety limit` });
    }

    // Load opted-out phones so we can skip them
    const optedOutRecords = await prisma.cachedJobberClient.findMany({
      where:  { userId, optedOut: true },
      select: { phone: true },
    });
    const optedOutPhones = new Set(optedOutRecords.map((r) => r.phone).filter(Boolean));

    // Build message rows — mark skipped upfront for opted-out, no phone, or smsAllowed=false
    const messageRows = audience.contacts.map((c) => {
      const isOptedOut = c.phone && optedOutPhones.has(c.phone);
      const canSend    = c.phone && c.smsAllowed && !isOptedOut;
      return {
        jobberClientId: c.jobberClientId,
        clientName:     c.clientName,
        firstName:      c.firstName,
        phone:          c.phone,
        status:         canSend ? 'pending' : 'skipped',
        error:          canSend    ? null
                       : isOptedOut ? 'Opted out (STOP received)'
                       : !c.phone  ? 'No phone number'
                       : 'SMS not allowed',
      };
    });

    const skippedCount = messageRows.filter((m) => m.status === 'skipped').length;

    // Create campaign + all message rows in a transaction
    const campaign = await prisma.marketingCampaign.create({
      data: {
        userId,
        name:            name.trim(),
        templateId,
        audienceListId,
        messageBody:     template.body,
        status:          'pending',
        totalRecipients: messageRows.length,
        skippedCount,
        messages:        { create: messageRows },
      },
    });

    // Fire-and-forget dispatch — don't block the HTTP response
    dispatchCampaign(campaign.id, userId).catch((err) => {
      console.error(`[marketing] Async dispatch failed for campaign ${campaign.id}:`, err.message);
    });

    res.json({ campaignId: campaign.id, totalRecipients: messageRows.length, skippedCount });
  } catch (err) {
    console.error('[marketing] POST /campaigns/send error:', err.message);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// ---------------------------------------------------------------------------
// Inbox — inbound SMS replies from clients
// ---------------------------------------------------------------------------

// GET /api/marketing/inbox
router.get('/inbox', async (req, res) => {
  try {
    const messages = await prisma.inboundSMS.findMany({
      where:   { userId: req.user.userId },
      orderBy: { receivedAt: 'desc' },
      take:    200,
    });
    res.json(messages);
  } catch (err) {
    console.error('[marketing] GET /inbox error:', err.message);
    res.status(500).json({ error: 'Failed to load inbox' });
  }
});

// GET /api/marketing/inbox/unread-count
router.get('/inbox/unread-count', async (req, res) => {
  try {
    const count = await prisma.inboundSMS.count({
      where: { userId: req.user.userId, read: false },
    });
    res.json({ count });
  } catch (err) {
    console.error('[marketing] GET /inbox/unread-count error:', err.message);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// POST /api/marketing/inbox/mark-all-read
router.post('/inbox/mark-all-read', async (req, res) => {
  try {
    await prisma.inboundSMS.updateMany({
      where: { userId: req.user.userId, read: false },
      data:  { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] POST /inbox/mark-all-read error:', err.message);
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

// POST /api/marketing/inbox/:id/read
router.post('/inbox/:id/read', async (req, res) => {
  try {
    const msg = await prisma.inboundSMS.findFirst({
      where: { id: req.params.id, userId: req.user.userId },
    });
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    await prisma.inboundSMS.update({
      where: { id: req.params.id },
      data:  { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] POST /inbox/:id/read error:', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

module.exports = router;
