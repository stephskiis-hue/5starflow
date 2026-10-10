/**
 * Polite crawl of the live site: robots.txt, every sitemap, every sitemap URL and every internal link
 * (status, redirect chain, canonical, noindex, links), posts.json, and the www/https redirects.
 * Read-only. Concurrency 3, capped at growthConfig.crawlMaxUrls, clear User-Agent.
 */
const axios = require('axios');
const { canonicalPath, isAsset, toUrl } = require('./urls');
const { parseSitemap, sitemapHash, robotsSitemaps } = require('./sitemap');
const { extractPageFacts } = require('./html');

const UA = 'Mozilla/5.0 (compatible; 5StarFlow-SEO/1.0; +https://5starflow.com)';

/** GET following up to maxHops redirects by hand so the chain is visible. maxHops 0 returns the redirect itself. */
async function fetchUrl(url, { maxHops = 5 } = {}) {
  const chain = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await axios.get(current, { maxRedirects: 0, validateStatus: () => true, timeout: 20000, responseType: 'text', headers: { 'User-Agent': UA }, transformResponse: (d) => d });
    } catch (err) {
      return { url, status: 0, error: err.code || err.message, chain, finalUrl: current };
    }
    chain.push({ url: current, status: res.status });
    const location = res.headers.location ? new URL(res.headers.location, current).toString() : null;
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= maxHops) return { url, status: res.status, location, finalUrl: location, chain, error: maxHops ? 'too many redirects' : null };
      current = location;
      continue;
    }
    return { url, status: res.status, finalUrl: current, chain, contentType: res.headers['content-type'] || '', body: typeof res.data === 'string' ? res.data : '' };
  }
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Robots + sitemap tree. Returns { robots, sitemaps: [{url,isIndex,parentUrl,status,entries,hash,error}] }. */
async function readSitemaps(origin) {
  const robots = await fetchUrl(`${origin}/robots.txt`);
  const listed = robots.status === 200 ? robotsSitemaps(robots.body) : [];
  // Nothing in robots.txt: try the usual names, and only keep the ones that exist.
  const roots = listed.length ? listed : [`${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`];
  const sitemaps = [];
  const seen = new Set();
  const visit = async (url, parentUrl) => {
    if (seen.has(url) || sitemaps.length >= 20) return;
    seen.add(url);
    const r = await fetchUrl(url);
    if (!listed.length && !parentUrl && r.status !== 200) return;
    const row = { url, parentUrl: parentUrl || null, status: r.status, finalUrl: r.finalUrl, isIndex: false, entries: [], hash: null, error: r.error || null };
    if (r.status === 200) {
      try {
        const p = parseSitemap(r.body);
        Object.assign(row, { isIndex: p.isIndex, entries: p.entries, hash: sitemapHash(p.entries) });
      } catch (err) { row.error = `parse: ${err.message}`; }
    }
    sitemaps.push(row);
    if (row.isIndex) for (const e of row.entries) await visit(e.loc, url);
  };
  for (const root of roots) await visit(root, null);
  return { robots: { status: robots.status, sitemaps: listed }, roots: sitemaps.filter((x) => !x.parentUrl).map((x) => x.url), sitemaps };
}

/**
 * Full crawl. pages: Map(path -> { path, url, status, finalPath, redirectTo, chain, title, h1, canonical, noindex,
 * wordCount, contentHash, inlinks, linkedFrom[], sitemapUrl, inSitemap }).
 */
async function crawlSite(origin, { maxUrls = 300 } = {}) {
  const { robots, roots, sitemaps } = await readSitemaps(origin);
  const pages = new Map();
  const ensure = (path) => { if (!pages.has(path)) pages.set(path, { path, url: toUrl(path, origin), inlinks: 0, linkedFrom: [], inSitemap: false, sitemapUrl: null, sitemapLocs: [] }); return pages.get(path); };

  for (const s of sitemaps) {
    if (s.isIndex) continue;
    for (const e of s.entries) {
      const path = canonicalPath(e.loc, origin);
      if (!path) continue;
      const p = ensure(path);
      p.inSitemap = true; p.sitemapUrl = p.sitemapUrl || s.url; p.sitemapLocs.push(e.loc); p.lastmod = e.lastmod;
    }
  }

  const queue = ['/', ...pages.keys()];
  const fetched = new Set();
  while (queue.length && fetched.size < maxUrls) {
    const batch = [];
    while (queue.length && batch.length < 9 && fetched.size + batch.length < maxUrls) {
      const path = queue.shift();
      if (!fetched.has(path) && !batch.includes(path)) batch.push(path);
    }
    await pool(batch, 3, async (path) => {
      fetched.add(path);
      const p = ensure(path);
      const r = await fetchUrl(p.url);
      p.status = r.status; p.chain = r.chain; p.error = r.error || null;
      const finalPath = canonicalPath(r.finalUrl, origin);
      p.redirectTo = r.chain.length > 1 ? r.finalUrl : null;
      p.finalPath = finalPath;
      if (r.status !== 200 || !/html/i.test(r.contentType || '')) return;
      const f = extractPageFacts(r.body);
      Object.assign(p, { title: f.title, h1: f.h1, h1Count: f.h1Count, canonical: f.canonical, noindex: f.noindex, wordCount: f.wordCount, contentHash: f.contentHash, description: f.description });
      if (finalPath && finalPath !== path) return;           // a redirect target is crawled on its own path
      for (const href of f.links) {
        const lp = canonicalPath(href, r.finalUrl);
        if (!lp || isAsset(lp) || lp === path) continue;
        const target = ensure(lp);
        target.inlinks += 1;
        if (target.linkedFrom.length < 5 && !target.linkedFrom.includes(path)) target.linkedFrom.push(path);
        if (!fetched.has(lp) && !queue.includes(lp)) queue.push(lp);
      }
    });
  }

  // Sitemap locs that are not the clean URL (e.g. "/about.html"): Google is told to crawl a redirect.
  const sitemapRedirects = [];
  const odd = [...new Set(sitemaps.flatMap((s) => (s.isIndex ? [] : s.entries.map((e) => e.loc))))]
    .filter((loc) => { const p = canonicalPath(loc, origin); return p && loc !== toUrl(p, origin); });
  await pool(odd.slice(0, 150), 3, async (loc) => {
    const r = await fetchUrl(loc, { maxHops: 0 });
    if (r.status !== 200) sitemapRedirects.push({ loc, status: r.status, location: r.location || null });
  });

  const [postsJson, nonWww, http] = await Promise.all([
    fetchUrl(`${origin}/posts.json`),
    fetchUrl(origin.replace('://www.', '://'), { maxHops: 0 }),
    fetchUrl(origin.replace('https://', 'http://'), { maxHops: 0 }),
  ]);
  let posts = null;
  if (postsJson.status === 200) {
    try {
      const list = JSON.parse(postsJson.body);
      posts = (Array.isArray(list) ? list : list.posts || []).map((x) => ({ path: canonicalPath(x.url || x.slug || '', origin), title: x.title, date: x.date, category: x.category })).filter((x) => x.path);
    } catch { posts = null; }
  }
  const hostChecks = { nonWww: { status: nonWww.status, location: nonWww.location || null }, http: { status: http.status, location: http.location || null } };
  return { robots, roots, sitemaps, pages, posts, hostChecks, sitemapRedirects, fetched: fetched.size, capped: queue.length > 0 };
}

module.exports = { fetchUrl, readSitemaps, crawlSite, UA };
