const twilio = require('twilio');

const REVIEW_LINK = process.env.REVIEW_LINK || 'https://g.page/r/CSu2cqDYFOxDEAE/review';

let _client = null;

function getTwilioClient() {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
    }
    _client = twilio(sid, token);
  }
  return _client;
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
 * @returns {Promise<string>} Twilio message SID
 */
async function sendReviewSMS(rawPhone, firstName) {
  const to = toE164(rawPhone);

  const body =
    `Hi ${firstName}! We hope you're loving the look of your property! ` +
    `We put in the sweat so you didn't have to—we'd love to hear what you think of the results. 🫡 \n\n` +
    `${REVIEW_LINK} — Much appreciated! ⭐️⭐️⭐️⭐️⭐️`;

  if (process.env.DRY_RUN === 'true') {
    console.log(`[smsService] DRY RUN — would send SMS to ${to}: "${body.slice(0, 80)}..."`);
    return 'dry-run';
  }

  const message = await getTwilioClient().messages.create({
    body,
    from: process.env.TWILIO_FROM_NUMBER || '+14314509814',
    to,
  });

  console.log(`[smsService] SMS sent to ${to} | SID: ${message.sid}`);
  return message.sid;
}

module.exports = { sendReviewSMS };
