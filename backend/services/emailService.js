const nodemailer = require('nodemailer');
const axios  = require('axios');
const prisma = require('../lib/prismaClient');

const REVIEW_LINK = process.env.REVIEW_LINK || 'https://g.page/r/CSu2cqDYFOxDEAE/review';

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
 * Replicates the Zapier Gmail step template exactly, parameterized with firstName.
 */
function buildHtmlEmail(firstName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>No-Bs Yardwork Review Request</title>
</head>
<body style="margin:0; padding:0; background-color:#ffffff; font-family: 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="padding: 40px 10px; background-color:#ffffff;">
    <tr>
      <td align="center">

        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width:550px; background-color:#ffffff; border-radius:32px; border-collapse: separate; overflow:hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.05); border: 1px solid #f0f0f0;">

          <tr>
            <td align="center" style="padding: 60px 20px 25px 20px;">
              <table border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 20px;">
                <tr>
                  <td align="center" style="background-color: #ffffff; padding: 6px; border-radius: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #f0f0f0;">
                    <img src="https://no-bs-yardwork.com/images/about-img-2.png?v=11"
                         alt="No-Bs Yardwork"
                         width="115"
                         style="display:block; max-width:115px; height:auto; border-radius: 14px;">
                  </td>
                </tr>
              </table>
              <p style="margin: 0; font-size: 10px; color: #1b5e20; text-transform: uppercase; letter-spacing: 2px; font-weight: 800; opacity: 0.8;">
                Design &bull; Build &bull; Maintain
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 40px 45px 40px;">

              <h1 style="font-size: 24px; color: #111827; margin: 0 0 15px 0; font-weight: 800; text-align: center;">
                Hi ${firstName},
              </h1>

              <p style="font-size: 16px; color: #4b5563; line-height: 1.6; margin: 0 0 35px 0; text-align: center;">
                We hope you're loving the look of your property! We put in the sweat so you didn't have to&mdash;we'd love to hear what you think of the results. 🫡
              </p>

              <div style="text-align: center; border: 1px solid #f3f4f6; border-radius: 24px; padding: 30px 20px; background-color: #fcfdfc;">
                <p style="font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 15px; font-weight: 700;">
                  Rate our "No-Bs" Service
                </p>
                <div style="font-size: 20px; color: #fbbf24; margin-bottom: 25px; letter-spacing: 2px; line-height: 1;">
                  &#9733; &#9733; &#9733; &#9733; &#9733;
                </div>

                <a href="${REVIEW_LINK}"
                   style="background-color: #1b5e20;
                          color: #ffffff;
                          padding: 16px 32px;
                          text-decoration: none;
                          border-radius: 14px;
                          font-weight: bold;
                          font-size: 15px;
                          display: inline-block;
                          box-shadow: 0 8px 16px rgba(27, 94, 32, 0.15);">
                  Leave a Google Review
                </a>
              </div>

              <p style="font-size: 13px; color: #9ca3af; line-height: 1.6; text-align: center; margin-top: 40px; font-style: italic; max-width: 85%; margin-left: auto; margin-right: auto;">
                "Your feedback helps us grow and keeps us motivated to keep Winnipeg looking sharp. Plus, it makes us look good to our moms."
              </p>

              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-top: 35px;">
                <tr>
                  <td align="center">
                    <p style="font-size: 15px; color: #1b5e20; font-weight: 800; margin: 0;">
                      &mdash; The No-Bs Yardwork Team
                    </p>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <tr>
            <td align="center" style="background-color: #fcfdfc; padding: 30px 20px; border-top: 1px solid #f3f4f6; border-bottom-left-radius: 32px; border-bottom-right-radius: 32px;">
              <p style="font-size: 10px; color: #d1d5db; margin: 0; font-weight: 700; letter-spacing: 1.5px;">
                &copy; 2026 NO-BS YARDWORK
              </p>
            </td>
          </tr>

        </table>

        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 550px;">
          <tr>
            <td align="center" style="padding: 30px 0;">
              <p style="font-size: 11px; color: #9ca3af; line-height: 1.5; max-width: 400px; margin: 0;">
                You are receiving this because you recently completed a project with No-Bs Yardwork in Winnipeg. Thanks for supporting local!
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

  const info = await transporter.sendMail({
    from:    `"${creds.fromName}" <${creds.user}>`,
    to,
    subject: 'Could you do us a small favor?',
    html:    buildHtmlEmail(firstName),
  });

  console.log(`[emailService] Email sent to ${to} | messageId: ${info.messageId}`);
  return info.messageId;
}

module.exports = { sendReviewEmail, getGmailCreds };
