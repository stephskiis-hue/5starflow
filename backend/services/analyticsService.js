const { GoogleAuth } = require('google-auth-library');

// ---------------------------------------------------------------------------
// In-memory cache — GA4 quota is generous but no need to call on every page load
// ---------------------------------------------------------------------------
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// Build GoogleAuth client from env vars
// ---------------------------------------------------------------------------
function getAuthClient() {
  const email      = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!email || !privateKey) return null;

  return new GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
}

// ---------------------------------------------------------------------------
// Fetch GA4 stats for the last 7 days
// Returns: { configured, visitors, sessions, pageViews, topSource, cachedAt }
// ---------------------------------------------------------------------------
async function getGA4Stats() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const auth       = getAuthClient();

  if (!propertyId || !auth) {
    return { configured: false };
  }

  // Serve from cache if fresh
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) {
    return { ..._cache, fromCache: true };
  }

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

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GA4 API error ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Aggregate totals across all rows (one row per channel grouping)
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

  const result = {
    configured: true,
    visitors,
    sessions,
    pageViews,
    topSource,
    cachedAt: new Date().toISOString(),
    fromCache: false,
  };

  _cache  = result;
  _cacheAt = Date.now();

  return result;
}

function clearCache() {
  _cache  = null;
  _cacheAt = 0;
}

module.exports = { getGA4Stats, clearCache };
