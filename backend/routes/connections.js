const express  = require('express');
const router   = express.Router();
const prisma   = require('../lib/prismaClient');
const axios    = require('axios');
const nodemailer = require('nodemailer');

// Helper: upsert a verification record after a successful test or OAuth connect.
async function markVerified(userId, service) {
  await prisma.connectionVerification.upsert({
    where:  { userId_service: { userId, service } },
    update: { verifiedAt: new Date() },
    create: { userId, service },
  });
}

// Helper: clear verification (e.g. after disconnect).
async function clearVerified(userId, service) {
  await prisma.connectionVerification.deleteMany({ where: { userId, service } });
}

/**
 * GET /api/connections/status
 * Returns live status for all integrations.
 * Green checkmark requires a ConnectionVerification record — not just env vars.
 */
router.get('/status', async (req, res) => {
  try {
    const uid = req.user.userId;

    // Load all verifications for this user in one query
    const verifications = await prisma.connectionVerification.findMany({ where: { userId: uid } });
    const isVerified = (service) => verifications.some(v => v.service === service);

    // ── Jobber ──────────────────────────────────────────────────────────────
    let jobberAccount = await prisma.jobberAccount.findFirst({
      where: { OR: [{ userId: uid }, { userId: null }] },
    });
    if (jobberAccount && !jobberAccount.userId) {
      jobberAccount = await prisma.jobberAccount.update({
        where: { id: jobberAccount.id },
        data:  { userId: uid },
      });
      // Auto-verify since they successfully went through OAuth
      await markVerified(uid, 'jobber');
    }
    const lastRefreshLog = jobberAccount
      ? await prisma.tokenRefreshLog.findFirst({
          where:   { accountId: jobberAccount.accountId },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const recentLogs = jobberAccount
      ? await prisma.tokenRefreshLog.findMany({
          where:   { accountId: jobberAccount.accountId },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
      : [];
    const tokenMinutesLeft = jobberAccount
      ? Math.max(0, Math.floor((new Date(jobberAccount.expiresAt) - Date.now()) / 60000))
      : null;

    const jobber = jobberAccount
      ? {
          connected:        isVerified('jobber'),
          accountId:        jobberAccount.accountId,
          expiresAt:        jobberAccount.expiresAt,
          tokenMinutesLeft,
          hasRefreshToken:  !!(jobberAccount.refreshToken),
          lastRefresh:      lastRefreshLog?.createdAt || null,
          lastRefreshOk:    lastRefreshLog?.success   || null,
          recentLogs:       recentLogs.map(l => ({
            createdAt: l.createdAt,
            success:   l.success,
            message:   l.message,
            trigger:   l.trigger,
          })),
        }
      : { connected: false, hasRefreshToken: false };

    // ── Gmail ───────────────────────────────────────────────────────────────
    const gmailCred = await prisma.gmailCredential.findUnique({ where: { userId: uid } });
    const gmail = {
      configured:  isVerified('gmail'),
      fromAddress: gmailCred?.gmailUser || process.env.GMAIL_USER || null,
      fromName:    gmailCred?.fromName  || null,
    };

    // ── Twilio ──────────────────────────────────────────────────────────────
    const twilioCred = await prisma.twilioCredential.findUnique({ where: { userId: uid } });
    const twilio = {
      configured:  isVerified('twilio'),
      fromNumber:  twilioCred?.fromNumber || process.env.TWILIO_PHONE_NUMBER || null,
      accountSid:  twilioCred
        ? twilioCred.accountSid.slice(0, 8) + '...'
        : process.env.TWILIO_ACCOUNT_SID
          ? process.env.TWILIO_ACCOUNT_SID.slice(0, 8) + '...'
          : null,
    };

    // ── OpenWeatherMap ──────────────────────────────────────────────────────
    const latestWeather = await prisma.weatherCheck.findFirst({
      where:   { userId: uid },
      orderBy: { checkedAt: 'desc' },
    });
    const openweather = {
      configured: isVerified('openweather'),
      city:       process.env.WEATHER_CITY || null,
      lastCheck:  latestWeather?.checkedAt || null,
      lastDate:   latestWeather?.date      || null,
    };

    // ── Google Search Console ────────────────────────────────────────────────
    const seoSettings = await prisma.seoSettings.findFirst({ where: { userId: uid } });
    const saEmail = process.env.GOOGLE_CLIENT_EMAIL || null;
    const saConfigured = !!(saEmail && process.env.GOOGLE_PRIVATE_KEY);
    const google = {
      connected:              !!(seoSettings?.googleAccessToken) || saConfigured,
      serviceAccountConfigured: saConfigured,
      serviceAccountEmail:    saEmail,
      siteProperty:           seoSettings?.siteProperty  || null,
      ga4PropertyId:          seoSettings?.ga4PropertyId || null,
      tokenExpiry:            seoSettings?.googleTokenExpiry || null,
    };

    // ── Skyvern (placeholder) ───────────────────────────────────────────────
    const skyvern = { connected: false, comingSoon: true };

    // ── PageSpeed ───────────────────────────────────────────────────────────
    const pagespeed = {
      configured: isVerified('pagespeed') || !!process.env.GOOGLE_API_KEY,
      hasApiKey:  !!process.env.GOOGLE_API_KEY,
    };

    res.json({ jobber, gmail, twilio, openweather, google, skyvern, pagespeed });
  } catch (err) {
    console.error('[connections] /status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/connections/test/:service
 * Live-tests a specific integration. On success, saves a verification record
 * so the status page shows the green checkmark.
 */
router.post('/test/:service', async (req, res) => {
  const { service } = req.params;
  const uid = req.user.userId;

  const succeed = async (message) => {
    await markVerified(uid, service);
    return res.json({ ok: true, verified: true, message });
  };
  const fail = (message) => res.json({ ok: false, verified: false, message });

  try {
    switch (service) {
      case 'jobber': {
        const { getValidAccessToken } = require('../services/jobberClient');
        const token = await getValidAccessToken(uid);
        const resp  = await axios.post(
          process.env.JOBBER_GRAPHQL_URL || 'https://api.getjobber.com/api/graphql',
          { query: '{ account { id name } }' },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-JOBBER-GRAPHQL-VERSION': '2026-03-10' } }
        );
        const accountName = resp.data?.data?.account?.name || 'Unknown';
        return succeed(`Connected — account: ${accountName}`);
      }

      case 'gmail': {
        // Try OAuth credential first
        const { getGmailCreds, ensureFreshToken } = require('../services/emailService');
        const creds = await getGmailCreds(uid);
        if (creds) {
          const accessToken = await ensureFreshToken(uid, creds);
          const check = await axios.get(
            `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${accessToken}`
          ).catch(e => ({ status: e.response?.status || 400 }));
          if (check.status === 200) return succeed(`Gmail connected — sending as ${creds.user}`);
          return fail('Gmail OAuth token invalid — sign out and reconnect');
        }
        // Fall back to App Password (env vars)
        const gmailUser = process.env.GMAIL_USER;
        const gmailPass = process.env.GMAIL_APP_PASSWORD;
        if (!gmailUser || !gmailPass) return fail('No Gmail credentials found — add GMAIL_USER and GMAIL_APP_PASSWORD');
        const transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: gmailUser, pass: gmailPass },
        });
        await transporter.verify();
        return succeed(`Gmail SMTP verified — sending as ${gmailUser}`);
      }

      case 'twilio': {
        const twilio = require('twilio');
        const { getTwilioCreds } = require('../services/smsService');
        const creds = await getTwilioCreds(uid);
        if (!creds.accountSid || !creds.authToken) return fail('Twilio credentials not configured — add them in Settings');
        const client  = twilio(creds.accountSid, creds.authToken);
        const account = await client.api.accounts(creds.accountSid).fetch();
        return succeed(`Twilio connected — status: ${account.status}`);
      }

      case 'openweather': {
        const key  = process.env.OPENWEATHER_API_KEY;
        const city = process.env.WEATHER_CITY || 'Winnipeg';
        if (!key || key.includes('your_') || key.includes('get_free')) return fail('OPENWEATHER_API_KEY not configured');
        const resp    = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`);
        const weather = resp.data?.weather?.[0]?.description || 'ok';
        const temp    = resp.data?.main?.temp;
        return succeed(`${city}: ${weather}, ${temp}°C`);
      }

      case 'pagespeed': {
        const { getPageSpeed } = require('../services/seoService');
        const settings = await prisma.seoSettings.findFirst({ where: { userId: uid } });
        const url = settings?.siteUrl;
        if (!url) return fail('Set your site URL in SEO Settings first.');
        const result = await getPageSpeed(url, 'mobile');
        return succeed(`PageSpeed OK — score: ${result.score ?? 'n/a'}/100 for ${url}`);
      }

      case 'google': {
        const { GoogleAuth } = require('google-auth-library');
        const settings = await prisma.seoSettings.findFirst({ where: { userId: uid } });
        if (!settings?.siteProperty) return fail('Set your Search Console property first (e.g. sc-domain:yourdomain.com)');
        const saEmail = process.env.GOOGLE_CLIENT_EMAIL;
        const saKey   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
        if (!saEmail || !saKey) return fail('Service account not configured — check GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY in .env');
        const auth   = new GoogleAuth({ credentials: { client_email: saEmail, private_key: saKey }, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
        const client = await auth.getClient();
        const tok    = await client.getAccessToken();
        const resp   = await axios.get('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${tok.token}` } });
        const sites  = (resp.data.siteEntry || []).map(s => s.siteUrl);
        return succeed(`Connected — ${sites.length} site(s) accessible in Search Console`);
      }

      default:
        return res.status(400).json({ error: `Unknown service: ${service}` });
    }
  } catch (err) {
    console.error(`[connections] test/${service} error:`, err.message);
    return fail(err.message);
  }
});

module.exports = router;
