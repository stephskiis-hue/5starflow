const express        = require('express');
const router         = express.Router();
const { GoogleAuth } = require('google-auth-library');
const { getGA4Stats, clearCache } = require('../services/analyticsService');

// GET /api/analytics/stats
// Returns GA4 traffic stats for the last 7 days.
// Returns { configured: false } gracefully if env vars are missing.
router.get('/stats', async (req, res) => {
  try {
    const stats = await getGA4Stats();
    res.json(stats);
  } catch (err) {
    console.error('[analytics] /stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/test
// Bypasses cache, hits GA4 API fresh, returns diagnostic info.
router.get('/test', async (req, res) => {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const email      = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!propertyId || !email || !privateKey) {
    return res.json({
      configured: false,
      propertyId:           propertyId || null,
      serviceAccountEmail:  email      || null,
      error: 'Missing env vars: ' + [
        !propertyId  && 'GA4_PROPERTY_ID',
        !email       && 'GOOGLE_CLIENT_EMAIL',
        !privateKey  && 'GOOGLE_PRIVATE_KEY',
      ].filter(Boolean).join(', '),
    });
  }

  try {
    const auth   = new GoogleAuth({
      credentials: { client_email: email, private_key: privateKey },
      scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
    });
    const client      = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    const token       = tokenResult.token;

    const url  = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
    const body = {
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
      ],
      dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
      limit: 5,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    };

    const apiRes = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      return res.json({
        configured:          true,
        propertyId,
        serviceAccountEmail: email,
        error: `GA4 API error ${apiRes.status}: ${text}`,
      });
    }

    const data = await apiRes.json();

    let visitors  = 0;
    let sessions  = 0;
    let pageViews = 0;
    let topSource = '—';

    if (data.rows?.length) {
      for (const row of data.rows) {
        visitors  += parseInt(row.metricValues[0].value, 10) || 0;
        sessions  += parseInt(row.metricValues[1].value, 10) || 0;
        pageViews += parseInt(row.metricValues[2].value, 10) || 0;
      }
      topSource = data.rows[0].dimensionValues[0].value || '—';
    }

    // Bust cache so the main card refreshes on next load
    clearCache();

    console.log(`[analytics] test: OK — ${visitors} visitors, ${sessions} sessions`);

    res.json({
      configured:          true,
      propertyId,
      serviceAccountEmail: email,
      visitors,
      sessions,
      pageViews,
      topSource,
      rawRowCount: data.rows?.length ?? 0,
    });
  } catch (err) {
    console.error('[analytics] test error:', err.message);
    res.json({
      configured:          true,
      propertyId,
      serviceAccountEmail: email,
      error: err.message,
    });
  }
});

module.exports = router;
