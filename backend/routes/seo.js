const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const axios   = require('axios');

// In-memory pagespeed job state — resets on server restart (scan stops too, so this is fine)
const activePageSpeedJobs = new Map(); // userId -> { status, result, error }
const {
  runWeeklyAudit,
  getSettings,
  applyChange,
  getPageSpeed,
  scrapeCompetitor,
  getSearchConsoleData,
  getServiceAccountClient,
} = require('../services/seoService');

// ---------------------------------------------------------------------------
// GET /api/seo/status
// Latest audit + pending proposal count — scoped to current user
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const [latestAudit, pendingCount, latestPageSpeed] = await Promise.all([
      prisma.seoAudit.findFirst({ where: { userId: req.user.userId }, orderBy: { runAt: 'desc' } }),
      prisma.seoProposal.count({ where: { status: 'pending', userId: req.user.userId } }),
      prisma.pageSpeedHistory.findFirst({
        where:   { userId: req.user.userId },
        orderBy: { runAt: 'desc' },
        select:  { mobileScore: true, desktopScore: true, mobileSeo: true, lcp: true, cls: true, fid: true, runAt: true },
      }),
    ]);

    res.json({
      latestAudit,
      pendingProposals: pendingCount,
      latestPageSpeed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/audits
// Last 10 audit runs — scoped to current user
// ---------------------------------------------------------------------------
router.get('/audits', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const audits = await prisma.seoAudit.findMany({
      where:   { userId: req.user.userId },
      orderBy: { runAt: 'desc' },
      take: 10,
    });

    // Attach proposal status to each audit
    const auditIds = audits.map(a => a.id);
    const proposals = await prisma.seoProposal.findMany({
      where: { auditId: { in: auditIds }, userId: req.user.userId },
      select: { auditId: true, status: true, id: true },
    });
    const proposalMap = Object.fromEntries(proposals.map(p => [p.auditId, p]));

    const result = audits.map(a => ({
      ...a,
      proposal: proposalMap[a.id] || null,
    }));

    res.json({ audits: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/pagespeed/running
// Check whether a pagespeed scan is in progress for the current user.
// ---------------------------------------------------------------------------
router.get('/pagespeed/running', (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const job = activePageSpeedJobs.get(req.user.userId);
  res.json({
    running: job?.status === 'running',
    result:  job?.status === 'done'  ? job.result : null,
    error:   job?.status === 'error' ? job.error  : null,
  });
});

// ---------------------------------------------------------------------------
// POST /api/seo/pagespeed
// Tier 1 (Free): runs Google PageSpeed for mobile + desktop, returns scores + issues.
// Fire-and-forget: responds immediately so navigation away doesn't kill the scan.
// Poll GET /api/seo/pagespeed/running for results.
// ---------------------------------------------------------------------------
router.post('/pagespeed', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.userId;

  // If already running, just confirm — frontend will poll
  if (activePageSpeedJobs.get(userId)?.status === 'running') {
    return res.json({ alreadyRunning: true });
  }

  // Validate settings before starting (fast DB read, safe to do before responding)
  const settings = await getSettings(userId).catch(() => null);
  const url = settings?.siteUrl;
  if (!url) return res.status(400).json({ error: 'Set your site URL in SEO Settings first.' });

  // Mark as running and respond immediately
  activePageSpeedJobs.set(userId, { status: 'running' });
  res.json({ started: true });

  // Run the actual scan in background after the response is sent
  ;(async () => {
    try {
      const [mobile, desktop] = await Promise.all([
        getPageSpeed(url, 'mobile'),
        getPageSpeed(url, 'desktop'),
      ]);

      // Merge + deduplicate issues from both strategies
      const seen = new Set();
      const allIssues = [];
      for (const issue of [...mobile.issues, ...desktop.issues]) {
        if (!seen.has(issue.id)) {
          seen.add(issue.id);
          allIssues.push(issue);
        }
      }

      // Save to history
      prisma.pageSpeedHistory.create({
        data: {
          userId,
          siteUrl:      url,
          mobileScore:  mobile.score   ?? null,
          desktopScore: desktop.score  ?? null,
          mobileSeo:    mobile.seoScore ?? null,
          lcp:          mobile.lcp     ?? null,
          cls:          mobile.cls     ?? null,
          fid:          mobile.fid     ?? null,
          issuesJson:   JSON.stringify(allIssues),
        },
      }).catch(err => console.error('[seo] history save error:', err.message));

      activePageSpeedJobs.set(userId, {
        status: 'done',
        result: {
          url,
          mobile:  { score: mobile.score,  seoScore: mobile.seoScore,  lcp: mobile.lcp,  cls: mobile.cls,  fid: mobile.fid  },
          desktop: { score: desktop.score, seoScore: desktop.seoScore, lcp: desktop.lcp, cls: desktop.cls, fid: desktop.fid },
          issues:  allIssues,
          hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
        },
      });
    } catch (err) {
      console.error('[seo] /pagespeed background error:', err.message);
      const is429 = err.message?.includes('quota') || err.message?.includes('rate limit');
      activePageSpeedJobs.set(userId, {
        status: 'error',
        error:  is429 ? 'Rate limited — try again in a few minutes.' : err.message,
      });
    }
  })();
});

// ---------------------------------------------------------------------------
// GET /api/seo/pagespeed/history
// Last 20 Free Site Score runs for the current user.
// ---------------------------------------------------------------------------
router.get('/pagespeed/history', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const rows = await prisma.pageSpeedHistory.findMany({
      where:   { userId: req.user.userId },
      orderBy: { runAt: 'desc' },
      take:    20,
      select:  { id: true, siteUrl: true, mobileScore: true, desktopScore: true,
                 mobileSeo: true, lcp: true, cls: true, fid: true, issuesJson: true, runAt: true },
    });
    res.json({ history: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/seo/run-audit
// Manual trigger — tier: 'pro' (Haiku, no competitors) or 'pro-plus' (Sonnet + competitors)
// ---------------------------------------------------------------------------
router.post('/run-audit', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tier = ['pro', 'pro-plus'].includes(req.body?.tier) ? req.body.tier : 'pro-plus';
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(402).json({ error: 'Claude API key required for AI audit. Set ANTHROPIC_API_KEY in your .env.' });
  }
  try {
    // Fire and forget — audit is async
    runWeeklyAudit(req.user.userId, tier).catch(err => console.error('[seo] run-audit error:', err.message));
    res.json({ success: true, tier, message: 'Audit started — check /api/seo/status for progress' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/seo/trigger
// External trigger (no session — protected by SEO_TRIGGER_SECRET query param)
// Mount BEFORE requireAuth in server.js (in the public zone)
// ---------------------------------------------------------------------------
router.post('/trigger', async (req, res) => {
  const secret = process.env.SEO_TRIGGER_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'SEO_TRIGGER_SECRET not configured' });
  }
  if (req.query.token !== secret) {
    return res.status(401).json({ error: 'Invalid trigger token' });
  }
  // External trigger runs for all users
  runWeeklyAudit().catch(err => console.error('[seo] external trigger error:', err.message));
  res.json({ success: true, message: 'Audit triggered' });
});

// ---------------------------------------------------------------------------
// GET /api/seo/proposals
// List proposals, pending first — scoped to current user
// ---------------------------------------------------------------------------
router.get('/proposals', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const proposals = await prisma.seoProposal.findMany({
      where: { userId: req.user.userId },
      orderBy: [
        { status: 'asc' },   // "pending" sorts before "approved"/"declined" alphabetically
        { createdAt: 'desc' },
      ],
      take: 20,
    });

    // Attach changes to each proposal
    const ids = proposals.map(p => p.id);
    const changes = await prisma.seoChange.findMany({
      where: { proposalId: { in: ids }, userId: req.user.userId },
    });
    const changeMap = {};
    for (const c of changes) {
      if (!changeMap[c.proposalId]) changeMap[c.proposalId] = [];
      changeMap[c.proposalId].push(c);
    }

    const result = proposals.map(p => ({
      ...p,
      changes: changeMap[p.id] || [],
    }));

    res.json({ proposals: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/seo/proposals/:id/respond
// Approve or decline a proposal
// Body: { decision: "approved" | "declined" }
// ---------------------------------------------------------------------------
router.post('/proposals/:id/respond', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { id }                          = req.params;
  const { decision, selectedChangeIds } = req.body || {};

  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "declined"' });
  }

  try {
    const proposal = await prisma.seoProposal.findFirst({ where: { id, userId: req.user.userId } });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: `Proposal already ${proposal.status}` });
    }

    await prisma.seoProposal.update({
      where: { id },
      data:  { status: decision, respondedAt: new Date() },
    });

    if (decision === 'approved') {
      const settings = await getSettings(req.user.userId);
      let allChanges = await prisma.seoChange.findMany({ where: { proposalId: id, userId: req.user.userId } });

      let changesToApply = allChanges;
      let skipped = 0;

      if (Array.isArray(selectedChangeIds) && selectedChangeIds.length > 0) {
        const selectedSet = new Set(selectedChangeIds.map(Number));
        changesToApply = allChanges.filter(c => selectedSet.has(c.id));
        skipped = allChanges.length - changesToApply.length;
      }

      let applied = 0;
      let failed  = 0;
      for (const change of changesToApply) {
        try {
          await applyChange(change, settings);
          applied++;
        } catch {
          failed++;
        }
      }

      return res.json({ success: true, decision, applied, failed, skipped, total: allChanges.length });
    }

    res.json({ success: true, decision });
  } catch (err) {
    console.error('[seo] /proposals/:id/respond error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/settings
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const settings = await getSettings(req.user.userId);
    // Mask sensitive fields
    res.json({
      ...settings,
      deployPass:         settings.deployPass ? '••••••••' : null,
      googleAccessToken:  settings.googleAccessToken ? '••••••••' : null,
      googleRefreshToken: settings.googleRefreshToken ? '••••••••' : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/seo/settings
// ---------------------------------------------------------------------------
router.post('/settings', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const settings = await getSettings(req.user.userId);
    const {
      siteUrl, competitorUrls, deployType,
      deployHost, deployPort, deployUser, deployPass, deployPath, deployBranch,
      siteProperty, auditEnabled, ga4PropertyId,
    } = req.body || {};

    const data = {};
    if (siteUrl          !== undefined) data.siteUrl          = siteUrl;
    if (competitorUrls   !== undefined) data.competitorUrls   = JSON.stringify(Array.isArray(competitorUrls) ? competitorUrls : [competitorUrls]);
    if (deployType       !== undefined) data.deployType       = deployType;
    if (deployHost       !== undefined) data.deployHost       = deployHost;
    if (deployPort       !== undefined) data.deployPort       = parseInt(deployPort, 10) || null;
    if (deployUser       !== undefined) data.deployUser       = deployUser;
    if (deployPath       !== undefined) data.deployPath       = deployPath;
    if (deployBranch     !== undefined) data.deployBranch     = deployBranch;
    if (siteProperty     !== undefined) data.siteProperty     = siteProperty;
    if (auditEnabled     !== undefined) data.auditEnabled     = Boolean(auditEnabled);
    if (ga4PropertyId    !== undefined) data.ga4PropertyId    = ga4PropertyId || null;
    // Only overwrite password if a real value (not masked) is provided
    if (deployPass && deployPass !== '••••••••') data.deployPass = deployPass;

    const updated = await prisma.seoSettings.update({ where: { id: settings.id }, data });
    res.json({ success: true, settings: updated });
  } catch (err) {
    console.error('[seo] /settings POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/traffic-stats
// Returns GA4 channel breakdown for the last 7 days using stored OAuth tokens.
// Results cached 30 min per user to avoid GA4 quota exhaustion.
// ---------------------------------------------------------------------------

const trafficStatsCache = new Map(); // userId -> { data, cachedAt }
const TRAFFIC_CACHE_TTL = 30 * 60 * 1000;

router.get('/traffic-stats', async (req, res) => {
  if (!req.user || !req.user.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const userId = req.user.userId;

  // Serve from cache if fresh
  const cached = trafficStatsCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < TRAFFIC_CACHE_TTL) {
    return res.json({ ...cached.data, fromCache: true });
  }

  try {
    const settings = await getSettings(userId);
    const { googleAccessToken, googleRefreshToken, googleTokenExpiry, ga4PropertyId } = settings || {};

    if (!ga4PropertyId) {
      return res.json({ configured: false });
    }

    // Build Authorization header — prefer service account (no browser login needed)
    let authHeader;
    const saClient = await getServiceAccountClient();
    if (saClient) {
      const hdrs = await saClient.getRequestHeaders();
      authHeader = hdrs.Authorization;
    } else if (googleAccessToken) {
      // Fall back to stored OAuth token, refreshing inline if needed
      let accessToken = googleAccessToken;
      if (googleTokenExpiry && new Date(googleTokenExpiry) < new Date(Date.now() + 5 * 60 * 1000)) {
        if (googleRefreshToken) {
          try {
            const resp = await axios.post('https://oauth2.googleapis.com/token', {
              client_id:     process.env.GOOGLE_CLIENT_ID,
              client_secret: process.env.GOOGLE_CLIENT_SECRET,
              refresh_token: googleRefreshToken,
              grant_type:    'refresh_token',
            });
            accessToken = resp.data.access_token;
            const newExpiry = new Date(Date.now() + (resp.data.expires_in || 3600) * 1000);
            await prisma.seoSettings.update({
              where: { id: settings.id },
              data:  { googleAccessToken: accessToken, googleTokenExpiry: newExpiry },
            });
          } catch (refreshErr) {
            console.error('[seo] traffic-stats inline token refresh failed:', refreshErr.message);
          }
        }
      }
      authHeader = `Bearer ${accessToken}`;
    } else {
      return res.json({ configured: false });
    }

    // Normalise property ID — accept both "properties/123456" and "123456"
    const propId = ga4PropertyId.startsWith('properties/')
      ? ga4PropertyId
      : `properties/${ga4PropertyId}`;

    const gaRes = await axios.post(
      `https://analyticsdata.googleapis.com/v1beta/${propId}:runReport`,
      {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        metrics:    [{ name: 'sessions' }],
        dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
        limit: 8,
      },
      { headers: { Authorization: authHeader } }
    );

    const rows = (gaRes.data.rows || []).map(r => ({
      channel:  r.dimensionValues?.[0]?.value || 'Other',
      sessions: parseInt(r.metricValues?.[0]?.value || '0', 10),
    })).sort((a, b) => b.sessions - a.sessions);

    const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);

    const result = { configured: true, propertyId: propId, channels: rows, totalSessions };
    trafficStatsCache.set(userId, { data: result, cachedAt: Date.now() });
    res.json(result);
  } catch (err) {
    console.error('[seo] traffic-stats error:', err.response?.data || err.message);
    res.status(500).json({ configured: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/google/auth
// Redirect to Google OAuth consent screen
// ---------------------------------------------------------------------------
router.get('/google/auth', (req, res) => {
  // Route is in the public zone — req.user is not populated. Read session cookie manually.
  let userId = null;
  try {
    const { verifyToken } = require('../lib/auth');
    const token = req.cookies?.sf_session;
    if (token) {
      const payload = verifyToken(token);
      if (payload?.userId) userId = payload.userId;
    }
  } catch { /* no session — proceed without userId */ }

  const clientId    = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send('GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI must be set in .env');
  }

  const scopes = [
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
  ].join(' ');

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope',         scopes);
  url.searchParams.set('access_type',   'offline');
  url.searchParams.set('prompt',        'consent');
  // Pass userId in state so callback can scope the save
  url.searchParams.set('state', userId || 'anon');

  res.redirect(url.toString());
});

// ---------------------------------------------------------------------------
// GET /api/seo/google/callback
// Exchange code for tokens, save to SeoSettings
// ---------------------------------------------------------------------------
router.get('/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.redirect('/connections.html?google_error=' + encodeURIComponent(error));
  if (!code)  return res.redirect('/connections.html?google_error=no_code');

  // state = userId passed from /google/auth
  const userId = state || null;

  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  process.env.GOOGLE_REDIRECT_URI,
      grant_type:    'authorization_code',
    });

    const { access_token, refresh_token, expires_in } = resp.data;
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

    const settings = await getSettings(userId);
    await prisma.seoSettings.update({
      where: { id: settings.id },
      data: {
        googleAccessToken:  access_token,
        googleRefreshToken: refresh_token || settings.googleRefreshToken,
        googleTokenExpiry:  expiresAt,
      },
    });

    console.log('[seo] Google OAuth connected');
    res.redirect('/connections.html?google_connected=1');
  } catch (err) {
    console.error('[seo] Google callback error:', err.response?.data || err.message);
    res.redirect('/connections.html?google_error=' + encodeURIComponent(err.message));
  }
});

module.exports = router;
