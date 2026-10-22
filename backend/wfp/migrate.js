/**
 * One-time move of the old WordPress blog posts into the custom blog (/articles/<slug>/).
 *   - reads the posts from WordPress's public REST API (no password), keeps slug, date, title, category
 *   - re-uploads every wp-content/uploads image to /images/articles/ and rewrites the links, so WordPress can go later
 *   - renders each post with the article template, rebuilds the article list, edits the sitemap (adds /articles/,
 *     drops the old /blog/ URLs) and, if asked, writes a small redirect file into WordPress (mu-plugins, loads by
 *     itself, deleting it turns the redirects off) that 301s every /blog/<slug>/ to /articles/<slug>/
 * Safe to re-run: posts already moved are skipped unless overwrite is set. dryRun (or DRY_RUN=true) only reports.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const prisma = require('../lib/prismaClient');
const { getConfig } = require('./settings');
const kw = require('./keywords');
const { renderPost, renderCards, renderIndex, postUrls, sanitizeBody } = require('./template');
const { runScript, ftpEnv } = require('./publisher');
const { localParts } = require('./plan');
const { note } = require('./runner');

const UA = { 'User-Agent': '5StarFlow-WFP/1.0' };
const text = (html) => cheerio.load(`<div>${html || ''}</div>`).text().replace(/\s+/g, ' ').trim();
/** Cut at a word boundary with an ellipsis. */
const clip = (str, n) => { const t = String(str || '').trim(); if (t.length <= n) return t; const cut = t.slice(0, n - 1); return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s,;:.\-–—]+$/, '')}…`; };
const baseName = (u) => { try { return decodeURIComponent(new URL(u, 'http://x').pathname.split('/').pop() || ''); } catch { return ''; } };
const noSize = (n) => n.replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/-scaled(?=\.\w+$)/, '');
const SHORTCODE = /\[\/?(caption|gallery|embed|video|audio|playlist|vc_[a-z_]+|et_pb_[a-z_]+|elementor[a-z_-]*)[^\]]*\]/gi;

async function fetchWpPosts(base) {
  const out = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await axios.get(`${base}/wp-json/wp/v2/posts`, { params: { per_page: 100, page, _embed: 1, orderby: 'date', order: 'desc' }, timeout: 90000, validateStatus: () => true, headers: UA });
    if (res.status === 400 && page > 1) break; // past the last page
    if (res.status !== 200 || !Array.isArray(res.data)) throw new Error(`The WordPress API answered ${res.status} for ${base}/wp-json/wp/v2/posts`);
    out.push(...res.data);
    if (page >= Number(res.headers['x-wp-totalpages'] || 1)) break;
  }
  return out;
}

/**
 * WordPress HTML -> clean article body. Returns { html, images: Map(absoluteUrl -> file name) }.
 * Images under wp-content/uploads are pointed at /images/articles/<file>; links to other moved posts are rewritten.
 */
function convertContent(html, { cfg, base, slugs, featured }) {
  const images = new Map();
  const siteHost = new URL(base).hostname.replace(/^www\./, '');
  const blogPath = new URL(base).pathname.replace(/\/+$/, '');
  const local = (u) => {
    if (!u || !/\/wp-content\/uploads\//.test(u)) return null;
    let abs;
    try { abs = new URL(u, `${base}/`).href; } catch { return null; }
    if (!images.has(abs)) {
      let name = baseName(abs).replace(/[^A-Za-z0-9._-]+/g, '-');
      if ([...images.values()].includes(name)) name = `${images.size}-${name}`;
      images.set(abs, name);
    }
    return `/images/articles/${images.get(abs)}`;
  };
  const clean = String(html || '').replace(SHORTCODE, '').replace(/<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');
  const $ = cheerio.load(`<div id="r">${clean}</div>`, null, false);
  $('#r').find('*').addBack().contents().filter((_, n) => n.type === 'comment').remove();

  const featuredKey = featured ? noSize(baseName(featured)) : null;
  let dropped = false;
  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.attr('data-src') || '';
    if (!dropped && featuredKey && noSize(baseName(src)) === featuredKey) { dropped = true; const fig = $el.closest('figure'); (fig.length ? fig : $el).remove(); return; }
    const l = local(src);
    $el.attr('src', l || src).removeAttr('srcset').removeAttr('sizes').removeAttr('data-src').removeAttr('data-srcset').removeAttr('data-lazy-src');
    if (!$el.attr('loading')) $el.attr('loading', 'lazy');
  });
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const l = local(href);
    if (l) { $(el).attr('href', l); return; }
    let u;
    try { u = new URL(href, `${base}/`); } catch { return; }
    if (u.hostname.replace(/^www\./, '') !== siteHost || !u.pathname.startsWith(`${blogPath}/`)) return;
    const rest = u.pathname.slice(blogPath.length + 1).replace(/\/+$/, '');
    if (!rest) $(el).attr('href', postUrls(cfg, 'x').path.replace(/x\/?$/, '').replace(/x\.html$/, ''));
    else if (slugs.has(rest)) $(el).attr('href', postUrls(cfg, rest).path + (u.hash || ''));
  });
  return { html: sanitizeBody($('#r').html() || ''), images };
}

/** No featured image in WordPress: the first picture of the post becomes the hero and card photo, and leaves the body. */
function takeFirstImage(html) {
  const $ = cheerio.load(`<div id="r">${html}</div>`, null, false);
  const img = $('#r img').first();
  const src = img.attr('src');
  if (!src) return { html, src: '' };
  const holder = img.closest('figure').length ? img.closest('figure') : img.parent('p');
  (holder.length && !holder.text().trim() ? holder : img).remove();
  return { html: $('#r').html(), src };
}

/** The mu-plugin that 301s the old URLs. map: { slug: newPath }. Plain PHP, no database, no settings. */
function redirectPlugin(cfg, blogPath, map) {
  const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const rows = Object.entries(map).map(([k, v]) => `    ${q(k)} => ${q(v)},`).join('\n');
  return `<?php
/**
 * Plugin Name: Winnipeg Fence Pros article redirects
 * Description: 301 redirects from the old ${blogPath}/ posts to the new /articles/ pages. Written by 5StarFlow. Delete this file to turn them off.
 */
add_action('init', function () {
  $base = ${q(`${blogPath}/`)};
  $site = ${q(cfg.SITE_URL)};
  $map = array(
${rows}
  );
  $path = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '', PHP_URL_PATH);
  if (!$path || strpos($path, $base) !== 0) return;
  $rest = trim(substr($path, strlen($base)), '/');
  if ($rest === '') { $to = ${q(postUrls(cfg, 'x').path.replace(/x\/?$/, '').replace(/x\.html$/, ''))}; }
  elseif (isset($map[$rest])) { $to = $map[$rest]; }
  else { return; }
  header('Location: ' . $site . $to, true, 301);
  exit;
}, 1);
`;
}

const dateOf = (p) => String(p.date || '').slice(0, 10);

async function downloadImage(url, file) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, headers: UA, validateStatus: () => true });
  if (res.status !== 200) throw new Error(`${res.status}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(res.data));
}

async function migrateTick(ctx, { dryRun = false, overwrite = false, redirects = true } = {}) {
  const cfg = await getConfig();
  if (!cfg.WP_BLOG_URL) throw new Error('Set the old WordPress blog URL on the Settings tab first');
  if (!cfg.SITE_URL) throw new Error('Set the website URL first');
  const live = !dryRun && process.env.DRY_RUN !== 'true';
  if (live && (!cfg.FTP_HOST || !cfg.FTP_USER || !cfg.FTP_PASS)) throw new Error('Set the FTP login first');
  const base = cfg.WP_BLOG_URL.replace(/\/+$/, '');
  const blogPath = new URL(base).pathname.replace(/\/+$/, '');

  const wp = await fetchWpPosts(base);
  ctx.log(`WordPress: ${wp.length} posts at ${base}`);
  const done = new Set((await prisma.wfpPost.findMany({ where: { mode: 'import' }, select: { slug: true } })).map((p) => p.slug));
  const mine = new Set((await prisma.wfpPost.findMany({ where: { mode: { not: 'import' }, status: { in: ['published', 'draft'] } }, select: { slug: true } })).map((p) => p.slug));
  const todo = wp.filter((p) => (overwrite || !done.has(p.slug)) && !mine.has(p.slug));
  const slugs = new Set(wp.map((p) => p.slug));
  if (!todo.length) return { skipped: true, summary: `Nothing to move: all ${wp.length} posts were moved already` };

  const items = todo.map((p) => {
    const featured = p._embedded?.['wp:featuredmedia']?.[0]?.source_url || '';
    const conv = convertContent(p.content?.rendered, { cfg, base, slugs, featured });
    let inlineHero = '';
    if (!featured) { const t = takeFirstImage(conv.html); conv.html = t.html; inlineHero = t.src; }
    const title = text(p.title?.rendered) || p.slug;
    const plain = text(conv.html);
    const excerpt = clip(text(p.excerpt?.rendered) || plain, 180);
    const wpCat = (p._embedded?.['wp:term']?.[0] || []).map((t) => t.name).find((n) => n && !/uncategori/i.test(n));
    const category = kw.serviceFor(`${title} ${plain.slice(0, 600)}`, cfg.services) || (cfg.services.find((s) => s.name.toLowerCase() === String(wpCat).toLowerCase())?.name) || cfg.POST_CATEGORY || 'Fence';
    const words = plain.split(' ').filter(Boolean).length;
    let heroAbs = featured ? new URL(featured, `${base}/`).href : '';
    let heroName = heroAbs ? (conv.images.get(heroAbs) || baseName(heroAbs).replace(/[^A-Za-z0-9._-]+/g, '-')) : '';
    if (!heroAbs && inlineHero) {
      heroName = inlineHero.replace(/^\/images\/articles\//, '');
      heroAbs = [...conv.images].find(([, n]) => n === heroName)?.[0] || (/^https?:/.test(inlineHero) ? inlineHero : '');
    }
    if (heroAbs && !conv.images.has(heroAbs) && /\/wp-content\/uploads\//.test(heroAbs)) conv.images.set(heroAbs, heroName);
    const image = inlineHero && !featured ? inlineHero : heroAbs && /\/wp-content\/uploads\//.test(heroAbs) ? `/images/articles/${heroName}` : (heroAbs || '');
    return { p, title, excerpt, category, words, conv, date: dateOf(p), heroAbs, image, imageAlt: p._embedded?.['wp:featuredmedia']?.[0]?.alt_text || title };
  });
  for (const it of items) ctx.log(`${it.p.slug} → ${postUrls(cfg, it.p.slug).path} [${it.category}] ${it.words} words, ${it.conv.images.size + (it.heroAbs && !it.conv.images.has(it.heroAbs) ? 1 : 0)} images`);
  if (!live) {
    return { summary: `${dryRun ? 'Preview' : 'DRY_RUN is on'}: ${items.length} posts would move to ${postUrls(cfg, 'x').path.replace(/x\/?$/, '')}; nothing was uploaded`, detail: { posts: items.map((i) => ({ from: i.p.link, to: postUrls(cfg, i.p.slug).url, category: i.category })) } };
  }

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wfp-migrate-'));
  try {
    const uploads = [];
    const allImages = new Map();
    for (const it of items) for (const [u, n] of it.conv.images) allImages.set(u, n);
    const failed = new Set();
    for (const [u, n] of allImages) {
      try { await downloadImage(u, path.join(work, 'img', n)); uploads.push({ local: `img/${n}`, remote: `${String(cfg.IMAGES_DIR || 'images').replace(/^\/+|\/+$/g, '')}/articles/${n}` }); } catch (e) { failed.add(u); ctx.log(`image not copied (${e.message}): ${u}`); }
    }
    for (const it of items) {
      // an image that could not be copied keeps pointing at WordPress rather than a missing file
      let html = it.conv.html;
      for (const u of failed) { const n = allImages.get(u); if (n) html = html.split(`/images/articles/${n}`).join(u); }
      const image = it.image && failed.has(it.heroAbs) ? it.heroAbs : it.image;
      const { html: page, urls } = renderPost(cfg, { slug: it.p.slug, title: it.title, metaDescription: clip(it.excerpt, 158), excerpt: it.excerpt, category: it.category, readTime: Math.max(2, Math.round(it.words / 220)), bodyHtml: html, faq: [], image, imageAlt: it.imageAlt }, it.date);
      it.page = page; it.urls = urls; it.finalImage = image;
      await fs.mkdir(path.join(work, 'files', it.p.slug), { recursive: true });
      await fs.writeFile(path.join(work, 'files', it.p.slug, 'page.html'), page, 'utf8');
      uploads.push({ local: `files/${it.p.slug}/page.html`, remote: `${urls.remoteDir ? `${urls.remoteDir}/` : ''}${urls.file}` });
    }

    const movedSlugs = new Set(items.map((i) => i.p.slug));
    const others = await prisma.wfpPost.findMany({ where: { status: 'published', slug: { notIn: [...movedSlugs] } }, select: { slug: true, title: true, excerpt: true, metaDescription: true, category: true, readTime: true, publishedAt: true, image: true } });
    const cardOf = (slug, o) => ({ url: postUrls(cfg, slug).path, title: o.title, excerpt: o.excerpt || o.metaDescription || '', category: o.category, readTime: o.readTime, date: o.date, image: o.image || '' });
    const cards = renderCards(cfg, [
      ...others.map((o) => cardOf(o.slug, { ...o, date: localParts(o.publishedAt || new Date()).date })),
      ...items.map((i) => cardOf(i.p.slug, { title: i.title, excerpt: i.excerpt, category: i.category, readTime: Math.max(2, Math.round(i.words / 220)), date: i.date, image: i.finalImage })),
    ]);
    await fs.writeFile(path.join(work, 'cards.html'), cards, 'utf8');
    await fs.writeFile(path.join(work, 'index-template.html'), renderIndex(cfg, cards), 'utf8');

    if (redirects && blogPath) {
      const map = Object.fromEntries(items.map((i) => [i.p.slug, postUrls(cfg, i.p.slug).path]));
      await fs.writeFile(path.join(work, 'redirects.php'), redirectPlugin(cfg, blogPath, map), 'utf8');
      uploads.push({ local: 'redirects.php', remote: `${blogPath.replace(/^\/+/, '')}/wp-content/mu-plugins/wfp-articles-redirects.php` });
    }
    const manifest = {
      uploads, indexFile: cfg.BLOG_INDEX_FILE || '', cardsFile: 'cards.html', indexTemplateFile: 'index-template.html',
      sitemapFile: cfg.sitemapAuto ? (cfg.SITEMAP_FILE || '') : '', sitemapAdd: items.map((i) => ({ url: i.urls.url, date: i.date })),
      sitemapRemovePrefixes: blogPath ? [`${cfg.SITE_URL}${blogPath}/`] : [],
    };
    await fs.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    ctx.log(`Uploading ${uploads.length} files over FTP`);
    const { code, out, result } = await runScript(['--workdir', work, '--batch', 'manifest.json'], ftpEnv(cfg), 900000);
    if (!result?.ok) throw new Error(result?.error || `blog_publish.py exited with ${code}: ${(cfg.FTP_PASS ? out.split(cfg.FTP_PASS).join('***') : out).slice(-300)}`);

    for (const it of items) {
      const publishedAt = it.p.date_gmt ? new Date(`${it.p.date_gmt}Z`) : new Date(`${it.date}T12:00:00Z`);
      const data = { keywordId: null, keyword: it.title, mode: 'import', slug: it.p.slug, title: it.title, metaDescription: clip(it.excerpt, 158), excerpt: it.excerpt, category: it.category, readTime: Math.max(2, Math.round(it.words / 220)), image: it.finalImage || null, oldUrl: it.p.link, html: it.page, status: 'published', url: it.urls.url, publishedAt, log: null, error: null };
      const row = await prisma.wfpPost.findFirst({ where: { slug: it.p.slug, mode: 'import' } });
      const saved = row ? await prisma.wfpPost.update({ where: { id: row.id }, data }) : await prisma.wfpPost.create({ data });
      const d = kw.describe(it.title, cfg);
      const existing = await prisma.wfpKeyword.findUnique({ where: { matchKey: d.matchKey } });
      const live = ['published', 'indexed', 'ranking', 'page1', 'top3'];
      const kwData = { postId: saved.id, targetUrl: it.urls.url, publishedAt, service: it.category, recommended: false };
      if (existing) await prisma.wfpKeyword.update({ where: { id: existing.id }, data: live.includes(existing.status) ? kwData : { ...kwData, status: 'published', statusChangedAt: new Date() } });
      else if (d.matchKey) await prisma.wfpKeyword.create({ data: { ...d, ...kwData, service: it.category, source: 'import', status: 'published' } });
      await prisma.wfpPost.update({ where: { id: saved.id }, data: { keywordId: (await prisma.wfpKeyword.findUnique({ where: { matchKey: d.matchKey } }))?.id || null } });
    }
    await note('system', 'milestone', `Moved ${items.length} WordPress posts to ${postUrls(cfg, 'x').path.replace(/x\/?$/, '')}`, `${items.length} articles, ${allImages.size - failed.size} images copied${failed.size ? `, ${failed.size} images could not be copied` : ''}. ${redirects ? `The old ${blogPath}/ links now 301 to the new pages (redirect file in WordPress: ${blogPath}/wp-content/mu-plugins/wfp-articles-redirects.php, delete it to turn the redirects off). ` : 'No redirects were written: the old links still open the WordPress posts. '}The sitemap lists the new URLs.`);
    return { summary: `Moved ${items.length} posts, ${allImages.size - failed.size} images${redirects ? ', redirects written' : ''}`, detail: { posts: items.length, images: allImages.size, imagesFailed: failed.size, sitemap: result.sitemap, index: result.index } };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { migrateTick, fetchWpPosts, convertContent, redirectPlugin, clip };
