const { jobberGraphQL } = require('./jobberClient');
const prisma = require('../lib/prismaClient');

const REVIEW_SENT_TAG = 'review-sent';

// ---------------------------------------------------------------------------
// GraphQL: Fetch invoice → client → emails, phones, and existing tags
// in a single round-trip. Phone fields added to support SMS delivery.
// ---------------------------------------------------------------------------
const GET_INVOICE_WITH_CLIENT = `
  query GetInvoiceWithClient($invoiceId: EncodedId!) {
    invoice(id: $invoiceId) {
      id
      invoiceNumber
      invoiceStatus
      allowReviewRequest
      client {
        id
        name
        emails {
          address
          primary
        }
        phones {
          number
          primary
          smsAllowed
        }
        tags {
          nodes {
            label
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Main entry point — called by webhook.js and invoicePoller.js
// ---------------------------------------------------------------------------

/**
 * Handle a paid invoice event.
 *
 * Checks both deduplication layers then inserts a PendingReview row
 * (with scheduledAt = now + REVIEW_DELAY_MINUTES). The delivery queue
 * processes the row after the delay and does the actual sending.
 *
 * @param {object} invoiceData - { id, status, ... } from Jobber webhook payload
 */
async function handleInvoicePaid(invoiceData) {
  const invoiceId = invoiceData.id;
  const userId    = invoiceData.userId || null;
  console.log(`[reviewRequester] Processing paid invoice: ${invoiceId} (userId: ${userId})`);

  // --- Fetch full invoice + client details ---
  let invoice;
  try {
    const result = await jobberGraphQL(GET_INVOICE_WITH_CLIENT, { invoiceId }, userId);
    invoice = result?.invoice;
  } catch (err) {
    console.error(`[reviewRequester] GraphQL fetch failed for invoice ${invoiceId}:`, err.message);
    return;
  }

  if (!invoice) {
    console.warn(`[reviewRequester] Invoice ${invoiceId} not found via Jobber GraphQL — skipping`);
    return;
  }

  // Only proceed for paid invoices
  // invoiceStatus enum: check case-insensitively; allowReviewRequest is Jobber's own gate
  const isPaid = invoice.invoiceStatus?.toLowerCase() === 'paid';
  if (!isPaid) {
    console.log(`[reviewRequester] Invoice ${invoiceId} status is "${invoice.invoiceStatus}" — no action needed`);
    return;
  }

  if (invoice.allowReviewRequest === false) {
    console.log(`[reviewRequester] Invoice ${invoiceId} allowReviewRequest=false — Jobber says skip`);
    return;
  }

  const client = invoice.client;
  const clientId = client.id;
  const clientName = client.name;

  // --- Dedup layer 1: Jobber "review-sent" tag ---
  const jobberTags = client.tags?.nodes?.map((t) => t.label.toLowerCase()) ?? [];
  if (jobberTags.includes(REVIEW_SENT_TAG.toLowerCase())) {
    console.log(`[reviewRequester] SKIP: Client "${clientName}" already has "${REVIEW_SENT_TAG}" tag in Jobber`);
    return;
  }

  // --- Dedup layer 2: local ReviewSent table ---
  const alreadySent = await prisma.reviewSent.findUnique({ where: { clientId } });
  if (alreadySent) {
    console.log(`[reviewRequester] SKIP: Client "${clientName}" found in local ReviewSent table`);
    return;
  }

  // --- Extract contact details ---
  const phones = client.phones || [];
  const primaryPhone = phones.find((p) => p.primary) || phones[0] || null;
  const phone = primaryPhone?.number || null;
  const smsAllowed = primaryPhone?.smsAllowed === true;

  const emails = client.emails || [];
  const primaryEmail = emails.find((e) => e.primary)?.address || emails[0]?.address || null;

  // First word of client name as first name for personalization
  const firstName = clientName.trim().split(/\s+/)[0] || clientName;

  // --- Schedule send ---
  const delayMinutes = parseInt(process.env.REVIEW_DELAY_MINUTES, 10) || 60;
  const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);

  // --- Insert into PendingReview queue ---
  // invoiceId is UNIQUE — webhook retries / poller duplicates hit P2002 and are silently dropped
  try {
    await prisma.pendingReview.create({
      data: {
        invoiceId,
        clientId,
        clientName,
        firstName,
        phone,
        smsAllowed,
        email: primaryEmail,
        scheduledAt,
        userId,
      },
    });

    console.log(
      `[reviewRequester] Queued review for "${clientName}" (SMS:${phone ? 'yes' : 'no'}, Email:${primaryEmail ? 'yes' : 'no'}) — sends at ${scheduledAt.toISOString()}`
    );
  } catch (err) {
    if (err.code === 'P2002') {
      // Already queued — webhook retry or poller race, completely safe to ignore
      console.log(`[reviewRequester] SKIP: Invoice ${invoiceId} already in PendingReview queue`);
    } else {
      console.error(`[reviewRequester] Failed to queue review for "${clientName}":`, err.message);
    }
  }
}

module.exports = { handleInvoicePaid };
