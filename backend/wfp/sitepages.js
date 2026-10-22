/** The live site's pages, read from its sitemap: internal-link targets for the writer and the health check. */
const axios = require('axios');

/** Pages listed in the site's sitemap (one level of sitemap index), for internal links. */
async function sitePages(cfg, max = 150) {
  if (!cfg.SITEMAP_URL) return [];
  const get = async (u) => (await axios.get(u, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': '5StarFlow-WFP/1.0' } })).data;
  const locs = (xml) => [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  try {
    const xml = await get(cfg.SITEMAP_URL);
    if (/<sitemapindex/i.test(xml)) {
      const out = [];
      for (const child of locs(xml).slice(0, 5)) out.push(...locs(await get(child).catch(() => '')));
      return out.slice(0, max);
    }
    return locs(xml).slice(0, max);
  } catch {
    return [];
  }
}

module.exports = { sitePages };
