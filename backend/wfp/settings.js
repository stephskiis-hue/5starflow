/**
 * Winnipeg Fence Pros settings: what the page's Settings tab edits and every job reads.
 *
 * A value comes from, in order: the page (WfpSetting row, secrets encrypted with lib/ftpCrypto), the WFP_<KEY>
 * environment variable (.env / Railway), then for API keys the server's shared variable (`shared`), then the default.
 * Stored in Postgres rather than written into .env because the server's files are replaced on every deploy.
 * Secrets never leave the server: publicView() only says whether one is set.
 */
const prisma = require('../lib/prismaClient');
const { encryptPassword, decryptPassword } = require('../lib/ftpCrypto');

const DEFAULT_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}} | {{BUSINESS_NAME}}</title>
<meta name="description" content="{{META_DESCRIPTION}}">
<link rel="canonical" href="{{CANONICAL}}">
<meta property="og:type" content="article">
<meta property="og:title" content="{{TITLE}}">
<meta property="og:description" content="{{META_DESCRIPTION}}">
<meta property="og:url" content="{{CANONICAL}}">
<meta property="og:image" content="{{IMAGE_URL}}">
{{SCHEMA}}
<style>
  :root { --ink: #1d2327; --muted: #5b6770; --brand: #7a4b22; --brand-dark: #5a3516; --bg: #ffffff; --soft: #f6f2ee; --line: #e6ddd4; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); background: var(--bg); line-height: 1.7; }
  header, footer { background: var(--soft); border-bottom: 1px solid var(--line); }
  footer { border-top: 1px solid var(--line); border-bottom: 0; margin-top: 3rem; }
  .wrap { max-width: 780px; margin: 0 auto; padding: 1rem 16px; }
  header a.brand { color: var(--brand-dark); font-weight: 800; text-decoration: none; font-size: 1.15rem; }
  header .call { float: right; color: var(--brand-dark); font-weight: 700; text-decoration: none; }
  h1 { font-size: clamp(1.7rem, 4vw, 2.4rem); line-height: 1.2; margin: 1.5rem 0 .5rem; }
  h2 { font-size: 1.45rem; margin-top: 2.2rem; line-height: 1.3; }
  h3 { font-size: 1.15rem; margin-top: 1.6rem; }
  .meta { color: var(--muted); font-size: .92rem; }
  .hero { width: 100%; height: auto; border-radius: 10px; margin: 1rem 0; }
  a { color: var(--brand); }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid var(--line); padding: .5rem .7rem; text-align: left; }
  .cta { background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem; margin: 2.5rem 0; }
  .cta a.btn { display: inline-block; background: var(--brand); color: #fff; padding: .7rem 1.2rem; border-radius: 8px; text-decoration: none; font-weight: 700; }
</style>
</head>
<body>
<header><div class="wrap"><a class="brand" href="{{SITE_URL}}/">{{BUSINESS_NAME}}</a> <a class="call" href="tel:{{PHONE}}">{{PHONE}}</a></div></header>
<main class="wrap">
  <article>
    <p class="meta"><a href="{{BLOG_URL}}">Blog</a> · {{CATEGORY}} · {{DATE_HUMAN}} · {{READ_TIME}} min read</p>
    <h1>{{TITLE}}</h1>
    <!--HERO--><img class="hero" src="{{IMAGE}}" alt="{{IMAGE_ALT}}" width="1200" height="675"><!--/HERO-->
    {{BODY}}
    <div class="cta">
      <h2>Get a free fence quote</h2>
      <p>{{BUSINESS_NAME}} builds and repairs fences across {{CITY}}. Tell us about your yard and we will get back to you with a clear price.</p>
      <p><a class="btn" href="{{QUOTE_URL}}">Get My Free Quote</a> or call <a href="tel:{{PHONE}}">{{PHONE}}</a></p>
    </div>
  </article>
</main>
<footer><div class="wrap"><p>&copy; {{YEAR}} {{BUSINESS_NAME}} · {{CITY}}, {{REGION}}</p></div></footer>
</body>
</html>`;

// group: the Settings tab card it appears on. secret: encrypted, write-only. shared: server variable used when blank.
const FIELDS = [
  { key: 'BUSINESS_NAME', group: 'business', label: 'Business name', def: 'Winnipeg Fence Pros' },
  { key: 'SITE_URL', group: 'business', label: 'Website URL', help: 'https://www.example.com (no trailing slash)' },
  { key: 'CITY', group: 'business', label: 'City', def: 'Winnipeg' },
  { key: 'REGION', group: 'business', label: 'Province', def: 'Manitoba' },
  { key: 'PHONE', group: 'business', label: 'Phone', def: '' },
  { key: 'QUOTE_URL', group: 'business', label: 'Quote / contact page URL', help: 'Every post links here' },
  { key: 'SERVICES', group: 'business', label: 'Services (one per line)', multiline: true,
    def: 'fence installation\nfence repair\nwood fence\ncedar fence\nvinyl fence\nchain link fence\ncomposite fence\nprivacy fence\ngate installation\nfence staining\ndeck building' },
  { key: 'AREAS', group: 'business', label: 'Neighbourhoods served (one per line)', multiline: true,
    def: 'St. Vital\nSt. Boniface\nTranscona\nRiver Heights\nCharleswood\nFort Garry\nWaverley West\nNorth Kildonan\nSage Creek\nSt. James\nTuxedo\nEast St. Paul' },
  { key: 'BRAND_TERMS', group: 'business', label: 'Brand words (one per line)', multiline: true, def: 'winnipeg fence pros\nwinnipegfencepros', help: 'Searches for your own name are not keyword targets' },

  { key: 'FTP_HOST', group: 'ftp', label: 'FTP host' },
  { key: 'FTP_PORT', group: 'ftp', label: 'FTP port', def: '21' },
  { key: 'FTP_USER', group: 'ftp', label: 'FTP user' },
  { key: 'FTP_PASS', group: 'ftp', label: 'FTP password', secret: true },
  { key: 'FTP_PATH', group: 'ftp', label: 'Website folder on the server', def: '/public_html' },
  { key: 'FTP_SECURE', group: 'ftp', label: 'Use FTPS (TLS)', bool: true, def: 'false' },
  { key: 'BLOG_DIR', group: 'ftp', label: 'Blog folder inside the website folder', def: '', help: 'Blank = posts sit next to the home page' },
  { key: 'IMAGES_DIR', group: 'ftp', label: 'Images folder inside the website folder', def: 'images' },
  { key: 'BLOG_INDEX_FILE', group: 'ftp', label: 'Blog index page', def: 'blog.html', help: 'Its "var POSTS = [...]" list gets each new post. Blank = skip' },
  { key: 'CLEAN_URLS', group: 'ftp', label: 'Links without .html', bool: true, def: 'false', help: 'Only if the host rewrites /post to /post.html' },
  { key: 'DEFAULT_IMAGE', group: 'ftp', label: 'Fallback hero image', def: '', help: 'Used when Pexels has nothing, e.g. images/fence.jpg' },

  { key: 'SITEMAP_URL', group: 'sitemap', label: 'Sitemap URL', help: 'https://www.example.com/sitemap.xml, submitted to Search Console after each post' },
  { key: 'SITEMAP_FILE', group: 'sitemap', label: 'Sitemap file inside the website folder', def: 'sitemap.xml' },
  { key: 'SITEMAP_AUTO', group: 'sitemap', label: 'Add every new post to the sitemap and resubmit it', bool: true, def: 'true' },

  { key: 'GSC_PROPERTY', group: 'google', label: 'Search Console property', help: 'sc-domain:example.com or https://www.example.com/' },
  { key: 'GOOGLE_SA_JSON', group: 'google', label: 'Service account JSON (optional)', secret: true, multiline: true,
    help: 'Blank = the 5StarFlow service account. Either way, add its email as a Full user on the property' },

  { key: 'ANTHROPIC_API_KEY', group: 'keys', label: 'Anthropic API key (Claude writer)', secret: true, shared: 'ANTHROPIC_API_KEY' },
  { key: 'SERPER_API_KEY', group: 'keys', label: 'Serper API key (rank tracking + discovery)', secret: true, shared: 'SERPER_API_KEY' },
  { key: 'PEXELS_API_KEY', group: 'keys', label: 'Pexels API key (hero photos)', secret: true, shared: 'PEXELS_API_KEY' },
  { key: 'SERPER_WEEKLY_BUDGET', group: 'keys', label: 'Serper searches per week', def: '80' },

  { key: 'AUTOPILOT', group: 'autopilot', label: 'Autopilot on', bool: true, def: 'false', help: 'Writes and posts on the days below' },
  { key: 'PUBLISH_MODE', group: 'autopilot', label: 'Publish mode', options: ['auto', 'review'], def: 'auto', help: 'review = posts wait as drafts until you press Publish' },
  { key: 'POST_DAYS', group: 'autopilot', label: 'Post days', def: 'mon,thu', help: 'mon,tue,wed,thu,fri,sat,sun' },
  { key: 'POST_HOUR', group: 'autopilot', label: 'Post hour (24h, Winnipeg time)', def: '9' },
  { key: 'POSTS_PER_WEEK', group: 'autopilot', label: 'Max posts per 7 days', def: '2' },
  { key: 'FOCUS_MAX', group: 'autopilot', label: 'Focus keywords at once', def: '3' },
  { key: 'FOCUS_SUPPORT', group: 'autopilot', label: 'Supporting posts per focus keyword', def: '4' },
  { key: 'RANK_TRACK_MAX', group: 'autopilot', label: 'Keywords rank-tracked weekly', def: '20' },
  { key: 'RECOMMEND_MAX', group: 'autopilot', label: 'Keyword recommendations per week', def: '5' },
  { key: 'POST_CATEGORY', group: 'autopilot', label: 'Default blog category', def: 'Fencing' },
  { key: 'WRITER_MODEL', group: 'autopilot', label: 'Claude model', def: 'claude-opus-5-5' },
  { key: 'WRITER_NOTES', group: 'autopilot', label: 'Notes for Claude (voice, what to always / never say)', multiline: true,
    def: 'Plain, friendly, practical. Canadian spelling. Talk like a local fence contractor, not a marketer. Never invent prices, reviews, warranties or awards.' },
  { key: 'POST_TEMPLATE', group: 'template', label: 'Post page template', multiline: true, def: DEFAULT_TEMPLATE },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

let cache = null;
let cacheAt = 0;

async function rows() {
  if (cache && Date.now() - cacheAt < 5000) return cache;
  const list = await prisma.wfpSetting.findMany();
  cache = Object.fromEntries(list.map((r) => [r.key, r.value]));
  cacheAt = Date.now();
  return cache;
}

/** { value, source } for one field: page | env | server | default. */
function resolve(field, stored, env = process.env) {
  if (stored[field.key] !== undefined && stored[field.key] !== '') {
    return { value: field.secret ? decryptPassword(stored[field.key]) : stored[field.key], source: 'page' };
  }
  if (env[`WFP_${field.key}`]) return { value: env[`WFP_${field.key}`], source: 'env' };
  if (field.shared && env[field.shared]) return { value: env[field.shared], source: 'server' };
  return { value: field.def ?? '', source: 'default' };
}

const lines = (s) => String(s || '').split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
const bool = (s) => /^(1|true|on|yes)$/i.test(String(s || '').trim());
const int = (s, d) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : d; };

/** Typed config every job uses. */
function toConfig(raw) {
  const site = String(raw.SITE_URL || '').trim().replace(/\/+$/, '');
  const blogDir = String(raw.BLOG_DIR || '').trim().replace(/^\/+|\/+$/g, '');
  return {
    ...raw,
    SITE_URL: site,
    BLOG_DIR: blogDir,
    services: lines(raw.SERVICES).map((s) => s.toLowerCase()),
    areas: lines(raw.AREAS),
    brandTerms: lines(raw.BRAND_TERMS).map((s) => s.toLowerCase()),
    ftpPort: int(raw.FTP_PORT, 21),
    ftpSecure: bool(raw.FTP_SECURE),
    cleanUrls: bool(raw.CLEAN_URLS),
    sitemapAuto: bool(raw.SITEMAP_AUTO),
    autopilot: bool(raw.AUTOPILOT),
    publishMode: raw.PUBLISH_MODE === 'review' ? 'review' : 'auto',
    postDays: lines(String(raw.POST_DAYS || '').toLowerCase()).map((d) => d.slice(0, 3)),
    postHour: Math.min(23, Math.max(0, int(raw.POST_HOUR, 9))),
    postsPerWeek: Math.max(0, int(raw.POSTS_PER_WEEK, 2)),
    focusMax: Math.max(1, int(raw.FOCUS_MAX, 3)),
    focusSupport: Math.max(0, int(raw.FOCUS_SUPPORT, 4)),
    rankTrackMax: Math.max(0, int(raw.RANK_TRACK_MAX, 20)),
    recommendMax: Math.max(1, int(raw.RECOMMEND_MAX, 5)),
    serperWeeklyBudget: Math.max(0, int(raw.SERPER_WEEKLY_BUDGET, 80)),
    host: (() => { try { return new URL(site).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
  };
}

async function getConfig() {
  const stored = await rows();
  const raw = {};
  for (const f of FIELDS) raw[f.key] = resolve(f, stored).value;
  return toConfig(raw);
}

/** What the page may see: no secret values, only whether they are set and where from. */
async function publicView() {
  const stored = await rows();
  return FIELDS.map((f) => {
    const { value, source } = resolve(f, stored);
    const base = { key: f.key, group: f.group, label: f.label, help: f.help || '', secret: !!f.secret, multiline: !!f.multiline, bool: !!f.bool, options: f.options || null, source };
    return f.secret ? { ...base, value: '', isSet: !!value } : { ...base, value, isSet: value !== '' };
  });
}

/**
 * Save the page's form. Blank secrets keep the stored value (the form never receives them); `clear: [KEY]` removes
 * a stored value so the env/default applies again. Unknown keys are ignored.
 */
async function saveSettings(values = {}, clear = []) {
  const ops = [];
  for (const [key, v] of Object.entries(values || {})) {
    const f = BY_KEY[key];
    if (!f || v === undefined || v === null) continue;
    const val = typeof v === 'boolean' ? String(v) : String(v);
    if (f.secret && val.trim() === '') continue;
    if (f.options && !f.options.includes(val)) continue;
    const stored = f.secret ? encryptPassword(val.trim()) : (f.multiline ? val : val.trim());
    ops.push(prisma.wfpSetting.upsert({ where: { key }, update: { value: stored }, create: { key, value: stored } }));
  }
  for (const key of clear || []) if (BY_KEY[key]) ops.push(prisma.wfpSetting.deleteMany({ where: { key } }));
  if (ops.length) await prisma.$transaction(ops);
  cache = null;
  return ops.length;
}

/** Plain list of what is still missing for each part of the autopilot. */
function missing(cfg) {
  const out = [];
  if (!cfg.SITE_URL) out.push('Website URL');
  if (!cfg.FTP_HOST || !cfg.FTP_USER || !cfg.FTP_PASS) out.push('FTP login');
  if (!cfg.ANTHROPIC_API_KEY) out.push('Anthropic API key');
  if (!cfg.GSC_PROPERTY) out.push('Search Console property');
  if (!cfg.SERPER_API_KEY) out.push('Serper API key');
  if (cfg.sitemapAuto && !cfg.SITEMAP_URL) out.push('Sitemap URL');
  return out;
}

module.exports = { FIELDS, DEFAULT_TEMPLATE, getConfig, publicView, saveSettings, missing, toConfig, resolve, _reset: () => { cache = null; } };
