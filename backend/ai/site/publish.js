/**
 * Publishing to the live site from the server. The writer (a Claude routine) sends a structured page; this checks it,
 * renders it into the site's template, uploads it over FTP, keeps posts.json / blog.html / the sitemaps in step, and
 * reports it to the SEO engine (assign.markPublished). Nothing here uses an AI model.
 *   publishPage   new post / refresh / landing page      addLink   one sentence + link inside an existing post
 *   viewPage      a live page's editable parts           reconcileIndex   posts.json, blog.html, sitemaps from the live site
 */
const prisma = require('../../lib/prismaClient');
const { toDateString } = require('../../lib/tz');
const g = require('../seo/google');
const sa = require('../seo/siteAccess');
const assign = require('../seo/assign');
const { canonicalPath, toUrl } = require('../seo/urls');
const { withSite, canWrite, httpError } = require('./store');
const { renderPage, extractPage } = require('./render');
const { checkPage, checkFragment, normalizeLinks } = require('./check');
const { makeHero } = require('./images');
const { postFacts, mergePosts, postsJson, patchBlogHtml } = require('./blogIndex');
const { buildSitemaps } = require('./sitemaps');

/** Keep the existing file's line endings: the PC wrote CRLF, so rewriting it with LF would change every line. */
const withEol = (text, like) => (like && like.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
const slugOf = (path) => String(path || '').replace(/^\/+/, '').replace(/\.html?$/i, '');
const problems = (status, message, details) => Object.assign(httpError(status, message), { details });

/**
 * While the PC's nightly rebuild is still switched on, its 3 AM upload would overwrite whatever the server publishes
 * (stale sitemaps, posts.json and blog.html). Turn that routine off in AI Command once the PC jobs are removed.
 */
async function assertPcRetired(userId) {
  if (process.env.SITE_PUBLISH_FORCE === 'on') return;
  const r = await prisma.routine.findUnique({ where: { userId_slug: { userId, slug: 'ext-seo-site-nightly' } }, select: { enabled: true } });
  if (r?.enabled) throw httpError(409, 'The PC still rebuilds and uploads the site every night, which would overwrite what the server publishes. Turn off "Website sitemap + blog index rebuild (MSI)" in AI Command (and remove the 3 AM upload task on the PC) first.');
}

async function pageMap(userId) {
  return Object.fromEntries((await prisma.seoPage.findMany({ where: { userId } })).map((p) => [p.path, p]));
}

/** What a live page looks like to the writer: its fields and editable body (null body = a layout the API cannot edit). */
async function viewPage(userId, path) {
  const seo = await g.loadSeo(userId);
  const p = canonicalPath(path, `${seo.origin}/`);
  if (!p || p === '/') throw httpError(400, 'path must be a page on this site, for example /blog-aeration-cost-winnipeg');
  const r = await sa.probe(`${seo.origin}${p}`);
  if (r.status !== 200) throw httpError(404, `${p} answered ${r.status || r.error}`);
  const page = extractPage(String(r.body));
  return { path: p, slug: slugOf(p), editable: !!page, ...(page || { note: 'This page is not in the standard blog layout; it has to be edited by hand.' }) };
}

/** posts.json + blog.html + sitemaps for the current live state. `upserts`/`drop`: posts.json changes to apply first. */
async function syncIndex(site, userId, { upserts = [], drop = [], reconcile = false, write = true } = {}) {
  const seo = await g.loadSeo(userId);
  const pages = await pageMap(userId);
  const out = { changed: [], notes: [], posts: 0, added: [] };
  // one FTP connection does one thing at a time: read the files in turn, never in parallel
  const postsText = await site.readText('posts.json');
  const blogHtml = await site.readText('blog.html');
  const smText = await site.readText('sitemap.xml');
  const blogSmText = await site.readText('blog-sitemap.xml');
  if (postsText == null && !reconcile) throw httpError(502, 'posts.json is missing on the live site: run rebuild-index first');
  let current;
  try { current = postsText ? JSON.parse(postsText) : []; } catch { throw httpError(502, 'posts.json on the live site is not valid JSON: left alone'); }

  let add = [...upserts];
  let remove = [...drop];
  if (reconcile) {
    const have = new Set(current.map((p) => String(p.url).replace(/^\/+/, '').replace(/\.html?$/, '')));
    for (const p of Object.values(pages)) {
      const slug = slugOf(p.path);
      if (!/^blog-/i.test(slug)) continue;
      const live = (p.httpStatus || 0) === 200 && !p.redirectTo;
      if (live && !p.noindex && !have.has(slug) && !p.excluded) {
        const r = await sa.probe(`${seo.origin}${p.path}`);
        if (r.status === 200) { add.push(postFacts(slug, String(r.body))); out.added.push(slug); }
      } else if (have.has(slug) && p.httpStatus && !live) remove.push(slug);
    }
  }
  const posts = mergePosts(current, add, remove);
  out.posts = posts.length;
  const nextJson = withEol(postsJson(posts), postsText);
  if (nextJson !== postsText) { if (write) await site.write('posts.json', nextJson, { reason: 'blog index' }); out.changed.push('posts.json'); }
  if (blogHtml != null) {
    const patched = patchBlogHtml(blogHtml.replace(/\r\n/g, '\n'), posts);
    out.notes.push(...patched.notes);
    const nextBlog = withEol(patched.html, blogHtml);
    if (nextBlog !== blogHtml) { if (write) await site.write('blog.html', nextBlog, { reason: 'blog index', probeUrl: `${seo.origin}/blog` }); out.changed.push('blog.html'); }
  } else out.notes.push('blog.html was not found');

  const exclude = Array.isArray(seo.cfg.sitemapExclude) ? seo.cfg.sitemapExclude : [];
  const sm = buildSitemaps({ origin: seo.origin, pages: Object.values(pages), exclude, live: { sitemap: smText, blog: blogSmText }, today: toDateString() });
  const live = { 'sitemap.xml': smText, 'blog-sitemap.xml': blogSmText, 'sitemap_index.xml': await site.readText('sitemap_index.xml') };
  for (const [name, raw] of Object.entries(sm.files)) {
    const xml = withEol(raw, live[name]);
    if (xml === live[name]) continue;
    if (write) await site.write(name, xml, { reason: 'sitemap', probeUrl: `${seo.origin}/${name}` });
    out.changed.push(name);
  }
  return { ...out, sitemap: { counts: sm.counts, ...sm.diff } };
}

/**
 * input: { mode: new|refresh|page, assignmentId?, slug, title, description, keywords[], h1, crumb?, keyword,
 *          bodyHtml, heroAssetId?, heroQuery?, imageAlt?, secondaryKeywords[]?, contentType?, category? }
 */
async function publishPage(userId, input, { agent = 'content', now = new Date() } = {}) {
  const seo = await g.loadSeo(userId);
  const origin = seo.origin;
  const assignment = input.assignmentId ? await prisma.seoAssignment.findFirst({ where: { id: String(input.assignmentId), userId } }) : null;
  const brief = assignment?.brief || {};
  const mode = ['new', 'refresh', 'page'].includes(input.mode) ? input.mode : assignment?.mode;
  if (!mode) throw httpError(400, 'mode must be new, refresh or page (links edits use /seo/site/link)');
  const kind = mode === 'page' ? 'page' : 'post';
  const keyword = String(input.keyword || assignment?.keywordText || '').trim();
  const slug = String(input.slug || '').trim().replace(/\.html?$/, '');
  const pages = await pageMap(userId);
  const bodyHtml = normalizeLinks(String(input.bodyHtml || ''), origin);

  const draft = { kind, mode, slug, title: String(input.title || '').trim(), description: String(input.description || '').trim(), h1: String(input.h1 || '').trim(), keyword, bodyHtml,
    requiredLinks: (brief.internalLinks || []).filter((l) => l.required).map((l) => l.url), wordRange: brief.onPage?.wordCount };
  const check = checkPage(draft, { pages, origin });
  if (!check.ok) throw problems(422, 'The page did not pass the checks. Fix everything listed and send it again.', { errors: check.errors, warnings: check.warnings });
  await assertPcRetired(userId);

  const today = toDateString(now);
  const image = `images/${slug}.webp`;
  return withSite(userId, async (site) => {
    const livePath = `${slug}.html`;
    let existing = null;
    if (mode === 'refresh') {
      const html = await site.readText(livePath);
      existing = html ? extractPage(html) : null;
      if (!existing) throw problems(422, `/${slug} is not a page in the standard layout that can be refreshed here`, { errors: [`/${slug} cannot be refreshed through the API`] });
    }
    let hero = null;
    if (mode === 'refresh' && !input.heroAssetId) hero = null;
    else {
      hero = await makeHero(userId, { assetId: input.heroAssetId, query: input.heroQuery });
      if (!hero && mode === 'new') throw problems(422, 'No hero image', { errors: ['Send heroAssetId (a non-private vault photo) or heroQuery with PEXELS_API_KEY set on the server.'] });
    }
    const heroPath = hero ? image : (existing?.image || '');
    const html = renderPage({ kind, origin, slug, title: draft.title, description: draft.description, keywords: input.keywords || [keyword], h1: draft.h1, crumb: input.crumb || draft.h1,
      image: heroPath, imageAlt: input.imageAlt || existing?.imageAlt || draft.h1, date: existing?.date || today, modified: mode === 'refresh' ? today : '', bodyHtml });

    const files = [];
    if (hero) { await site.write(image, hero.buffer, { reason: 'hero' }); files.push(image); }
    await site.write(livePath, html, { reason: `${mode}: ${draft.title}`, probeUrl: `${origin}/${slug}` });
    files.push(livePath);

    const url = `${origin}/${slug}`;
    const done = await assign.markPublished(userId, { assignmentId: assignment?.id, url, mode, title: draft.title, primaryKeyword: keyword, secondaryKeywords: input.secondaryKeywords,
      contentType: input.contentType || assignment?.contentType, wordCount: check.words, kind: mode === 'page' ? (brief.kind === 'area' ? 'area' : 'service') : 'blog' }, { agent, now });
    // the crawl has not seen the page yet: say what is true now so the sitemap includes it
    await prisma.seoPage.updateMany({ where: { userId, path: `/${slug}` }, data: { httpStatus: 200, lastCheckedAt: now, contentChangedAt: now, inSitemap: true, title: draft.title, h1: draft.h1 } });

    let index = null; let indexError = null;
    try {
      const entry = { title: draft.title, excerpt: draft.description.slice(0, 200), url: slug, readTime: Math.max(3, Math.round(check.words / 200)),
        ...(mode === 'refresh' ? {} : { date: today, image: heroPath, category: input.category || 'Lawn Care' }) };
      index = await syncIndex(site, userId, { upserts: kind === 'post' ? [entry] : [] });
      files.push(...index.changed);
    } catch (e) { indexError = e.message; }
    return { ok: true, mode, url, slug, words: check.words, warnings: check.warnings, files, index, indexError, reportDue: done.reportDue, postsSinceReport: done.postsSinceReport };
  }, { write: true });
}

/** Insert one paragraph (with the link) after the paragraph containing `afterText` in an existing post. */
async function addLink(userId, { assignmentId, path, afterText, sentenceHtml }, { agent = 'content', now = new Date() } = {}) {
  const seo = await g.loadSeo(userId);
  const origin = seo.origin;
  const assignment = assignmentId ? await prisma.seoAssignment.findFirst({ where: { id: String(assignmentId), userId } }) : null;
  const target = assignment?.brief?.linkTo?.url;
  if (!target) throw httpError(400, 'assignmentId must be an open links assignment');
  const slug = slugOf(canonicalPath(path, `${origin}/`));
  if (!slug) throw httpError(400, 'path must be a page on this site');
  const pages = await pageMap(userId);
  const sentence = normalizeLinks(String(sentenceHtml || '').trim(), origin);
  const check = checkFragment(sentence, { requiredLinks: [target], pages, origin });
  if (!check.ok) throw problems(422, 'The sentence did not pass the checks.', { errors: check.errors });
  await assertPcRetired(userId);

  return withSite(userId, async (site) => {
    const file = `${slug}.html`;
    const html = await site.readText(file);
    if (html == null) throw httpError(404, `${file} is not on the live site`);
    const col = html.indexOf('<div class="col-lg-8 mx-auto">');
    const foot = html.indexOf('<footer', col);
    if (col < 0 || foot < 0) throw problems(422, `${file} is not in the standard layout`, { errors: ['The page has no standard content column.'] });
    const region = html.slice(col, foot);
    if (region.includes(`href="${target}"`)) throw httpError(409, 'The page already links there');
    const at = String(afterText || '');
    if (at.length < 12 || region.split(at).length !== 2) throw problems(422, 'afterText must match exactly one place in the page', { errors: ['Send a 12+ character snippet of an existing paragraph, copied from GET /seo/site/page, that appears once.'] });
    const idx = col + region.indexOf(at);
    const pStart = html.lastIndexOf('<p', idx);
    const close = html.indexOf('</p>', idx);
    if (pStart < 0 || close < 0 || html.slice(pStart, idx).includes('</p>')) throw problems(422, 'afterText is not inside a paragraph', { errors: ['Pick text inside a normal paragraph, not a list or a heading.'] });
    const end = close + 4;
    let next = `${html.slice(0, end)}\n            ${sentence}${html.slice(end)}`;
    const today = toDateString(now);
    next = /"dateModified"\s*:\s*"[^"]*"/.test(next) ? next.replace(/("dateModified"\s*:\s*")[^"]*(")/, `$1${today}$2`)
      : next.replace(/("datePublished"\s*:\s*"[^"]*")/, `$1,\n      "dateModified": "${today}"`);
    await site.write(file, next, { reason: `link to ${target}`, probeUrl: `${origin}/${slug}` });
    const done = await assign.markPublished(userId, { assignmentId: assignment.id, url: `${origin}/${slug}`, mode: 'links' }, { agent, now });
    return { ok: true, mode: 'links', url: `${origin}/${slug}`, files: [file], reportDue: done.reportDue, postsSinceReport: done.postsSinceReport };
  }, { write: true });
}

/**
 * The daily/manual index job. dry (or publishing switched off): nothing is written, the result says what would change.
 */
async function reconcileIndex(userId, { dry = false } = {}) {
  const write = !dry && canWrite();
  if (write) await assertPcRetired(userId);
  const out = await withSite(userId, (site) => syncIndex(site, userId, { reconcile: true, write }), { write });
  return { dryRun: !write, ...out };
}

module.exports = { publishPage, addLink, viewPage, reconcileIndex, syncIndex };
