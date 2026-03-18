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
const { requireAuth } = require('./middleware/requireAuth');
const { startTokenRefreshScheduler } = require('./services/tokenManager');
const { startDeliveryQueue }         = require('./services/deliveryQueue');
const { startInvoicePoller }         = require('./services/invoicePoller');
const { startWeatherScheduler }      = require('./services/weatherService');
const { startSeoScheduler }          = require('./services/seoService');

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

// Protected API routes
app.use('/api', portalRouter);  // /api/admin/me, /api/admin/users, etc.
app.use('/api', statusRouter);
app.use('/api/weather', weatherRouter);
app.use('/api/connections', connectionsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/audit', auditRouter);

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
  console.log(`  Users       : http://localhost:${PORT}/admin.html`);
  console.log(`  Health      : http://localhost:${PORT}/health`);
  console.log('==============================================');
  console.log('');

  startTokenRefreshScheduler();
  startDeliveryQueue();
  startInvoicePoller();
  startWeatherScheduler();
  startSeoScheduler();
});
