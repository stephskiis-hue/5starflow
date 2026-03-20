const nodemailer = require('nodemailer');
const axios  = require('axios');
const prisma = require('../lib/prismaClient');

const REVIEW_LINK = process.env.REVIEW_LINK || 'https://g.page/r/CSu2cqDYFOxDEAE/review';

async function getMessageSettings(userId) {
  if (!userId) return null;
  return prisma.messageSettings.findUnique({ where: { userId } }).catch(() => null);
}

/**
 * Load Gmail OAuth2 credentials for a user from DB.
 * Returns null if not configured (no env var fallback — OAuth only).
 *
 * @param {string|null} userId
 * @returns {{ user, fromName, accessToken, refreshToken, tokenExpiry } | null}
 */
async function getGmailCreds(userId) {
  if (userId) {
    const cred = await prisma.gmailCredential.findUnique({ where: { userId } });
    if (cred && cred.accessToken) {
      return {
        user:         cred.gmailUser,
        fromName:     cred.fromName || 'No-Bs Yardwork',
        accessToken:  cred.accessToken,
        refreshToken: cred.refreshToken || null,
        tokenExpiry:  cred.tokenExpiry || null,
      };
    }
  }
  return null;
}

/**
 * Ensure the access token is fresh. If it's expiring within 5 minutes,
 * uses the refresh token to get a new one and persists it.
 *
 * @param {string} userId
 * @param {object} creds - result of getGmailCreds()
 * @returns {string} fresh access token
 */
async function ensureFreshToken(userId, creds) {
  const fiveMinutes = 5 * 60 * 1000;
  const isExpiring  = creds.tokenExpiry && (new Date(creds.tokenExpiry) - Date.now()) < fiveMinutes;

  if (!isExpiring) return creds.accessToken;

  if (!creds.refreshToken) {
    console.warn(`[emailService] Gmail token expiring but no refresh token for userId=${userId} — using existing`);
    return creds.accessToken;
  }

  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', {
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: creds.refreshToken,
      grant_type:    'refresh_token',
    });

    const { access_token, expires_in } = resp.data;
    const tokenExpiry = new Date(Date.now() + (expires_in || 3600) * 1000);

    await prisma.gmailCredential.update({
      where: { userId },
      data:  { accessToken: access_token, tokenExpiry },
    });

    console.log(`[emailService] Gmail token refreshed for userId=${userId}`);
    return access_token;
  } catch (err) {
    console.error(`[emailService] Gmail token refresh failed for userId=${userId}:`, err.response?.data || err.message);
    return creds.accessToken; // use the old one and hope it still works
  }
}

/**
 * Build the branded HTML email body.
 * Accepts optional MessageSettings; falls back to hardcoded defaults.
 */
function buildHtmlEmail(firstName, s) {
  // If custom HTML is set, use it entirely (with placeholder substitution)
  if (s?.emailCustomHtml?.trim()) {
    return s.emailCustomHtml
      .replace(/\{\{firstName\}\}/g, firstName)
      .replace(/\{\{reviewLink\}\}/g, s.reviewLink || REVIEW_LINK)
      .replace(/\{\{businessName\}\}/g, s.businessName || 'My Business');
  }

  const businessName = s?.businessName || 'No-Bs Yardwork';
  const tagline      = s?.tagline      || 'Design &bull; Build &bull; Maintain';
  const logoUrl      = s?.logoUrl      || 'https://no-bs-yardwork.com/images/about-img-2.png?v=11';
  const reviewLink   = s?.reviewLink   || REVIEW_LINK;
  const btnColor     = s?.buttonColor  || '#1b5e20';
  const emailBody    = s?.emailBody    || "We hope you're loving the look of your property! We put in the sweat so you didn't have to&mdash;we'd love to hear what you think of the results. 🫡";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${businessName} Review Request</title>
</head>
<body style="margin:0; padding:0; background-color:#ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="padding: 40px 10px; background-color:#ffffff;">
    <tr>
      <td align="center">

        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:550px; background-color:#ffffff; border-radius:32px; border-collapse: separate; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); border: 1px solid #f0f0f0;">

          <tr>
            <td align="center" style="padding: 60px 20px 25px 20px;">
              ${logoUrl ? `<table border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                <tr>
                  <td align="center" style="background-color: #ffffff; padding: 6px; border-radius: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #f0f0f0;">
                    <img src="${logoUrl}"
                         alt="${businessName}"
                         width="115"
                         style="display:block; max-width:115px; height:auto; border-radius: 14px;">
                  </td>
                </tr>
              </table>` : ''}
              <p style="margin: 0; font-size: 10px; color: ${btnColor}; text-transform: uppercase; letter-spacing: 2px; font-weight: 800; opacity: 0.8;">
                ${tagline}
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 40px 45px 40px;">

              <h1 style="font-size: 24px; color: #111827; margin: 0 0 15px 0; font-weight: 800; text-align: center;">
                Hi ${firstName},
              </h1>

              <p style="font-size: 16px; color: #4b5563; line-height: 1.6; margin: 0 0 35px 0; text-align: center;">
                ${emailBody}
              </p>

              <div style="text-align: center; border: 1px solid #f3f4f6; border-radius: 24px; padding: 30px 20px; background-color: #fcfdfc;">
                <div style="font-size: 20px; color: #fbbf24; margin-bottom: 25px; letter-spacing: 2px; line-height: 1;">
                  &#9733; &#9733; &#9733; &#9733; &#9733;
                </div>

                <a href="${reviewLink}"
                   style="background-color: ${btnColor};
                          color: #ffffff;
                          padding: 16px 32px;
                          text-decoration: none;
                          border-radius: 14px;
                          font-weight: bold;
                          font-size: 15px;
                          display: inline-block;">
                  Leave a Google Review
                </a>
              </div>

              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-top: 35px;">
                <tr>
                  <td align="center">
                    <p style="font-size: 15px; color: ${btnColor}; font-weight: 800; margin: 0;">
                      &mdash; The ${businessName} Team
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <tr>
            <td align="center" style="background-color: #fcfdfc; padding: 30px 20px; border-top: 1px solid #f3f4f6; border-bottom-left-radius: 32px; border-bottom-right-radius: 32px;">
              <p style="font-size: 10px; color: #d1d5db; margin: 0; font-weight: 700; letter-spacing: 1.5px;">
                &copy; ${new Date().getFullYear()} ${businessName.toUpperCase()}
              </p>
            </td>
          </tr>

        </table>

        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 550px;">
          <tr>
            <td align="center" style="padding: 30px 0;">
              <p style="font-size: 11px; color: #9ca3af; line-height: 1.5; max-width: 400px; margin: 0;">
                You are receiving this because you recently completed a project with ${businessName}. Thanks for supporting local!
              </p>
            </td>
          </tr>
        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;
}

/**
 * Send the review request email via Gmail SMTP.
 * Matches Zapier Path B (email fallback) exactly.
 *
 * @param {string} to        - recipient email address
 * @param {string} firstName - client's first name for personalization
 * @param {string} userId    - portal user whose Gmail creds to use
 * @returns {Promise<string>} nodemailer messageId
 */
async function sendReviewEmail(to, firstName, userId) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`[emailService] DRY RUN — would send email to ${to} for ${firstName}`);
    return 'dry-run';
  }

  const creds = await getGmailCreds(userId);
  if (!creds) {
    throw new Error('Gmail not connected for this account — connect via Settings → Gmail');
  }

  const accessToken = await ensureFreshToken(userId, creds);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type:         'OAuth2',
      user:         creds.user,
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: creds.refreshToken,
      accessToken,
    },
  });

  const msgSettings = await getMessageSettings(userId);
  const info = await transporter.sendMail({
    from:    `"${creds.fromName}" <${creds.user}>`,
    to,
    subject: msgSettings?.emailSubject || 'Could you do us a small favor?',
    html:    buildHtmlEmail(firstName, msgSettings),
  });

  console.log(`[emailService] Email sent to ${to} | messageId: ${info.messageId}`);
  return info.messageId;
}

/**
 * Plain, professional follow-up email sent 24 hours after the initial request.
 */
function buildFollowUpHtmlEmail(firstName, reviewLink = REVIEW_LINK, businessName = 'No-Bs Yardwork', btnColor = '#1b5e20') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>One last thing</title>
</head>
<body style="margin:0; padding:0; background-color:#ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="padding: 40px 10px; background-color:#ffffff;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:550px; background-color:#ffffff; border-radius:32px; border-collapse: separate; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); border: 1px solid #f0f0f0;">
          <tr>
            <td style="padding: 50px 45px 45px 45px;">
              <h1 style="font-size: 22px; color: #111827; margin: 0 0 20px 0; font-weight: 700;">
                Hi ${firstName},
              </h1>
              <p style="font-size: 15px; color: #4b5563; line-height: 1.7; margin: 0 0 20px 0;">
                We sent you a message yesterday about leaving us a Google review, and we completely understand if it slipped your mind — life gets busy.
              </p>
              <p style="font-size: 15px; color: #4b5563; line-height: 1.7; margin: 0 0 30px 0;">
                If you did have a moment, an honest review would mean the world to us. It only takes about 30 seconds and helps us keep growing.
              </p>
              <div style="text-align: center; margin-bottom: 35px;">
                <a href="${reviewLink}"
                   style="background-color: ${btnColor};
                          color: #ffffff;
                          padding: 15px 30px;
                          text-decoration: none;
                          border-radius: 12px;
                          font-weight: 600;
                          font-size: 15px;
                          display: inline-block;">
                  Leave a Google Review
                </a>
              </div>
              <p style="font-size: 14px; color: #6b7280; line-height: 1.6; margin: 0;">
                Either way, thank you for trusting us with your property. We hope you're enjoying the results.
              </p>
              <p style="font-size: 15px; color: ${btnColor}; font-weight: 700; margin: 25px 0 0 0;">
                &mdash; The ${businessName} Team
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="background-color: #fcfdfc; padding: 20px; border-top: 1px solid #f3f4f6;">
              <p style="font-size: 10px; color: #d1d5db; margin: 0; font-weight: 700; letter-spacing: 1.5px;">
                &copy; ${new Date().getFullYear()} ${businessName.toUpperCase()}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Send the 24-hour professional follow-up email.
 *
 * @param {string} to        - recipient email address
 * @param {string} firstName - client's first name
 * @param {string} userId    - portal user whose Gmail creds to use
 */
async function sendFollowUpEmail(to, firstName, userId) {
  if (process.env.DRY_RUN === 'true') {
    console.log(`[emailService] DRY RUN — would send follow-up email to ${to} for ${firstName}`);
    return 'dry-run';
  }

  const creds = await getGmailCreds(userId);
  if (!creds) {
    throw new Error('Gmail not connected for this account — connect via Settings → Gmail');
  }

  const accessToken = await ensureFreshToken(userId, creds);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      type:         'OAuth2',
      user:         creds.user,
      clientId:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: creds.refreshToken,
      accessToken,
    },
  });

  const msgSettings = await getMessageSettings(userId);
  const reviewLink  = msgSettings?.reviewLink || REVIEW_LINK;
  const businessName = msgSettings?.businessName || 'No-Bs Yardwork';
  const btnColor    = msgSettings?.buttonColor || '#1b5e20';
  const info = await transporter.sendMail({
    from:    `"${creds.fromName}" <${creds.user}>`,
    to,
    subject: 'One last thing — could you spare 30 seconds?',
    html:    buildFollowUpHtmlEmail(firstName, reviewLink, businessName, btnColor),
  });

  console.log(`[emailService] Follow-up email sent to ${to} | messageId: ${info.messageId}`);
  return info.messageId;
}

module.exports = { sendReviewEmail, sendFollowUpEmail, getGmailCreds, ensureFreshToken, getMessageSettings };
