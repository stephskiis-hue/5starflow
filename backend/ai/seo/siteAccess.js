/**
 * What the server can do on the live website itself when the MSI PC can't (docs/seo/pc-request.md steps 1 and 3):
 *   - Search Console: the service account verifies the site on its own (Site Verification API, META method on the
 *     homepage) and adds it to its Search Console list, so nobody has to add it as a user by hand. The tag goes into
 *     index.html over FTP right away when the server has the site's FTP login; seo_site.py nightly puts the same tag
 *     in the PC's copy so the PC's deploy keeps it (Google re-checks it now and then).
 *   - The .htaccess SEO redirects: uploaded over FTP, checked live, and the saved copy put back at once on any 5xx,
 *     loop or wrong target. seo_site.py nightly mirrors a block that passed into the PC's .htaccess.
 * FTP login: the Website Audit one (FtpConfig) or the SEO deploy one (SeoSettings deployType "ftp").
 */
const path = require('path');
const { Readable, PassThrough } = require('stream');
const axios = require('axios');
const ftp = require('basic-ftp');
const { JWT } = require('google-auth-library');
const prisma = require('../../lib/prismaClient');
const { decryptPassword } = require('../../lib/ftpCrypto');
const g = require('./google');

const SV = 'https://www.googleapis.com/siteVerification/v1';
const WM = 'https://searchconsole.googleapis.com/webmasters/v3';
const UA = 'Mozilla/5.0 (compatible; 5StarFlow-SEO/1.0; +https://5starflow.app)';
const HTACCESS_MARK = '# --- SEO: one address for the whole site (added by the SEO setup) ---';

// --------------------------------------------------------------------------- pure helpers (tested)
const verificationContent = (metaTag) => String(metaTag || '').match(/content\s*=\s*["']([^"']+)["']/i)?.[1] || null;

/** index.html with the verification meta right after <head>, keeping the file's line endings. null = no <head>. */
function withVerificationTag(html, content) {
  if (html.includes(`content="${content}"`)) return html;
  const head = html.match(/<head\b[^>]*>/i);
  if (!head) return null;
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${eol}  <meta name="google-site-verification" content="${content}" />${html.slice(at)}`;
}

/** The redirect block of pc-request.md step 3 for this origin. */
function seoRedirectLines(origin) {
  return [
    HTACCESS_MARK,
    'RewriteCond %{HTTPS} off [OR]',
    'RewriteCond %{HTTP_HOST} !^www\\. [NC]',
    `RewriteRule ^ ${origin}%{REQUEST_URI} [L,R=301]`,
    '# --- SEO: duplicates of real pages ---',
    'RewriteRule ^Spring-Fall-Cleanups(\\.html)?$ /spring-fall-cleanups [L,R=301]',
    'RewriteRule ^lawn-care-premium(\\.html)?$ /premium-lawn-care [L,R=301,NC]',
    'RewriteRule ^premium-packages(\\.html)?$ /premium-lawn-care [L,R=301,NC]',
  ];
}

/** .htaccess with the block directly after the first `RewriteEngine On` (or a new one at the top). Existing rules untouched. */
function withSeoRedirects(text, origin) {
  if (text.includes(HTACCESS_MARK)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = seoRedirectLines(origin).join(eol);
  const on = text.match(/^[ \t]*RewriteEngine[ \t]+On[ \t]*$/im);
  if (!on) return `RewriteEngine On${eol}${block}${eol}${eol}${text}`;
  const at = on.index + on[0].length;
  return `${text.slice(0, at)}${eol}${block}${text.slice(at)}`;
}

/** What the live site must answer once the block is in (pc-request.md step 3 table). */
function htaccessChecks(origin) {
  const bare = origin.replace('://www.', '://');
  return [
    { url: `${origin}/`, status: 200 },
    { url: `${origin}/blog`, status: 200 },
    { url: `${origin}/spring-fall-cleanups`, status: 200 },
    { url: `${origin}/contact`, status: 200 },
    { url: `${origin}/blog-fence-repair-cost-winnipeg`, status: 200 },
    { url: `${origin}/premium-lawn-care`, status: 200 },
    { url: `${bare}/`, status: 301, to: `${origin}/` },
    { url: `${origin.replace('https://', 'http://')}/`, status: 301, to: `${origin}/` },
    { url: `${origin}/Spring-Fall-Cleanups`, status: 301, to: `${origin}/spring-fall-cleanups` },
    { url: `${origin}/lawn-care-premium`, status: 301, to: `${origin}/premium-lawn-care` },
  ];
}

/** One check against the redirect chain it produced. fatal = put the old file back now (5xx, loop, dead end). */
function judge(check, chain) {
  const first = chain[0];
  const last = chain[chain.length - 1];
  const hops = chain.length - 1;
  const line = `${first.status} ${first.location || ''}  ${check.url}`.replace(/ {3}/, '  ');
  if (chain.some((c) => c.status >= 500 || c.status === 0)) return { ok: false, fatal: true, line, why: 'server error' };
  if (hops > 2 || last.status !== 200) return { ok: false, fatal: true, line, why: hops > 2 ? 'redirect loop' : `ends in ${last.status}` };
  if (check.status === 200) return hops === 0 ? { ok: true, line } : { ok: false, line, why: `redirects to ${first.location}` };
  if (first.status !== 301) return { ok: false, line, why: `expected 301, got ${first.status}` };
  if (first.location !== check.to) return { ok: false, line, why: `goes to ${first.location}, expected ${check.to}` };
  return { ok: true, line };
}

// --------------------------------------------------------------------------- I/O
async function probe(url) {
  try {
    const r = await axios.get(url, { maxRedirects: 0, validateStatus: () => true, timeout: 20000, responseType: 'text',
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } });
    return { url, status: r.status, location: r.headers.location ? new URL(r.headers.location, url).href : null, body: r.data };
  } catch (err) {
    return { url, status: 0, location: null, error: err.message };
  }
}

async function chainOf(url) {
  const chain = [];
  let u = url;
  for (let i = 0; i < 5; i++) {
    const p = await probe(u);
    delete p.body;
    chain.push(p);
    if (p.status < 300 || p.status >= 400 || !p.location) break;
    u = p.location;
  }
  return chain;
}

async function ftpConfig(userId) {
  const row = await prisma.ftpConfig.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })
    || await prisma.ftpConfig.findFirst({ where: { userId: null }, orderBy: { createdAt: 'desc' } });
  if (row) return { host: row.host, port: row.port || 21, user: row.user, password: decryptPassword(row.encryptedPassword), root: row.rootPath || '/public_html', source: 'website-audit' };
  const s = await prisma.seoSettings.findFirst({ where: { deployType: 'ftp', deployHost: { not: null }, OR: [{ userId }, { userId: null }] } });
  if (s?.deployUser && s.deployPass) return { host: s.deployHost, port: s.deployPort || 21, user: s.deployUser, password: s.deployPass, root: s.deployPath || '/', source: 'seo-settings' };
  return null;
}

async function withFtp(cfg, fn) {
  const client = new ftp.Client(30000);
  try {
    await client.access({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, secure: false });
    return await fn({
      file: (name) => path.posix.join(cfg.root, name),
      read: async (p) => {
        const chunks = [];
        const sink = new PassThrough();
        sink.on('data', (c) => chunks.push(c));
        await client.downloadTo(sink, p);
        return Buffer.concat(chunks);
      },
      write: (p, buf) => client.uploadFrom(Readable.from([buf]), p),
    });
  } finally {
    client.close();
  }
}

const titleOf = (html) => (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();

/**
 * The FTP folder the live site really serves: its index.html must carry the live homepage's <title> (a wrong root
 * path would edit a copy nobody sees). Tries the saved root, then the usual cPanel/Hostinger layouts. null = none.
 */
async function siteRoot(cfg, origin) {
  const live = await probe(`${origin}/`);
  const want = live.status === 200 ? titleOf(live.body) : '';
  if (!want) return null;
  const roots = [...new Set([cfg.root, '/public_html', '/', '/domains/no-bs-yardwork.com/public_html'].filter(Boolean))];
  return withFtp(cfg, async (f) => {
    for (const root of roots) {
      const buf = await f.read(path.posix.join(root, 'index.html')).catch(() => null);
      if (buf && titleOf(buf.toString('utf8')) === want) return root;
    }
    return null;
  });
}

let svJwt = null;
async function svCall(method, url, data) {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('No Google service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY)');
  if (!svJwt) svJwt = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/siteverification', 'https://www.googleapis.com/auth/webmasters'] });
  const { token } = await svJwt.getAccessToken();
  try {
    return (await axios({ method, url, data, headers: { Authorization: `Bearer ${token}` }, timeout: 30000 })).data;
  } catch (err) {
    const e = new Error(`Google ${method.toUpperCase()} ${url.replace(/^https:\/\/[^/]+/, '')}: ${err.response?.data?.error?.message || err.message}`);
    e.status = err.response?.status;
    throw e;
  }
}

/** Google's "enable this API" link for the Site Verification API, or null. */
function svDisabledLink(err) {
  const msg = String(err?.message || '');
  if (!/has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(msg)) return null;
  return msg.match(/https:\/\/console\.developers\.google\.com\/apis\/api\/[\w.]+\/overview\?project=\d+/)?.[0]
    || 'https://console.cloud.google.com/apis/library/siteverification.googleapis.com';
}

/** Public view for the SEO Growth page and seo_site.py (never the FTP password or a .htaccess backup). */
async function status(userId) {
  const seo = await g.loadSeo(userId);
  const cfg = await ftpConfig(userId);
  const v = seo.state.verify || null;
  const h = seo.state.htaccess || null;
  return {
    ftp: cfg ? { configured: true, host: cfg.host, root: cfg.root, source: cfg.source } : { configured: false },
    verification: v ? { identifier: v.identifier, content: v.content, verifiedAt: v.verifiedAt || null, liveAt: v.liveAt || null } : null,
    htaccess: h ? { state: h.state, at: h.at, lines: h.state === 'applied' ? seoRedirectLines(seo.origin) : null, report: h.report || [] } : null,
    pc: seo.state.pcCopy || null,
  };
}

/**
 * Make the service account an owner of the URL-prefix property: get the META token, make sure the live homepage
 * carries it (FTP when `apply` and a login exists), then verify and add the site to its Search Console list.
 */
async function ensureOwnership(userId, { apply = false } = {}) {
  const seo = await g.loadSeo(userId);
  const identifier = `${seo.origin}/`;
  const auth = await g.getAuth(seo);
  if (auth?.header && auth.via === 'service_account') {
    const { site } = await require('./sync').resolveProperty(auth, seo).catch(() => ({}));
    if (site && ['siteOwner', 'siteFullUser'].includes(site.permissionLevel)) return { status: 'ok', property: site.siteUrl, permissionLevel: site.permissionLevel };
  }
  let v = seo.state.verify;
  if (!v?.content || v.identifier !== identifier) {
    let t;
    try {
      t = await svCall('post', `${SV}/token`, { site: { type: 'SITE', identifier }, verificationMethod: 'META' });
    } catch (err) {
      const link = svDisabledLink(err);
      return { status: link ? 'api_disabled' : 'error', error: err.message, enableLink: link };
    }
    v = { identifier, content: verificationContent(t.token), tag: t.token, at: new Date().toISOString() };
    await g.saveState(seo.row.id, { verify: v });
  }
  const home = await probe(identifier);
  let live = home.status === 200 && String(home.body || '').includes(v.content);
  let ftpResult = null;
  if (!live && apply) {
    ftpResult = await putTagOverFtp(userId, seo.origin, v.content).catch((err) => ({ ftp: 'error', error: err.message }));
    for (let i = 0; i < 3 && !live && ftpResult.ftp === 'uploaded'; i++) {
      await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
      const again = await probe(identifier);
      live = again.status === 200 && String(again.body || '').includes(v.content);
    }
  }
  if (!live) return { status: 'needs_tag', tag: v.tag, content: v.content, ftp: ftpResult, note: 'seo_site.py nightly adds the tag to index.html on the PC; the next sync verifies once it is live' };
  if (!v.liveAt) await g.saveState(seo.row.id, { verify: (v = { ...v, liveAt: new Date().toISOString() }) });
  try {
    await svCall('post', `${SV}/webResource?verificationMethod=META`, { site: { type: 'SITE', identifier } });
    await svCall('put', `${WM}/sites/${encodeURIComponent(identifier)}`);
  } catch (err) {
    const link = svDisabledLink(err);
    return { status: link ? 'api_disabled' : 'error', error: err.message, enableLink: link, ftp: ftpResult };
  }
  await g.saveState(seo.row.id, { verify: { ...v, verifiedAt: new Date().toISOString() } });
  return { status: 'verified', property: identifier, ftp: ftpResult };
}

async function putTagOverFtp(userId, origin, content) {
  const found = await ftpConfig(userId);
  if (!found) return { ftp: 'not_configured' };
  const root = await siteRoot(found, origin);
  if (!root) return { ftp: 'root_mismatch', tried: found.root };
  const cfg = { ...found, root };
  return withFtp(cfg, async (f) => {
    const p = f.file('index.html');
    const before = await f.read(p);
    const next = withVerificationTag(before.toString('utf8'), content);
    if (next == null) return { ftp: 'no_head', path: p };
    if (next === before.toString('utf8')) return { ftp: 'already', path: p };
    await f.write(p, Buffer.from(next, 'utf8'));
    const home = await probe(`${origin}/`);
    if (home.status !== 200) { await f.write(p, before); return { ftp: 'reverted', path: p, status: home.status }; }
    return { ftp: 'uploaded', path: p };
  });
}

/**
 * The .htaccess redirects. apply=false: show the plan. apply=true: back up, upload, check every row of the table
 * (a few rounds, the server can take seconds to re-read the file), put the old file back on any failure.
 */
async function applyHtaccess(userId, { apply = false } = {}) {
  const seo = await g.loadSeo(userId);
  const found = await ftpConfig(userId);
  if (!found) return { status: 'no_ftp', note: 'The server has no FTP login for the site (Website Audit > FTP settings).' };
  const root = await siteRoot(found, seo.origin);
  if (!root) return { status: 'root_mismatch', tried: found.root };
  const cfg = { ...found, root };
  const checks = htaccessChecks(seo.origin);
  // each FTP step gets its own connection: the live checks take ~30 s and the put-back must not ride a stale one
  const p = path.posix.join(root, '.htaccess');
  const before = await withFtp(cfg, (f) => f.read(p)).catch(() => null);
  if (before == null) return { status: 'no_file', path: p };
  const text = before.toString('utf8');
  const next = withSeoRedirects(text, seo.origin);
  if (next === text) return { status: 'already', path: p };
  // pages that already fail today would trip the check without being our fault: leave them out and say so
  const baseline = [];
  for (const c of checks.filter((x) => x.status === 200)) {
    if (!judge(c, await chainOf(c.url)).ok) baseline.push(c.url);
  }
  if (baseline.includes(`${seo.origin}/`)) return { status: 'site_down', path: p, baseline };
  const active = checks.filter((c) => !baseline.includes(c.url));
  if (!apply) return { status: 'plan', path: p, insertAfter: 'the first RewriteEngine On', lines: seoRedirectLines(seo.origin), skippedChecks: baseline, current: text };

  await g.saveState(seo.row.id, { htaccess: { state: 'uploading', at: new Date().toISOString(), path: p, backup: text } });
  await withFtp(cfg, (f) => f.write(p, Buffer.from(next, 'utf8')));
  let results = [];
  for (let round = 0; round < 4; round++) {
    await new Promise((ok) => setTimeout(ok, round ? 5000 : 2000));
    results = [];
    for (const c of active) results.push(judge(c, await chainOf(c.url)));
    if (results.some((r) => r.fatal) || results.every((r) => r.ok)) break;
  }
  const report = results.map((r) => (r.ok ? r.line : `${r.line}  <- ${r.why}`));
  if (results.every((r) => r.ok)) {
    await g.saveState(seo.row.id, { htaccess: { state: 'applied', at: new Date().toISOString(), path: p, backup: text, report } });
    return { status: 'applied', path: p, report, skippedChecks: baseline };
  }
  let putBack = null;
  for (let i = 0; i < 3 && putBack !== true; i++) {
    putBack = await withFtp(cfg, (f) => f.write(p, before)).then(() => true, (err) => err.message);
  }
  const after = await chainOf(`${seo.origin}/`);
  await g.saveState(seo.row.id, { htaccess: { state: putBack === true ? 'reverted' : 'revert_failed', at: new Date().toISOString(), path: p, backup: text, report } });
  return { status: putBack === true ? 'reverted' : 'revert_failed', path: p, report, revertError: putBack === true ? null : putBack, homeAfterRevert: after.map((c) => `${c.status} ${c.url}`), skippedChecks: baseline };
}

/** Put back the .htaccess saved before the last upload. */
async function revertHtaccess(userId) {
  const seo = await g.loadSeo(userId);
  const { backup, path: p } = seo.state.htaccess || {};
  const cfg = await ftpConfig(userId);
  if (!backup || !p || !cfg) return { status: !backup || !p ? 'no_backup' : 'no_ftp' };
  // the path saved at upload time: during an outage the live homepage can't be used to find the folder
  await withFtp(cfg, (f) => f.write(p, Buffer.from(backup, 'utf8')));
  await g.saveState(seo.row.id, { htaccess: { state: 'reverted', at: new Date().toISOString(), path: p, backup } });
  return { status: 'reverted', home: (await chainOf(`${seo.origin}/`)).map((c) => `${c.status} ${c.url}`) };
}

module.exports = { status, ensureOwnership, applyHtaccess, revertHtaccess, withVerificationTag, withSeoRedirects, seoRedirectLines, htaccessChecks, judge, verificationContent, HTACCESS_MARK };
