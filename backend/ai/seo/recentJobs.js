/**
 * "Recent jobs" sections for the service and neighbourhood pages. Every paid Jobber invoice is reduced to
 * { service, neighbourhood, month }: no client name, street or house number is ever stored or published.
 *   recordInvoice(userId, id)   called when an invoice is paid (reviewRequester) - never throws
 *   backfill(userId, opts)      paced, resumable walk through older invoices (cursor kept in growthState)
 *   feed(userId)                what the nightly site build (seo_site.py) renders, one entry per page path
 * Photos are only ever real ones from the Content Vault (quality 3+, not private), matched by service tag.
 */
const prisma = require('../../lib/prismaClient');
const { CLUSTERS, FSA_AREAS, SERVICE_TAGS, clusterById } = require('./config');
const kw = require('./keywords');
const g = require('./google');

const DAY = 86400000;
const KEEP_DAYS = 400;
const MAX_JOBS_PER_PAGE = 6;
const MAX_PHOTOS_PER_PAGE = 3;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const FACTS = `
  id invoiceStatus issuedDate
  billingAddress { postalCode }
  lineItems(first: 15) { nodes { name } }`;
const ONE = `query SiteJobFacts($invoiceId: EncodedId!) { invoice(id: $invoiceId) { ${FACTS} } }`;
const PAGE = `query SiteJobPage($cursor: String) { invoices(first: 20, after: $cursor) { nodes { ${FACTS} } pageInfo { hasNextPage endCursor } } }`;

/** 'r2h 0a1' / 'R2H0A1' -> 'R2H'; anything that is not a Canadian postal code -> null. */
function fsaOf(postal) {
  const m = String(postal || '').toUpperCase().replace(/\s+/g, '').match(/^([ABCEGHJ-NPRSTVXY]\d[A-Z])\d[A-Z]\d$/);
  return m ? m[1] : null;
}

/** The service a set of invoice line items belongs to: the first line item that names one of our services. */
function clusterOfItems(names) {
  for (const n of names || []) {
    const c = kw.clusterFor(n);
    if (c !== 'other' && c !== 'brand') return c;
  }
  return null;
}

/** Fact row from a Jobber invoice node, or null when it does not count (unpaid, no service, too old). */
function factsFromInvoice(inv, now = new Date()) {
  if (!inv || String(inv.invoiceStatus || '').toLowerCase() !== 'paid') return null;
  const doneAt = inv.issuedDate ? new Date(inv.issuedDate) : null;
  if (!doneAt || Number.isNaN(doneAt.getTime()) || now - doneAt > KEEP_DAYS * DAY) return null;
  const cluster = clusterOfItems((inv.lineItems?.nodes || []).map((n) => n.name));
  if (!cluster) return null;
  const fsa = fsaOf(inv.billingAddress?.postalCode);
  return { invoiceId: inv.id, cluster, fsa, area: fsa ? FSA_AREAS[fsa] || null : null, doneAt };
}

const monthLabel = (d) => `${MONTHS[new Date(d).getUTCMonth()]} ${new Date(d).getUTCFullYear()}`;

async function save(userId, facts) {
  try { await prisma.siteJob.create({ data: { userId, ...facts } }); return true; } catch (e) { if (e.code === 'P2002') return false; throw e; }
}

/** One paid invoice -> a SiteJob row. Its own query, so a wrong field name can never break the review flow. */
async function recordInvoice(userId, invoiceId) {
  try {
    const { jobberGraphQL } = require('../../services/jobberClient');
    const res = await jobberGraphQL(ONE, { invoiceId }, userId);
    const facts = factsFromInvoice(res?.invoice);
    return facts ? await save(userId, facts) : false;
  } catch (e) { console.warn('[recentJobs] could not record invoice', invoiceId, e.message); return false; }
}

/**
 * Walk the invoice list a few pages per call and keep the paid ones with a service we sell. Resumes from the saved
 * cursor, stops at the first throttle and does nothing once the whole list was seen.
 */
async function backfill(userId, { maxPages = 25, pauseMs = 1200 } = {}) {
  const seo = await g.loadSeo(userId);
  const st = seo.state.jobsBackfill || {};
  if (st.done) return { done: true, pages: 0, added: 0 };
  const { jobberGraphQL } = require('../../services/jobberClient');
  let cursor = st.cursor || null; let pages = 0; let added = 0; let done = false; let note = null;
  while (pages < maxPages) {
    let res;
    try { res = await jobberGraphQL(PAGE, { cursor }, userId); } catch (e) { note = /throttl|429/i.test(e.message) ? 'Jobber throttled; will resume next run' : e.message; break; }
    pages++;
    for (const inv of res?.invoices?.nodes || []) { const f = factsFromInvoice(inv); if (f && await save(userId, f)) added++; }
    const info = res?.invoices?.pageInfo;
    if (!info?.hasNextPage) { done = true; break; }
    cursor = info.endCursor;
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  await g.saveState(seo.row.id, { jobsBackfill: { cursor, done, at: new Date().toISOString() } });
  return { done, pages, added, note };
}

/** Which vault tags suit a service, as a photo-picking helper. */
const tagsFor = (cluster) => SERVICE_TAGS[cluster] || [];

/**
 * Pure: turn jobs + pages + photos into one entry per page path.
 *   jobs     [{ cluster, area, doneAt }]            pages     [{ path, kind: 'service'|'area', clusters?, area? }]
 *   photos   [{ id, tags: [..], width, height }]
 */
function buildFeed({ jobs, pages, photos, now = new Date() }) {
  const used = new Set();
  const seasonStart = new Date(now.getTime() - 120 * DAY);
  const entries = [];
  for (const p of pages) {
    const mine = jobs.filter((j) => (p.kind === 'area' ? j.area === p.area : p.clusters.includes(j.cluster)))
      .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt));
    if (!mine.length) continue;
    const seen = new Set();
    const list = [];
    for (const j of mine) {
      const label = `${clusterById(j.cluster)?.label || j.cluster}${j.area && p.kind !== 'area' ? ` in ${j.area}` : ''}`;
      const key = `${label}|${monthLabel(j.doneAt)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ service: clusterById(j.cluster)?.label || j.cluster, area: j.area || null, month: monthLabel(j.doneAt), label });
      if (list.length >= MAX_JOBS_PER_PAGE) break;
    }
    const wanted = new Set(p.kind === 'area' ? mine.flatMap((j) => tagsFor(j.cluster)) : p.clusters.flatMap(tagsFor));
    const pool = photos.filter((ph) => ph.tags.some((t) => wanted.has(t)));
    const fresh = pool.filter((ph) => !used.has(ph.id));
    const chosen = (fresh.length >= MAX_PHOTOS_PER_PAGE ? fresh : [...fresh, ...pool.filter((ph) => used.has(ph.id))]).slice(0, MAX_PHOTOS_PER_PAGE);
    chosen.forEach((ph) => used.add(ph.id));
    const place = p.kind === 'area' ? p.area : 'Winnipeg';
    const what = p.kind === 'service' && p.clusters.length === 1 ? (clusterById(p.clusters[0])?.label || 'yard').toLowerCase() : 'yard';
    entries.push({
      path: p.path, kind: p.kind, area: p.area || null, services: p.clusters || null,
      heading: p.kind === 'area' ? `Recent jobs in ${p.area}` : 'Recent jobs',
      count: mine.filter((j) => new Date(j.doneAt) >= seasonStart).length, jobs: list,
      photos: chosen.map((ph) => ({ id: ph.id, width: ph.width || null, height: ph.height || null, alt: `Our ${what} work in ${place}` })),
    });
  }
  return entries;
}

/** Pages that get a section: each service page (all services that share it) and each neighbourhood page. */
async function pageTargets(userId, seo) {
  const { pillarsFor } = require('./roadmap');
  const pages = await prisma.seoPage.findMany({ where: { userId } });
  const pillars = pillarsFor(seo.state, Object.fromEntries(pages.map((p) => [p.path, p])));
  const byPath = {};
  for (const c of CLUSTERS) if (pillars[c.id]) (byPath[pillars[c.id]] ||= { path: pillars[c.id], kind: 'service', clusters: [] }).clusters.push(c.id);
  const out = Object.values(byPath);
  const areaKw = await prisma.seoKeyword.findMany({ where: { userId, kind: 'area', targetPath: { not: null }, area: { not: null }, status: { not: 'retired' } }, select: { targetPath: true, area: true } });
  const seen = new Set(out.map((o) => o.path));
  for (const k of areaKw) if (!seen.has(k.targetPath)) { seen.add(k.targetPath); out.push({ path: k.targetPath, kind: 'area', area: k.area }); }
  return out;
}

/** Real, curated, non-private photos: id + tags only (never the bytes). */
async function vaultPhotos(userId) {
  const rows = await prisma.contentAsset.findMany({ where: { userId, kind: 'photo', private: false, quality: { gte: 3 } }, orderBy: { createdAt: 'desc' }, take: 300,
    select: { id: true, tags: true, width: true, height: true } });
  return rows.map((r) => ({ id: r.id, width: r.width, height: r.height, tags: (() => { try { return JSON.parse(r.tags || '[]'); } catch { return []; } })() }));
}

async function feed(userId, { now = new Date() } = {}) {
  const seo = await g.loadSeo(userId);
  const [jobs, targets, photos] = await Promise.all([
    prisma.siteJob.findMany({ where: { userId, doneAt: { gte: new Date(now.getTime() - KEEP_DAYS * DAY) } }, orderBy: { doneAt: 'desc' }, select: { cluster: true, area: true, doneAt: true } }),
    pageTargets(userId, seo), vaultPhotos(userId),
  ]);
  return { enabled: !!seo.cfg.recentJobs, jobsTotal: jobs.length, backfill: seo.state.jobsBackfill || null, pages: buildFeed({ jobs, pages: targets, photos, now }) };
}

module.exports = { fsaOf, clusterOfItems, factsFromInvoice, buildFeed, recordInvoice, backfill, feed, monthLabel, tagsFor };
