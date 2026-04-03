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
  if (!MessageSid || !From || !Body) return;

  const prisma = require('./lib/prismaClient');
  const { toE164 } = require('./services/smsService');
  const twilio = require('twilio');

  try {
    // Deduplicate: Twilio can fire the webhook more than once
    const existing = await prisma.inboundSMS.findUnique({ where: { messageSid: MessageSid } });
    if (existing) return;

    // Find which portal user owns the number that received this message
    const cred = await prisma.twilioCredential.findFirst({ where: { fromNumber: To } });
    if (!cred) {
      console.warn(`[inbound-sms] No TwilioCredential found for To=${To}`);
      return;
    }
    const userId = cred.userId;

    // Normalize the sender's phone to E.164 for matching
    const normalizedFrom = toE164(From) || From;

    // Try to match a cached client by phone
    const cachedClient = await prisma.cachedJobberClient.findFirst({
      where: { userId, phone: normalizedFrom },
    });

    // Find the most recent campaign message sent to this number
    const recentMessage = await prisma.marketingMessage.findFirst({
      where:   { phone: normalizedFrom, campaign: { userId } },
      orderBy: { sentAt: 'desc' },
      include: { campaign: { select: { id: true, name: true } } },
    });

    // Parse Y/N response
    const bodyUpper = Body.trim().toUpperCase();
    const isResponse = ['Y', 'YES', 'N', 'NO'].includes(bodyUpper);
    const response   = isResponse ? (['Y', 'YES'].includes(bodyUpper) ? 'yes' : 'no') : null;

    // Store the inbound message
    const inbound = await prisma.inboundSMS.create({
      data: {
        userId,
        from:           normalizedFrom,
        body:           Body.trim(),
        messageSid:     MessageSid,
        isResponse,
        response,
        clientName:     cachedClient?.name     || null,
        jobberClientId: cachedClient?.jobberClientId || null,
        campaignId:     recentMessage?.campaign?.id  || null,
        notified:       false,
        read:           false,
      },
    });

    console.log(
      `[inbound-sms] Received from ${normalizedFrom}` +
      (cachedClient ? ` (${cachedClient.name})` : '') +
      (isResponse   ? ` — response: ${response}` : '')
    );

    // Link reply back to the matching MarketingMessage record
    if (recentMessage && isResponse) {
      await prisma.marketingMessage.update({
        where: { id: recentMessage.id },
        data:  { replyBody: Body.trim(), replyReceivedAt: new Date() },
      });
    }

    // Send admin notification SMS if this is a Y/N response and notifyPhone is set
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
