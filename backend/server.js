require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const cookieParser = require('cookie-parser');
const path       = require('path');

const authRouter        = require('./routes/auth');
const webhookRouter     = require('./routes/webhook');
const statusRouter      = require('./routes/status');
const portalRouter      = require('./routes/portal');
const weatherRouter     = require('./routes/weather');
const connectionsRouter = require('./routes/connections');
const seoRouter         = require('./routes/seo');
const gmailRouter       = require('./routes/gmail');
const settingsRouter    = require('./routes/settings');
const analyticsRouter   = require('./routes/analytics');
const auditRouter       = require('./routes/websiteAudit');
const leaderboardRouter = require('./routes/leaderboard');
const marketingRouter   = require('./routes/marketing');
const campaignsRouter   = require('./routes/campaigns');
const { requireAuth } = require('./middleware/requireAuth');
const { startTokenRefreshScheduler }      = require('./services/tokenManager');
const { startDeliveryQueue }              = require('./services/deliveryQueue');
const { startInvoicePoller }              = require('./services/invoicePoller');
const { startWeatherScheduler }           = require('./services/weatherService');
const { startSeoScheduler }               = require('./services/seoService');
const { startJobberClientSyncScheduler }  = require('./services/jobberClientSync');

const app = express();

// ---------------------------------------------------------------------------
// CORS — allow the static frontend and the local dashboard to call this API
// ---------------------------------------------------------------------------
const allowedOrigins = [
  process.env.FRONTEND_ORIGIN,
  'http://localhost:3001',
  'http://127.0.0.1:3001',
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin "${origin}" not allowed`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ---------------------------------------------------------------------------
// CRITICAL MIDDLEWARE ORDER
//
// 1. Webhook route uses express.raw() at the route level — mount BEFORE
//    express.json() so the global JSON parser never touches webhook bodies.
// 2. cookie-parser must run before requireAuth (reads req.cookies).
// 3. Public routes (login page, auth endpoints) must be mounted BEFORE
//    requireAuth so they are accessible without a session.
// ---------------------------------------------------------------------------
app.use('/webhook', webhookRouter);

app.use(express.json());
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Public routes — no auth required
// ---------------------------------------------------------------------------

// Serve login page directly (not behind auth)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// OAuth callback and connect — must be accessible without session
// (user arrives here from Jobber's redirect after consent screen)
app.use('/auth', authRouter);

// SEO routes — mounted before requireAuth so that:
//   /api/seo/google/callback (Google redirect) and
//   /api/seo/trigger?token=... (external cron trigger) work without a session.
// The /trigger endpoint enforces its own SEO_TRIGGER_SECRET check.
app.use('/api/seo', seoRouter);

// Gmail OAuth routes — callback must be public (Google redirects here without a session).
// The /auth endpoint enforces its own requireAuth internally.
app.use('/api/gmail', gmailRouter);

// Portal login/logout/setup-user
app.use('/auth', portalRouter);

// Twilio delivery status callback — public (Twilio posts here, no session)
app.post('/api/weather/twilio-callback', express.urlencoded({ extended: false }), async (req, res) => {
  const { MessageSid, MessageStatus } = req.body || {};
  if (MessageSid && MessageStatus) {
    const prisma = require('./lib/prismaClient');
    await prisma.rainMessage.updateMany({
      where: { messageSid: MessageSid },
      data:  { status: MessageStatus },
    }).catch(err => console.warn('[twilio-callback] DB update failed:', err.message));
  }
  res.sendStatus(204);
});

// Marketing Twilio delivery status callback — public (Twilio posts here, no session)
app.post('/api/marketing/twilio-callback', express.urlencoded({ extended: false }), async (req, res) => {
  const { MessageSid, MessageStatus } = req.body || {};
  if (MessageSid && MessageStatus) {
    const p = require('./lib/prismaClient');
    await p.marketingMessage.updateMany({
      where: { messageSid: MessageSid },
      data:  { status: MessageStatus },
    }).catch(err => console.warn('[marketing-twilio-callback] DB update failed:', err.message));
  }
  res.sendStatus(204);
});

// Marketing inbound SMS webhook — Twilio posts here when a client replies to the marketing number
// Must be public (no auth session) and return TwiML so Twilio doesn't retry
app.post('/api/marketing/inbound-sms', express.urlencoded({ extended: false }), async (req, res) => {
  // Always respond with empty TwiML first to prevent Twilio retries
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const { From, Body, MessageSid, To } = req.body || {};
  console.log(`[inbound-sms] Webhook received — From=${From} To=${To} Sid=${MessageSid} Body="${Body}"`);

  if (!MessageSid || !From || !Body) {
    console.warn('[inbound-sms] Missing required fields — ignoring');
    return;
  }

  const prisma = require('./lib/prismaClient');
  const { toE164 } = require('./services/smsService');
  const twilio = require('twilio');

  try {
    // Deduplicate: Twilio can fire the webhook more than once
    const existing = await prisma.inboundSMS.findUnique({ where: { messageSid: MessageSid } });
    if (existing) {
      console.log(`[inbound-sms] Duplicate webhook for sid=${MessageSid} — ignoring`);
      return;
    }

    // Normalize both numbers to E.164 for reliable matching
    const normalizedFrom = toE164(From) || From;
    const normalizedTo   = toE164(To)   || To;

    // Find which portal user owns the number that received this message.
    // Tries: exact E.164 match → raw To match → space-stripped match
    // (handles "+1 431 450 9814" stored vs "+14314509814" sent by Twilio)
    // → single-user fallback if only one credential exists.
    let cred = await prisma.twilioCredential.findFirst({ where: { fromNumber: normalizedTo } });
    if (!cred && normalizedTo !== To) {
      cred = await prisma.twilioCredential.findFirst({ where: { fromNumber: To } });
    }
    if (!cred) {
      // Try matching after stripping spaces from stored number
      const allCreds = await prisma.twilioCredential.findMany();
      cred = allCreds.find(c => (c.fromNumber || '').replace(/\s/g, '') === normalizedTo) || null;
      if (!cred && allCreds.length === 1) {
        cred = allCreds[0];
        console.warn(`[inbound-sms] fromNumber mismatch (To=${To}, stored=${cred.fromNumber}) — using fallback credential`);
      }
    }
    if (!cred) {
      console.warn(`[inbound-sms] No TwilioCredential found for To=${To} — cannot store message`);
      return;
    }
    // Auto-fix stored fromNumber if it contains spaces (normalize to clean E.164 for future lookups)
    if (cred.fromNumber && /\s/.test(cred.fromNumber)) {
      const fixed = cred.fromNumber.replace(/\s/g, '');
      console.log(`[inbound-sms] Auto-fixing stored fromNumber: "${cred.fromNumber}" → "${fixed}"`);
      prisma.twilioCredential.update({ where: { id: cred.id }, data: { fromNumber: fixed } }).catch(() => {});
      cred = { ...cred, fromNumber: fixed };
    }
    const userId = cred.userId;

    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
    const from10 = last10(normalizedFrom);

    // Try to match a cached client by phone (exact E.164 first, then last-10 digits fallback)
    let cachedClient = await prisma.cachedJobberClient.findFirst({
      where: { userId, phone: normalizedFrom },
    });
    if (!cachedClient && from10) {
      const candidates = await prisma.cachedJobberClient.findMany({
        where: { userId, phone: { not: null } },
        select: { id: true, name: true, firstName: true, phone: true, jobberClientId: true, optedOut: true },
      });
      cachedClient = candidates.find((c) => last10(c.phone) === from10) || null;
    }

    // Find the most recent campaign message sent to this number
    const recentMessage = await prisma.marketingMessage.findFirst({
      where:   { phone: normalizedFrom, campaign: { userId } },
      orderBy: { sentAt: 'desc' },
      include: { campaign: { select: { id: true, name: true } } },
    });

    const bodyUpper = Body.trim().toUpperCase();

    // Opt-out / STOP detection (must check before Y/N parsing)
    const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
    const isOptOut = STOP_WORDS.includes(bodyUpper);

    if (isOptOut) {
      const now = new Date();

      // 1) Persist SMS opt-out in CachedJobberClient (used by SMS Marketing system)
      let updatedCount = 0;
      const exact = await prisma.cachedJobberClient.updateMany({
        where: { userId, phone: normalizedFrom },
        data:  { optedOut: true, optedOutAt: now },
      });
      updatedCount += exact.count || 0;

      if (updatedCount === 0 && from10) {
        const candidates = await prisma.cachedJobberClient.findMany({
          where: { userId, phone: { not: null } },
          select: { id: true, phone: true },
        });
        const matchIds = candidates
          .filter((c) => last10(c.phone) === from10)
          .map((c) => c.id);

        if (matchIds.length > 0) {
          const fallback = await prisma.cachedJobberClient.updateMany({
            where: { userId, id: { in: matchIds } },
            data:  { optedOut: true, optedOutAt: now },
          });
          updatedCount += fallback.count || 0;
        }
      }

      // 2) Persist SMS opt-out in CampaignClient (new Campaign Manager system)
      // Prefer linking by jobberClientId when we have it, otherwise fall back to phone matching.
      if (cachedClient?.jobberClientId) {
        await prisma.campaignClient.updateMany({
          where: { userId, jobberClientId: cachedClient.jobberClientId },
          data:  { optedOut: true, optedOutAt: now },
        }).catch(() => {});
      } else if (from10) {
        const campaignCandidates = await prisma.campaignClient.findMany({
          where: { userId, primaryPhone: { not: null } },
          select: { id: true, primaryPhone: true },
        }).catch(() => []);
        const matchIds = campaignCandidates
          .filter((c) => last10(c.primaryPhone) === from10)
          .map((c) => c.id);
        if (matchIds.length > 0) {
          await prisma.campaignClient.updateMany({
            where: { userId, id: { in: matchIds } },
            data:  { optedOut: true, optedOutAt: now },
          }).catch(() => {});
        }
      }

      const label = cachedClient?.name || 'unknown';
      console.log(`[inbound-sms] Opt-out received from ${normalizedFrom} (${label}) — updated cached clients: ${updatedCount}`);
    }

    // Parse Y/N booking response
    const isResponse = !isOptOut && ['Y', 'YES', 'N', 'NO'].includes(bodyUpper);
    const response   = isOptOut  ? 'optout'
                     : isResponse ? (['Y', 'YES'].includes(bodyUpper) ? 'yes' : 'no')
                     : null;

    // Store the inbound message
    const inbound = await prisma.inboundSMS.create({
      data: {
        userId,
        from:           normalizedFrom,
        body:           Body.trim(),
        messageSid:     MessageSid,
        isResponse:     isResponse || isOptOut,
        response,
        clientName:     cachedClient?.name           || null,
        jobberClientId: cachedClient?.jobberClientId || null,
        campaignId:     recentMessage?.campaign?.id  || null,
        notified:       false,
        read:           false,
      },
    });

    console.log(
      `[inbound-sms] Stored message from ${normalizedFrom}` +
      (cachedClient ? ` (${cachedClient.name})` : ' (unmatched)') +
      (isOptOut   ? ' — OPTED OUT'       : '') +
      (isResponse ? ` — response: ${response}` : '')
    );

    // Link reply back to the matching MarketingMessage record
    if (recentMessage && (isResponse || isOptOut)) {
      await prisma.marketingMessage.update({
        where: { id: recentMessage.id },
        data:  { replyBody: Body.trim(), replyReceivedAt: new Date() },
      });
    }

    // Send admin SMS notification for Y/N responses (not for opt-outs or general messages)
    if (isResponse && cred.notifyPhone) {
      try {
        const twilioClient = twilio(cred.accountSid, cred.authToken);
        const clientLabel  = cachedClient?.name || normalizedFrom;
        const campaignName = recentMessage?.campaign?.name || 'a campaign';
        const responseWord = response === 'yes' ? 'YES ✓' : 'NO ✗';

        await twilioClient.messages.create({
          to:   cred.notifyPhone,
          from: cred.fromNumber,
          body: `5StarFlow: ${clientLabel} replied ${responseWord} to "${campaignName}". Phone: ${normalizedFrom}`,
        });

        await prisma.inboundSMS.update({
          where: { id: inbound.id },
          data:  { notified: true },
        });

        console.log(`[inbound-sms] Admin notified at ${cred.notifyPhone}`);
      } catch (notifyErr) {
        console.error('[inbound-sms] Admin SMS notification failed:', notifyErr.message);
      }
    }
  } catch (err) {
    console.error('[inbound-sms] Error processing inbound SMS:', err.message);
  }
});

// Referral redirect — public, no auth required (clients click from their phones)
// Sets hasPendingMultiplier=true for the referrer, then redirects to booking page.
app.get('/r/:slug', async (req, res) => {
  try {
    const prisma = require('./lib/prismaClient');
    await prisma.loyaltyClient.updateMany({
      where: { referralSlug: req.params.slug },
      data:  { hasPendingMultiplier: true },
    });
  } catch (err) {
    console.error('[referral] DB update failed:', err.message);
  }
  res.redirect(process.env.REFERRAL_REDIRECT_URL || '/login.html');
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Root redirect — send visitors to login
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// ---------------------------------------------------------------------------
// Protected zone — requireAuth guards everything below
// ---------------------------------------------------------------------------
app.use(requireAuth);

// Serve dashboard and other static files (protected)
app.use(express.static(__dirname));
app.use('/images', express.static(path.join(__dirname, 'images')));

// Protected API routes
app.use('/api', portalRouter);  // /api/admin/me, /api/admin/users, etc.
app.use('/api', statusRouter);
app.use('/api/weather', weatherRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/message-settings', require('./routes/messageSettings'));
app.use('/api/message-templates', requireAuth, require('./routes/messageTemplates'));
app.use('/api/analytics', analyticsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/marketing', marketingRouter);
app.use('/api/campaigns', campaignsRouter);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 3001;

app.listen(PORT, () => {
  console.log('');
  console.log('==============================================');
  console.log(`  5StarFlow backend running on port ${PORT}`);
  console.log(`  Login       : http://localhost:${PORT}/login.html`);
  console.log(`  Home        : http://localhost:${PORT}/index.html`);
  console.log(`  Reviews     : http://localhost:${PORT}/review-dashboard.html`);
  console.log(`  Rain Alerts : http://localhost:${PORT}/weather-dashboard.html`);
  console.log(`  SEO Audit   : http://localhost:${PORT}/seo-dashboard.html`);
  console.log(`  Connections : http://localhost:${PORT}/connections.html`);
  console.log(`  Settings    : http://localhost:${PORT}/settings.html`);
  console.log(`  Web Audit   : http://localhost:${PORT}/website-audit.html`);
  console.log(`  Marketing  : http://localhost:${PORT}/marketing.html`);
  console.log(`  Users       : http://localhost:${PORT}/admin.html`);
  console.log(`  Health      : http://localhost:${PORT}/health`);
  console.log('==============================================');
  console.log('');

  startTokenRefreshScheduler();
  startDeliveryQueue();
  startInvoicePoller();
  startWeatherScheduler();
  startSeoScheduler();
  startJobberClientSyncScheduler();
});
