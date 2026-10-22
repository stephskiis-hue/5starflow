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

const { POST_TEMPLATE: DEFAULT_TEMPLATE, CARD_TEMPLATE: DEFAULT_CARD, INDEX_TEMPLATE: DEFAULT_INDEX } = require('./templates');

// group: the Settings tab card it appears on. secret: encrypted, write-only. shared: server variable used when blank.
const FIELDS = [
  { key: 'BUSINESS_NAME', group: 'business', label: 'Business name', def: 'Winnipeg Fence Pros' },
  { key: 'SITE_URL', group: 'business', label: 'Website URL', def: 'https://www.winnipegfencepros.com', help: 'No trailing slash' },
  { key: 'CITY', group: 'business', label: 'City', def: 'Winnipeg' },
  { key: 'REGION', group: 'business', label: 'Province', def: 'Manitoba' },
  { key: 'PHONE', group: 'business', label: 'Phone', def: '' },
  { key: 'QUOTE_URL', group: 'business', label: 'Quote / contact page URL', def: 'https://www.winnipegfencepros.com/#contactus', help: 'Every post links here' },
  { key: 'LOGO_URL', group: 'business', label: 'Logo (path or URL)', def: '/img/logo.webp', help: 'Shown in the header of every article page' },
  { key: 'FAVICON_URL', group: 'business', label: 'Favicon (path or URL)', def: '/img/logo.ico' },
  { key: 'NAV_LINKS', group: 'business', label: 'Menu links (one per line: Label | /page)', multiline: true, def: 'Fence | /\nDeck | /decks.html\nPergola | /pergolas.html\nLandscape | /landscaping.html\nArticles | /articles/', help: 'The header and footer menu on the article pages' },
  { key: 'SERVICES', group: 'business', label: 'Services = blog categories (one per line: Name | page on the site | words people search)', multiline: true,
    def: 'Fence | / | fence, gate, picket, chain link, privacy\nDeck | /decks.html | deck, decking, railing\nPergola | /pergolas.html | pergola, gazebo, pavilion\nLandscaping | /landscaping.html | landscaping, landscape, retaining wall, patio, paver, garden',
    help: 'Each article is written for one service, filed under its name, and links to its page. Keywords that match no service are ignored. Delete a line to stop writing about it.' },
  { key: 'AREAS', group: 'business', label: 'Neighbourhoods served (one per line)', multiline: true,
    def: 'St. Vital\nSt. Boniface\nTranscona\nRiver Heights\nCharleswood\nFort Garry\nWaverley West\nNorth Kildonan\nSage Creek\nSt. James\nTuxedo\nEast St. Paul' },
  { key: 'BRAND_TERMS', group: 'business', label: 'Brand words (one per line)', multiline: true, def: 'winnipeg fence pros\nwinnipegfencepros', help: 'Searches for your own name are not keyword targets' },

  { key: 'FTP_HOST', group: 'ftp', label: 'FTP host' },
  { key: 'FTP_PORT', group: 'ftp', label: 'FTP port', def: '21' },
  { key: 'FTP_USER', group: 'ftp', label: 'FTP user' },
  { key: 'FTP_PASS', group: 'ftp', label: 'FTP password', secret: true },
  { key: 'FTP_PATH', group: 'ftp', label: 'Website folder on the server', def: '/public_html' },
  { key: 'FTP_SECURE', group: 'ftp', label: 'Use FTPS (TLS)', bool: true, def: 'false' },
  { key: 'BLOG_DIR', group: 'blog', label: 'Articles folder inside the website folder', def: 'articles', help: 'Articles are /articles/<name>/. Blank = next to the home page' },
  { key: 'URL_STYLE', group: 'blog', label: 'Article URL style', options: ['folder', 'html'], def: 'folder', help: 'folder = /articles/name/ (no rewrite rules needed). html = /articles/name.html' },
  { key: 'IMAGES_DIR', group: 'blog', label: 'Images folder inside the website folder', def: 'images' },
  { key: 'BLOG_INDEX_FILE', group: 'blog', label: 'Articles list page', def: 'articles/index.html', help: 'Rebuilt between its <!-- 5sf:articles:start --> and <!-- 5sf:articles:end --> markers on every publish. Created from the list template if missing' },
  { key: 'DEFAULT_IMAGE', group: 'blog', label: 'Fallback hero image', def: '', help: 'Used when Pexels has nothing, e.g. images/fence.jpg' },

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
  { key: 'POST_CATEGORY', group: 'autopilot', label: 'Category for keywords with no service', def: 'Fence' },
  { key: 'WRITER_MODEL', group: 'autopilot', label: 'Claude model', def: 'claude-opus-5-5' },
  { key: 'WRITER_NOTES', group: 'autopilot', label: 'Notes for Claude (voice, what to always / never say)', multiline: true,
    def: 'Plain, friendly, practical. Canadian spelling. Talk like a local fence contractor, not a marketer. Never invent prices, reviews, warranties or awards.' },
  { key: 'WP_BLOG_URL', group: 'blog', label: 'Old WordPress blog URL (for the one-time move)', def: 'https://www.winnipegfencepros.com/blog' },
  { key: 'POST_TEMPLATE', group: 'blog', label: 'Article page template', multiline: true, def: DEFAULT_TEMPLATE },
  { key: 'INDEX_TEMPLATE', group: 'blog', label: 'Articles list page template (only used when the list page does not exist yet)', multiline: true, def: DEFAULT_INDEX },
  { key: 'CARD_TEMPLATE', group: 'blog', label: 'Article card on the list page', multiline: true, def: DEFAULT_CARD },
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
/** "Fence | /fences.html | fence, gate" lines -> { name, path, terms[] }. The name itself is always a term. */
function parseServices(raw) {
  return String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, path = '', terms = ''] = l.split('|').map((x) => x.trim());
    const t = terms.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const low = name.toLowerCase();
    return { name, path: path ? (path.startsWith('http') ? path : `/${path.replace(/^\/+/, '')}`) : '', terms: t.includes(low) ? t : [low, ...t] };
  }).filter((x) => x.name);
}

/** "Deck | /decks.html" lines -> [{ label, path }]. */
function parseNav(raw) {
  return String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [label, path = '/'] = l.split('|').map((x) => x.trim());
    return { label, path };
  }).filter((x) => x.label);
}

const int = (s, d) => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : d; };

/** Typed config every job uses. */
function toConfig(raw) {
  const site = String(raw.SITE_URL || '').trim().replace(/\/+$/, '');
  const blogDir = String(raw.BLOG_DIR || '').trim().replace(/^\/+|\/+$/g, '');
  return {
    ...raw,
    SITE_URL: site,
    BLOG_DIR: blogDir,
    services: parseServices(raw.SERVICES),
    navLinks: parseNav(raw.NAV_LINKS),
    urlStyle: raw.URL_STYLE === 'html' ? 'html' : 'folder',
    areas: lines(raw.AREAS),
    brandTerms: lines(raw.BRAND_TERMS).map((s) => s.toLowerCase()),
    ftpPort: int(raw.FTP_PORT, 21),
    ftpSecure: bool(raw.FTP_SECURE),
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

module.exports = { FIELDS, DEFAULT_TEMPLATE, DEFAULT_CARD, DEFAULT_INDEX, parseServices, parseNav, getConfig, publicView, saveSettings, missing, toConfig, resolve, _reset: () => { cache = null; } };
