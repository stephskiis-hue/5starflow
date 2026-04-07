const express = require('express');
const router = express.Router();
const prisma = require('../lib/prismaClient');
const { Prisma } = require('@prisma/client');

const { syncClientsForUser, getSyncStatus } = require('../services/campaignSync');

function normalizeType(t) {
  const s = String(t || '').trim().toUpperCase();
  if (s === 'SMS' || s === 'EMAIL') return s;
  return null;
}

function effectiveChannel(campaignType, channelOverride) {
  const override = channelOverride ? String(channelOverride).trim().toUpperCase() : null;
  return override || campaignType;
}

function isEligibleForChannel(client, channel) {
  if (channel === 'SMS') return client?.isSmsEligible === true;
  if (channel === 'EMAIL') return client?.isEmailEligible === true;
  return false;
}

async function requireJobberAccountForUser(userId) {
  const account = await prisma.jobberAccount.findFirst({ where: { userId } });
  if (!account) {
    const err = new Error('No Jobber account connected for this user. Go to Connections and connect Jobber first.');
    err.statusCode = 400;
    throw err;
  }
  return account;
}

async function loadCampaignOrThrow(userId, campaignId) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
  });
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// Sync Jobber -> CampaignClient
// ---------------------------------------------------------------------------

// POST /api/campaigns/sync-clients (fire-and-forget)
router.post('/sync-clients', async (req, res) => {
  try {
    const userId = req.user.userId;
    await requireJobberAccountForUser(userId);

    const status = getSyncStatus();
    if (status.status === 'running') {
      return res.json({ message: 'Sync already running', status });
    }

    const minAvailablePoints = Math.max(0, parseInt(req.query.minPoints, 10) || 1000);
    const dryRun = req.query.dryRun === 'true';

    syncClientsForUser(userId, { dryRun, minAvailablePoints }).catch((err) => {
      console.error('[campaigns] Sync failed:', err.message);
    });

    res.json({ message: 'Sync started', dryRun, minAvailablePoints });
  } catch (err) {
    console.error('[campaigns] POST /sync-clients error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to start sync' });
  }
});

// GET /api/campaigns/sync-status
router.get('/sync-status', (req, res) => {
  try {
    res.json(getSyncStatus());
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// ---------------------------------------------------------------------------
// Clients + Tags
// ---------------------------------------------------------------------------

// GET /api/campaigns/clients?tag=...&q=...&eligible=sms|email&take=100&skip=0
router.get('/clients', async (req, res) => {
  try {
    const userId = req.user.userId;

    const take = Math.min(Math.max(parseInt(req.query.take, 10) || 100, 1), 500);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

    const q = String(req.query.q || '').trim();
    const tag = String(req.query.tag || '').trim();
    const eligible = String(req.query.eligible || '').trim().toLowerCase(); // sms|email

    const whereParts = [Prisma.sql`"userId" = ${userId}`];
    if (q) whereParts.push(Prisma.sql`"fullName" ILIKE ${'%' + q + '%'}`);
    if (eligible === 'sms') whereParts.push(Prisma.sql`"isSmsEligible" = true`);
    if (eligible === 'email') whereParts.push(Prisma.sql`"isEmailEligible" = true`);
    if (tag) whereParts.push(Prisma.sql`tags @> ${JSON.stringify([tag])}::jsonb`);

    const whereSql = Prisma.join(whereParts, Prisma.sql` AND `);

    const totalRows = await prisma.$queryRaw(
      Prisma.sql`SELECT COUNT(*)::int AS count FROM clients WHERE ${whereSql}`
    );
    const total = totalRows?.[0]?.count ?? 0;

    const clients = await prisma.$queryRaw(
      Prisma.sql`
        SELECT
          "id",
          "fullName",
          "primaryPhone",
          "primaryEmail",
          "smsAllowedFlag",
          "smsConsentStatus",
          "emailConsentStatus",
          "isSmsEligible",
          "isEmailEligible",
          "tags",
          "optedOut",
          "optedOutAt",
          "syncedAt",
          "updatedAt"
        FROM clients
        WHERE ${whereSql}
        ORDER BY "updatedAt" DESC
        LIMIT ${take} OFFSET ${skip}
      `
    );

    res.json({ total, take, skip, clients });
  } catch (err) {
    console.error('[campaigns] GET /clients error:', err.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// GET /api/campaigns/tags
router.get('/tags', async (req, res) => {
  try {
    const userId = req.user.userId;
    const rows = await prisma.$queryRaw(
      Prisma.sql`
        SELECT tag, COUNT(*)::int AS count
        FROM clients c,
        LATERAL jsonb_array_elements_text(c.tags) AS tag
        WHERE c."userId" = ${userId}
        GROUP BY tag
        ORDER BY COUNT(*) DESC, tag ASC
      `
    );
    res.json({ tags: rows || [] });
  } catch (err) {
    console.error('[campaigns] GET /tags error:', err.message);
    res.status(500).json({ error: 'Failed to load tags' });
  }
});

// ---------------------------------------------------------------------------
// Campaigns CRUD
// ---------------------------------------------------------------------------

// GET /api/campaigns
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaigns = await prisma.campaign.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { members: true } } },
    });
    res.json({ campaigns });
  } catch (err) {
    console.error('[campaigns] GET / error:', err.message);
    res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

// POST /api/campaigns
router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, type } = req.body || {};

    const safeName = String(name || '').trim();
    const safeType = normalizeType(type);

    if (!safeName) return res.status(400).json({ error: 'Campaign name is required' });
    if (safeName.length > 120) return res.status(400).json({ error: 'Campaign name too long (max 120 chars)' });
    if (!safeType) return res.status(400).json({ error: 'Campaign type must be SMS or EMAIL' });

    const jobberAccount = await requireJobberAccountForUser(userId);

    const campaign = await prisma.campaign.create({
      data: {
        userId,
        jobberAccountId: jobberAccount.id,
        name: safeName,
        type: safeType,
        status: 'draft',
      },
    });

    res.json({ campaign });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A campaign with this name/type already exists' });
    }
    console.error('[campaigns] POST / error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to create campaign' });
  }
});

// GET /api/campaigns/:id
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await loadCampaignOrThrow(userId, req.params.id);

    const counts = await prisma.campaignMember.groupBy({
      by: ['status'],
      where: { campaignId: campaign.id },
      _count: { _all: true },
    }).catch(() => []);

    res.json({ campaign, statusCounts: counts });
  } catch (err) {
    console.error('[campaigns] GET /:id error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to load campaign' });
  }
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

// GET /api/campaigns/:id/members?includeRemoved=true
router.get('/:id/members', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await loadCampaignOrThrow(userId, req.params.id);
    const includeRemoved = req.query.includeRemoved === 'true';

    const members = await prisma.campaignMember.findMany({
      where: { campaignId: campaign.id, ...(includeRemoved ? {} : { isRemoved: false }) },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        client: {
          select: {
            id: true,
            fullName: true,
            primaryPhone: true,
            primaryEmail: true,
            isSmsEligible: true,
            isEmailEligible: true,
            tags: true,
            optedOut: true,
            syncedAt: true,
          },
        },
      },
    });

    const enriched = members.map((m) => {
      const eff = effectiveChannel(campaign.type, m.channelOverride);
      const sendable = isEligibleForChannel(m.client, eff) && !m.isRemoved;
      return {
        ...m,
        effectiveChannel: eff,
        isSendable: sendable,
      };
    });

    res.json({ campaign, members: enriched });
  } catch (err) {
    console.error('[campaigns] GET /:id/members error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to load members' });
  }
});

// POST /api/campaigns/:id/bulk-add { tag }
router.post('/:id/bulk-add', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { tag } = req.body || {};
    const safeTag = String(tag || '').trim();
    if (!safeTag) return res.status(400).json({ error: 'tag is required' });

    const campaign = await loadCampaignOrThrow(userId, req.params.id);

    // Select candidate clients for this campaign's Jobber account + tag
    const candidates = await prisma.$queryRaw(
      Prisma.sql`
        SELECT "id", "isSmsEligible", "isEmailEligible"
        FROM clients
        WHERE "userId" = ${userId}
          AND "jobberAccountId" = ${campaign.jobberAccountId}
          AND tags @> ${JSON.stringify([safeTag])}::jsonb
      `
    );

    if (!candidates || candidates.length === 0) {
      return res.json({ attempted: 0, added: 0, message: 'No matching clients for this tag' });
    }

    const rows = candidates.map((c) => {
      let channelOverride = null;
      let status = 'pending';
      let lastError = null;

      if (campaign.type === 'SMS') {
        if (c.isSmsEligible === true) {
          channelOverride = null;
        } else if (c.isEmailEligible === true) {
          channelOverride = 'EMAIL';
        } else {
          status = 'skipped';
          lastError = 'Not eligible for SMS or Email';
        }
      } else {
        if (c.isEmailEligible === true) {
          channelOverride = null;
        } else if (c.isSmsEligible === true) {
          channelOverride = 'SMS';
        } else {
          status = 'skipped';
          lastError = 'Not eligible for Email or SMS';
        }
      }

      return {
        campaignId: campaign.id,
        clientId: c.id,
        status,
        channelOverride,
        lastError,
      };
    });

    const created = await prisma.campaignMember.createMany({
      data: rows,
      skipDuplicates: true,
    });

    res.json({ attempted: rows.length, added: created.count, tag: safeTag });
  } catch (err) {
    console.error('[campaigns] POST /:id/bulk-add error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to bulk add' });
  }
});

// PATCH /api/campaigns/:id/members/:clientId { channelOverride, isRemoved }
router.patch('/:id/members/:clientId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const campaign = await loadCampaignOrThrow(userId, req.params.id);
    const clientId = req.params.clientId;

    const member = await prisma.campaignMember.findUnique({
      where: { campaignId_clientId: { campaignId: campaign.id, clientId } },
      include: {
        client: { select: { isSmsEligible: true, isEmailEligible: true } },
      },
    });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const patch = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'isRemoved')) {
      patch.isRemoved = req.body.isRemoved === true;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'channelOverride')) {
      const requested = req.body.channelOverride === null ? null : normalizeType(req.body.channelOverride);
      if (req.body.channelOverride !== null && !requested) {
        return res.status(400).json({ error: 'channelOverride must be SMS, EMAIL, or null' });
      }

      // Normalize: override equal to default campaign type => store null
      const normalizedOverride = requested && requested === campaign.type ? null : requested;
      const eff = effectiveChannel(campaign.type, normalizedOverride);
      if (!isEligibleForChannel(member.client, eff)) {
        return res.status(400).json({ error: `Client is not eligible for ${eff}` });
      }
      patch.channelOverride = normalizedOverride;
    }

    const updated = await prisma.campaignMember.update({
      where: { campaignId_clientId: { campaignId: campaign.id, clientId } },
      data: patch,
    });

    res.json({ member: updated });
  } catch (err) {
    console.error('[campaigns] PATCH /:id/members/:clientId error:', err.message);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to update member' });
  }
});

module.exports = router;

