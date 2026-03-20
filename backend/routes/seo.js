const express = require('express');
const router  = express.Router();
const prisma  = require('../lib/prismaClient');
const axios   = require('axios');
const {
  runWeeklyAudit,
  getSettings,
  applyChange,
  getPageSpeed,
  scrapeCompetitor,
  getSearchConsoleData,
} = require('../services/seoService');

// ---------------------------------------------------------------------------
// GET /api/seo/status
// Latest audit + pending proposal count — scoped to current user
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  try {
    const [latestAudit, pendingCount] = await Promise.all([
      prisma.seoAudit.findFirst({ where: { userId: req.user?.userId }, orderBy: { runAt: 'desc' } }),
      prisma.seoProposal.count({ where: { status: 'pending', userId: req.user?.userId } }),
    ]);

    res.json({
      latestAudit,
      pendingProposals: pendingCount,
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
  try {
    const audits = await prisma.seoAudit.findMany({
      where:   { userId: req.user?.userId },
      orderBy: { runAt: 'desc' },
      take: 10,
    });

    // Attach proposal status to each audit
    const auditIds = audits.map(a => a.id);
    const proposals = await prisma.seoProposal.findMany({
      where: { auditId: { in: auditIds }, userId: req.user?.userId },
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
// POST /api/seo/pagespeed
// Tier 1 (Free): runs Google PageSpeed for mobile + desktop, returns scores + issues.
// No Claude API key required.
// Body: { url }
// ---------------------------------------------------------------------------
router.post('/pagespeed', async (req, res) => {
  try {
    const settings = await getSettings(req.user?.userId);
    const url = settings?.siteUrl;
    if (!url) return res.status(400).json({ error: 'Set your site URL in SEO Settings first.' });

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

    // Save to history (fire-and-forget — never let a DB error break the response)
    prisma.pageSpeedHistory.create({
      data: {
        userId:      req.user?.userId ?? null,
        siteUrl:     url,
        mobileScore:  mobile.score  ?? null,
        desktopScore: desktop.score ?? null,
        mobileSeo:    mobile.seoScore  ?? null,
        lcp:          mobile.lcp ?? null,
        cls:          mobile.cls ?? null,
        fid:          mobile.fid ?? null,
        issuesJson:   JSON.stringify(allIssues),
      },
    }).catch(err => console.error('[seo] history save error:', err.message));

    res.json({
      url,
      mobile:  { score: mobile.score,  seoScore: mobile.seoScore,  lcp: mobile.lcp,  cls: mobile.cls,  fid: mobile.fid  },
      desktop: { score: desktop.score, seoScore: desktop.seoScore, lcp: desktop.lcp, cls: desktop.cls, fid: desktop.fid },
      issues:  allIssues,
      hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    });
  } catch (err) {
    console.error('[seo] /pagespeed error:', err.message);
    const is429 = err.message?.includes('quota') || err.message?.includes('rate limit');
    res.status(is429 ? 429 : 500).json({
      error: err.message,
      rateLimited: is429,
      needsApiKey: is429 && !process.env.GOOGLE_API_KEY,
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/seo/pagespeed/history
// Last 20 Free Site Score runs for the current user.
// ---------------------------------------------------------------------------
router.get('/pagespeed/history', async (req, res) => {
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
  const tier = ['pro', 'pro-plus'].includes(req.body?.tier) ? req.body.tier : 'pro-plus';
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(402).json({ error: 'Claude API key required for AI audit. Set ANTHROPIC_API_KEY in your .env.' });
  }
  try {
    // Fire and forget — audit is async
    runWeeklyAudit(req.user?.userId, tier).catch(err => console.error('[seo] run-audit error:', err.message));
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
  try {
    const proposals = await prisma.seoProposal.findMany({
      where: { userId: req.user?.userId },
      orderBy: [
        { status: 'asc' },   // "pending" sorts before "approved"/"declined" alphabetically
        { createdAt: 'desc' },
      ],
      take: 20,
    });

    // Attach changes to each proposal
    const ids = proposals.map(p => p.id);
    const changes = await prisma.seoChange.findMany({
      where: { proposalId: { in: ids }, userId: req.user?.userId },
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
  const { id }                          = req.params;
  const { decision, selectedChangeIds } = req.body || {};

  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "declined"' });
  }

  try {
    const proposal = await prisma.seoProposal.findFirst({ where: { id, userId: req.user?.userId } });
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(400).json({ error: `Proposal already ${proposal.status}` });
    }

    await prisma.seoProposal.update({
      where: { id },
      data:  { status: decision, respondedAt: new Date() },
    });

    if (decision === 'approved') {
      const settings = await getSettings(req.user?.userId);
      let allChanges = await prisma.seoChange.findMany({ where: { proposalId: id, userId: req.user?.userId } });

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
  try {
    const settings = await getSettings(req.user?.userId);
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
  try {
    const settings = await getSettings(req.user?.userId);
    const {
      siteUrl, competitorUrls, deployType,
      deployHost, deployPort, deployUser, deployPass, deployPath, deployBranch,
      siteProperty, auditEnabled,
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
