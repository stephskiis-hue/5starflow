// Sitemap parsing + change detection. The PC builds the files; the backend only reads and submits them.
const crypto = require('crypto');
const cheerio = require('cheerio');

/** { isIndex, entries: [{ loc, lastmod }] } for a <urlset> or a <sitemapindex>. */
function parseSitemap(xml) {
  const $ = cheerio.load(String(xml || ''), { xmlMode: true });
  const isIndex = $('sitemapindex').length > 0;
  const entries = [];
  $(isIndex ? 'sitemap' : 'url').each((_, el) => {
    const loc = $(el).children('loc').first().text().trim();
    if (!loc) return;
    const lastmod = $(el).children('lastmod').first().text().trim() || null;
    entries.push({ loc, lastmod });
  });
  return { isIndex, entries };
}

/** Order- and whitespace-independent fingerprint: changes only when a URL or a lastmod changes. */
function sitemapHash(entries) {
  const lines = (entries || []).map((e) => `${e.loc}|${e.lastmod || ''}`).sort();
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}

/** Sitemap URLs listed in robots.txt. */
function robotsSitemaps(robotsTxt) {
  return String(robotsTxt || '').split(/\r?\n/).map((l) => l.match(/^\s*sitemap\s*:\s*(\S+)/i)?.[1]).filter(Boolean);
}

module.exports = { parseSitemap, sitemapHash, robotsSitemaps };
