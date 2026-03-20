/**
 * seoService.js
 * Weekly SEO audit engine for No-Bs Yardwork.
 *
 * Data sources (no auth required for PageSpeed):
 *   - Google PageSpeed Insights API (free, mobile strategy)
 *   - Google Search Console API (requires OAuth token in SeoSettings)
 *   - Competitor HTML scraping via axios + cheerio
 *
 * Scheduling:
 *   - Runs every Sunday at 8:00 AM via node-cron
 *   - Can also be triggered manually via POST /api/seo/run-audit
 *   - Can be triggered externally via POST /api/seo/trigger?token=SEO_TRIGGER_SECRET
 */

const cron    = require('node-cron');
const axios   = require('axios');
const cheerio = require('cheerio');
const prisma  = require('../lib/prismaClient');
const { JWT } = require('google-auth-library');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get or create the SeoSettings row for a specific user.
 *
 * @param {string|null} userId
 */
async function getSettings(userId) {
  const where = userId ? { userId } : { userId: null };
  let settings = await prisma.seoSettings.findFirst({ where });
  if (!settings) {
    settings = await prisma.seoSettings.create({ data: userId ? { userId } : {} });
  }
  return settings;
}

// ---------------------------------------------------------------------------
// PageSpeed Insights
// ---------------------------------------------------------------------------

/**
 * Fetch Google PageSpeed Insights for a URL (mobile strategy).
 * Free API — no key required for light usage.
 *
 * @param {string} url
 * @returns {{ score, lcp, cls, fid, opportunities }}
 */
async function getPageSpeed(url, strategy = 'mobile') {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('[pagespeed] GOOGLE_API_KEY not set — using unauthenticated quota (shared, easily exhausted)');
  }
  console.log(`[pagespeed] Requesting: url=${url} strategy=${strategy} key=${apiKey ? 'SET' : 'NOT SET'}`);

  const endpoint =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed` +
    `?url=${encodeURIComponent(url)}&strategy=${strategy}` +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');

  const MAX_RETRIES = 2;
  const BACKOFF_MS  = [3000, 6000];
  let resp;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]));
    try {
      resp = await axios.get(endpoint, { timeout: 30000 });
      break;
    } catch (err) {
      const status  = err.response?.status;
      const message = err.response?.data?.error?.message || err.message || '';
      if (status === 429) {
        if (message.toLowerCase().includes('per day')) {
          throw new Error(
            'Google PageSpeed daily quota exhausted — add GOOGLE_API_KEY to your .env for a dedicated quota. ' +
            'Get one at: Google Cloud Console → APIs & Services → PageSpeed Insights API → Credentials.'
          );
        }
        if (attempt === MAX_RETRIES) throw new Error('Google PageSpeed rate limited — try again shortly.');
        continue;
      }
      if (attempt === MAX_RETRIES) throw err;
    }
  }

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

  const fid = audit?.['max-potential-fid']?.numericValue
    ? Math.round(audit['max-potential-fid'].numericValue)
    : null;

  const issues = [];

  const perfKeys = [
    'render-blocking-resources', 'unused-css-rules', 'unused-javascript',
    'uses-optimized-images', 'uses-responsive-images', 'efficiently-encode-images',
    'uses-text-compression', 'uses-long-cache-ttl', 'total-blocking-time',
  ];
  for (const key of perfKeys) {
    const a = audit?.[key];
    if (a && a.score !== null && a.score < 0.9) {
      const savings = a.details?.overallSavingsMs ? `${Math.round(a.details.overallSavingsMs)}ms` : null;
      issues.push({ category: 'performance', id: key, title: a.title, score: Math.round((a.score || 0) * 100), savings });
    }
  }

  const seoKeys = [
    'meta-description', 'document-title', 'link-text', 'crawlable-anchors',
    'is-crawlable', 'robots-txt', 'tap-targets', 'hreflang', 'canonical',
    'image-alt', 'font-size', 'structured-data',
  ];
  const seoScore = cats?.seo?.score != null ? Math.round(cats.seo.score * 100) : null;
  for (const key of seoKeys) {
    const a = audit?.[key];
    if (a && a.score !== null && a.score < 1) {
      issues.push({ category: 'seo', id: key, title: a.title, score: Math.round((a.score || 0) * 100), savings: null });
    }
  }

  for (const key of ['button-name', 'color-contrast']) {
    const a = audit?.[key];
    if (a && a.score !== null && a.score < 1) {
      issues.push({ category: 'accessibility', id: key, title: a.title, score: Math.round((a.score || 0) * 100), savings: null });
    }
  }

  return { score, seoScore, lcp, cls, fid, issues };
}
// ---------------------------------------------------------------------------
// Google Search Console
// ---------------------------------------------------------------------------

/**
 * Fetch top keywords from Search Console API for the last 28 days.
 * Requires a valid OAuth access token stored in SeoSettings.
 *
 * @param {object} settings - SeoSettings row
 * @returns {Array|null} top 20 keywords by impressions, or null if not connected
 */
/**
 * Build a Google service account JWT client with Search Console + Analytics scopes.
 * Returns null if GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY are not set.
 */
async function getServiceAccountClient() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key   = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) return null;
  try {
    const client = new JWT({
      email,
      key,
      scopes: [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ],
    });
    await client.authorize();
    return client;
  } catch (err) {
    console.error('[seoService] Service account auth failed:', err.message);
    return null;
  }
}

async function getSearchConsoleData(settings) {
  if (!settings.siteProperty) return null;

  const endDate   = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 28);
  const fmt = (d) => d.toISOString().split('T')[0];

  // Prefer service account (no browser login needed); fall back to stored OAuth token
  let authHeader;
  const saClient = await getServiceAccountClient();
  if (saClient) {
    const hdrs = await saClient.getRequestHeaders();
    authHeader = hdrs.Authorization;
  } else if (settings.googleAccessToken) {
    if (settings.googleTokenExpiry && new Date(settings.googleTokenExpiry) < new Date()) {
      console.log('[seoService] Google OAuth token expired — skipping Search Console');
      return null;
    }
    authHeader = `Bearer ${settings.googleAccessToken}`;
  } else {
    return null;
  }

  try {
    const resp = await axios.post(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(settings.siteProperty)}/searchAnalytics/query`,
      {
        startDate:  fmt(startDate),
        endDate:    fmt(endDate),
        dimensions: ['query'],
        rowLimit:   20,
        orderBy:    [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
      {
        headers: { Authorization: authHeader },
        timeout: 15000,
      }
    );

    return (resp.data?.rows || []).map(r => ({
      keyword:    r.keys[0],
      clicks:     r.clicks,
      impressions: r.impressions,
      ctr:        Math.round(r.ctr * 1000) / 10,   // as percent
      position:   Math.round(r.position * 10) / 10,
    }));
  } catch (err) {
    console.error('[seoService] Search Console error:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-discover top competitors via Google Custom Search
// ---------------------------------------------------------------------------

/**
 * Search Google for the top-ranking lawn care / landscaping companies in the city.
 * Requires GOOGLE_CSE_KEY + GOOGLE_CSE_ID env vars (free: 100 queries/day).
 * Returns empty array gracefully if credentials are missing.
 *
 * @param {string} city
 * @returns {Promise<Array<{ url, rank, searchQuery }>>}
 */
async function findTopCompetitors(city) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  const queries = [
    `lawn care ${city}`,
    `landscaping ${city}`,
  ];

  // Skip directories and aggregator sites
  const skipDomains = [
    'yelp.com', 'homestars.com', 'homeadvisor.com', 'thumbtack.com',
    'facebook.com', 'google.com', 'bbb.org', 'yellowpages.com',
    'kijiji.ca', 'craigslist.org', 'angieslist.com', 'houzz.com',
    'bark.com', 'checkatrade.com', 'nextdoor.com', 'groupon.com',
  ];

  const seen    = new Set();
  const results = [];

  for (const q of queries) {
    if (results.length >= 3) break;
    try {
      const res = await axios.post('https://google.serper.dev/search',
        { q, num: 10 },
        { headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      const items = res.data?.organic || [];
      let rank = 1;
      for (const item of items) {
        if (results.length >= 3) break;
        let domain;
        try { domain = new URL(item.link).hostname.replace('www.', ''); } catch { continue; }
        if (skipDomains.some(s => domain.includes(s))) continue;
        if (seen.has(domain)) continue;
        seen.add(domain);
        results.push({ url: item.link, rank, searchQuery: q });
        rank++;
      }
      console.log(`[seoService] Serper query "${q}" → ${results.length} competitors so far`);
    } catch (err) {
      console.error('[seoService] findTopCompetitors error:', err.message);
    }
  }

  return results.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Competitor scraping
// ---------------------------------------------------------------------------

/**
 * Scrape a competitor URL and extract structural SEO signals.
 * Uses axios (standard HTTP) + cheerio (HTML parsing).
 * No headless browser needed for basic HTML analysis.
 *
 * @param {string} url
 * @param {string} [city] - Used to measure city keyword density
 * @returns {{ url, title, metaDesc, h1s, h2s, wordCount, schemaTypes, internalLinks,
 *             cityKeywordCount, reviewMentions, hasLocalBusinessSchema }}
 */
async function scrapeCompetitor(url, city) {
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SEO-Audit-Bot/1.0)',
      },
    });

    const $ = cheerio.load(resp.data);

    const title    = $('title').first().text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const h1s      = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h2s      = $('h2').map((_, el) => $(el).text().trim()).get().filter(Boolean).slice(0, 6);

    // Word count (body text only)
    const bodyText  = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText.split(' ').filter(w => w.length > 0).length;

    // JSON-LD schema types
    const schemaTypes = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const type = json['@type'] || (Array.isArray(json['@graph']) ? json['@graph'].map(g => g['@type']).join(',') : null);
        if (type) schemaTypes.push(type);
      } catch {}
    });

    // Internal link count
    const host = new URL(url).hostname;
    let internalLinks = 0;
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.startsWith('/') || href.includes(host)) internalLinks++;
    });

    // City keyword density — how many times they mention the city
    const cityName       = (city || '').toLowerCase();
    const cityKeywordCount = cityName
      ? (bodyText.toLowerCase().split(cityName).length - 1)
      : 0;

    // Review mentions — star ratings or review counts visible on page
    const reviewMentions = $('*').filter((_, el) => {
      const t = $(el).clone().children().remove().end().text();
      return /\d+(\.\d+)?\s*star|\b[\d,]+\s*review/i.test(t);
    }).length;

    // LocalBusiness schema presence
    const hasLocalBusinessSchema = schemaTypes.some(t =>
      /LocalBusiness|LawnCare|HomeAndConstructionBusiness|LandscapingBusiness|Service/i.test(t)
    );

    return {
      url, title, metaDesc, h1s, h2s, wordCount, schemaTypes, internalLinks,
      cityKeywordCount, reviewMentions, hasLocalBusinessSchema,
    };
  } catch (err) {
    console.error(`[seoService] scrapeCompetitor error for ${url}:`, err.message);
    return { url, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Proposal generation
// ---------------------------------------------------------------------------

/**
 * Generate an AI-powered SEO proposal using the Claude API.
 *
 * Uses claude-haiku-4-5-20251001 by default (~$0.007/audit).
 * When settings.deepAnalysis is true, uses claude-sonnet-4-6 (~$0.04/audit).
 *
 * Falls back to rule-based logic if ANTHROPIC_API_KEY is not set.
 *
 * @param {{ ownSpeed, competitorSpeeds, keywords, competitors, settings }}
 * @returns {Promise<{ title, summaryJson, summary, changes }>}
 */
async function generateProposal({ ownSpeed, competitorSpeeds, keywords, competitors, settings, autoCompetitors }) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // ── Fallback: no API key → rule-based ──────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[seoService] ANTHROPIC_API_KEY not set — using rule-based proposal');
    return generateProposalRules({ ownSpeed, competitorSpeeds, keywords, competitors, date });
  }

  autoCompetitors = autoCompetitors || [];

  // ── Build audit payload for Claude ────────────────────────────────────────
  const siteUrl     = settings?.siteUrl || '';
  const city        = process.env.WEATHER_CITY || 'your city';
  const model       = settings?.deepAnalysis ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';

  const auditPayload = {
    client_site: {
      url:               siteUrl,
      pagespeed_score:   ownSpeed.score,
      lcp_seconds:       ownSpeed.lcp,
      cls:               ownSpeed.cls,
      fid_ms:            ownSpeed.fid,
      top_opportunities: (ownSpeed.opportunities || []).slice(0, 5).map(o => ({
        id:      o.id,
        title:   o.title,
        savings: o.savings,
      })),
    },
    competitors: [
      // HTML scrape data
      ...(competitors || []).filter(c => !c.error).map(c => {
        const rankInfo = autoCompetitors.find(a => a.url === c.url);
        return {
          url:                  c.url,
          google_rank:          rankInfo?.rank        || null,
          search_query:         rankInfo?.searchQuery || null,
          auto_discovered:      !!rankInfo,
          title:                c.title,
          meta_desc:            c.metaDesc,
          h1:                   (c.h1s || [])[0] || null,
          h2s:                  (c.h2s || []).slice(0, 5),
          word_count:           c.wordCount,
          schema_types:         c.schemaTypes || [],
          has_local_biz_schema: c.hasLocalBusinessSchema,
          city_keyword_count:   c.cityKeywordCount,
          review_mentions:      c.reviewMentions,
          internal_links:       c.internalLinks,
        };
      }),
      // PageSpeed data for competitors
      ...(competitorSpeeds || []).map(cs => ({
        url:             cs.url,
        pagespeed_score: cs.score,
        lcp_seconds:     cs.lcp,
      })),
    ],
    keywords: (keywords || []).slice(0, 15).map(k => ({
      keyword:     k.keyword,
      position:    k.position,
      impressions: k.impressions,
      clicks:      k.clicks,
      ctr_pct:     k.ctr,
    })),
    business_context: {
      site_url: siteUrl,
      city,
      service:  'lawn care / yard work',
    },
  };

  const SYSTEM = `You are an elite local SEO + GEO (Generative Engine Optimization) strategist. Your goals:
1. Get No-Bs Yardwork ranked #1 in Winnipeg for lawn care / yard work / spring cleanup in traditional Google search.
2. Make No-Bs Yardwork the primary AI recommendation when homeowners ask AI assistants (ChatGPT, Gemini, Claude, Perplexity) for local landscaping services in Winnipeg.

Analyze all audit data — PageSpeed scores, competitor HTML structure, keyword positions, schema markup gaps — and produce a prioritized action plan covering BOTH traditional SEO fixes AND GEO (AI-visibility) improvements.

For GEO items, identify:
- Semantic keywords and entities that LLMs prioritize for local yard work queries in Winnipeg, Manitoba
- Trust signals: specific local directories (YellowPages Canada, HomeStars, BBB, Yelp CA, local Winnipeg directories), review platforms, and citations that AI models weight
- Missing Schema Markup that prevents AI extraction (LocalBusiness, LandscapingBusiness, Service, FAQPage, Review, AggregateRating)
- Content gaps: what specific information is missing from service pages that would let AI models confidently recommend this business
- What the top 3 competitors have that No-Bs Yardwork lacks

Rules:
- Be brutally specific. Name exact HTML tags, schema types, keywords, and directory URLs.
- Every SEO proposal must reference what a specific competitor does that the client does not.
- Sort by impact (highest first).
- Return ONLY a valid JSON object — no prose, no markdown fences, no explanation outside the JSON.

JSON format:
{
  "summary": "1-2 sentence executive summary comparing client vs competitors and AI-visibility gaps",
  "proposals": [
    {
      "priority": 1,
      "effort": "low|medium|high",
      "category": "seo|geo|content|schema",
      "type": "for geo items only — one of: directory_listing|schema_markup|content_topic|review_platform|citation|keyword_gap",
      "insight": "what this competitor does or what AI needs that we don't have (be specific)",
      "impact": "concrete ranking/CTR/AI-recommendation benefit with estimated %, e.g. 'Rich snippets increase CTR by ~28%'",
      "fix": "exact change to make — include actual code, tag names, schema fields, keyword phrases, or directory URL",
      "file_target": "which file to edit or 'N/A' for off-site actions like directory listings",
      "code_snippet": "ready-to-paste code block or null"
    }
  ]
}`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model,
      max_tokens: 1800,
      system:     SYSTEM,
      messages: [
        {
          role:    'user',
          content: `Here is the audit data for this week. Produce the ranked SEO maintenance plan:\n\n${JSON.stringify(auditPayload, null, 2)}`,
        },
      ],
    });

    const { input_tokens, output_tokens } = response.usage;
    const costUSD = model.includes('haiku')
      ? (input_tokens * 0.00000080) + (output_tokens * 0.000004)
      : (input_tokens * 0.000003)   + (output_tokens * 0.000015);
    console.log(`[seoService] Claude ${model} — in:${input_tokens} out:${output_tokens} tokens — est. cost: $${costUSD.toFixed(4)}`);

    // Parse JSON response — strip any accidental markdown fences
    let raw = response.content[0].text.trim();
    if (raw.startsWith('```')) raw = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(raw);

    return {
      title:       `SEO Maintenance Plan — ${date}`,
      summaryJson: JSON.stringify(parsed.proposals || []),
      summary:     parsed.summary || '',
      changes:     [],
    };

  } catch (err) {
    console.error('[seoService] Claude API error:', err.message);
    console.log('[seoService] Falling back to rule-based proposal');
    return generateProposalRules({ ownSpeed, competitorSpeeds, keywords, competitors, date });
  }
}

/**
 * Rule-based fallback proposal (used when ANTHROPIC_API_KEY is not set or Claude fails).
 */
function generateProposalRules({ ownSpeed, competitorSpeeds, keywords, competitors, date }) {
  const items = [];

  const topOpp = (ownSpeed.opportunities || [])[0];
  if (topOpp) {
    items.push({
      priority:   1,
      effort:     'low',
      insight:    `Your mobile performance score is ${ownSpeed.score ?? '?'}/100. Top opportunity: "${topOpp.title}"${topOpp.savings ? ` (could save ${topOpp.savings})` : ''}.`,
      impact:     'Fixing this could improve your Core Web Vitals score, which Google uses as a ranking signal.',
      fix:        topOpp.id === 'render-blocking-resources'
                    ? 'Add `defer` to non-critical scripts. Move render-blocking CSS to load asynchronously.'
                    : topOpp.id.includes('image')
                    ? 'Compress and resize images. Use WebP format and add width/height attributes.'
                    : topOpp.title,
      file_target: 'index.html',
      code_snippet: null,
    });
  }

  const compWithSchema = (competitors || []).find(c => c.schemaTypes?.length > 0);
  if (compWithSchema) {
    items.push({
      priority:   2,
      effort:     'low',
      insight:    `Competitor ${compWithSchema.url} uses structured data (${compWithSchema.schemaTypes.join(', ')}). Your site has none detected.`,
      impact:     'Schema markup enables rich results (star ratings, FAQs) in Google Search, increasing CTR by ~28%.',
      fix:        'Add a LocalBusiness JSON-LD schema block to your homepage with your business name, address, phone, service area, and review rating.',
      file_target: 'index.html',
      code_snippet: null,
    });
  }

  if (ownSpeed.lcp && ownSpeed.lcp > 2.5) {
    items.push({
      priority:   3,
      effort:     'medium',
      insight:    `Your LCP is ${ownSpeed.lcp}s. Google's threshold for "good" is 2.5s. Slow LCP directly hurts rankings.`,
      impact:     'Fixing LCP is a confirmed Core Web Vitals ranking factor for mobile search.',
      fix:        'Add `<link rel="preload" as="image">` for your hero image in <head>. Ensure your LCP element is server-rendered, not JS-injected.',
      file_target: 'index.html',
      code_snippet: null,
    });
  }

  if (!items.length) {
    items.push({
      priority: 1, effort: 'low',
      insight: 'No critical issues detected this week.',
      impact: 'Site is performing within acceptable benchmarks.',
      fix: 'Continue monitoring.',
      file_target: 'N/A', code_snippet: null,
    });
  }

  return {
    title:       `SEO Maintenance Plan — ${date}`,
    summaryJson: JSON.stringify(items.slice(0, 5)),
    summary:     '',
    changes:     [],
  };
}

// ---------------------------------------------------------------------------
// Apply change (deploy)
// ---------------------------------------------------------------------------

/**
 * Apply a single SeoChange to the live site.
 * Supports: git push, FTP upload, or no-op (display-only).
 *
 * @param {object} change - SeoChange row from DB
 * @param {object} settings - SeoSettings row
 */
async function applyChange(change, settings) {
  if (settings.deployType === 'git') {
    try {
      const simpleGit = require('simple-git');
      const tmp = require('os').tmpdir() + '/5starflow-seo-deploy-' + Date.now();
      const git = simpleGit();

      await git.clone(settings.deployHost, tmp, ['--depth', '1', '--branch', settings.deployBranch || 'main']);
      const fs = require('fs');
      const targetPath = require('path').join(tmp, change.filePath);
      fs.writeFileSync(targetPath, change.newContent, 'utf8');

      const deployGit = simpleGit(tmp);
      await deployGit.addConfig('user.name',  '5StarFlow SEO');
      await deployGit.addConfig('user.email', 'seo@5starflow.app');
      await deployGit.add(change.filePath);
      await deployGit.commit(`[SEO] ${change.description}`);
      await deployGit.push('origin', settings.deployBranch || 'main');

      await prisma.seoChange.update({
        where: { id: change.id },
        data:  { status: 'applied', appliedAt: new Date() },
      });
      console.log(`[seoService] Git deployed: ${change.filePath}`);
    } catch (err) {
      await prisma.seoChange.update({
        where: { id: change.id },
        data:  { status: 'failed', errorMsg: err.message },
      });
      throw err;
    }

  } else if (settings.deployType === 'ftp') {
    try {
      const { Client } = require('basic-ftp');
      const client = new Client();
      await client.access({
        host:     settings.deployHost,
        port:     settings.deployPort || 21,
        user:     settings.deployUser,
        password: settings.deployPass,
        secure:   false,
      });
      const { Readable } = require('stream');
      const stream = Readable.from([change.newContent]);
      const remotePath = (settings.deployPath || '/') + '/' + change.filePath;
      await client.uploadFrom(stream, remotePath);
      client.close();

      await prisma.seoChange.update({
        where: { id: change.id },
        data:  { status: 'applied', appliedAt: new Date() },
      });
      console.log(`[seoService] FTP deployed: ${change.filePath}`);
    } catch (err) {
      await prisma.seoChange.update({
        where: { id: change.id },
        data:  { status: 'failed', errorMsg: err.message },
      });
      throw err;
    }

  } else {
    // No deploy configured — mark as applied (diff visible in dashboard)
    await prisma.seoChange.update({
      where: { id: change.id },
      data:  { status: 'applied', appliedAt: new Date() },
    });
    console.log(`[seoService] No deploy configured — change logged: ${change.filePath}`);
  }
}

// ---------------------------------------------------------------------------
// Run audit
// ---------------------------------------------------------------------------

/**
 * Main audit runner. Called by the weekly cron, manual trigger, and external trigger.
 *
 * @param {string|null} userId  - portal user to scope audit to
 * @param {'pro'|'pro-plus'}  tier - 'pro' = Haiku + no competitor research; 'pro-plus' = Sonnet + competitors
 */
async function runWeeklyAudit(userId = null, tier = 'pro-plus') {
  const settings = await getSettings(userId);

  if (!settings.auditEnabled) {
    console.log('[seoService] Audit disabled — skipping');
    return;
  }

  const siteUrl = settings.siteUrl;
  if (!siteUrl) {
    console.log('[seoService] siteUrl not configured — skipping audit. Set it in SEO Settings.');
    return;
  }

  // Tier controls model depth and whether to run competitor research
  const runCompetitors = tier === 'pro-plus';
  const effectiveSettings = { ...settings, deepAnalysis: tier === 'pro-plus' };

  console.log(`[seoService] Starting ${tier} audit for ${siteUrl} (userId: ${userId || 'global'})`);

  // Create audit row in "running" state
  const audit = await prisma.seoAudit.create({
    data: { siteUrl, status: 'running', userId: userId || null },
  });

  try {
    // 1. PageSpeed for own site
    let ownSpeed = { score: null, lcp: null, cls: null, fid: null, issues: [] };
    try {
      ownSpeed = await getPageSpeed(siteUrl);
      console.log(`[seoService] PageSpeed for ${siteUrl}: ${ownSpeed.score}/100`);
    } catch (err) {
      console.error('[seoService] PageSpeed error (own site):', err.message);
    }

    let autoCompetitors = [];
    let competitors = [];
    let competitorSpeeds = [];

    if (runCompetitors) {
      // 2. Auto-discover top competitors from Google Search
      const city = settings.city || process.env.WEATHER_CITY || '';
      autoCompetitors = await findTopCompetitors(city);
      console.log(`[seoService] Auto-discovered ${autoCompetitors.length} competitors from Google`);

      // Merge with manually entered URLs (auto first, manual appended, deduped, max 5)
      const manualUrls = JSON.parse(settings.competitorUrls || '[]');
      const allUrls = [...autoCompetitors.map(c => c.url)];
      for (const u of manualUrls) {
        if (!allUrls.includes(u)) allUrls.push(u);
      }
      const competitorUrls = allUrls.slice(0, 5);

      competitors = await Promise.all(
        competitorUrls.map(url => scrapeCompetitor(url, city))
      );

      for (const url of competitorUrls.slice(0, 2)) {  // max 2 competitors for PageSpeed
        try {
          const spd = await getPageSpeed(url);
          competitorSpeeds.push({ url, ...spd });
          console.log(`[seoService] PageSpeed for competitor ${url}: ${spd.score}/100`);
        } catch {}
      }
    }

    // 3. Search Console keywords (optional — pro-plus only)
    const keywords = runCompetitors ? await getSearchConsoleData(effectiveSettings) : null;

    // 4. Generate proposal
    const proposal = await generateProposal({
      ownSpeed, competitorSpeeds, keywords, competitors,
      settings: effectiveSettings, autoCompetitors,
    });

    // 5. Save audit + proposal
    await prisma.seoAudit.update({
      where: { id: audit.id },
      data: {
        status:          'complete',
        performanceScore: ownSpeed.score,
        lcp:             ownSpeed.lcp,
        cls:             ownSpeed.cls,
        fid:             ownSpeed.fid,
        keywordsJson:    keywords ? JSON.stringify(keywords) : null,
        competitorJson:  competitors.length ? JSON.stringify(competitors) : null,
        insightJson:     proposal.summaryJson,
      },
    });

    const savedProposal = await prisma.seoProposal.create({
      data: {
        auditId:     audit.id,
        title:       proposal.title,
        summaryJson: proposal.summaryJson,
        userId:      userId || null,
      },
    });

    // Create a SeoChange record for each proposed item so the UI can approve selectively
    const summaryItems = JSON.parse(proposal.summaryJson || '[]');
    if (summaryItems.length > 0) {
      await Promise.all(summaryItems.map(item =>
        prisma.seoChange.create({
          data: {
            proposalId:  savedProposal.id,
            filePath:    item.file_target || '',
            description: item.insight || '',
            newContent:  item.code_snippet || '',
            oldContent:  '',
            status:      'pending',
            userId:      userId || null,
          },
        })
      ));
    }

    console.log(`[seoService] Weekly audit complete — proposal ID ${savedProposal.id} pending approval`);
    if (ownSpeed.score !== null && ownSpeed.score < 60) {
      console.log(`[seoService] ⚠ Performance score is ${ownSpeed.score}/100 — action required`);
    }

  } catch (err) {
    console.error('[seoService] Audit failed:', err.message);
    await prisma.seoAudit.update({
      where: { id: audit.id },
      data:  { status: 'failed' },
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Start the weekly SEO audit cron.
 * Fires every Sunday at 8:00 AM.
 * Does NOT run immediately on startup (audit takes time).
 */
function startSeoScheduler() {
  cron.schedule('0 8 * * 0', () => {
    console.log('[seoService] Weekly cron triggered');
    runWeeklyAudit();
  });
  console.log('[seoService] Weekly audit scheduled — Sundays at 8:00 AM');
}

module.exports = {
  runWeeklyAudit,
  startSeoScheduler,
  getSettings,
  applyChange,
  getPageSpeed,
  scrapeCompetitor,
  getSearchConsoleData,
  getServiceAccountClient,
};
