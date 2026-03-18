const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const axios   = require('axios');

/**
 * GET /api/connections/status
 * Returns live status for all 6 integrations.
 */
router.get('/status', async (req, res) => {
  try {
    // ── Jobber ──────────────────────────────────────────────────────────────
    const jobberAccount = await prisma.jobberAccount.findFirst({ where: { userId: req.user.userId } });
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
          take: 3,
        })
      : [];

    let tokenMinutesLeft = null;
    if (jobberAccount) {
      tokenMinutesLeft = Math.max(
        0,
        Math.floor((new Date(jobberAccount.expiresAt) - Date.now()) / 60000)
      );
    }

    const jobber = jobberAccount
      ? {
          connected:        true,
          accountId:        jobberAccount.accountId,
          expiresAt:        jobberAccount.expiresAt,
          tokenMinutesLeft,
          hasRefreshToken:  !!(jobberAccount.refreshToken),
          lastRefresh:      lastRefreshLog ? lastRefreshLog.createdAt : null,
          lastRefreshOk:    lastRefreshLog ? lastRefreshLog.success   : null,
          recentLogs:       recentLogs.map(l => ({
            createdAt: l.createdAt,
            success:   l.success,
            message:   l.message,
            trigger:   l.trigger,
          })),
        }
      : { connected: false, hasRefreshToken: false };

    // ── Gmail ───────────────────────────────────────────────────────────────
    const gmailCred = await prisma.gmailCredential.findUnique({ where: { userId: req.user.userId } });
    const gmail = gmailCred
      ? { configured: true, fromAddress: gmailCred.gmailUser, fromName: gmailCred.fromName || null }
      : { configured: false, fromAddress: null, fromName: null };

    // ── Twilio ──────────────────────────────────────────────────────────────
    const twilioCred = await prisma.twilioCredential.findUnique({ where: { userId: req.user.userId } });
    const twilio = twilioCred
      ? { configured: true, fromNumber: twilioCred.fromNumber, accountSid: twilioCred.accountSid.slice(0, 8) + '...' }
      : { configured: false, fromNumber: null, accountSid: null };

    // ── OpenWeatherMap ──────────────────────────────────────────────────────
    const owKey = process.env.OPENWEATHER_API_KEY;
    const latestWeather = await prisma.weatherCheck.findFirst({
      where:   { userId: req.user.userId },
      orderBy: { checkedAt: 'desc' },
    });
    const openweather = {
      configured: !!(owKey && !owKey.includes('your_') && !owKey.includes('get_free')),
      city:       process.env.WEATHER_CITY || null,
      lastCheck:  latestWeather ? latestWeather.checkedAt : null,
      lastDate:   latestWeather ? latestWeather.date      : null,
    };

    // ── Google (placeholder) ────────────────────────────────────────────────
    const seoSettings = await prisma.seoSettings.findFirst({ where: { userId: req.user.userId } });
    const google = {
      connected:   !!(seoSettings && seoSettings.googleAccessToken),
      placeholder: true,
      siteProperty: seoSettings ? seoSettings.siteProperty : null,
    };

    // ── Skyvern (placeholder) ───────────────────────────────────────────────
    const skyvern = {
      connected:  false,
      comingSoon: true,
    };

    res.json({ jobber, gmail, twilio, openweather, google, skyvern });
  } catch (err) {
    console.error('[connections] /status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/connections/test/:service
 * Live-tests a specific integration and returns { ok, message }.
 */
router.post('/test/:service', async (req, res) => {
  const { service } = req.params;

  try {
    switch (service) {
      case 'jobber': {
        const { getValidAccessToken } = require('../services/jobberClient');
        const token = await getValidAccessToken(req.user.userId);
        const resp = await axios.post(
          process.env.JOBBER_GRAPHQL_URL || 'https://api.getjobber.com/api/graphql',
          { query: '{ account { id name } }' },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'X-JOBBER-GRAPHQL-VERSION': '2026-03-10',
            },
          }
        );
        const accountName = resp.data?.data?.account?.name || 'Unknown';
        return res.json({ ok: true, message: `Connected — account: ${accountName}` });
      }

      case 'gmail': {
        const nodemailer = require('nodemailer');
        const { getGmailCreds } = require('../services/emailService');
        const creds = await getGmailCreds(req.user.userId);
        if (!creds.user || !creds.pass) return res.json({ ok: false, message: 'Gmail credentials not configured — add them in Settings' });
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: creds.user, pass: creds.pass } });
        await transporter.verify();
        return res.json({ ok: true, message: `SMTP verified — ready to send as ${creds.user}` });
      }

      case 'twilio': {
        const twilio = require('twilio');
        const { getTwilioCreds } = require('../services/smsService');
        const creds = await getTwilioCreds(req.user.userId);
        if (!creds.accountSid || !creds.authToken) return res.json({ ok: false, message: 'Twilio credentials not configured — add them in Settings' });
        const client  = twilio(creds.accountSid, creds.authToken);
        const account = await client.api.accounts(creds.accountSid).fetch();
        return res.json({ ok: true, message: `Twilio connected — status: ${account.status}` });
      }

      case 'openweather': {
        const key  = process.env.OPENWEATHER_API_KEY;
        const city = process.env.WEATHER_CITY || 'Winnipeg';
        if (!key || key.includes('your_') || key.includes('get_free')) {
          return res.json({ ok: false, message: 'OPENWEATHER_API_KEY not configured' });
        }
        const resp = await axios.get(
          `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${key}&units=metric`
        );
        const weather = resp.data?.weather?.[0]?.description || 'ok';
        const temp    = resp.data?.main?.temp;
        return res.json({ ok: true, message: `${city}: ${weather}, ${temp}°C` });
      }

      default:
        return res.status(400).json({ error: `Unknown service: ${service}` });
    }
  } catch (err) {
    console.error(`[connections] test/${service} error:`, err.message);
    res.json({ ok: false, message: err.message });
  }
});

module.exports = router;
