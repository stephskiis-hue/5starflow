const cron = require('node-cron');
const prisma = require('../lib/prismaClient');
const { jobberGraphQL } = require('./jobberClient');
const { sendReviewSMS } = require('./smsService');
const { sendReviewEmail } = require('./emailService');

const REVIEW_SENT_TAG = 'review-sent';

// Re-check tags just before sending — catches clients manually tagged
// during the 1-hour delay window
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

const ADD_CLIENT_TAG = `
  mutation AddClientTag($clientId: EncodedId!, $label: String!) {
    clientTagCreate(clientId: $clientId, label: $label) {
      tag { id label }
      errors { message path }
    }
  }
`;

// ---------------------------------------------------------------------------
// Main processor — runs every 1 minute
// ---------------------------------------------------------------------------

/**
 * Find all PendingReview rows whose scheduledAt has passed and send them.
 */
async function processPendingReviews() {
  const now = new Date();

  const pending = await prisma.pendingReview.findMany({
    where: {
      scheduledAt: { lte: now },
      processed: false,
      cancelled: false,
    },
  });

  if (pending.length === 0) return;

  console.log(`[deliveryQueue] ${pending.length} review(s) due — processing...`);

  for (const row of pending) {
    try {
      await processOneReview(row);
    } catch (err) {
      console.error(`[deliveryQueue] Unexpected error for invoice ${row.invoiceId}:`, err.message);
    }
  }
}

async function processOneReview(row) {
  const { id, invoiceId, clientId, clientName, firstName, phone, smsAllowed, email } = row;
  const tag = `[deliveryQueue][${clientName}]`;

  // --- Re-check Jobber tag (client may have been manually tagged during the 1hr wait) ---
  try {
    const result = await jobberGraphQL(GET_CLIENT_TAGS, { clientId });
    const tags = result?.client?.tags?.nodes?.map((t) => t.label.toLowerCase()) ?? [];
    if (tags.includes(REVIEW_SENT_TAG)) {
      console.log(`${tag} SKIP: Client now has "${REVIEW_SENT_TAG}" tag — marking processed`);
      await markProcessed(id);
      return;
    }
  } catch (err) {
    // Tag check failed — proceed anyway; ReviewSent is the backup dedup
    console.warn(`${tag} Could not re-check Jobber tags (proceeding):`, err.message);
  }

  // --- Re-check local ReviewSent table ---
  const alreadySent = await prisma.reviewSent.findUnique({ where: { clientId } });
  if (alreadySent) {
    console.log(`${tag} SKIP: Client already in ReviewSent table — marking processed`);
    await markProcessed(id);
    return;
  }

  let smsSent = false;
  let emailSent = false;

  // --- Path A: SMS (only if phone exists and SMS is allowed) ---
  if (phone && smsAllowed) {
    try {
      await sendReviewSMS(phone, firstName);
      smsSent = true;
    } catch (err) {
      console.error(`${tag} SMS failed (${phone}):`, err.message);
      // Non-fatal — email path still runs
    }
  } else {
    console.log(`${tag} SMS skipped — phone: ${phone || 'none'}, smsAllowed: ${smsAllowed}`);
  }

  // --- Path B: Email (always runs if email address available) ---
  if (email) {
    try {
      await sendReviewEmail(email, firstName);
      emailSent = true;
    } catch (err) {
      console.error(`${tag} Email failed (${email}):`, err.message);
      // Non-fatal
    }
  } else {
    console.log(`${tag} Email skipped — no email address on record`);
  }

  if (!smsSent && !emailSent) {
    console.warn(`${tag} Both delivery channels failed or unavailable — marking processed to prevent infinite retry`);
  }

  // --- Add "review-sent" tag in Jobber ---
  try {
    const tagResult = await jobberGraphQL(ADD_CLIENT_TAG, { clientId, label: REVIEW_SENT_TAG });
    const errors = tagResult?.clientTagCreate?.errors;
    if (errors?.length) {
      console.error(`${tag} Jobber tag errors:`, errors.map((e) => e.message).join('; '));
    } else {
      console.log(`${tag} Jobber tag "${REVIEW_SENT_TAG}" added`);
    }
  } catch (err) {
    // Non-fatal — ReviewSent table below handles dedup if tag fails
    console.error(`${tag} Failed to add Jobber tag:`, err.message);
  }

  // --- Write ReviewSent record (dedup backup) ---
  try {
    await prisma.reviewSent.upsert({
      where: { clientId },
      update: {},
      create: { clientId, invoiceId },
    });
  } catch (err) {
    console.error(`${tag} ReviewSent write failed:`, err.message);
  }

  // --- Mark PendingReview as done ---
  await markProcessed(id);
  console.log(`${tag} Done — SMS: ${smsSent}, Email: ${emailSent}`);
}

async function markProcessed(id) {
  await prisma.pendingReview.update({
    where: { id },
    data: { processed: true },
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Start the delivery queue processor.
 * Runs every 1 minute. Also runs immediately on startup to catch anything
 * that was due while the server was down.
 */
function startDeliveryQueue() {
  console.log('[deliveryQueue] Starting delivery queue processor (every 1 minute)');

  cron.schedule('* * * * *', async () => {
    await processPendingReviews().catch((err) => {
      console.error('[deliveryQueue] Scheduler error:', err.message);
    });
  });

  // Immediate run on startup
  processPendingReviews().catch((err) => {
    console.error('[deliveryQueue] Startup run error:', err.message);
  });
}

module.exports = { startDeliveryQueue, processPendingReviews };
