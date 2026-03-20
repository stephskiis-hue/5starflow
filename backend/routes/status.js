const express = require('express');
const router = express.Router();
const prisma = require('../lib/prismaClient');

/**
 * GET /api/status
 * Returns the current Jobber connection state.
 * Frontend polls this to show connected/disconnected UI.
 *
 * Response:
 *   { connected: false }
 *   { connected: true, accountId, expiresAt, tokenExpired, minutesUntilExpiry }
 */
router.get('/status', async (req, res) => {
  try {
    const account =
      await prisma.jobberAccount.findFirst({ where: { userId: req.user.userId } }) ??
      await prisma.jobberAccount.findFirst();

    if (!account) {
      return res.json({ connected: false });
    }

    const now = new Date();
    const tokenExpired = account.expiresAt <= now;
    const minutesUntilExpiry = Math.round((account.expiresAt - now) / 60000);

    res.json({
      connected: true,
      accountId: account.accountId,
      expiresAt: account.expiresAt.toISOString(),
      tokenExpired,
      minutesUntilExpiry: tokenExpired ? 0 : minutesUntilExpiry,
      connectedSince: account.createdAt.toISOString(),
      lastUpdated: account.updatedAt.toISOString(),
      dryRun: process.env.DRY_RUN === 'true',
    });
  } catch (err) {
    console.error('[status] /api/status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

/**
 * GET /api/token-logs
 * Returns the most recent token refresh attempts (success + failures).
 * Powers the dashboard health monitor and frontend status widget.
 *
 * Query params:
 *   ?limit=N  (default 50, max 200)
 *
 * Response: Array of TokenRefreshLog rows, newest first.
 */
router.get('/token-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const logs = await prisma.tokenRefreshLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    res.json({ logs, count: logs.length });
  } catch (err) {
    console.error('[status] /api/token-logs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch token logs' });
  }
});

/**
 * GET /api/review-stats
 * Returns a count of review requests sent and list of recent ones.
 * Useful for verifying the webhook flow is working end-to-end.
 */
router.get('/review-stats', async (req, res) => {
  try {
    const total = await prisma.reviewSent.count();
    const recent = await prisma.reviewSent.findMany({
      orderBy: { sentAt: 'desc' },
      take: 20,
    });

    res.json({ total, recent });
  } catch (err) {
    console.error('[status] /api/review-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch review stats' });
  }
});

/**
 * GET /api/pending-reviews
 * Returns the current pending review queue.
 * Powers the dashboard queue card — shows who is waiting to receive a review request.
 *
 * Query params:
 *   ?processed=true   include already-sent rows (default: false = unprocessed only)
 *   ?limit=N          default 50, max 200
 */
router.get('/pending-reviews', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    // Default: return ALL rows (pending + sent + cancelled) for full history.
    // Filter with ?processed=true|false if needed.
    const where =
      req.query.processed === 'true'  ? { processed: true }  :
      req.query.processed === 'false' ? { processed: false } :
      {};

    const rows = await prisma.pendingReview.findMany({
      where,
      orderBy: { scheduledAt: 'desc' },  // newest first
      take: limit,
    });

    const now = new Date();
    const enriched = rows.map((r) => {
      let status;
      if (r.cancelled)                                                        status = 'cancelled';
      else if (r.processed && r.followUpSent)                                 status = 'follow-up-sent';
      else if (r.processed && r.followUpScheduledAt && !r.followUpSent)       status = 'follow-up-pending';
      else if (r.processed)                                                    status = 'sent';
      else if (r.scheduledAt <= now)                                           status = 'overdue';
      else                                                                     status = 'pending';

      return {
        id: r.id,
        clientName: r.clientName,
        phone: r.phone,
        smsAllowed: r.smsAllowed,
        email: r.email,
        scheduledAt: r.scheduledAt.toISOString(),
        processed: r.processed,
        cancelled: r.cancelled,
        channel: r.channel || null,
        followUpScheduledAt: r.followUpScheduledAt?.toISOString() || null,
        followUpSent: r.followUpSent,
        status,
        minutesUntilSend: (status === 'pending') ? Math.max(0, Math.round((r.scheduledAt - now) / 60000)) : null,
      };
    });

    const pendingCount = enriched.filter((r) => r.status === 'pending' || r.status === 'overdue').length;
    res.json({ count: enriched.length, pendingCount, queue: enriched });
  } catch (err) {
    console.error('[status] /api/pending-reviews error:', err.message);
    res.status(500).json({ error: 'Failed to fetch pending reviews' });
  }
});

/**
 * DELETE /api/pending-reviews/:id
 * Soft-cancels a pending review — marks cancelled:true so it won't be sent.
 * Already-processed (sent) rows cannot be cancelled.
 */
router.delete('/pending-reviews/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await prisma.pendingReview.findUnique({ where: { id } });

    if (!row) {
      return res.status(404).json({ error: 'Review not found' });
    }
    if (row.processed) {
      return res.status(400).json({ error: 'Cannot cancel — review has already been sent' });
    }
    if (row.cancelled) {
      return res.status(400).json({ error: 'Already cancelled' });
    }

    await prisma.pendingReview.update({ where: { id }, data: { cancelled: true } });
    console.log(`[status] Cancelled pending review for "${row.clientName}" (invoice: ${row.invoiceId})`);
    res.json({ success: true });
  } catch (err) {
    console.error('[status] DELETE /api/pending-reviews error:', err.message);
    res.status(500).json({ error: 'Failed to cancel review' });
  }
});

/**
 * GET /api/clients-list
 * Returns up to 50 clients from Jobber with contact info for the test-send modal.
 */
router.get('/clients-list', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');
    const data = await jobberGraphQL(`{
      clients(first: 50) {
        nodes {
          id
          name
          phones { number primary smsAllowed }
          emails { address primary }
        }
      }
    }`);
    const clients = (data?.clients?.nodes || []).map((c) => {
      const primaryPhone = c.phones?.find((p) => p.primary) || c.phones?.[0] || null;
      const primaryEmail = c.emails?.find((e) => e.primary)?.address || c.emails?.[0]?.address || null;
      return {
        id:         c.id,
        name:       c.name,
        phone:      primaryPhone?.number || null,
        smsAllowed: primaryPhone?.smsAllowed === true,
        email:      primaryEmail,
      };
    });
    res.json({ success: true, clients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/test-send-review
 * Dry-runs the full review-request flow for a specific client.
 * Always uses DRY_RUN mode regardless of env var — never actually sends.
 * Body: { clientId }
 */
router.post('/test-send-review', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId required' });

    // Fetch client details
    const data = await jobberGraphQL(`
      query GetClient($clientId: EncodedId!) {
        client(id: $clientId) {
          id name
          phones { number primary smsAllowed }
          emails { address primary }
          tags { nodes { label } }
        }
      }
    `, { clientId });

    const client = data?.client;
    if (!client) return res.status(404).json({ success: false, error: 'Client not found in Jobber' });

    const primaryPhone = client.phones?.find((p) => p.primary) || client.phones?.[0] || null;
    const phone      = primaryPhone?.number || null;
    const smsAllowed = primaryPhone?.smsAllowed === true;
    const email      = client.emails?.find((e) => e.primary)?.address || client.emails?.[0]?.address || null;
    const tags       = client.tags?.nodes?.map((t) => t.label.toLowerCase()) ?? [];
    const firstName  = client.name.trim().split(/\s+/)[0] || client.name;

    const hasReviewTag  = tags.includes('review-sent');
    const alreadyInDB   = !!(await prisma.reviewSent.findUnique({ where: { clientId } }));

    // Determine what channel would fire
    let channel = null;
    let wouldSend = false;
    if (!hasReviewTag && !alreadyInDB) {
      if (phone && smsAllowed) { channel = 'sms'; wouldSend = true; }
      else if (email)          { channel = 'email'; wouldSend = true; }
    }

    const result = {
      success: true,
      clientName: client.name,
      firstName,
      phone,
      smsAllowed,
      email,
      hasReviewTag,
      alreadyInDB,
      wouldSend,
      channel,
      followUpEmail: wouldSend && email ? email : null,
      skippedReason: !wouldSend
        ? hasReviewTag  ? 'Client already has "review-sent" tag in Jobber'
        : alreadyInDB   ? 'Client already in ReviewSent database'
        : !phone && !email ? 'No phone or email on file'
        : 'Unknown'
        : null,
    };

    console.log(`[status] TEST SEND — client: ${client.name} | channel: ${channel || 'none'} | wouldSend: ${wouldSend}`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test-clients
 * Fetches total client count + sample names from Jobber.
 * Use this to verify the full GraphQL pipeline is working end-to-end.
 */
router.get('/test-clients', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');
    const data = await jobberGraphQL(`{
      clients {
        totalCount
        nodes {
          id
          name
        }
      }
    }`);
    const clients = data?.clients;
    res.json({
      success: true,
      totalCount: clients?.totalCount ?? 0,
      sample: (clients?.nodes || []).slice(0, 5).map((c) => c.name),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test-graphql
 * Runs a minimal Jobber GraphQL query to verify API connectivity.
 * Use this to confirm the version header and auth token are working.
 */
router.get('/test-graphql', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');
    const data = await jobberGraphQL(`{ currentUser { id name } }`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/test-latest-invoice
 * Fetches the most recent invoice (by updatedAt) and returns key client details.
 */
router.get('/test-latest-invoice', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');

    const query = `
      query LatestInvoice($cursor: String) {
        invoices(after: $cursor) {
          nodes {
            id
            invoiceNumber
            updatedAt
            client {
              id
              name
              emails { address primary }
              phones { number primary smsAllowed }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    // Fetch first page and pick the most recently updated invoice from it.
    const data = await jobberGraphQL(query, { cursor: null });
    const nodes = data?.invoices?.nodes || [];

    if (!nodes.length) {
      return res.json({ success: true, invoice: null, message: 'No invoices found' });
    }

    const latest = nodes.reduce((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bTime > aTime ? b : a;
    });

    const client = latest.client || {};
    const phones = client.phones || [];
    const primaryPhone = phones.find((p) => p.primary) || phones[0] || null;
    const emails = client.emails || [];
    const primaryEmail = emails.find((e) => e.primary)?.address || emails[0]?.address || null;

    res.json({
      success: true,
      invoiceId: latest.id,
      invoiceNumber: latest.invoiceNumber,
      updatedAt: latest.updatedAt,
      client: {
        id: client.id || null,
        name: client.name || null,
        phone: primaryPhone?.number || null,
        smsAllowed: primaryPhone?.smsAllowed === true,
        email: primaryEmail || null,
      },
    });
  } catch (err) {
    console.error('[status] /api/test-latest-invoice error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/probe-version
 * Tries known Jobber API version dates until one succeeds.
 * Use this to find which X-JOBBER-GRAPHQL-VERSION value is valid for your app.
 */
router.get('/probe-version', async (req, res) => {
  const axios = require('axios');
  const { getValidAccessToken } = require('../services/jobberClient');

  const candidates = [
    '2022-07-14', '2023-01-01', '2023-06-01', '2023-11-15',
    '2024-01-01', '2024-04-01', '2024-07-01', '2024-10-01',
  ];

  let token;
  try {
    token = await getValidAccessToken();
  } catch (err) {
    return res.status(500).json({ error: 'No connected account: ' + err.message });
  }

  const results = [];
  for (const version of candidates) {
    try {
      const r = await axios.post(
        process.env.JOBBER_GRAPHQL_URL,
        { query: '{ __typename }' },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-JOBBER-GRAPHQL-VERSION': version,
          },
        }
      );
      results.push({ version, status: 200, data: r.data });
      break; // stop at first working version
    } catch (e) {
      results.push({ version, status: e.response?.status ?? 'ERR', error: e.response?.data });
    }
  }

  const working = results.find((r) => r.status === 200);
  res.json({ working: working?.version || null, results });
});

/**
 * GET /api/inspect-schema
 * Introspects the invoices query filter input type to get exact field names.
 */
router.get('/inspect-schema', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');

    const queryFields = await jobberGraphQL(`{
      __type(name: "Query") {
        fields {
          name
          args {
            name
            type { name kind ofType { name kind } }
          }
        }
      }
    }`);

    const invoicesArgs = queryFields?.__type?.fields
      ?.find((f) => f.name === 'invoices')?.args || [];

    const filterArg = invoicesArgs.find((a) => a.name === 'filter');
    const filterTypeName = filterArg?.type?.name || filterArg?.type?.ofType?.name;

    let filterFields = null;
    if (filterTypeName) {
      const filterType = await jobberGraphQL(`{
        __type(name: "${filterTypeName}") {
          inputFields {
            name
            type { name kind ofType { name kind enumValues { name } } }
          }
        }
      }`);
      filterFields = filterType?.__type?.inputFields;
    }

    res.json({ success: true, invoicesArgs, filterTypeName, filterFields });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/setup-status
 * Returns which configuration steps are complete.
 * Powers the dashboard setup checklist — drives conditional "how to" instructions.
 */
router.get('/setup-status', async (req, res) => {
  const clientIdConfigured   = !!process.env.JOBBER_CLIENT_ID && !process.env.JOBBER_CLIENT_ID.startsWith('<');
  const secretConfigured     = !!process.env.JOBBER_CLIENT_SECRET && !process.env.JOBBER_CLIENT_SECRET.startsWith('<');
  const reviewLinkConfigured = !!process.env.REVIEW_LINK && !process.env.REVIEW_LINK.startsWith('<');

  let jobberConnected    = false;
  let webhookRegistered  = false;
  try {
    const account =
      await prisma.jobberAccount.findFirst({ where: { userId: req.user.userId } }) ??
      await prisma.jobberAccount.findFirst();
    jobberConnected = !!account;

    // Check locally first; fall back to querying Jobber if webhookId not yet stored
    if (jobberConnected) {
      if (account.webhookId) {
        webhookRegistered = true;
      } else {
        const { jobberGraphQL } = require('../services/jobberClient');
        try {
          const data = await jobberGraphQL(`{ webhookEndpoints { nodes { id topic } } }`);
          const nodes = data?.webhookEndpoints?.nodes || [];
          const match = nodes.find((w) => w.topic === 'INVOICE_UPDATE');
          if (match) {
            webhookRegistered = true;
            // Backfill so future checks are instant
            await prisma.jobberAccount.updateMany({ data: { webhookId: match.id } });
          }
        } catch {
          webhookRegistered = false;
        }
      }
    }
  } catch {
    jobberConnected = false;
  }

  const needsSetup = !clientIdConfigured || !secretConfigured || !reviewLinkConfigured || !jobberConnected || !webhookRegistered;

  res.json({
    clientIdConfigured,
    secretConfigured,
    reviewLinkConfigured,
    jobberConnected,
    webhookRegistered,
    needsSetup,
  });
});

/**
 * POST /api/register-webhook
 * Registers this server's /webhook/jobber endpoint with Jobber via GraphQL.
 * Only needs to be called once. Uses JOBBER_REDIRECT_URI to derive the base URL.
 */
router.post('/register-webhook', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');

    // Derive webhook URL from JOBBER_REDIRECT_URI (replace /auth/callback suffix)
    const redirectUri  = process.env.JOBBER_REDIRECT_URI || '';
    const webhookUrl   = redirectUri.replace(/\/auth\/callback$/, '/webhook/jobber');

    if (!webhookUrl || !webhookUrl.startsWith('http')) {
      return res.status(400).json({ success: false, error: 'Could not derive webhook URL from JOBBER_REDIRECT_URI — check your .env' });
    }

    const data = await jobberGraphQL(
      `mutation WebhookEndpointCreate($url: String!, $topic: WebHookTopicEnum!) {
        webhookEndpointCreate(input: { url: $url, topic: $topic }) {
          webhookEndpoint { id url topic }
          userErrors { message path }
        }
      }`,
      { url: webhookUrl, topic: 'INVOICE_UPDATE' }
    );

    const result     = data?.webhookEndpointCreate;
    const userErrors = result?.userErrors || [];

    // If Jobber says one already exists, look it up and treat as success
    const alreadyExists = userErrors.some((e) => e.message?.toLowerCase().includes('one hook'));
    if (alreadyExists) {
      const { jobberGraphQL: gql } = require('../services/jobberClient');
      try {
        const listData = await gql(`{ webhookEndpoints { nodes { id topic } } }`);
        const existing = (listData?.webhookEndpoints?.nodes || []).find((w) => w.topic === 'INVOICE_UPDATE');
        if (existing) {
          await prisma.jobberAccount.updateMany({ data: { webhookId: existing.id } });
          console.log(`[status] Webhook already existed — id: ${existing.id}`);
          return res.json({ success: true, webhookId: existing.id, topic: existing.topic });
        }
        // List query worked but no match found — still confirmed by Jobber
      } catch { /* list query failed */ }
      // Jobber confirmed it exists — store sentinel and succeed
      await prisma.jobberAccount.updateMany({ data: { webhookId: 'registered' } });
      console.log('[status] Webhook already existed (sentinel stored)');
      return res.json({ success: true, webhookId: 'registered', topic: 'INVOICE_UPDATE' });
    }

    if (userErrors.length) {
      const msg = userErrors.map((e) => e.message).join('; ');
      return res.status(400).json({ success: false, error: msg });
    }

    const webhook = result?.webhookEndpoint;
    console.log(`[status] Webhook registered — id: ${webhook?.id}, url: ${webhook?.url}, topic: ${webhook?.topic}`);

    // Persist the webhook ID so setup-status can check it locally
    await prisma.jobberAccount.updateMany({ data: { webhookId: webhook?.id } });

    // Also register CLIENT_UPDATE webhook (for tag-removal detection)
    try {
      await jobberGraphQL(
        `mutation WebhookEndpointCreate($url: String!, $topic: WebHookTopicEnum!) {
          webhookEndpointCreate(input: { url: $url, topic: $topic }) {
            webhookEndpoint { id topic }
            userErrors { message }
          }
        }`,
        { url: webhookUrl, topic: 'CLIENT_UPDATE' }
      );
      console.log('[status] CLIENT_UPDATE webhook registered');
    } catch (err) {
      // Non-fatal — tag removal detection won't work but core flow is unaffected
      console.warn('[status] CLIENT_UPDATE webhook registration failed (non-fatal):', err.message);
    }

    res.json({ success: true, webhookId: webhook?.id, url: webhook?.url, topic: webhook?.topic });
  } catch (err) {
    console.error('[status] /api/register-webhook error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/inspect-invoice-type
 * Lists all fields on the Invoice GraphQL type to find the correct status field name.
 */
router.get('/inspect-invoice-type', async (req, res) => {
  try {
    const { jobberGraphQL } = require('../services/jobberClient');
    const data = await jobberGraphQL(`{
      __type(name: "Invoice") {
        fields { name type { name kind ofType { name kind } } }
      }
    }`);
    const fields = data?.__type?.fields?.map(f => ({
      name: f.name,
      type: f.type?.name || f.type?.ofType?.name || f.type?.kind,
    }));
    res.json({ fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/force-refresh
 * Immediately triggers a token refresh — use this to verify the refresh
 * mechanism works without waiting for the scheduler.
 */
router.post('/force-refresh', async (req, res) => {
  try {
    const account =
      await prisma.jobberAccount.findFirst({ where: { userId: req.user.userId } }) ??
      await prisma.jobberAccount.findFirst();
    if (!account) {
      return res.status(404).json({ error: 'No Jobber account connected' });
    }
    const { refreshAccessToken } = require('../services/jobberClient');
    await refreshAccessToken(account, 'manual');
    res.json({ success: true, message: 'Token refreshed — check Token Refresh Log below' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
