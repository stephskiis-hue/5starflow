const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const { dispatchCampaign, resetFailedForRetry, MAX_RECIPIENTS, ACCEPTED_STATUSES } = require('../services/marketingService');
const { toE164, calculateSegments, stripToGsm7, senderParams } = require('../services/smsService');
const logger = require('../lib/logger');

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

// POST /api/marketing/sync-clients — triggers a manual background sync (fire-and-forget)
router.post('/sync-clients', async (req, res) => {
  try {
    const { syncAllAccounts } = require('../services/jobberClientSync');
    syncAllAccounts().catch((err) =>
      console.error('[marketing] Manual sync error:', err.message)
    );
    res.json({ message: 'Sync started.' });
  } catch (err) {
    console.error('[marketing] POST /sync-clients error:', err.message);
    res.status(500).json({ error: 'Failed to start sync' });
  }
});

// GET /api/marketing/sync-status — poll sync progress (used by UI spinner)
router.get('/sync-status', (req, res) => {
  try {
    const { getSyncStatus } = require('../services/jobberClientSync');
    res.json(getSyncStatus());
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sync status' });
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

// GET /api/marketing/campaigns/:id — campaign + per-row messages + status counts
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await prisma.marketingCampaign.findFirst({
      where:   { id: req.params.id, userId: req.user.userId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Roll up actual row counts — authoritative, always accurate even mid-retry
    const grouped = await prisma.marketingMessage.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });
    const c = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const counts = {
      pending:  c.pending  || 0,
      retrying: c.retrying || 0,
      // queued = accepted by Twilio. 'sent' is the legacy spelling of the same
      // thing on rows written before delivery tracking existed.
      sent:     ACCEPTED_STATUSES.reduce((n, st) => n + (c[st] || 0), 0),
      failed:   c.failed   || 0,
      skipped:  c.skipped  || 0,
    };
    counts.total = counts.pending + counts.retrying + counts.sent + counts.failed + counts.skipped;

    // Delivery receipts — what actually reached a handset. Tracked separately
    // because they arrive asynchronously, long after dispatch finishes.
    const deliveryGrouped = await prisma.marketingMessage.groupBy({
      by: ['deliveryStatus'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    });
    const d = Object.fromEntries(
      deliveryGrouped.filter((g) => g.deliveryStatus).map((g) => [g.deliveryStatus, g._count._all])
    );
    const delivery = {
      delivered:   d.delivered   || 0,
      undelivered: (d.undelivered || 0) + (d.failed || 0),
      inFlight:    (d.queued || 0) + (d.sending || 0) + (d.sent || 0),
    };
    // Accepted by Twilio but no receipt of any kind yet.
    delivery.awaitingReceipt = Math.max(
      0, counts.sent - delivery.delivered - delivery.undelivered - delivery.inFlight
    );

    const segAgg = await prisma.marketingMessage.aggregate({
      where:  { campaignId: campaign.id, status: { notIn: ['skipped'] } },
      _sum:   { segments: true },
    });

    res.json({ campaign, counts, delivery, totalSegments: segAgg._sum.segments || 0 });
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
    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
    const optedOutPhones = new Set(optedOutRecords.map((r) => last10(r.phone)).filter(Boolean));

    // Build message rows — mark skipped upfront for opted-out, no phone, or smsAllowed=false.
    // Pre-resolve body per row so post-start template edits can't affect in-flight sends,
    // and so the retry worker has everything it needs without re-reading the campaign.
    const messageRows = audience.contacts.map((c) => {
      const isOptedOut = c.phone && optedOutPhones.has(last10(c.phone));
      const canSend    = c.phone && c.smsAllowed && !isOptedOut;
      const resolvedBody = (template.body || '').replace(/\{firstName\}/gi, c.firstName || 'there');
      // Segments are computed per row because {firstName} substitution changes
      // the length — and can tip a body over a segment boundary for some clients.
      const seg = calculateSegments(resolvedBody);
      return {
        userId,                               // denormalized for cron retry worker
        jobberClientId: c.jobberClientId,
        clientName:     c.clientName,
        firstName:      c.firstName,
        phone:          c.phone,
        body:           resolvedBody,
        segments:       seg.segments,
        encoding:       seg.encoding,
        status:         canSend ? 'pending' : 'skipped',
        error:          canSend    ? null
                       : isOptedOut ? 'Opted out (STOP received)'
                       : !c.phone  ? 'No phone number'
                       : 'SMS not allowed',
      };
    });

    const skippedCount = messageRows.filter((m) => m.status === 'skipped').length;

    // Cost + throughput estimate for the rows we will actually send. Logged so a
    // surprising bill or a slow-draining campaign is explainable after the fact.
    const sendable      = messageRows.filter((m) => m.status === 'pending');
    const totalSegments = sendable.reduce((sum, m) => sum + m.segments, 0);
    const encoding      = sendable.some((m) => m.encoding === 'UCS-2') ? 'UCS-2' : 'GSM-7';
    const segsPerSecond = Math.max(0.1, parseFloat(process.env.SMS_SEGMENTS_PER_SECOND) || 1);
    const estimate = {
      recipients:       sendable.length,
      totalSegments,
      encoding,
      // What the same campaign would cost stripped back to plain GSM-7 text.
      // The gap between these two numbers is what emoji and curly quotes cost.
      gsm7Segments:     sendable.reduce(
        (sum, m) => sum + calculateSegments(stripToGsm7(m.body)).segments, 0),
      estimatedMinutes: Math.ceil(totalSegments / segsPerSecond / 60),
    };

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

    await logger.info('campaign', 'Campaign queued for dispatch', {
      campaignId: campaign.id, name: campaign.name, skippedCount, ...estimate,
    }, userId);

    // Fire-and-forget dispatch — don't block the HTTP response
    dispatchCampaign(campaign.id, userId).catch((err) => {
      console.error(`[marketing] Async dispatch failed for campaign ${campaign.id}:`, err.message);
    });

    res.json({ campaignId: campaign.id, totalRecipients: messageRows.length, skippedCount, estimate });
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

// ---------------------------------------------------------------------------
// Conversations (iMessage-style threads — merges InboundSMS + MarketingMessage)
// ---------------------------------------------------------------------------

// GET /api/marketing/conversations — list all threads (one per unique phone).
// Batched: one query per table, then aggregate in memory. Avoids the
// per-phone N+1 that made this endpoint slow once inbox grew past ~50 clients.
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.user.userId;

    // Pull everything we need in 4 queries total (not 4 per phone).
    const [inboundAll, outboundAll, cachedClients] = await Promise.all([
      prisma.inboundSMS.findMany({
        where:  { userId },
        select: { from: true, receivedAt: true, body: true, read: true, sentiment: true },
        orderBy: { receivedAt: 'desc' },
      }),
      prisma.marketingMessage.findMany({
        where: {
          phone:    { not: null },
          status:   { notIn: ['skipped', 'pending'] },   // includes queued/sent/failed/retrying
          campaign: { userId },
        },
        orderBy: { sentAt: 'desc' },
        select: {
          phone: true,
          body:  true,
          sentAt: true,
          campaign: { select: { name: true, messageBody: true } },
        },
      }),
      prisma.cachedJobberClient.findMany({
        where: { userId },
        select: { phone: true, firstName: true, name: true, jobberClientId: true, optedOut: true },
      }),
    ]);

    // Index by phone
    const lastInboundByPhone  = new Map();
    const unreadByPhone       = new Map();
    for (const row of inboundAll) {
      if (!lastInboundByPhone.has(row.from)) lastInboundByPhone.set(row.from, row);
      if (!row.read) unreadByPhone.set(row.from, (unreadByPhone.get(row.from) || 0) + 1);
    }

    const lastOutboundByPhone = new Map();
    for (const row of outboundAll) {
      if (!lastOutboundByPhone.has(row.phone)) lastOutboundByPhone.set(row.phone, row);
    }

    const clientByPhone = new Map();
    for (const c of cachedClients) {
      if (c.phone) clientByPhone.set(c.phone, c);
    }

    const phoneSet = new Set([...lastInboundByPhone.keys(), ...lastOutboundByPhone.keys()]);

    const threads = [...phoneSet].map((phone) => {
      const lastInbound  = lastInboundByPhone.get(phone);
      const lastOutbound = lastOutboundByPhone.get(phone);
      const client       = clientByPhone.get(phone);

      const inAt  = lastInbound  ? new Date(lastInbound.receivedAt).getTime()  : 0;
      const outAt = lastOutbound ? new Date(lastOutbound.sentAt || 0).getTime() : 0;
      const lastMessageAt  = inAt > outAt ? lastInbound.receivedAt  : (lastOutbound?.sentAt || null);
      // Prefer per-row resolved body on outbound; fall back to raw template for legacy rows
      const lastMessage    = inAt > outAt
        ? lastInbound.body
        : (lastOutbound?.body || lastOutbound?.campaign?.messageBody || '');
      const lastMessageDir = inAt > outAt ? 'inbound' : 'outbound';

      return {
        phone,
        firstName:      client?.firstName      || null,
        clientName:     client?.name           || null,
        jobberClientId: client?.jobberClientId || null,
        optedOut:       client?.optedOut       || false,
        lastMessage:    (lastMessage || '').slice(0, 80),
        lastMessageAt,
        lastMessageDir,
        sentiment:      lastMessageDir === 'inbound' ? (lastInbound?.sentiment || null) : null,
        unreadCount:    unreadByPhone.get(phone) || 0,
      };
    });

    threads.sort((a, b) => {
      if (!a.lastMessageAt) return 1;
      if (!b.lastMessageAt) return -1;
      return new Date(b.lastMessageAt) - new Date(a.lastMessageAt);
    });

    res.json(threads);
  } catch (err) {
    console.error('[marketing] GET /conversations error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// GET /api/marketing/conversations/:phone — full thread (inbound + outbound merged)
router.get('/conversations/:phone', async (req, res) => {
  try {
    const userId = req.user.userId;
    const phone  = decodeURIComponent(req.params.phone);

    const inbound  = await prisma.inboundSMS.findMany({
      where:   { userId, from: phone },
      orderBy: { receivedAt: 'asc' },
    });

    const outbound = await prisma.marketingMessage.findMany({
      where:   { phone, status: { notIn: ['skipped', 'pending'] }, campaign: { userId } },
      orderBy: { sentAt: 'asc' },
      include: { campaign: { select: { name: true, messageBody: true } } },
    });

    const messages = [
      ...inbound.map(m => ({
        id:           m.id,
        direction:    'inbound',
        body:         m.body,
        timestamp:    m.receivedAt,
        status:       'received',
        response:     m.response,
        sentiment:    m.sentiment || null,
        campaignName: null,
        read:         m.read,
      })),
      ...outbound.map(m => ({
        id:           m.id,
        direction:    'outbound',
        body:         m.campaign?.messageBody || '',
        timestamp:    m.sentAt || m.createdAt,
        status:       m.status,
        response:     null,
        campaignName: m.campaign?.name || null,
        read:         true,
      })),
    ];

    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const client = await prisma.cachedJobberClient.findFirst({ where: { userId, phone } });

    res.json({
      phone,
      firstName:      client?.firstName      || null,
      clientName:     client?.name           || null,
      jobberClientId: client?.jobberClientId || null,
      optedOut:       client?.optedOut       || false,
      messages,
    });
  } catch (err) {
    console.error('[marketing] GET /conversations/:phone error:', err.message);
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

// POST /api/marketing/conversations/:phone/send — send a direct reply
router.post('/conversations/:phone/send', async (req, res) => {
  try {
    const userId  = req.user.userId;
    const phone   = decodeURIComponent(req.params.phone);
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const cred = await prisma.twilioCredential.findUnique({ where: { userId } });
    if (!cred) return res.status(400).json({ error: 'No Twilio credentials configured' });

    // Each direct send gets its own campaign row so messageBody is preserved per-message
    const campaign = await prisma.marketingCampaign.create({
      data: {
        userId,
        name:            'Direct Messages',
        templateId:      'direct',
        audienceListId:  'direct',
        messageBody:     message.trim(),
        status:          'complete',
        totalRecipients: 1,
        skippedCount:    0,
      },
    });

    let messageSid = null;
    let status     = 'queued';   // accepted by Twilio; delivery confirmed via callback
    let error      = null;

    if (process.env.DRY_RUN === 'true') {
      messageSid = 'DRY_RUN_' + Date.now();
    } else {
      try {
        const twilio = require('twilio');
        const tc     = twilio(cred.accountSid, cred.authToken);
        const params = { to: phone, ...senderParams(cred), body: message.trim() };
        // Ask for a delivery receipt like campaign sends do, so a direct reply
        // that the carrier drops doesn't sit in the thread looking delivered.
        if (process.env.APP_URL) params.statusCallback = `${process.env.APP_URL}/api/marketing/twilio-callback`;
        const sent   = await tc.messages.create(params);
        messageSid   = sent.sid;
      } catch (twilioErr) {
        error  = twilioErr.message;
        status = 'failed';
      }
    }

    const client = await prisma.cachedJobberClient.findFirst({ where: { userId, phone } });

    const directSeg = calculateSegments(message.trim());

    const msg = await prisma.marketingMessage.create({
      data: {
        campaignId:     campaign.id,
        userId,
        jobberClientId: client?.jobberClientId || 'direct',
        clientName:     client?.name           || phone,
        firstName:      client?.firstName      || '',
        phone,
        body:           message.trim(),
        segments:       directSeg.segments,
        encoding:       directSeg.encoding,
        status,
        messageSid,
        error,
        sentAt: new Date(),
      },
    });

    // Update campaign sentCount/failedCount
    await prisma.marketingCampaign.update({
      where: { id: campaign.id },
      data:  status === 'queued' ? { sentCount: 1 } : { failedCount: 1 },
    });

    res.json({ ok: true, messageId: msg.id, status, error });
  } catch (err) {
    console.error('[marketing] POST /conversations/:phone/send error:', err.message);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/marketing/conversations/:phone/read — mark all inbound from this phone as read
router.post('/conversations/:phone/read', async (req, res) => {
  try {
    const userId = req.user.userId;
    const phone  = decodeURIComponent(req.params.phone);
    await prisma.inboundSMS.updateMany({
      where: { userId, from: phone, read: false },
      data:  { read: true },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] POST /conversations/:phone/read error:', err.message);
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// ---------------------------------------------------------------------------
// Campaign delivery log + retry — powers the per-recipient status UI
// ---------------------------------------------------------------------------

// GET /api/marketing/campaigns/:id/messages?status=failed&limit=100&offset=0
router.get('/campaigns/:id/messages', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await prisma.marketingCampaign.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const status = req.query.status; // optional filter
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = { campaignId: campaign.id };
    if (status) where.status = status;

    const [messages, total] = await Promise.all([
      prisma.marketingMessage.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
        take:    limit,
        skip:    offset,
        select: {
          id: true, phone: true, clientName: true, firstName: true,
          status: true, attempts: true, messageSid: true,
          error: true, sentAt: true, lastAttemptAt: true, nextRetryAt: true,
          replyBody: true, replyReceivedAt: true, createdAt: true,
        },
      }),
      prisma.marketingMessage.count({ where }),
    ]);

    res.json({ messages, total, limit, offset });
  } catch (err) {
    console.error('[marketing] GET /campaigns/:id/messages error:', err.message);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /api/marketing/campaigns/:id/retry-failed — reset failed rows to retrying
router.post('/campaigns/:id/retry-failed', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await prisma.marketingCampaign.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const rowsReset = await resetFailedForRetry(campaign.id, userId);
    res.json({ ok: true, rowsReset });
  } catch (err) {
    console.error('[marketing] POST /campaigns/:id/retry-failed error:', err.message);
    res.status(500).json({ error: 'Failed to queue retry' });
  }
});

// POST /api/marketing/campaigns/:id/resume — manually kick dispatch for a campaign
router.post('/campaigns/:id/resume', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await prisma.marketingCampaign.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    dispatchCampaign(campaign.id, userId).catch((err) => {
      console.error(`[marketing] resume dispatch error: ${err.message}`);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[marketing] POST /campaigns/:id/resume error:', err.message);
    res.status(500).json({ error: 'Failed to resume campaign' });
  }
});

// ---------------------------------------------------------------------------
// AppLog viewer — app-wide structured logs (sms / campaign / webhook / etc.)
// ---------------------------------------------------------------------------

// GET /api/marketing/logs?category=sms&level=error&limit=200
router.get('/logs', async (req, res) => {
  try {
    const userId   = req.user.userId;
    const category = req.query.category || null;
    const level    = req.query.level    || null;
    const limit    = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const where = {
      OR: [{ userId }, { userId: null }], // include system-level rows that have no userId
    };
    if (category) where.category = category;
    if (level)    where.level    = level;

    const logs = await prisma.appLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select: { id: true, userId: true, category: true, level: true, message: true, context: true, createdAt: true },
    });
    res.json({ logs });
  } catch (err) {
    console.error('[marketing] GET /logs error:', err.message);
    res.status(500).json({ error: 'Failed to load logs' });
  }
});

module.exports = router;
