/**
 * Write + publish for Winnipeg Fence Pros.
 *   writeTick   picks the next piece (plan.nextPiece, or the keyword the page asked for), has Claude write it,
 *               renders it with the template and stores a WfpPost; in auto mode publishes it straight away
 *   publishPost runs wfp/blog_publish.py (FTP upload, blog index, sitemap), then resubmits the sitemap to Search
 *               Console and moves the keyword to published
 * DRY_RUN=true on the server runs the script with --dry-run: nothing is uploaded.
 */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const prisma = require('../lib/prismaClient');
const { getConfig, missing } = require('./settings');
const { nextPiece, LIVE, localParts } = require('./plan');
const { writePost } = require('./writer');
const { renderPost, postUrls } = require('./template');
const g = require('./google');
const { note } = require('./runner');

const SCRIPT = path.join(__dirname, 'blog_publish.py');
const PY = process.env.PYTHON_BIN || 'python3';
const DAY = 86400000;

/** Keywords that already have a post being written or waiting for review. */
async function busyKeywords() {
  const rows = await prisma.wfpPost.findMany({ where: { status: { in: ['writing', 'draft', 'publishing'] } }, select: { keywordId: true } });
  return new Set(rows.map((r) => r.keywordId).filter(Boolean));
}

/** Is it time for the autopilot to write? { due, why } */
async function autopilotDue(cfg, now = new Date()) {
  if (!cfg.autopilot) return { due: false, why: 'Autopilot is off' };
  const p = localParts(now);
  if (!cfg.postDays.includes(p.day)) return { due: false, why: `Not a post day (${cfg.postDays.join(', ')})` };
  if (p.hour < cfg.postHour) return { due: false, why: `Posting starts at ${cfg.postHour}:00` };
  const today = await prisma.wfpPost.count({ where: { createdAt: { gte: new Date(now.getTime() - 20 * 3600000) }, mode: { not: 'manual' } } });
  if (today) return { due: false, why: 'Already wrote today' };
  const week = await prisma.wfpPost.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY) }, status: { not: 'failed' } } });
  if (week >= cfg.postsPerWeek) return { due: false, why: `${week} posts in the last 7 days (max ${cfg.postsPerWeek})` };
  return { due: true };
}

/**
 * opts.keywordId: write for this keyword now (the page's "Write now"); otherwise the autopilot's next piece.
 * opts.force: skip the schedule check (manual run).
 */
async function writeTick(ctx, opts = {}) {
  const cfg = await getConfig();
  const gaps = missing(cfg).filter((m) => ['Website URL', 'FTP login', 'Anthropic API key'].includes(m));
  if (!opts.keywordId && !opts.force) {
    const due = await autopilotDue(cfg);
    if (!due.due) return { skipped: true, summary: due.why };
  }
  if (gaps.length) throw new Error(`Set up first: ${gaps.join(', ')}`);

  const keywords = await prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } } });
  const busy = await busyKeywords();
  let piece;
  if (opts.keywordId) {
    const k = keywords.find((x) => x.id === opts.keywordId);
    if (!k) throw new Error('Keyword not found');
    if (busy.has(k.id)) throw new Error('A post for this keyword is already being written or waiting for review');
    const focus = k.supportsId ? keywords.find((x) => x.id === k.supportsId) : k.focus ? k : null;
    piece = { mode: LIVE.has(k.status) ? 'refresh' : k.supportsId ? 'support' : 'new', keyword: k, focus, why: 'Asked for on the page' };
  } else {
    piece = nextPiece(keywords, { busy });
    if (!piece) return { skipped: !opts.force, summary: 'Nothing planned: run the keyword research or add keywords' };
  }
  ctx.log(`${piece.mode}: "${piece.keyword.keyword}" (${piece.why})`);

  let existing = null;
  if (piece.mode === 'refresh') {
    existing = await prisma.wfpPost.findFirst({ where: { keywordId: piece.keyword.id, status: 'published' }, orderBy: { publishedAt: 'desc' } });
    if (!existing) piece.mode = 'new';
  }
  const date = localParts(new Date()).date;
  const row = await prisma.wfpPost.create({ data: { keywordId: piece.keyword.id, keyword: piece.keyword.keyword, mode: opts.keywordId ? 'manual' : piece.mode, slug: existing?.slug || 'writing', title: `Writing: ${piece.keyword.keyword}`, html: '', status: 'writing' } });
  try {
    const post = await writePost(cfg, piece, { log: ctx.log, existing });
    const { html, urls } = renderPost(cfg, post, date);
    await prisma.wfpPost.update({
      where: { id: row.id },
      data: { slug: post.slug, title: post.title, metaDescription: post.metaDescription, excerpt: post.excerpt, category: post.category || cfg.POST_CATEGORY, readTime: post.readTime, imageQuery: post.imageQuery, html, sources: post.sources, url: urls.url, status: 'draft', log: `${piece.mode}: ${piece.why}` },
    });
  } catch (err) {
    await prisma.wfpPost.update({ where: { id: row.id }, data: { status: 'failed', error: String(err.message).slice(0, 2000), title: `Failed: ${piece.keyword.keyword}` } });
    throw err;
  }
  if (cfg.publishMode === 'review') {
    await note('system', 'note', 'A post is waiting for review', `"${piece.keyword.keyword}" is written. Open the Posts tab to read it and press Publish.`);
    return { summary: `Draft ready for review: ${piece.keyword.keyword}`, detail: { postId: row.id } };
  }
  const pub = await publishPost(row.id, ctx);
  return { summary: pub.summary, detail: { postId: row.id, ...pub.detail } };
}

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
  const refresh = post.mode === 'refresh' || (await prisma.wfpPost.count({ where: { slug: post.slug, status: 'published', id: { not: postId } } })) > 0;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'wfp-'));
  try {
    await fs.writeFile(path.join(work, urls.file), post.html, 'utf8');
    const args = ['--workdir', work, '--file', urls.file, '--slug', post.slug, '--title', post.title, '--date', date, '--category', post.category || cfg.POST_CATEGORY || 'Fencing',
      '--excerpt', post.excerpt || post.metaDescription || post.title, '--readtime', String(post.readTime || 5), '--image', urls.image, '--url-path', urls.path, '--public-url', urls.url,
      '--blog-dir', cfg.BLOG_DIR || '', '--blog-index', cfg.BLOG_INDEX_FILE || '', '--sitemap-file', cfg.sitemapAuto ? (cfg.SITEMAP_FILE || '') : '', '--fallback-image', cfg.DEFAULT_IMAGE || ''];
    if (refresh) args.push('--keep-image');
    else if (post.imageQuery) args.push('--fetch-image', post.imageQuery);
    if (dryRun) args.push('--dry-run');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONIOENCODING: 'utf-8', FTP_HOST: cfg.FTP_HOST, FTP_PORT: String(cfg.ftpPort), FTP_USER: cfg.FTP_USER, FTP_PASS: cfg.FTP_PASS,
      FTP_PATH: cfg.FTP_PATH || '/', FTP_SECURE: String(cfg.ftpSecure), PEXELS_API_KEY: cfg.PEXELS_API_KEY || '' };
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
    await prisma.wfpPost.update({ where: { id: postId }, data: { status: 'published', url: urls.url, publishedAt: now, log, error: result.warnings?.length ? result.warnings.join('; ') : null } });
    if (refresh) await prisma.wfpPost.updateMany({ where: { slug: post.slug, status: 'published', id: { not: postId } }, data: { status: 'replaced' } });
    if (post.keywordId) {
      const k = await prisma.wfpKeyword.findUnique({ where: { id: post.keywordId } });
      if (k) {
        await prisma.wfpKeyword.update({
          where: { id: k.id },
          data: refresh ? { refreshedAt: now, postId, targetUrl: urls.url } : { status: LIVE.has(k.status) ? k.status : 'published', statusChangedAt: now, publishedAt: k.publishedAt || now, postId, targetUrl: urls.url, recommended: false },
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

module.exports = { writeTick, publishPost, autopilotDue, busyKeywords, runScript };
