const twilio = require('twilio');
const prisma = require('../lib/prismaClient');
const logger = require('../lib/logger');

const REVIEW_LINK = process.env.REVIEW_LINK || 'https://g.page/r/CSu2cqDYFOxDEAE/review';

const DEFAULT_SMS_TEMPLATE =
  'Hi {firstName}! We hope you\'re loving the look of your property! ' +
  'We put in the sweat so you didn\'t have to—we\'d love to hear what you think of the results. 🫡 \n\n' +
  '{reviewLink} — Much appreciated! ⭐️⭐️⭐️⭐️⭐️';

// Twilio error codes that are permanent (NEVER retry):
//   21211 invalid 'To' number
//   21408 permission denied (unverified / blocked region)
//   21610 opt-out list
//   21614 not a mobile number
//   21612 not reachable
//   21211 invalid number
//   21606 'From' not enabled for SMS
//   21617 body too long
//   21421 invalid number (Twilio-side format)
//   30003 unreachable destination handset
//   30005 unknown destination handset
//   30006 landline / unreachable carrier
//   30007 filtered by carrier
const PERMANENT_TWILIO_CODES = new Set([
  21211, 21408, 21610, 21614, 21612, 21606, 21617, 21421, 30003, 30005, 30006, 30007,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load Twilio credentials for a user from DB.
 * Falls back to env vars if no DB credential found (local dev).
 */
async function getTwilioCreds(userId) {
  if (userId) {
    const cred = await prisma.twilioCredential.findUnique({ where: { userId } });
    if (cred) {
      return { accountSid: cred.accountSid, authToken: cred.authToken, fromNumber: cred.fromNumber };
    }
  }
  // Fallback to env vars
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken:  process.env.TWILIO_AUTH_TOKEN,
    fromNumber: process.env.TWILIO_FROM_NUMBER || '+14314509814',
  };
}

/**
 * Normalize a phone number to E.164 format for Twilio.
 * Jobber stores numbers in local format, e.g. "780-123-4567" or "17801234567".
 * Twilio requires "+17801234567".
 *
 * @param {string} raw - raw phone number from Jobber
 * @param {string} countryCode - default "1" (Canada/US)
 * @returns {string} E.164 formatted number
 */
function toE164(raw, countryCode = '1') {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+${countryCode}${digits}`;
  if (digits.length === 11 && digits.startsWith(countryCode)) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`; // already long-form, trust it
  return `+${countryCode}${digits}`; // best effort
}

/**
 * Classify a Twilio error as permanent (don't retry) or transient (retry).
 * Transient: network errors, 5xx, 429, Twilio code 20429 queue overflow.
 * Permanent: invalid number, opt-out, landline, carrier filter, etc.
 */
function classifyTwilioError(err) {
  const code   = err?.code;
  const status = err?.status;
  const msg    = err?.message || '';

  if (code && PERMANENT_TWILIO_CODES.has(code)) {
    return { permanent: true, errorCode: code, errorMessage: msg };
  }
  // Twilio's 429 Queue Overflow / rate-limit codes — retry
  if (code === 20429 || code === 20003 /* auth race */) {
    return { permanent: false, errorCode: code, errorMessage: msg };
  }
  // HTTP status signals
  if (status === 401 || status === 403) {
    return { permanent: true, errorCode: code || status, errorMessage: msg };
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return { permanent: false, errorCode: code || status, errorMessage: msg };
  }
  // Network-level errors (axios / node)
  if (err?.code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(err.code)) {
    return { permanent: false, errorCode: err.code, errorMessage: msg };
  }
  // Unknown — treat as transient so retry worker gets another shot (capped at maxAttempts)
  return { permanent: false, errorCode: code || status || 'UNKNOWN', errorMessage: msg };
}

/**
 * Hardened Twilio send — ALWAYS returns a structured result, never throws.
 * Does up to `inFnRetries` quick retries with exponential backoff for transient
 * errors before surfacing as transient. Use this for all SMS sends app-wide.
 *
 * @returns {Promise<{ok:boolean, sid?:string, errorCode?:string|number, errorMessage?:string, permanent?:boolean, durationMs:number, attempts:number}>}
 */
async function sendSmsSafely({ to, from, body, client, userId, statusCallback, inFnRetries = 2 }) {
  const start = Date.now();
  let   lastErr = null;
  let   attempt = 0;

  while (attempt <= inFnRetries) {
    attempt++;
    try {
      const params = { body, from, to };
      if (statusCallback) params.statusCallback = statusCallback;
      const result = await client.messages.create(params);

      const durationMs = Date.now() - start;
      await logger.info('sms', 'Twilio send OK', {
        to, from, sid: result.sid, attempt, durationMs,
      }, userId);

      return { ok: true, sid: result.sid, attempts: attempt, durationMs };
    } catch (err) {
      lastErr = err;
      const { permanent, errorCode, errorMessage } = classifyTwilioError(err);

      await logger.warn('sms', `Twilio send attempt ${attempt} failed${permanent ? ' (permanent)' : ' (transient)'}`, {
        to, from, attempt, errorCode, errorMessage, permanent,
      }, userId);

      if (permanent) {
        return {
          ok:      false,
          permanent: true,
          errorCode,
          errorMessage,
          attempts: attempt,
          durationMs: Date.now() - start,
        };
      }
      // Transient — back off before retrying (only if retries remain)
      if (attempt <= inFnRetries) {
        const backoff = 500 * Math.pow(2, attempt - 1); // 500, 1000, 2000 ms
        await sleep(backoff);
      }
    }
  }

  // Exhausted in-function retries — surface transient so caller can schedule its own retry
  const { permanent, errorCode, errorMessage } = classifyTwilioError(lastErr || {});
  return {
    ok:         false,
    permanent:  false, // we ran out of quick retries; caller may still retry via cron
    errorCode,
    errorMessage: errorMessage || (lastErr?.message ?? 'Unknown Twilio error'),
    attempts:   attempt,
    durationMs: Date.now() - start,
  };
}

/**
 * Send the review request SMS via Twilio.
 * Message matches the Zapier Path A template exactly.
 *
 * @param {string} rawPhone  - phone number from Jobber (any format)
 * @param {string} firstName - client's first name
 * @param {string} userId    - portal user whose Twilio creds to use
 * @returns {Promise<string>} Twilio message SID
 */
async function sendReviewSMS(rawPhone, firstName, userId) {
  const to = toE164(rawPhone);

  const msgSettings = userId
    ? await prisma.messageSettings.findUnique({ where: { userId } }).catch(() => null)
    : null;
  const template = msgSettings?.smsTemplate || DEFAULT_SMS_TEMPLATE;
  const body = template
    .replace('{firstName}', firstName)
    .replace('{reviewLink}', REVIEW_LINK);

  if (process.env.DRY_RUN === 'true') {
    console.log(`[smsService] DRY RUN — would send SMS to ${to}: "${body.slice(0, 80)}..."`);
    return 'dry-run';
  }

  const creds = await getTwilioCreds(userId);
  if (!creds.accountSid || !creds.authToken) {
    throw new Error('Twilio credentials not configured for this account');
  }

  const client = twilio(creds.accountSid, creds.authToken);
  const result = await sendSmsSafely({
    to,
    from: creds.fromNumber,
    body,
    client,
    userId,
  });

  if (!result.ok) {
    const tag = result.permanent ? 'permanent' : 'transient';
    throw new Error(`Twilio send failed (${tag}, code ${result.errorCode}): ${result.errorMessage}`);
  }

  return result.sid;
}

module.exports = {
  sendReviewSMS,
  sendSmsSafely,
  classifyTwilioError,
  getTwilioCreds,
  toE164,
  PERMANENT_TWILIO_CODES,
};
