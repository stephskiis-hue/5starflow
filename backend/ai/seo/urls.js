// URL normalization for the SEO engine. Every URL is stored as a canonical site path:
// no host, no query/hash, no ".html"/"index.html", no trailing slash (except "/"), original case kept.
const { DEFAULT_ORIGIN } = require('./config');

const ASSET_RE = /\.(css|js|mjs|png|jpe?g|webp|gif|svg|ico|avif|xml|json|pdf|txt|woff2?|ttf|eot|mp4|webm|mov|zip|csv)$/i;

/** "https://www.no-bs-yardwork.com" from any form of the site URL or Search Console property. */
function siteOrigin(siteUrl) {
  const raw = String(siteUrl || '').trim().replace(/^sc-domain:/i, '');
  if (!raw) return DEFAULT_ORIGIN;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = u.hostname.toLowerCase();
    return `https://${host.startsWith('www.') ? host : `www.${host}`}`;
  } catch { return DEFAULT_ORIGIN; }
}

const bareHost = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/** Canonical path for href (resolved against base), or null for another site, a non-http link or an asset. */
function canonicalPath(href, base = DEFAULT_ORIGIN) {
  if (!href || /^(mailto|tel|javascript|data|sms):/i.test(String(href).trim())) return null;
  let u;
  try { u = new URL(String(href).trim(), base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (bareHost(u.hostname) !== bareHost(new URL(base).hostname)) return null;
  let p = u.pathname.replace(/\/{2,}/g, '/');
  try { p = decodeURI(p); } catch { /* keep as is */ }
  p = p.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

const isAsset = (path) => ASSET_RE.test(String(path || ''));
/** Lowercase key: two live paths with the same key are the same page served twice (/Spring-Fall-Cleanups). */
const dupKey = (path) => String(path || '').toLowerCase();
const toUrl = (path, origin = DEFAULT_ORIGIN) => `${origin}${path === '/' ? '/' : path}`;

/** What kind of page a path is, from the path alone (the crawl and the publish report can refine it). */
function kindForPath(path, servicePaths = []) {
  if (path === '/') return 'home';
  if (/^\/blog-/i.test(path) || /^\/blog\//i.test(path)) return 'blog';
  if (/^\/blog$/i.test(path)) return 'hub';
  if (servicePaths.includes(path)) return 'service';
  return 'other';
}

module.exports = { siteOrigin, canonicalPath, isAsset, dupKey, toUrl, kindForPath, bareHost };
