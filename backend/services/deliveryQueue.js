const cron = require('node-cron');
const { runRoutine } = require('../ai/runner');
const prisma = require('../lib/prismaClient');
const { jobberGraphQL } = require('./jobberClient');
const { sendReviewSMS } = require('./smsService');
const { sendReviewEmail, sendFollowUpEmail } = require('./emailService');

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
let reviewTickRunning = false;

async function processPendingReviews() {
  // The cron fires every minute; a slow tick (Jobber/Twilio latency) must not overlap itself
  // or the same review can be sent twice before ReviewSent is written.
  if (reviewTickRunning) return { skipped: true, summary: 'previous tick still running' };
  reviewTickRunning = true;
  try {
    return await processPendingReviewsOnce();
  } finally {
    reviewTickRunning = false;
  }
}

async function processPendingReviewsOnce() {
  const now = new Date();

  const pending = await prisma.pendingReview.findMany({
    where: {
      scheduledAt: { lte: now },
      processed: false,
      cancelled: false,
    },
  });

  if (pending.length === 0) return { items_found: 0 };

  console.log(`[deliveryQueue] ${pending.length} review(s) due — processing...`);

  const outcomes = { sms: 0, email: 0, skipped: 0, retry: 0, errors: 0 };
  for (const row of pending) {
    try {
      const o = await processOneReview(row);
      outcomes[o] = (outcomes[o] || 0) + 1;
    } catch (err) {
      outcomes.errors++;
      console.error(`[deliveryQueue] Unexpected error for invoice ${row.invoiceId}:`, err.message);
    }
  }
  const sent = outcomes.sms + outcomes.email;
  return {
    items_found: pending.length,
    requires_attention: outcomes.retry + outcomes.errors,
    actions_taken: sent ? [`Sent ${sent} review request(s) (${outcomes.sms} SMS, ${outcomes.email} email)`] : [],
    summary: `${pending.length} due: ${sent} sent, ${outcomes.skipped} skipped, ${outcomes.retry} will retry, ${outcomes.errors} errors`,
  };
}

async function processOneReview(row) {
  const { id, invoiceId, clientId, clientName, firstName, phone, smsAllowed, email, userId } = row;
  const tag = `[deliveryQueue][${clientName}]`;

  // --- Re-check Jobber tag (client may have been manually tagged during the 1hr wait) ---
  try {
    const result = await jobberGraphQL(GET_CLIENT_TAGS, { clientId }, userId);
    const tags = result?.client?.tags?.nodes?.map((t) => t.label.toLowerCase()) ?? [];
    if (tags.includes(REVIEW_SENT_TAG)) {
      console.log(`${tag} SKIP: Client now has "${REVIEW_SENT_TAG}" tag — marking processed`);
      await markProcessed(id);
      return 'skipped';
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
    return 'skipped';
  }

  let smsSent = false;
  let emailSent = false;
  let smsPermanentFail = false;

  // --- Exclusive channel selection ---
  // phone + smsAllowed → SMS only
  // phone + !smsAllowed, or no phone + email → email only
  // no contact method → log and bail
  if (phone && smsAllowed) {
    try {
      await sendReviewSMS(phone, firstName, userId);
      smsSent = true;
    } catch (err) {
      if (err.skip) {
        console.log(`${tag} SKIP: ${err.message} — marking processed`);
        await markProcessed(id);
        return 'skipped';
      }
      console.error(`${tag} SMS failed (${phone}):`, err.message);
      smsPermanentFail = !!err.permanent;
    }
  } else if (email) {
    try {
      await sendReviewEmail(email, firstName, userId);
      emailSent = true;
    } catch (err) {
      console.error(`${tag} Email failed (${email}):`, err.message);
    }
  } else {
    console.warn(`${tag} No contact method available — marking processed`);
    await markProcessed(id);
    return 'skipped';
  }

  // A permanently undeliverable number (invalid, landline) will never work: try email once, otherwise stop retrying.
  if (!smsSent && !emailSent && smsPermanentFail) {
    if (email) {
      try { await sendReviewEmail(email, firstName, userId); emailSent = true; }
      catch (err) { console.error(`${tag} Email fallback failed (${email}):`, err.message); }
    }
    if (!emailSent) {
      console.error(`${tag} SMS number is permanently undeliverable and no email worked — marking processed WITHOUT review-sent tag`);
      await markProcessed(id);
      return 'skipped';
    }
  }

  // --- A failed send must NOT be recorded as sent (the client would be suppressed forever) ---
  if (!smsSent && !emailSent) {
    const ageMs = Date.now() - new Date(row.createdAt).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      console.error(`${tag} Giving up after 24h of failed sends — marking processed WITHOUT review-sent tag`);
      await markProcessed(id);
    } else {
      await prisma.pendingReview.update({ where: { id }, data: { scheduledAt: new Date(Date.now() + 15 * 60 * 1000) } });
      console.warn(`${tag} Send failed — will retry in 15 min`);
      return 'retry';
    }
    return 'skipped';
  }

  // DRY_RUN: no real message went out, so don't tag the client in Jobber or write the dedup row.
  if (process.env.DRY_RUN === 'true') {
    console.log(`${tag} DRY RUN — skipping Jobber tag + ReviewSent record`);
    await markProcessed(id);
    return 'skipped';
  }

  // --- Add "review-sent" tag in Jobber ---
  try {
    const tagResult = await jobberGraphQL(ADD_CLIENT_TAG, { clientId, label: REVIEW_SENT_TAG }, userId);
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
    const acctRow = await prisma.jobberAccount.findFirst({ where: { userId: userId || undefined } });
    await prisma.reviewSent.upsert({
      where:  { clientId },
      update: {},
      create: { clientId, invoiceId, accountId: acctRow?.accountId || null },
    });
  } catch (err) {
    console.error(`${tag} ReviewSent write failed:`, err.message);
  }

  // --- Schedule 24-hour follow-up email if client has an email address ---
  const followUpScheduledAt = email ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

  // --- Mark PendingReview as done, record channel + follow-up schedule ---
  await prisma.pendingReview.update({
    where: { id },
    data: {
      processed:           true,
      channel:             smsSent ? 'sms' : 'email',
      followUpScheduledAt,
    },
  });

  console.log(
    `${tag} Done — channel: ${smsSent ? 'SMS' : 'Email'}` +
    (followUpScheduledAt ? ` | follow-up scheduled at ${followUpScheduledAt.toISOString()}` : '')
  );
  return smsSent ? 'sms' : 'email';
}

async function markProcessed(id) {
  await prisma.pendingReview.update({
    where: { id },
    data: { processed: true },
  });
}

// ---------------------------------------------------------------------------
// Follow-up processor — sends the 24h "professional" follow-up email
// ---------------------------------------------------------------------------

async function processFollowUps() {
  const now = new Date();

  const due = await prisma.pendingReview.findMany({
    where: {
      processed:           true,
      cancelled:           false,
      followUpSent:        false,
      followUpScheduledAt: { lte: now },
      email:               { not: null },
    },
  });

  if (due.length === 0) return { items_found: 0 };

  console.log(`[deliveryQueue] ${due.length} follow-up(s) due — processing...`);

  let done = 0;
  for (const row of due) {
    try {
      await processOneFollowUp(row);
      done++;
    } catch (err) {
      console.error(`[deliveryQueue] Follow-up error for invoice ${row.invoiceId}:`, err.message);
    }
  }
  return { items_found: due.length, actions_taken: done ? [`Processed ${done} review follow-up email(s)`] : [] };
}

async function processOneFollowUp(row) {
  const { id, clientName, firstName, email, userId } = row;
  const tag = `[deliveryQueue][follow-up][${clientName}]`;

  try {
    await sendFollowUpEmail(email, firstName, userId);
    console.log(`${tag} Follow-up email sent to ${email}`);
  } catch (err) {
    console.error(`${tag} Follow-up email failed:`, err.message);
  }

  await prisma.pendingReview.update({
    where: { id },
    data:  { followUpSent: true },
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
    await runRoutine('review-delivery-queue', processPendingReviews, { quiet: true });
    await runRoutine('review-followup-email', processFollowUps, { quiet: true });
  });

  // Immediate run on startup
  runRoutine('review-delivery-queue', processPendingReviews, { quiet: true, trigger: 'startup' });
  runRoutine('review-followup-email', processFollowUps, { quiet: true, trigger: 'startup' });
}

module.exports = { startDeliveryQueue, processPendingReviews };
