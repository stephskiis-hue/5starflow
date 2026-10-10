/**
 * seo-index-watch: are our pages in the sitemaps, crawlable, canonical and actually indexed by Google?
 *
 * Full run (daily): crawl the site, refresh the SeoPage registry, raise/close seo:* Tasks, submit changed
 * sitemaps, URL-inspect pages (new ones first). Light run (after a post or a deploy): sitemaps only,
 * submit if changed, ping IndexNow for new URLs, inspect the newest pages.
 */
const prisma = require('../../lib/prismaClient');
const { createTask, completeByDedupKey } = require('../tasks');
const { OPEN_TASK_STATES } = require('../constants');
const { CLUSTERS, AREAS } = require('./config');
const { canonicalPath, dupKey, toUrl, kindForPath } = require('./urls');
const { crawlSite, readSitemaps } = require('./crawl');
const g = require('./google');

const DAY = 86400000;
const SLUG = 'seo-index-watch';
const SERVICE_PATHS = [...new Set(CLUSTERS.flatMap((c) => [c.pillarPath, c.plannedPillar]).filter(Boolean)), '/services', '/yard-maintenance-winnipeg', '/premium-lawn-care', '/winter-packages'];
const AREA_SLUGS = AREAS.flatMap((a) => a.aliases.map((al) => al.replace(/\s+/g, '-')));

function kindFor(path) {
  const k = kindForPath(path, SERVICE_PATHS);
  if (k !== 'other') return k;
  const p = path.toLowerCase();
  if (AREA_SLUGS.some((s) => p.includes(s))) return 'area';
  if (/(winnipeg|lawn|snow|fenc|landscap|clean|aerat|raking|sod|weed|mow|grass|package)/.test(p)) return 'service';
  return 'other';
}

async function raise(userId, raised, t) {
  raised.add(t.dedupKey);
  await createTask(userId, { source: 'seo', agent: 'research', routineSlug: SLUG, urgency: 'normal', ...t });
}

/** Close seo tasks this run did not raise again: the problem is gone. Setup tasks are left to their own checks. */
async function closeResolved(userId, raised, prefixes) {
  const open = await prisma.task.findMany({ where: { userId, status: { in: OPEN_TASK_STATES }, OR: prefixes.map((p) => ({ dedupKey: { startsWith: p } })) }, select: { dedupKey: true } });
  let n = 0;
  for (const t of open) if (!raised.has(t.dedupKey)) { await completeByDedupKey(userId, t.dedupKey); n++; }
  return n;
}

const list = (arr, n = 15) => arr.slice(0, n).join('\n') + (arr.length > n ? `\n… and ${arr.length - n} more` : '');

/** Store the live sitemap files; returns rows with `changed` when the content differs from what we last submitted. */
async function recordSitemaps(userId, sitemaps, now) {
  const rows = [];
  for (const s of sitemaps) {
    const prev = await prisma.seoSitemap.findUnique({ where: { userId_url: { userId, url: s.url } } });
    const hashChanged = !prev || prev.contentHash !== s.hash;
    const data = { isIndex: s.isIndex, parentUrl: s.parentUrl, urlCount: s.entries.length, httpStatus: s.status, lastFetchedAt: now, lastError: s.error,
      ...(s.hash ? { contentHash: s.hash } : {}), ...(hashChanged && s.hash ? { hashChangedAt: now } : {}) };
    const row = await prisma.seoSitemap.upsert({ where: { userId_url: { userId, url: s.url } }, update: data, create: { userId, url: s.url, ...data } });
    rows.push({ ...row, changed: !!s.hash && row.submittedHash !== s.hash });
  }
  return rows;
}

/** Submit root sitemaps whose tree changed (or that Google has not read in a week). Max once a day per file. */
async function submitSitemaps(userId, { auth, property, roots, rows, gscList, now, actions }) {
  const listed = new Map((gscList || []).map((s) => [s.path, s]));
  const out = [];
  for (const root of roots) {
    const tree = rows.filter((r) => r.url === root || r.parentUrl === root);
    const treeHash = tree.map((r) => r.contentHash).join(',');
    const rootRow = rows.find((r) => r.url === root);
    if (!rootRow || rootRow.httpStatus !== 200) continue;
    const gsc = listed.get(root);
    const changed = tree.some((r) => r.changed);
    const unread = gsc && (!gsc.lastDownloaded || now - new Date(gsc.lastDownloaded) > 7 * DAY) && (!rootRow.lastSubmittedAt || now - new Date(rootRow.lastSubmittedAt) > 7 * DAY);
    const due = changed || !gsc || unread;
    if (!due || (rootRow.lastSubmittedAt && now - new Date(rootRow.lastSubmittedAt) < DAY && gsc)) continue;
    const why = !gsc ? 'not listed in Search Console' : changed ? 'content changed' : 'Google has not read it in 7+ days';
    if (!auth?.canWrite) { out.push({ url: root, submitted: false, why, reason: auth ? 'read-only Google connection' : 'Search Console not connected' }); continue; }
    if (!g.submitAllowed()) { actions.push(`would submit ${root} (${why}) — DRY_RUN`); out.push({ url: root, submitted: false, why, reason: 'DRY_RUN (set SEO_SUBMIT=on)' }); continue; }
    try {
      await g.submitSitemap(auth, property, root);
      for (const r of tree) await prisma.seoSitemap.update({ where: { id: r.id }, data: { lastSubmittedAt: now, submittedHash: r.contentHash } });
      actions.push(`submitted ${root} to Google (${why})`);
      out.push({ url: root, submitted: true, why, treeHash });
    } catch (err) {
      out.push({ url: root, submitted: false, why, reason: err.message, status: err.status });
      if (err.status === 403) await createTask(userId, { dedupKey: 'seo:gsc-permission', source: 'seo', agent: 'research', routineSlug: SLUG, urgency: 'high',
        title: 'Give the 5StarFlow service account Full access in Search Console', whatHappened: `Google refused the sitemap submit: ${err.message}`,
        whatNeeds: `Search Console > Settings > Users and permissions > Add user: ${process.env.GOOGLE_CLIENT_EMAIL || '(service account email)'} with permission "Full".` });
    }
  }
  return out;
}

async function syncGscSitemaps(userId, auth, property, now) {
  if (!auth?.header) return null;
  try {
    const list = await g.listSitemaps(auth, property);
    for (const s of list) {
      const data = { gscLastSubmitted: s.lastSubmitted ? new Date(s.lastSubmitted) : null, gscLastDownloaded: s.lastDownloaded ? new Date(s.lastDownloaded) : null,
        gscIsPending: !!s.isPending, gscErrors: Number(s.errors || 0), gscWarnings: Number(s.warnings || 0),
        gscSubmittedUrls: (s.contents || []).reduce((n, c) => n + Number(c.submitted || 0), 0) };
      await prisma.seoSitemap.upsert({ where: { userId_url: { userId, url: s.path } }, update: data, create: { userId, url: s.path, isIndex: !!s.isSitemapsIndex, ...data } });
    }
    return list;
  } catch (err) {
    console.warn('[seo] sitemaps.list failed:', err.message);
    return null;
  }
}

/** URL Inspection within budget, newest and least-known pages first. */
async function inspectPages(userId, { auth, property, origin, seo, now, limit, actions }) {
  if (!auth?.header || limit <= 0) return { inspected: 0 };
  const today = now.toISOString().slice(0, 10);
  const used = seo.state.inspections?.date === today ? seo.state.inspections.n : 0;
  let budget = Math.min(limit, 1500 - used);
  if (budget <= 0) return { inspected: 0, quota: true };
  const pages = await prisma.seoPage.findMany({ where: { userId, excluded: false, httpStatus: 200, noindex: false, OR: [{ inSitemap: true }, { kind: { in: ['blog', 'service', 'area', 'home'] } }] } });
  const age = (d) => (d ? (now - new Date(d)) / DAY : Infinity);
  const changedAt = (p) => p.refreshedAt || p.publishedAt;
  const due = (p) => {
    if (p.redirectTo || p.canonicalOk === false) return false;
    if (age(changedAt(p)) <= 21 && p.indexVerdict !== 'PASS') return 1;                                   // new: daily
    if (p.lastInspectedAt && p.contentChangedAt && new Date(p.contentChangedAt) > new Date(p.lastInspectedAt)) return 2;
    if (!p.lastInspectedAt) return 2;
    if (p.indexVerdict !== 'PASS' && age(p.lastInspectedAt) >= 3) return 3;
    if (age(p.lastInspectedAt) >= 14) return 4;
    return false;
  };
  const queue = pages.map((p) => ({ p, d: due(p) })).filter((x) => x.d).sort((a, b) => a.d - b.d || age(b.p.lastInspectedAt) - age(a.p.lastInspectedAt));
  let n = 0;
  for (const { p } of queue) {
    if (budget-- <= 0) break;
    try {
      const r = await g.inspectUrl(auth, property, toUrl(p.path, origin));
      const s = r?.indexStatusResult || {};
      await prisma.seoPage.update({ where: { id: p.id }, data: {
        indexVerdict: s.verdict || null, coverageState: s.coverageState || null, googleCanonical: s.googleCanonical || null,
        lastCrawlTime: s.lastCrawlTime ? new Date(s.lastCrawlTime) : null, lastInspectedAt: now,
        ...(s.verdict === 'PASS' && !p.indexedAt ? { indexedAt: now } : {}),
      } });
      n++;
    } catch (err) {
      if (err.status === 429) { actions.push('URL Inspection quota reached'); break; }
      if (err.status === 403) { actions.push(`URL Inspection refused: ${err.message}`); break; }
      console.warn('[seo] inspect failed', p.path, err.message);
    }
  }
  await g.saveState(seo.row.id, { inspections: { date: today, n: used + n } });
  if (n) actions.push(`inspected ${n} page(s) in Search Console`);
  return { inspected: n };
}

/** Write the crawl into SeoPage; returns the issue lists. */
async function applyCrawl(userId, origin, crawl, now) {
  const existing = new Map((await prisma.seoPage.findMany({ where: { userId } })).map((p) => [p.path, p]));
  const postPaths = new Set((crawl.posts || []).map((p) => p.path));
  const postDates = new Map((crawl.posts || []).filter((p) => p.date).map((p) => [p.path, p.date]));
  for (const p of crawl.pages.values()) {
    if (p.status === undefined) continue;
    const prev = existing.get(p.path);
    const selfUrl = toUrl(p.path, origin);
    const canonicalOk = p.status === 200 ? (p.canonical ? p.canonical.replace(/\/$/, '') === selfUrl.replace(/\/$/, '') : null) : null;
    const kind = prev?.source === 'published' || prev?.source === 'owner' ? prev.kind : kindFor(p.path);
    const data = {
      kind, title: p.title || prev?.title || null, h1: p.h1 || null, wordCount: p.wordCount ?? null, httpStatus: p.status, redirectTo: p.redirectTo,
      canonical: p.canonical || null, canonicalOk, noindex: !!p.noindex, inSitemap: p.inSitemap, sitemapUrl: p.sitemapUrl, inlinks: p.inlinks,
      inPostsJson: kind === 'blog' && crawl.posts ? postPaths.has(p.path) : null, lastCheckedAt: now,
      ...(p.contentHash && prev?.contentHash !== p.contentHash ? { contentHash: p.contentHash, contentChangedAt: now } : {}),
      ...(!prev?.publishedAt && postDates.has(p.path) ? { publishedAt: new Date(`${postDates.get(p.path)}T12:00:00Z`) } : {}),
      ...(!prev?.publishedAt && !postDates.has(p.path) && kind === 'blog' && p.lastmod ? { publishedAt: new Date(`${p.lastmod.slice(0, 10)}T12:00:00Z`) } : {}),
    };
    if (prev) await prisma.seoPage.update({ where: { id: prev.id }, data });
    else await prisma.seoPage.create({ data: { userId, path: p.path, source: p.inSitemap ? 'sitemap' : 'crawl', ...data } });
  }
}

function findIssues(origin, crawl) {
  const pages = [...crawl.pages.values()].filter((p) => p.status !== undefined);
  const live = pages.filter((p) => p.status === 200 && !p.redirectTo);
  const issues = {};
  issues.redirectingLocs = crawl.sitemapRedirects.map((r) => `${r.loc} → ${r.status}${r.location ? ` ${r.location}` : ''}`);
  issues.sitemapBroken = pages.filter((p) => p.inSitemap && (p.status !== 200 || p.redirectTo || p.noindex)).map((p) => `${p.path} (${p.noindex ? 'noindex' : p.redirectTo ? `redirects to ${p.redirectTo}` : p.status})`);
  issues.missing = live.filter((p) => !p.inSitemap && !p.noindex && p.inlinks > 0 && (!p.canonical || canonicalPath(p.canonical, origin) === p.path)).map((p) => p.path);
  issues.canonical = live.filter((p) => !p.noindex).map((p) => {
    if (!p.canonical) return `${p.path}: no canonical tag`;
    const self = toUrl(p.path, origin);
    if (p.canonical.replace(/\/$/, '') === self.replace(/\/$/, '')) return null;
    const cp = canonicalPath(p.canonical, origin);
    return cp === p.path ? `${p.path}: canonical is ${p.canonical} (a URL that redirects) — use ${self}` : `${p.path}: canonical points to another page (${p.canonical})`;
  }).filter(Boolean);
  const byKey = new Map();
  for (const p of live) { const k = dupKey(p.path); byKey.set(k, [...(byKey.get(k) || []), p.path]); }
  const byTitle = new Map();
  for (const p of live) if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) || []), p.path]);
  issues.duplicates = [...[...byKey.values()].filter((v) => v.length > 1).map((v) => `same page, different case: ${v.join(' and ')}`),
    ...[...byTitle.entries()].filter(([, v]) => v.length > 1 && new Set(v.map(dupKey)).size > 1).map(([t, v]) => `same title "${t}": ${v.join(', ')}`)];
  issues.broken = pages.filter((p) => (p.status >= 400 || p.status === 0) && p.inlinks > 0).map((p) => `${p.path} (${p.status || p.error}) linked from ${p.linkedFrom.join(', ')}`);
  const hc = crawl.hostChecks;
  issues.www = [];
  if (hc.nonWww.status === 200) issues.www.push(`${origin.replace('://www.', '://')}/ answers 200 instead of a 301 to ${origin}/`);
  if (hc.nonWww.status >= 300 && hc.nonWww.status < 400 && !String(hc.nonWww.location).startsWith(origin)) issues.www.push(`non-www redirects to ${hc.nonWww.location}, not ${origin}/`);
  if (hc.http.status === 200) issues.www.push(`${origin.replace('https://', 'http://')}/ answers 200 instead of a 301 to https`);
  issues.orphans = crawl.posts ? live.filter((p) => kindFor(p.path) === 'blog' && !crawl.posts.some((x) => x.path === p.path)).map((p) => p.path) : [];
  issues.noInlinks = live.filter((p) => kindFor(p.path) === 'blog' && p.inlinks === 0).map((p) => p.path);
  return issues;
}

async function raiseIssues(userId, origin, issues, raised) {
  const t = (key, title, items, extra = {}) => (items.length ? raise(userId, raised, { dedupKey: key, title, context: { items: items.slice(0, 100) }, whatHappened: list(items), ...extra }) : null);
  await t('seo:sitemap-redirects', `Sitemap lists ${issues.redirectingLocs.length + issues.sitemapBroken.length} URL(s) Google should not be sent to`, [...issues.redirectingLocs, ...issues.sitemapBroken],
    { whatNeeds: 'Rebuild the sitemaps with the clean URLs (no .html) of live, indexable pages: `seo_site.py build-sitemaps` runs before every deploy (docs/seo/windows-setup.md).', urgency: 'high' });
  await t('seo:missing-from-sitemap', `${issues.missing.length} live page(s) are not in any sitemap`, issues.missing,
    { whatNeeds: 'Either add them to the sitemap (build-sitemaps does it automatically) or, if they are duplicates, 301 them to the real page.' });
  await t('seo:canonical', `${issues.canonical.length} page(s) with a missing or wrong canonical tag`, issues.canonical,
    { whatNeeds: `Every page should carry <link rel="canonical" href="${origin}/<page-without-.html>">.` });
  await t('seo:duplicates', `${issues.duplicates.length} duplicate page group(s)`, issues.duplicates,
    { whatNeeds: 'Keep one page per topic; 301 the others to it in .htaccess and fix links that point at them.' });
  await t('seo:broken-links', `${issues.broken.length} broken internal link target(s)`, issues.broken, { whatNeeds: 'Fix or remove these links on the pages listed.' });
  await t('seo:www-redirect', 'The site answers on more than one address', issues.www, {
    whatNeeds: 'Add to .htaccess so every address 301s to https://www:',
    recommended: `RewriteEngine On\nRewriteCond %{HTTPS} off [OR]\nRewriteCond %{HTTP_HOST} !^www\\. [NC]\nRewriteRule ^ https://www.${new URL(origin).hostname.replace(/^www\./, '')}%{REQUEST_URI} [L,R=301]` });
  await t('seo:orphan-posts', `${issues.orphans.length} live blog post(s) missing from posts.json (not listed on the blog page)`, issues.orphans,
    { whatNeeds: '`seo_site.py blog-index` rebuilds posts.json from every live post and writes a static list into blog.html.' });
  await t('seo:no-inlinks', `${issues.noInlinks.length} blog post(s) have no link pointing at them`, issues.noInlinks,
    { whatNeeds: 'Google finds these only through the sitemap. The static blog index plus "related posts" links from each new post fix this.', urgency: 'low' });
}

async function notIndexedTasks(userId, now, raised) {
  const pages = await prisma.seoPage.findMany({ where: { userId, excluded: false, httpStatus: 200, noindex: false, lastInspectedAt: { not: null }, indexVerdict: { not: 'PASS' } } });
  const old = pages.filter((p) => { const since = p.publishedAt || p.createdAt; return since && now - new Date(since) >= 14 * DAY; });
  const advice = (c) => (/discovered/i.test(c || '') ? 'Google knows it exists but has not crawled it: add internal links to it from strong pages.'
    : /crawled/i.test(c || '') ? 'Google crawled it and chose not to index it: improve or refresh the content (it may look thin or duplicate).'
      : /unknown/i.test(c || '') ? 'Google has never seen it: make sure it is in the sitemap and linked from the blog page.'
        : /duplicate|canonical/i.test(c || '') ? 'Google picked another page as the original: consolidate or fix the canonical.'
          : 'Check the coverage state in Search Console.');
  for (const p of old.slice(0, 10)) {
    await raise(userId, raised, { dedupKey: `seo:not-indexed:${p.path}`.slice(0, 120), title: `Not indexed by Google: ${p.path}`, whatHappened: `${p.coverageState || p.indexVerdict}. Last crawl: ${p.lastCrawlTime ? p.lastCrawlTime.toISOString().slice(0, 10) : 'never'}.`, whatNeeds: advice(p.coverageState) });
  }
  if (old.length > 10) await raise(userId, raised, { dedupKey: 'seo:not-indexed', title: `${old.length} pages are not indexed by Google`, whatHappened: list(old.map((p) => `${p.path}: ${p.coverageState || p.indexVerdict}`)) });
}

async function indexWatchTick(ctx, { light = false } = {}) {
  const { userId } = ctx;
  const now = new Date();
  const seo = await g.loadSeo(userId);
  const auth = await g.getAuth(seo);
  const actions = [];
  const raised = new Set();

  let roots; let sitemaps; let crawl = null;
  if (light) ({ roots, sitemaps } = await readSitemaps(seo.origin));
  else { crawl = await crawlSite(seo.origin, { maxUrls: seo.cfg.crawlMaxUrls }); ({ roots, sitemaps } = crawl); }
  for (const s of sitemaps.filter((x) => x.status !== 200)) {
    await raise(userId, raised, { dedupKey: `seo:sitemap-http:${s.url}`.slice(0, 120), urgency: 'high', title: `Sitemap ${s.url.replace(seo.origin, '')} does not load (${s.status || s.error})`, whatNeeds: 'Re-upload it: _deploy.py uploads the sitemaps every night.' });
  }
  const rows = await recordSitemaps(userId, sitemaps, now);
  const gscList = await syncGscSitemaps(userId, auth, seo.property, now);
  const submitted = await submitSitemaps(userId, { auth, property: seo.property, roots, rows, gscList, now, actions });

  // New sitemap URLs since the last run go to IndexNow (Bing) right away.
  const known = new Set((await prisma.seoPage.findMany({ where: { userId, inSitemap: true }, select: { path: true } })).map((p) => p.path));
  const sitemapPaths = [...new Set(sitemaps.filter((s) => !s.isIndex).flatMap((s) => s.entries.map((e) => canonicalPath(e.loc, seo.origin))).filter(Boolean))];
  const fresh = sitemapPaths.filter((p) => !known.has(p));

  let issues = null;
  if (crawl) {
    await applyCrawl(userId, seo.origin, crawl, now);
    issues = findIssues(seo.origin, crawl);
    await raiseIssues(userId, seo.origin, issues, raised);
    await notIndexedTasks(userId, now, raised);
  } else {
    for (const p of fresh) await prisma.seoPage.upsert({ where: { userId_path: { userId, path: p } }, update: { inSitemap: true }, create: { userId, path: p, kind: kindFor(p), source: 'sitemap', inSitemap: true, httpStatus: 200 } });
  }

  if (fresh.length && process.env.INDEXNOW_KEY && known.size) {
    if (!g.submitAllowed()) actions.push(`would send ${fresh.length} new URL(s) to IndexNow — DRY_RUN`);
    else {
      const r = await g.indexNow(seo.origin, fresh.map((p) => toUrl(p, seo.origin))).catch((e) => ({ ok: false, status: e.message }));
      actions.push(r.ok ? `sent ${fresh.length} new URL(s) to IndexNow (Bing)` : `IndexNow failed (${r.status})`);
      if (r.status === 403) await createTask(userId, { dedupKey: 'seo:indexnow-key', source: 'seo', title: 'IndexNow key file is missing on the site', whatNeeds: `Upload a file named ${process.env.INDEXNOW_KEY}.txt containing ${process.env.INDEXNOW_KEY} to the site root.` });
    }
  }

  const limit = light ? 10 : (process.env.DRY_RUN === 'true' && process.env.SEO_SUBMIT !== 'on' ? Math.min(10, seo.cfg.inspectPerRun) : seo.cfg.inspectPerRun);
  const insp = await inspectPages(userId, { auth, property: seo.property, origin: seo.origin, seo, now, limit, actions });

  let closed = 0;
  if (crawl) closed = await closeResolved(userId, raised, ['seo:sitemap-', 'seo:missing-', 'seo:canonical', 'seo:duplicates', 'seo:broken-', 'seo:www-', 'seo:orphan-', 'seo:no-inlinks', 'seo:not-indexed']);
  if (!light) await g.saveState(seo.row.id, { lastIndexWatchAt: now.toISOString(), crawl: crawl ? { fetched: crawl.fetched, capped: crawl.capped, at: now.toISOString() } : undefined });

  const counts = issues ? Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, v.length])) : null;
  const parts = [crawl ? `${crawl.fetched} pages checked` : `${sitemaps.length} sitemap(s) read`, `${sitemapPaths.length} URLs in sitemaps`,
    submitted.filter((s) => s.submitted).length ? `submitted ${submitted.filter((s) => s.submitted).length} sitemap(s)` : null,
    submitted.find((s) => !s.submitted) ? `not submitted: ${submitted.find((s) => !s.submitted).reason}` : null,
    insp.inspected ? `${insp.inspected} inspected` : null, crawl ? (raised.size ? `${raised.size} issue task(s)` : 'no issues') : null, closed ? `${closed} resolved` : null];
  return { items_found: sitemapPaths.length, requires_attention: raised.size, summary: parts.filter(Boolean).join(', '), actions_taken: actions, issues: counts, submitted, newUrls: fresh.length };
}

module.exports = { indexWatchTick, findIssues, kindFor };
