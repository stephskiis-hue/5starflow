/**
 * The writer routine's work: one assignment at a time, like No-Bs's /api/ai/seo/assignment.
 *   getAssignment  the next piece (plan.nextPiece) with a frozen brief, reserved for HOLD_HOURS so two runs never write
 *                  the same thing; null when autopilot is off, the week's posts are done or nothing is planned
 *   submitPost     checks the finished post (wfp/check.js), renders it and publishes it (or keeps it as a draft in
 *                  review mode). A 422 lists every problem and nothing is uploaded.
 *   skipAssignment the routine could not write it honestly
 */
const cheerio = require('cheerio');
const prisma = require('../lib/prismaClient');
const { getConfig, missing } = require('./settings');
const kw = require('./keywords');
const { nextPiece, localParts, LIVE } = require('./plan');
const { postUrls, serviceByName, absUrl, renderPost } = require('./template');
const { sitePages } = require('./sitepages');
const { busyKeywords, publishPost } = require('./publisher');
const { checkPost, normPath, RULES } = require('./check');
const { runJob, note } = require('./runner');

const HOLD_HOURS = 6;
const DAY = 86400000;
const WORDS = { new: { min: 900, max: 1500 }, support: { min: 700, max: 1200 }, refresh: { min: 900, max: 1600 } };
const httpError = (status, message, details) => Object.assign(new Error(message), { status, details });

/** Posts the writer handed in during the last 7 days (moved WordPress posts do not count). */
const postsThisWeek = (now) => prisma.wfpPost.count({ where: { createdAt: { gte: new Date(now.getTime() - 7 * DAY) }, mode: { not: 'import' }, status: { in: ['published', 'draft', 'publishing', 'replaced'] } } });

/** The editable body of a published post (the default template keeps it in .content). */
function bodyOf(html) {
  const $ = cheerio.load(html || '');
  const el = $('.content').first().length ? $('.content').first() : $('article').first();
  return (el.html() || '').trim();
}

async function uniqueSlug(cfg, keyword, pages) {
  const base = kw.slugify(keyword);
  const taken = new Set((await prisma.wfpPost.findMany({ where: { status: { in: ['published', 'draft', 'publishing'] } }, select: { slug: true } })).map((p) => p.slug));
  const live = new Set(pages.map((u) => { try { return new URL(u).pathname.replace(/\.html$/, '').split('/').filter(Boolean).pop() || ''; } catch { return ''; } }));
  let slug = base;
  for (let i = 2; taken.has(slug) || live.has(slug); i += 1) slug = `${base}-${i}`;
  return slug;
}

/** Every path a post may link to on the site. */
async function allowedPaths(cfg, pages) {
  const paths = new Set(['/', normPath(postUrls(cfg, 'x').blogUrl.replace(cfg.SITE_URL, '') || '/')]);
  for (const u of pages) { try { paths.add(normPath(new URL(u).pathname)); } catch { /* skip */ } }
  for (const p of await prisma.wfpPost.findMany({ where: { status: 'published' }, select: { slug: true } })) paths.add(normPath(postUrls(cfg, p.slug).path));
  for (const s of cfg.services) if (s.path && !/^https?:/.test(s.path)) paths.add(normPath(s.path));
  for (const n of cfg.navLinks || []) if (!/^https?:/.test(n.path)) paths.add(normPath(n.path.split('#')[0]));
  try { paths.add(normPath(new URL(cfg.QUOTE_URL).pathname)); } catch { /* skip */ }
  return paths;
}

async function buildBrief(cfg, piece, keywords) {
  const k = piece.keyword;
  const svc = serviceByName(cfg, k.service);
  const servicePage = svc?.path ? absUrl(cfg, svc.path) : null;
  const pages = await sitePages(cfg, 400);
  const existing = piece.mode === 'refresh' ? await prisma.wfpPost.findFirst({ where: { keywordId: k.id, status: 'published' }, orderBy: { publishedAt: 'desc' } }) : null;
  const slug = existing?.slug || await uniqueSlug(cfg, k.keyword, pages);
  const tokens = k.matchKey.split(' ').filter(Boolean);
  const queries = (await prisma.wfpQuery.findMany({ orderBy: { impressions: 'desc' }, take: 2000 }))
    .filter((q) => { const m = ` ${kw.matchKey(q.query)} `; return tokens.every((t) => m.includes(` ${t} `)); })
    .slice(0, 15).map((q) => ({ query: q.query, impressions: q.impressions, position: q.position, page: q.page }));
  const articles = await prisma.wfpPost.findMany({ where: { status: 'published', slug: { not: slug } }, orderBy: { publishedAt: 'desc' }, take: 80, select: { title: true, url: true, category: true } });
  const required = [];
  if (servicePage) required.push({ url: servicePage, why: `the ${svc.name} service page` });
  if (cfg.QUOTE_URL) required.push({ url: cfg.QUOTE_URL, why: 'the free estimate (call to action)' });
  if (piece.mode === 'support' && piece.focus?.targetUrl) required.push({ url: piece.focus.targetUrl, why: `the focus article for "${piece.focus.keyword}": link it once in the first half`, anchorHint: piece.focus.keyword });
  const avoid = keywords.filter((x) => x.id !== k.id && LIVE.has(x.status) && x.targetUrl && (!k.service || x.service === k.service)).slice(0, 15).map((x) => ({ keyword: x.keyword, url: x.targetUrl }));
  const instructions = await prisma.wfpNote.findMany({ where: { kind: 'instruction', done: false }, orderBy: { createdAt: 'asc' }, take: 10 });
  const learnings = await prisma.wfpNote.findMany({ where: { kind: 'learning', done: false }, orderBy: { createdAt: 'desc' }, take: 20 });
  return {
    mode: piece.mode, keyword: k.keyword, keywordId: k.id, intent: k.intent, contentType: kw.contentTypeFor(k.keyword), why: piece.why,
    service: k.service || cfg.POST_CATEGORY, servicePage, slug, url: postUrls(cfg, slug).url, wordCount: WORDS[piece.mode] || WORDS.new,
    queries, peopleAlsoAsk: k.signals?.paa || [], related: k.signals?.related || [], competitors: k.serpTop || [],
    requiredLinks: required, avoid,
    linkTargets: { articles, sitePages: pages.slice(0, 150) },
    focus: piece.focus ? { id: piece.focus.id, keyword: piece.focus.keyword, goal: piece.focus.focusGoal, url: piece.focus.targetUrl || null, role: piece.mode === 'support' ? 'supporting' : 'main' } : null,
    refresh: piece.mode === 'refresh' ? { reason: k.refreshReason || piece.why, position28: k.position28, impressions28: k.impressions28, clicks28: k.clicks28 } : null,
    existing: existing ? { title: existing.title, metaDescription: existing.metaDescription, excerpt: existing.excerpt, url: existing.url, bodyHtml: bodyOf(existing.html) } : null,
    business: { name: cfg.BUSINESS_NAME, site: cfg.SITE_URL, city: cfg.CITY, region: cfg.REGION, phone: cfg.PHONE || null, quoteUrl: cfg.QUOTE_URL, services: cfg.services.map((s) => ({ name: s.name, page: s.path ? absUrl(cfg, s.path) : null })), areas: cfg.areas },
    notes: { owner: cfg.WRITER_NOTES || '', instructions: instructions.map((n) => `${n.title ? `${n.title}: ` : ''}${n.body}`), learnings: learnings.map((n) => `${n.title ? `${n.title}: ` : ''}${n.body}`) },
    rules: RULES,
  };
}

async function getAssignment({ now = new Date() } = {}) {
  const cfg = await getConfig();
  await prisma.wfpAssignment.updateMany({ where: { status: 'reserved', expiresAt: { lte: now } }, data: { status: 'expired' } });
  const open = await prisma.wfpAssignment.findFirst({ where: { status: 'reserved', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' } });
  if (open) return { assignment: { assignmentId: open.id, ...open.brief }, resumed: true };
  if (!cfg.autopilot) return { assignment: null, reason: 'Autopilot is off (Settings tab)' };
  const gaps = missing(cfg).filter((m) => ['Website URL', 'FTP login'].includes(m));
  if (gaps.length) return { assignment: null, reason: `Set up first: ${gaps.join(', ')}` };
  const week = await postsThisWeek(now);
  if (week >= cfg.postsPerWeek) return { assignment: null, reason: `${week} posts in the last 7 days (max ${cfg.postsPerWeek})` };
  const keywords = await prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } } });
  const piece = nextPiece(keywords, { busy: await busyKeywords(now), now });
  if (!piece) return { assignment: null, reason: 'Nothing planned: run the keyword research or add keywords' };
  const brief = await buildBrief(cfg, piece, keywords);
  const row = await prisma.wfpAssignment.create({ data: { keywordId: piece.keyword.id, keyword: piece.keyword.keyword, mode: piece.mode, brief, expiresAt: new Date(now.getTime() + HOLD_HOURS * 3600000) } });
  return { assignment: { assignmentId: row.id, ...brief } };
}

async function skipAssignment(id, reason) {
  const a = await prisma.wfpAssignment.findUnique({ where: { id } });
  if (!a) throw httpError(404, 'Assignment not found');
  if (a.status !== 'reserved') throw httpError(409, `Assignment is ${a.status}`);
  await prisma.wfpAssignment.update({ where: { id }, data: { status: 'skipped', skipReason: String(reason || '').slice(0, 1000) } });
  const k = await prisma.wfpKeyword.findUnique({ where: { id: a.keywordId } });
  // a skipped plain keyword leaves the queue (back to idea) so the next run gets something else; focus pieces stay
  if (k && !k.focus && !k.supportsId && k.status === 'planned') await prisma.wfpKeyword.update({ where: { id: k.id }, data: { status: 'idea', statusChangedAt: new Date(), notes: `${k.notes ? `${k.notes}\n` : ''}Skipped by the writer: ${reason || 'no reason'}`.slice(0, 2000) } });
  await note('claude', 'note', `Writer skipped "${a.keyword}"`, reason || 'No reason given');
  return { ok: true };
}

/** The routine hands in a finished post. Returns { status, url, postId } or throws 4xx with details.errors. */
async function submitPost(id, body) {
  const a = await prisma.wfpAssignment.findUnique({ where: { id } });
  if (!a) throw httpError(404, 'Assignment not found');
  if (a.status !== 'reserved' && a.status !== 'expired') throw httpError(409, `This assignment was already ${a.status}`);
  const cfg = await getConfig();
  const brief = a.brief;
  const pages = await sitePages(cfg, 2000);
  const errors = checkPost(body || {}, brief, { origin: cfg.SITE_URL, allowedPaths: await allowedPaths(cfg, pages) });
  if (errors.length) throw httpError(422, `${errors.length} problem${errors.length > 1 ? 's' : ''}: fix them all and send it again (nothing was uploaded)`, { errors });

  const date = localParts(new Date()).date;
  const words = cheerio.load(`<div>${body.bodyHtml}</div>`).text().split(/\s+/).filter(Boolean).length;
  const post = { slug: brief.slug, title: body.title.trim(), metaDescription: body.metaDescription.trim(), excerpt: String(body.excerpt || body.metaDescription).trim(), category: brief.service || cfg.POST_CATEGORY || 'Fence',
    readTime: Math.max(2, Math.round(words / 220)), bodyHtml: body.bodyHtml, faq: body.faq, imageAlt: body.imageAlt || body.title };
  const { html, urls } = renderPost(cfg, post, date);
  const sources = body.sources.map((s) => (typeof s === 'string' ? { url: s } : { url: s.url, title: s.title }));
  const row = await prisma.wfpPost.create({ data: { keywordId: a.keywordId, keyword: a.keyword, mode: a.mode, slug: post.slug, title: post.title, metaDescription: post.metaDescription, excerpt: post.excerpt, category: post.category, readTime: post.readTime, imageQuery: body.imageQuery || null, html, sources, faq: body.faq, status: 'draft', url: urls.url, log: `${a.mode}: ${brief.why}` } });
  await prisma.wfpAssignment.update({ where: { id }, data: { status: 'submitted', postId: row.id } });
  if (cfg.publishMode === 'review') {
    await note('system', 'note', 'A post is waiting for review', `"${post.title}" (${a.keyword}) is written. Open the Posts tab to read it and press Publish.`);
    return { status: 'draft', postId: row.id, url: urls.url, message: 'Saved for review: the owner publishes it from the page' };
  }
  const r = await runJob('publish', (ctx) => publishPost(row.id, ctx), { trigger: 'claude' });
  if (!r.ok) throw httpError(502, `Checked and saved, but the upload failed: ${r.error}. The owner can retry from the Posts tab.`, { postId: row.id });
  return { status: r.result?.detail?.dryRun ? 'dry_run' : 'published', postId: row.id, url: urls.url, detail: r.result?.detail };
}

module.exports = { getAssignment, skipAssignment, submitPost, buildBrief, allowedPaths, bodyOf, postsThisWeek, HOLD_HOURS };
