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
    const jobberAccount = await prisma.jobberAccount.findFirst();
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
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const gmail = {
      configured:  !!(gmailUser && gmailPass),
      fromAddress: gmailUser || null,
      fromName:    process.env.EMAIL_FROM_NAME || null,
    };

    // ── Twilio ──────────────────────────────────────────────────────────────
    const twilioSid   = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilio = {
      configured:  !!(twilioSid && twilioToken),
      fromNumber:  process.env.TWILIO_FROM_NUMBER || null,
      accountSid:  twilioSid ? `${twilioSid.slice(0, 8)}...` : null,
    };

    // ── OpenWeatherMap ──────────────────────────────────────────────────────
    const owKey = process.env.OPENWEATHER_API_KEY;
    const latestWeather = await prisma.weatherCheck.findFirst({
      orderBy: { checkedAt: 'desc' },
    });
    const openweather = {
      configured: !!(owKey && !owKey.includes('your_') && !owKey.includes('get_free')),
      city:       process.env.WEATHER_CITY || null,
      lastCheck:  latestWeather ? latestWeather.checkedAt : null,
      lastDate:   latestWeather ? latestWeather.date      : null,
    };

    // ── Google (placeholder) ────────────────────────────────────────────────
    const seoSettings = await prisma.seoSettings.findFirst();
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
        const token = await getValidAccessToken();
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
        const user = process.env.GMAIL_USER;
        const pass = process.env.GMAIL_APP_PASSWORD;
        if (!user || !pass) return res.json({ ok: false, message: 'GMAIL_USER or GMAIL_APP_PASSWORD not set' });
        const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
        await transporter.verify();
        return res.json({ ok: true, message: `SMTP verified — ready to send as ${user}` });
      }

      case 'twilio': {
        const twilio = require('twilio');
        const sid   = process.env.TWILIO_ACCOUNT_SID;
        const token = process.env.TWILIO_AUTH_TOKEN;
        if (!sid || !token) return res.json({ ok: false, message: 'TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set' });
        const client  = twilio(sid, token);
        const account = await client.api.accounts(sid).fetch();
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
