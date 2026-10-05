/**
 * Content pipeline: idea → draft → render (design system) → QA → queue → publish → measure.
 * Deterministic parts live here; the creative parts (what to say, which photo) are the Claude routines'.
 */
const prisma = require('../lib/prismaClient');
const { Prisma } = require('@prisma/client');
const { renderPost, RenderError } = require('./design/renderer');
const { lintContent } = require('./design/qa');
const { LAYOUTS } = require('./design/layouts');
const { saveAsset, resolvePhotos } = require('./vault');
const { recordAction } = require('./social');
const { recordActivity } = require('./ledger');
const { notify } = require('../lib/notify');

const FORMAT_SIZE = { post: 'feed', carousel: 'feed', group_post: 'square', story: 'story', reel_cover: 'story' };
const PILLARS = ['tip', 'proof', 'review', 'faq', 'offer', 'founder', 'story', 'group', 'seasonal'];
const FORMATS = Object.keys(FORMAT_SIZE);
// Advice posts must be researched: their `grounding` has to link the source(s) the facts came from.
const RESEARCHED_PILLARS = ['tip', 'seasonal'];

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const out = (row) => row && ({ ...row, platforms: parse(row.platforms, []) });

/** Slides to render for an item: one for single posts, N for carousels. */
function slidesOf(item) {
  if (item.format === 'carousel') return Array.isArray(item.slots?.slides) ? item.slots.slides : [];
  return item.layout ? [{ layout: item.layout, slots: item.slots || {} }] : [];
}

function lintItem(item) {
  const slides = slidesOf(item);
  const errors = []; const warnings = [];
  if (!slides.length) errors.push('No layout/slots to render.');
  const platform = item.format === 'story' ? 'story' : item.format === 'group_post' ? 'group' : (parse(item.platforms, [])[0] || 'facebook');
  slides.forEach((s, i) => {
    const r = lintContent({ slots: s.slots, layout: s.layout, caption: i === 0 ? item.caption : '', platform });
    r.errors.forEach((e) => errors.push(slides.length > 1 ? `Slide ${i + 1}: ${e}` : e));
    r.warnings.forEach((w) => warnings.push(slides.length > 1 ? `Slide ${i + 1}: ${w}` : w));
  });
  if (item.captionIg) {
    const r = lintContent({ caption: item.captionIg, platform: 'instagram' });
    errors.push(...r.errors.map((e) => `Instagram caption: ${e}`));
  }
  if (item.format === 'carousel' && (slides.length < 3 || slides.length > 10)) errors.push('Carousel needs 3 to 10 slides.');
  if (RESEARCHED_PILLARS.includes(item.pillar) && !/https?:\/\/\S+/.test(item.grounding || '')) {
    errors.push(`A ${item.pillar} post needs research: put the source URL(s) in grounding (extension service, City of Winnipeg, Manitoba government, our own site).`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

async function createContent(userId, c) {
  if (!c?.title) throw Object.assign(new Error('title required'), { code: 'INVALID_CONTENT' });
  const format = FORMATS.includes(c.format) ? c.format : 'post';
  if (c.layout && !LAYOUTS[c.layout]) throw Object.assign(new Error(`unknown layout "${c.layout}"`), { code: 'INVALID_CONTENT' });
  const row = await prisma.contentItem.create({
    data: {
      userId, title: String(c.title).slice(0, 160), pillar: PILLARS.includes(c.pillar) ? c.pillar : null, format, layout: c.layout || null,
      platforms: JSON.stringify(Array.isArray(c.platforms) && c.platforms.length ? c.platforms : ['facebook']),
      slots: c.slots || undefined, caption: String(c.caption || '').slice(0, 5000), captionIg: c.captionIg ? String(c.captionIg).slice(0, 2500) : null,
      groupId: c.groupId || null, grounding: c.grounding ? String(c.grounding).slice(0, 1000) : null, source: c.source || null,
      scheduledFor: c.scheduledFor ? new Date(c.scheduledFor) : null, status: c.status === 'idea' ? 'idea' : 'draft',
    },
  });
  return out(row);
}

/**
 * Render every slide, store PNGs in the vault, run QA, and settle the status. No owner approval: a clean render goes
 * straight to the queue (the owner is told, and can pull it). Anything that fails QA or does not fit goes back to the
 * agent as qa_failed with the reasons.
 */
async function renderContent(userId, id, { photos: photoOverride } = {}) {
  const item = await prisma.contentItem.findFirst({ where: { id, userId } });
  if (!item) throw Object.assign(new Error('content item not found'), { code: 'NOT_FOUND' });
  // a rejected or already-published item must not be revived (or re-queued) by a stray render call
  if (['rejected', 'published', 'failed'].includes(item.status)) throw Object.assign(new Error(`cannot render an item that is ${item.status}`), { code: 'BAD_STATE' });
  const qa = lintItem(item);
  if (!qa.ok) {
    const row = await prisma.contentItem.update({ where: { id }, data: { qa, status: 'qa_failed' } });
    return { item: out(row), qa, rendered: 0 };
  }

  const size = FORMAT_SIZE[item.format] || 'feed';
  const assetIds = [];
  const slides = slidesOf(item);
  for (let i = 0; i < slides.length; i++) {
    const { layout, slots } = slides[i];
    const refs = {};
    const photoSlots = new Set([...(LAYOUTS[layout]?.photos || []), 'photo', 'before', 'after']);
    for (const [k, v] of Object.entries({ ...(slots || {}), ...(photoOverride || {}) })) {
      if (typeof v === 'string' && v.startsWith('vault:')) refs[k] = v;
      else if (photoSlots.has(k) && typeof v === 'string' && v.trim()) throw Object.assign(new Error(`photo "${k}" must be "vault:<assetId>" (got "${v.slice(0, 40)}")`), { code: 'INVALID_PHOTO' });
    }
    const photos = await resolvePhotos(userId, refs);
    const clean = slots || {};   // photo slots keep their "vault:<id>" value so the required-slot check passes; pixels come from `photos`
    // tiles may carry per-tile photo refs: { photo: "vault:id" }
    if (Array.isArray(clean.tiles)) {
      for (let t = 0; t < clean.tiles.length; t++) {
        const ref = clean.tiles[t]?.photo;
        if (typeof ref === 'string' && ref.startsWith('vault:')) Object.assign(photos, await resolvePhotos(userId, { [`tiles.${t}`]: ref }));
      }
    }
    const r = await renderPost({ layout, slots: clean, size, photos });
    if (r.overflow) qa.errors.push(`${slides.length > 1 ? `Slide ${i + 1}: t` : 'T'}ext does not fit the graphic (runs off the edge or into the footer). Shorten the copy.`);
    const { asset } = await saveAsset(userId, { kind: 'graphic', name: `${item.title}-${i + 1}.png`, buffer: r.png, tags: [layout.replace('Post', '').toUpperCase()], source: 'render', contentItemId: id });
    assetIds.push(asset.id);
  }

  qa.ok = qa.errors.length === 0;
  // An already-approved (legacy) item stays approved after a re-render.
  const status = !qa.ok ? 'qa_failed' : item.status === 'approved' ? 'approved' : 'queued';
  const row = await prisma.contentItem.update({ where: { id }, data: { assetIds, qa, status } });
  await recordActivity(userId, { agent: 'design', action: 'rendered graphic', summary: `${item.title} (${slides.length} slide${slides.length > 1 ? 's' : ''})`, result: qa.ok ? 'ok' : 'qa_failed', source: 'design-system', runId: null });
  if (status === 'queued' && item.status !== 'queued') {
    const where = parse(item.platforms, []).join(' + ') || 'facebook';
    await notify(userId, { category: 'content', title: `Queued to post: ${item.title}`, body: `${where}. ${item.caption}`.slice(0, 600), link: '/ai.html#content' });
  }
  return { item: out(row), qa, rendered: assetIds.length };
}

const STATE_GUARD = {
  approve: ['rendered', 'queued', 'qa_failed', 'draft'],
  reject: ['draft', 'rendered', 'queued', 'qa_failed', 'approved'],
};

async function transition(userId, id, action, extra = {}) {
  const item = await prisma.contentItem.findFirst({ where: { id, userId } });
  if (!item) throw Object.assign(new Error('content item not found'), { code: 'NOT_FOUND' });
  if (!STATE_GUARD[action].includes(item.status)) throw Object.assign(new Error(`cannot ${action} an item that is ${item.status}`), { code: 'BAD_STATE' });
  if (action === 'approve') {
    if (!item.assetIds || !item.assetIds.length) throw Object.assign(new Error('render the graphic before approving'), { code: 'BAD_STATE' });
    return out(await prisma.contentItem.update({ where: { id }, data: { status: 'approved', approvedAt: new Date(), scheduledFor: extra.scheduledFor ? new Date(extra.scheduledFor) : item.scheduledFor, note: null } }));
  }
  return out(await prisma.contentItem.update({ where: { id }, data: { status: 'rejected', note: String(extra.note || '').slice(0, 500) || null } }));
}

/** Posts ready to go out now on `platform`: QA-passed 'queued' items (and legacy approved ones). Autopilot off = the owner paused posting. */
async function publishQueue(userId, { platform, autopilot, limit = 10 } = {}) {
  const statuses = autopilot ? ['approved', 'queued'] : ['approved'];
  const where = { userId, status: { in: statuses }, OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date() } }] };
  if (platform) where.platforms = { contains: `"${platform}"` };
  const rows = await prisma.contentItem.findMany({ where, orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }], take: 60 });
  // an item with a caption for Facebook AND Instagram stays in the queue for a platform until it was posted THERE
  return rows.map(out).filter((r) => !platform || !(r.publishedOn || {})[platform]).slice(0, Math.min(limit, 30));
}

/**
 * Record that `platform` published the item. The item only becomes 'published' once every platform it targets has
 * posted. The daily cap is checked FIRST (recordAction throws CapError) so a capped post is never marked live.
 */
async function markPublished(userId, id, { platform, postUrl, groupId }) {
  const item = await prisma.contentItem.findFirst({ where: { id, userId } });
  if (!item) throw Object.assign(new Error('content item not found'), { code: 'NOT_FOUND' });
  if (!['approved', 'queued'].includes(item.status)) throw Object.assign(new Error(`item is ${item.status}, not publishable`), { code: 'BAD_STATE' });
  const platforms = parse(item.platforms, []);
  const target = platform || platforms[0] || 'facebook';
  const done = { ...(item.publishedOn || {}) };
  if (done[target]) throw Object.assign(new Error(`already published on ${target}`), { code: 'BAD_STATE' });

  const kind = item.format === 'story' ? 'story' : item.format === 'group_post' || groupId ? 'group_post' : 'page_post';
  const apiPlatform = target === 'instagram' ? 'instagram' : 'facebook';   // groups live on Facebook
  await recordAction(userId, { platform: apiPlatform, kind, contentItemId: id, groupId: groupId || item.groupId, target: postUrl, summary: item.title, url: postUrl });

  done[target] = { postUrl: postUrl || null, at: new Date().toISOString() };
  const targets = platforms.filter((p) => p !== 'group');
  const allDone = (targets.length ? targets : [target]).every((p) => done[p]);
  return out(await prisma.contentItem.update({
    where: { id },
    data: { publishedOn: done, postUrl: item.postUrl || postUrl || null, ...(allDone ? { status: 'published', publishedAt: new Date() } : {}) },
  }));
}

async function recordMetrics(userId, id, metrics) {
  const r = await prisma.contentItem.updateMany({ where: { id, userId }, data: { metrics: { ...metrics, capturedAt: new Date().toISOString() } } });
  return r.count > 0;
}

/** What has worked: published items grouped by pillar/layout with average engagement — input for the Content Director. */
async function performanceSummary(userId, { days = 60 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await prisma.contentItem.findMany({ where: { userId, status: 'published', publishedAt: { gte: since } }, select: { pillar: true, layout: true, title: true, metrics: true, platforms: true } });
  const agg = {};
  for (const r of rows) {
    const m = r.metrics || {};
    const score = (m.reactions || 0) + 2 * (m.comments || 0) + 3 * (m.shares || 0) + 5 * (m.leads || 0);
    for (const key of [`pillar:${r.pillar || 'none'}`, `layout:${r.layout || 'none'}`]) {
      const a = (agg[key] ||= { n: 0, score: 0, measured: 0 });
      a.n++; if (r.metrics) { a.measured++; a.score += score; }
    }
  }
  return Object.entries(agg).map(([k, a]) => ({ key: k, posts: a.n, measured: a.measured, avgScore: a.measured ? +(a.score / a.measured).toFixed(1) : null })).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));
}

module.exports = { createContent, renderContent, transition, publishQueue, markPublished, recordMetrics, performanceSummary, lintItem, FORMATS, PILLARS, RenderError };
