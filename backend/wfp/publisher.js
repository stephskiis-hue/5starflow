/**
 * Publishing for Winnipeg Fence Pros. The writer is a Claude routine on claude.ai (no AI on this server): it takes an
 * assignment (wfp/assign.js) and sends the finished post to POST /api/wfp/publish, which checks it (wfp/check.js),
 * renders it and calls publishPost here:
 *   publishPost  runs wfp/blog_publish.py (Pexels hero, FTP upload, article list, sitemap), then resubmits the
 *                sitemap to Search Console and moves the keyword to published
 * DRY_RUN=true on the server runs the script with --dry-run: nothing is uploaded.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const prisma = require('../lib/prismaClient');
const { getConfig, missing } = require('./settings');
const { LIVE, localParts } = require('./plan');
const { renderCards, renderIndex, postUrls } = require('./template');
const g = require('./google');

const SCRIPT = path.join(__dirname, 'blog_publish.py');
const PY = process.env.PYTHON_BIN || 'python3';

/** Keywords that already have work under way: a reserved assignment or a post being published or waiting for review. */
async function busyKeywords(now = new Date()) {
  const [posts, assignments] = await Promise.all([
    prisma.wfpPost.findMany({ where: { status: { in: ['draft', 'publishing'] } }, select: { keywordId: true } }),
    prisma.wfpAssignment.findMany({ where: { status: 'reserved', expiresAt: { gt: now } }, select: { keywordId: true } }),
  ]);
  return new Set([...posts, ...assignments].map((r) => r.keywordId).filter(Boolean));
}

/** The only environment blog_publish.py gets: the FTP login and the Pexels key. */
const ftpEnv = (cfg) => ({ PATH: process.env.PATH, HOME: process.env.HOME, PYTHONIOENCODING: 'utf-8', FTP_HOST: cfg.FTP_HOST, FTP_PORT: String(cfg.ftpPort), FTP_USER: cfg.FTP_USER, FTP_PASS: cfg.FTP_PASS,
  FTP_PATH: cfg.FTP_PATH || '/', FTP_SECURE: String(cfg.ftpSecure), PEXELS_API_KEY: cfg.PEXELS_API_KEY || '' });

function runScript(args, env, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(PY, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const add = (b) => { out += b.toString(); if (out.length > 200000) out = out.slice(-200000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += '\nTIMEOUT: the publish script took too long'; }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: `${out}\nCould not start ${PY}: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').reverse().find((l) => l.startsWith('WFP_RESULT '));
      let result = null;
      try { result = line ? JSON.parse(line.slice('WFP_RESULT '.length)) : null; } catch { /* reported below */ }
      resolve({ code, out, result });
    });
  });
}

async function publishPost(postId, ctx = { log: () => {} }) {
  const cfg = await getConfig();
  const post = await prisma.wfpPost.findUnique({ where: { id: postId } });
  if (!post) throw new Error('Post not found');
  if (!['draft', 'failed'].includes(post.status) || !post.html) throw new Error(`This post can not be published (status ${post.status})`);
  const gaps = missing(cfg).filter((m) => ['Website URL', 'FTP login'].includes(m));
  if (gaps.length) throw new Error(`Set up first: ${gaps.join(', ')}`);

  await prisma.wfpPost.update({ where: { id: postId }, data: { status: 'publishing', error: null } });
  const urls = postUrls(cfg, post.slug);
  const date = localParts(new Date()).date;
  const dryRun = process.env.DRY_RUN === 'true';
  const previous = await prisma.wfpPost.findFirst({ where: { slug: post.slug, status: 'published', id: { not: postId } }, orderBy: { publishedAt: 'desc' } });
  const refresh = post.mode === 'refresh' || !!previous;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wfp-'));
  try {
    await fs.writeFile(path.join(work, urls.file), post.html, 'utf8');
    // the article list: every published article (this one included, replacing its older version), newest first
    const others = await prisma.wfpPost.findMany({ where: { status: 'published', slug: { not: post.slug } }, select: { slug: true, title: true, excerpt: true, metaDescription: true, category: true, readTime: true, publishedAt: true, image: true } });
    const card = (p, image) => ({ url: postUrls(cfg, p.slug).path, title: p.title, excerpt: p.excerpt || p.metaDescription || '', category: p.category, readTime: p.readTime, date: localParts(p.publishedAt || new Date()).date, image });
    const cards = renderCards(cfg, [...others.map((p) => card(p, p.image || '')), card({ ...post, publishedAt: new Date() }, refresh ? (previous?.image ?? post.image ?? '') : '__WFP_IMAGE__')]);
    await fs.writeFile(path.join(work, 'cards.html'), cards, 'utf8');
    await fs.writeFile(path.join(work, 'index-template.html'), renderIndex(cfg, cards), 'utf8');
    const args = ['--workdir', work, '--file', urls.file, '--slug', post.slug, '--title', post.title, '--date', date, '--category', post.category || cfg.POST_CATEGORY || 'Fence',
      '--excerpt', post.excerpt || post.metaDescription || post.title, '--readtime', String(post.readTime || 5), '--image', urls.image, '--url-path', urls.path, '--public-url', urls.url,
      '--blog-dir', urls.remoteDir || '', '--blog-index', cfg.BLOG_INDEX_FILE || '', '--cards-file', 'cards.html', '--index-template-file', 'index-template.html',
      '--sitemap-file', cfg.sitemapAuto ? (cfg.SITEMAP_FILE || '') : '', '--fallback-image', cfg.DEFAULT_IMAGE || ''];
    if (refresh) args.push('--keep-image');
    else if (post.imageQuery) args.push('--fetch-image', post.imageQuery);
    if (dryRun) args.push('--dry-run');
    const env = ftpEnv(cfg);
    ctx.log(`Running blog_publish.py${dryRun ? ' (dry run)' : ''}`);
    const { code, out, result } = await runScript(args, env);
    const log = (cfg.FTP_PASS ? out.split(cfg.FTP_PASS).join('***') : out).slice(-8000);
    if (!result?.ok) {
      const error = result?.error || `blog_publish.py exited with ${code}`;
      await prisma.wfpPost.update({ where: { id: postId }, data: { status: 'failed', error, log } });
      throw new Error(error);
    }
    if (dryRun) {
      await prisma.wfpPost.update({ where: { id: postId }, data: { status: 'draft', log, error: 'Dry run: DRY_RUN=true on the server, nothing was uploaded' } });
      return { summary: `Dry run for "${post.title}": nothing uploaded`, detail: { dryRun: true } };
    }
    const now = new Date();
    await prisma.wfpPost.update({ where: { id: postId }, data: { status: 'published', url: urls.url, publishedAt: now, image: refresh ? (previous?.image ?? result.image ?? null) : (result.image ?? null), log, error: result.warnings?.length ? result.warnings.join('; ') : null } });
    if (refresh) await prisma.wfpPost.updateMany({ where: { slug: post.slug, status: 'published', id: { not: postId } }, data: { status: 'replaced' } });
    if (post.keywordId) {
      const k = await prisma.wfpKeyword.findUnique({ where: { id: post.keywordId } });
      if (k) {
        await prisma.wfpKeyword.update({
          where: { id: k.id },
          data: refresh ? { refreshedAt: now, postId, targetUrl: urls.url, refreshAsked: null, refreshReason: null } : { status: LIVE.has(k.status) ? k.status : 'published', statusChangedAt: now, publishedAt: k.publishedAt || now, postId, targetUrl: urls.url, recommended: false },
        });
      }
    }
    let submitted = 'not set up';
    if (cfg.SITEMAP_URL && cfg.GSC_PROPERTY) {
      if (!g.submitAllowed()) submitted = 'skipped (DRY_RUN)';
      else {
        const a = await g.auth(cfg);
        submitted = a.error ? a.error : await g.submitSitemap(a, cfg.GSC_PROPERTY, cfg.SITEMAP_URL).then(() => 'submitted').catch((e) => e.message);
      }
    }
    ctx.log(`Sitemap: ${result.sitemap || 'unchanged'}; Search Console: ${submitted}`);
    return { summary: `Published "${post.title}" (${urls.url})`, detail: { url: urls.url, sitemap: result.sitemap || null, searchConsole: submitted, warnings: result.warnings } };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { publishPost, busyKeywords, runScript, ftpEnv };
