const express = require('express');
const router = express.Router();
const { verifyWebhookSignature } = require('../middleware/verifyWebhook');
const { handleInvoicePaid } = require('../services/reviewRequester');

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
      // handleInvoicePaid fetches the invoice from Jobber GraphQL and checks
      // whether status === 'paid' before queuing a review request
      handleInvoicePaid({ id: itemId }).catch((err) => {
        console.error('[webhook] handleInvoicePaid error:', err.message);
      });
    }
  }
);

module.exports = router;
