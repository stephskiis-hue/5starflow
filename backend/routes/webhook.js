const express = require('express');
const router = express.Router();
const { verifyWebhookSignature } = require('../middleware/verifyWebhook');
const { handleInvoicePaid } = require('../services/reviewRequester');
const { jobberGraphQL } = require('../services/jobberClient');
const prisma = require('../lib/prismaClient');

const REVIEW_SENT_TAG = 'review-sent';

const GET_CLIENT_TAGS = `
  query GetClientTags($clientId: EncodedId!) {
    client(id: $clientId) {
      tags {
        nodes {
          label
        }
      }
    }
  }
`;

/**
 * POST /webhook/jobber
 *
 * Jobber webhook payload structure:
 * {
 *   "data": {
 *     "webHookEvent": {
 *       "topic":      "INVOICE_UPDATE",
 *       "appId":      "...",
 *       "accountId":  "...",
 *       "itemId":     "<EncodedId of the invoice>",
 *       "occurredAt": "2026-03-14T18:32:16Z"
 *     }
 *   }
 * }
 *
 * Note: Jobber does NOT include invoice status in the webhook payload.
 * handleInvoicePaid fetches the invoice from GraphQL and checks status there.
 */
router.post(
  '/jobber',
  express.raw({ type: '*/*' }),
  verifyWebhookSignature,
  async (req, res) => {
    const event = req.parsedBody?.data?.webHookEvent;

    if (!event) {
      console.warn('[webhook] Unexpected payload shape — missing data.webHookEvent');
      return res.status(200).json({ received: true });
    }

    const { topic, accountId, itemId } = event;
    console.log(`[webhook] Received topic: ${topic} | Account: ${accountId} | Item: ${itemId}`);

    // Acknowledge immediately
    res.status(200).json({ received: true });

    if (topic === 'INVOICE_UPDATE' && itemId) {
      // Look up the userId associated with this Jobber account so review
      // requests are scoped to the correct portal user.
      prisma.jobberAccount.findFirst({ where: { accountId } })
        .then((account) => {
          handleInvoicePaid({ id: itemId, userId: account?.userId || null });
        })
        .catch((err) => {
          console.error('[webhook] handleInvoicePaid error:', err.message);
        });
    }

    if (topic === 'CLIENT_UPDATE' && itemId) {
      // itemId is the clientId — check if "review-sent" tag was removed
      prisma.jobberAccount.findFirst({ where: { accountId } })
        .then(async (account) => {
          const userId = account?.userId || null;
          try {
            const result = await jobberGraphQL(GET_CLIENT_TAGS, { clientId: itemId }, userId);
            const tags = result?.client?.tags?.nodes?.map((t) => t.label.toLowerCase()) ?? [];

            if (!tags.includes(REVIEW_SENT_TAG)) {
              // Tag is gone — check if they're in our ReviewSent table
              const existing = await prisma.reviewSent.findUnique({ where: { clientId: itemId } });
              if (existing) {
                await prisma.reviewSent.delete({ where: { clientId: itemId } });
                console.log(`[webhook] CLIENT_UPDATE: "review-sent" tag removed for client ${itemId} — deleted from ReviewSent, client is re-eligible`);
              }
            }
          } catch (err) {
            console.error('[webhook] CLIENT_UPDATE tag check failed:', err.message);
          }
        })
        .catch((err) => {
          console.error('[webhook] CLIENT_UPDATE account lookup failed:', err.message);
        });
    }
  }
);

module.exports = router;
