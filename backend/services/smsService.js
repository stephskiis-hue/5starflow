const twilio = require('twilio');
const prisma = require('../lib/prismaClient');

const REVIEW_LINK = process.env.REVIEW_LINK || 'https://g.page/r/CSu2cqDYFOxDEAE/review';

const DEFAULT_SMS_TEMPLATE =
  'Hi {firstName}! We hope you\'re loving the look of your property! ' +
  'We put in the sweat so you didn\'t have to—we\'d love to hear what you think of the results. 🫡 \n\n' +
  '{reviewLink} — Much appreciated! ⭐️⭐️⭐️⭐️⭐️';

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
  const message = await client.messages.create({
    body,
    from: creds.fromNumber,
    to,
  });

  console.log(`[smsService] SMS sent to ${to} | SID: ${message.sid}`);
  return message.sid;
}

module.exports = { sendReviewSMS, getTwilioCreds };
