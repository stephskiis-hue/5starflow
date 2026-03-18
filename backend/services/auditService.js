/**
 * auditService.js
 * SEO + Performance audit engine for the Website Audit feature.
 *
 * - SEO checks: cheerio analysis of HTML content (no network needed)
 * - Performance: Google PageSpeed Insights API (free, no key, mobile strategy)
 * - AI suggestions: Claude Haiku via @anthropic-ai/sdk (only if ANTHROPIC_API_KEY is set)
 *
 * All functions are stateless — no DB access. Route layer handles persistence.
 */

const cheerio = require('cheerio');
const axios   = require('axios');

// ─────────────────────────────────────────────
// SEO Checks (cheerio — no network required)
// ─────────────────────────────────────────────

/**
 * Run SEO heuristic checks against raw HTML.
 * @param {string} html
 * @returns {{ score: number, issues: Array<{ type, severity, message, fix }> }}
 */
function runSeoChecks(html) {
  const $ = cheerio.load(html);
  const issues = [];
  let deductions = 0;

  // 1. Title tag
  const title = $('title').first().text().trim();
  if (!title) {
    issues.push({ type: 'seo', severity: 'critical', message: 'Missing <title> tag', fix: 'Add a descriptive <title> tag inside <head> (50–60 characters recommended).' });
    deductions += 20;
  } else if (title.length < 10) {
    issues.push({ type: 'seo', severity: 'warning', message: `Title tag too short (${title.length} chars): "${title}"`, fix: 'Expand the title to 50–60 characters with your primary keyword.' });
    deductions += 10;
  } else if (title.length > 65) {
    issues.push({ type: 'seo', severity: 'info', message: `Title tag too long (${title.length} chars) — Google truncates at ~65`, fix: 'Shorten the title to under 65 characters.' });
    deductions += 5;
  }

  // 2. Meta description
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  if (!metaDesc) {
    issues.push({ type: 'seo', severity: 'critical', message: 'Missing meta description', fix: 'Add <meta name="description" content="..."> (120–160 characters).' });
    deductions += 15;
  } else if (metaDesc.length < 50) {
    issues.push({ type: 'seo', severity: 'warning', message: `Meta description too short (${metaDesc.length} chars)`, fix: 'Expand to 120–160 characters.' });
    deductions += 8;
  } else if (metaDesc.length > 165) {
    issues.push({ type: 'seo', severity: 'info', message: `Meta description too long (${metaDesc.length} chars)`, fix: 'Trim to under 165 characters.' });
    deductions += 3;
  }

  // 3. H1 tag
  const h1s = $('h1');
  if (h1s.length === 0) {
    issues.push({ type: 'seo', severity: 'critical', message: 'No <h1> tag found', fix: 'Add exactly one <h1> tag containing your primary keyword.' });
    deductions += 15;
  } else if (h1s.length > 1) {
    issues.push({ type: 'seo', severity: 'warning', message: `Multiple <h1> tags found (${h1s.length})`, fix: 'Use only one <h1> per page. Convert extras to <h2>.' });
    deductions += 8;
  }

  // 4. Images missing alt
  const imgsWithoutAlt = $('img').filter((_, el) => {
    const alt = $(el).attr('alt');
    return alt === undefined || alt === null;
  }).length;
  if (imgsWithoutAlt > 0) {
    issues.push({ type: 'seo', severity: 'warning', message: `${imgsWithoutAlt} image(s) missing alt attributes`, fix: 'Add descriptive alt="" text to all <img> tags for accessibility and image SEO.' });
    deductions += Math.min(imgsWithoutAlt * 3, 12);
  }

  // 5. Canonical URL
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical) {
    issues.push({ type: 'seo', severity: 'warning', message: 'Missing canonical <link> tag', fix: 'Add <link rel="canonical" href="https://yourdomain.com/this-page"> in <head>.' });
    deductions += 8;
  }

  // 6. Viewport meta (mobile-friendliness)
  const viewport = $('meta[name="viewport"]').attr('content');
  if (!viewport) {
    issues.push({ type: 'seo', severity: 'warning', message: 'Missing viewport meta tag', fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.' });
    deductions += 8;
  }

  // 7. Open Graph tags
  const ogTitle = $('meta[property="og:title"]').attr('content');
  if (!ogTitle) {
    issues.push({ type: 'seo', severity: 'info', message: 'Missing Open Graph tags (og:title, og:description)', fix: 'Add <meta property="og:title"> and <meta property="og:description"> for social sharing previews.' });
    deductions += 4;
  }

  // 8. JSON-LD structured data
  const hasSchema = $('script[type="application/ld+json"]').length > 0;
  if (!hasSchema) {
    issues.push({ type: 'seo', severity: 'warning', message: 'No structured data (JSON-LD) found', fix: 'Add a LocalBusiness schema block to improve rich result eligibility.' });
    deductions += 8;
  }

  // 9. Placeholder/empty links
  const brokenLinks = $('a[href]').filter((_, el) => {
    const href = $(el).attr('href');
    return href === '#' || href === '' || href === 'javascript:void(0)';
  }).length;
  if (brokenLinks > 0) {
    issues.push({ type: 'seo', severity: 'info', message: `${brokenLinks} placeholder/empty link(s) detected`, fix: 'Replace href="#" links with real destination URLs.' });
    deductions += Math.min(brokenLinks * 2, 8);
  }

  return { score: Math.max(0, 100 - deductions), issues };
}

// ─────────────────────────────────────────────
// PageSpeed Insights (mirrors existing seoService pattern)
// ─────────────────────────────────────────────

/**
 * Fetch Google PageSpeed score for a public URL.
 * Returns null scores gracefully if URL is not public or request fails.
 * @param {string} url
 * @returns {Promise<{ score: number|null, lcp: number|null, cls: number|null }>}
 */
async function getPageSpeedScore(url) {
  if (!url) return { score: null, lcp: null, cls: null };
  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile`;
    const resp = await axios.get(endpoint, { timeout: 30000 });

    const cats  = resp.data?.lighthouseResult?.categories;
    const audit = resp.data?.lighthouseResult?.audits;

    const score = cats?.performance?.score != null
      ? Math.round(cats.performance.score * 100)
      : null;

    const lcp = audit?.['largest-contentful-paint']?.numericValue
      ? Math.round(audit['largest-contentful-paint'].numericValue) / 1000
      : null;

    const cls = audit?.['cumulative-layout-shift']?.numericValue != null
      ? Math.round(audit['cumulative-layout-shift'].numericValue * 1000) / 1000
      : null;

    return { score, lcp, cls };
  } catch (err) {
    console.error(`[auditService] PageSpeed error for ${url}:`, err.message);
    return { score: null, lcp: null, cls: null };
  }
}

// ─────────────────────────────────────────────
// AI Suggestions via Claude Haiku (optional)
// ─────────────────────────────────────────────

/**
 * Use Claude Haiku to suggest improvements beyond the automated checks.
 * Only runs if ANTHROPIC_API_KEY is set. Returns null otherwise.
 * @param {string} html
 * @param {string} filename
 * @param {Array} seoIssues
 * @returns {Promise<Array<{ title, description, fix }>|null>}
 */
async function getAiSuggestions(html, filename, seoIssues) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const truncatedHtml = html.length > 8000
    ? html.slice(0, 8000) + '\n<!-- truncated -->'
    : html;

  const issuesSummary = seoIssues.length > 0
    ? seoIssues.map(i => `- [${i.severity}] ${i.message}`).join('\n')
    : 'No critical issues detected by automated checks.';

  const prompt = `You are an SEO and web performance expert. Analyze this HTML page (${filename}) and provide 3–5 specific, actionable improvement suggestions beyond what the automated checks already found.

Automated checks already found:
${issuesSummary}

HTML content:
\`\`\`html
${truncatedHtml}
\`\`\`

Respond with ONLY a valid JSON array (no prose, no markdown fences):
[
  {
    "title": "short improvement title",
    "description": "what is wrong and why it matters",
    "fix": "exact change to make, with example code if applicable"
  }
]`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages:   [{ role: 'user', content: prompt }],
    });

    let raw = response.content[0].text.trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error('[auditService] Claude error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// Main audit runner
// ─────────────────────────────────────────────

/**
 * Run a full audit: SEO checks + PageSpeed + AI suggestions.
 * @param {{ html: string, pageUrl: string|null, filename: string }} options
 * @returns {Promise<{ seoScore, perfScore, auditScore, issues, aiSuggestions }>}
 */
async function auditPage({ html, pageUrl, filename }) {
  const { score: seoScore, issues: seoIssues } = runSeoChecks(html);
  const { score: perfScore } = await getPageSpeedScore(pageUrl);
  const aiSuggestions = await getAiSuggestions(html, filename, seoIssues);

  const auditScore = perfScore != null
    ? Math.round(seoScore * 0.6 + perfScore * 0.4)
    : seoScore;

  return { seoScore, perfScore, auditScore, issues: seoIssues, aiSuggestions };
}

module.exports = { auditPage, runSeoChecks, getPageSpeedScore, getAiSuggestions };
