// Standalone PageSpeed API test
// Usage: node test-pagespeed.js [url]
// Tests your GOOGLE_API_KEY and PageSpeed Insights API setup before deploying.

require('dotenv').config();
const axios = require('axios');

const url      = process.argv[2] || 'https://www.no-bs-yardwork.com';
const apiKey   = process.env.GOOGLE_API_KEY;
const strategy = 'mobile';

console.log('--- PageSpeed Test ---');
console.log('URL:     ', url);
console.log('API Key: ', apiKey ? `SET (${apiKey.slice(0, 12)}...)` : 'NOT SET — will use shared quota');
console.log('');

const endpoint =
  `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
  `?url=${encodeURIComponent(url)}&strategy=${strategy}` +
  (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');

axios.get(endpoint, { timeout: 30000 })
  .then(resp => {
    const cats  = resp.data?.lighthouseResult?.categories;
    const score = cats?.performance?.score != null ? Math.round(cats.performance.score * 100) : 'n/a';
    const seo   = cats?.seo?.score         != null ? Math.round(cats.seo.score * 100)         : 'n/a';
    console.log('✓ Success');
    console.log('  Performance score:', score);
    console.log('  SEO score:        ', seo);
  })
  .catch(err => {
    const status  = err.response?.status;
    const message = err.response?.data?.error?.message || err.message;
    console.error('✗ Failed');
    console.error('  Status: ', status || 'network error');
    console.error('  Message:', message);
    if (status === 429) {
      console.error('  → Quota exhausted. Ensure PageSpeed Insights API is enabled in Google Cloud Console for your key.');
    }
    if (status === 400) {
      console.error('  → Bad request. Check the URL is publicly reachable and properly formatted.');
    }
    if (status === 403) {
      console.error('  → API key rejected. Check it is enabled for PageSpeed Insights API in Google Cloud Console.');
    }
    if (!apiKey) {
      console.error('  → Tip: Add GOOGLE_API_KEY=<your-key> to backend/.env');
    }
  });
