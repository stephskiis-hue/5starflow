/**
 * sitemap.xml, blog-sitemap.xml and sitemap_index.xml built from what the crawl knows (SeoPage), in the format the
 * site already serves. lastmod never moves backwards and only advances when the content really changed after the
 * crawl first saw the page (or the engine published/refreshed it), so Google can trust it.
 */
const { isAsset, dupKey } = require('../seo/urls');

const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NEVER = [/^\/thankyou/i, /^\/404$/, /^\/blog\//i];
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const maxDay = (...ds) => ds.filter(Boolean).sort().pop() || '';

/** { loc: lastmod } from an existing sitemap's xml. */
function readLastmods(xml) {
  const out = new Map();
  for (const m of String(xml || '').matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) out.set(m[1].trim(), (m[2] || '').trim().slice(0, 10));
  return out;
}

/** Pages that belong in a sitemap: live, indexable, self-canonical, not a duplicate casing, not excluded. */
function eligible(pages, exclude = []) {
  const ok = pages.filter((p) => p.httpStatus === 200 && !p.redirectTo && !p.noindex && !p.excluded && p.canonicalOk !== false && !isAsset(p.path)
    && !exclude.includes(p.path) && !NEVER.some((re) => re.test(p.path)));
  const keep = new Map();
  for (const p of ok) { const k = dupKey(p.path); if (!keep.has(k) || p.path === p.path.toLowerCase()) keep.set(k, p); }
  return [...keep.values()];
}

function lastmodFor(p, origin, live, today) {
  const changedLater = p.contentChangedAt && p.createdAt && new Date(p.contentChangedAt) - new Date(p.createdAt) > 60000;
  const known = maxDay(changedLater ? day(p.contentChangedAt) : '', day(p.publishedAt), day(p.refreshedAt));
  return maxDay(live.get(`${origin}${p.path === '/' ? '/' : p.path}`) || '', known) || day(p.contentChangedAt) || today;
}

const urlset = (rows) => `${HEAD}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.map((r) => `  <url>\n    <loc>${xmlEsc(r.loc)}</loc>\n    <lastmod>${r.lastmod}</lastmod>\n  </url>\n`).join('')}</urlset>\n`;

/**
 * pages: SeoPage rows. live: { sitemap, blog } current xml (for lastmod and the diff).
 * Returns { files: {name: xml}, counts, diff: { added[], removed[] } }.
 */
function buildSitemaps({ origin, pages, exclude = [], live = {}, today = new Date().toISOString().slice(0, 10) }) {
  const liveMods = new Map([...readLastmods(live.sitemap), ...readLastmods(live.blog)]);
  const rows = eligible(pages, exclude).map((p) => ({ path: p.path, loc: `${origin}${p.path === '/' ? '/' : p.path}`, lastmod: lastmodFor(p, origin, liveMods, today), blog: /^\/blog-/i.test(p.path) }));
  const main = rows.filter((r) => !r.blog).sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)));
  const blog = rows.filter((r) => r.blog).sort((a, b) => b.lastmod.localeCompare(a.lastmod) || a.path.localeCompare(b.path));
  const newest = (list) => maxDay(...list.map((r) => r.lastmod)) || today;
  const index = `${HEAD}<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[['sitemap.xml', main], ['blog-sitemap.xml', blog]]
    .map(([n, l]) => `  <sitemap>\n    <loc>${origin}/${n}</loc>\n    <lastmod>${newest(l)}</lastmod>\n  </sitemap>\n`).join('')}</sitemapindex>\n`;
  const before = new Set([...readLastmods(live.sitemap).keys(), ...readLastmods(live.blog).keys()]);
  const after = new Set(rows.map((r) => r.loc));
  return {
    files: { 'sitemap.xml': urlset(main), 'blog-sitemap.xml': urlset(blog), 'sitemap_index.xml': index },
    counts: { main: main.length, blog: blog.length },
    diff: { added: [...after].filter((u) => !before.has(u)), removed: [...before].filter((u) => !after.has(u)) },
  };
}

module.exports = { buildSitemaps, eligible, readLastmods };
