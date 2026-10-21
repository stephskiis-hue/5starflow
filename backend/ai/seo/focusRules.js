/**
 * Focus campaign rules that need no database or network, so the picker, the dashboard and the tests share them.
 * A focus campaign = one keyword the owner wants to win, plus the supporting posts, links, refreshes and social
 * posts 5StarFlow plans around it. focus.js does the database side.
 */
const { clusterById, isOffTopic } = require('./config');
const kw = require('./keywords');

const DAY = 86400000;
const OPEN_STEP = ['planned', 'queued', 'in_progress'];
const MAX_SUPPORT_TOTAL = 12;

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const live = (p) => !!p && (p.httpStatus || 200) === 200 && !p.redirectTo;

/** Where Google puts the keyword now: Search Console once it has 10+ impressions, else the Serper check. */
const currentPosition = (k) => (k.impressions28 >= 10 && k.position28) || k.serpPosition || null;
const pointPosition = (h) => (h && ((h.imp >= 10 && h.pos) || h.serp)) || null;

/** 0 to 100: how far the keyword has travelled from where the campaign started to the goal. */
function progressToGoal(start, now, goal) {
  if (!now) return 0;
  if (now <= goal) return 100;
  const s = start || 50;
  if (s <= goal) return 0;
  return Math.max(0, Math.min(99, Math.round(((s - now) / (s - goal)) * 100)));
}

/** Positions gained over the last `weeks` weekly history points (positive = moved up). */
function positionGain(history, weeks = 4) {
  const h = Array.isArray(history) ? history : [];
  const a = pointPosition(h[h.length - 1]);
  const b = pointPosition(h[h.length - 1 - weeks]);
  return a && b ? r1(b - a) : null;
}

/** Won = the last two weekly checks were both at or better than the goal. */
function hasReachedGoal(history, goal) {
  const h = Array.isArray(history) ? history : [];
  if (h.length < 2) return false;
  return h.slice(-2).every((p) => { const pos = pointPosition(p); return pos && pos <= goal; });
}

/** The anchor text for the next link to the focus page. Rotates so no single phrase is overused. */
function anchorFor(focus, n = 0) {
  const base = String(focus.keyword || '').replace(/\s+winnipeg$/i, '').trim();
  const head = clusterById(focus.cluster)?.head || base;
  const variants = [...new Set([`${head} in Winnipeg`, `${base} Winnipeg`, `our ${head} service`, base])].filter(Boolean);
  return variants[Math.abs(n) % variants.length];
}

/**
 * Which phrases become supporting posts for a focus keyword.
 * phrases: strings (Search Console queries, People Also Ask, related searches, autocomplete, existing ideas)
 * index:   every keyword row [{ id, keyword, matchKey, targetPath, kind, status, supportsId, focus }]
 * Returns { adopt: [{id, keyword}] (existing ideas to attach), create: [describeKeyword result] }.
 * Dropped: off-topic searches, head terms that belong to a service/area page, other topics, anything a page owns.
 */
function pickSupportKeywords({ focus, phrases, index, max = 4 }) {
  const out = { adopt: [], create: [] };
  const seen = new Set([focus.matchKey]);
  const claimed = new Set([focus.id]);
  const focusTokens = kw.tokens(focus.keyword).filter((t) => t !== kw.LOC);
  for (const phrase of phrases || []) {
    if (out.adopt.length + out.create.length >= max) break;
    const text = typeof phrase === 'string' ? phrase : phrase?.q;
    if (!text) continue;
    const d = kw.describeKeyword(text);
    if (!d.matchKey || seen.has(d.matchKey) || d.cluster === 'brand' || d.kind !== 'blog' || isOffTopic(text)) continue;
    if (d.matchKey.split(' ').length > 7 || d.keyword.length > 120) continue;
    const sameTopic = focus.cluster === 'other' ? d.matchKey.split(' ').some((t) => focusTokens.includes(t)) : d.cluster === focus.cluster;
    if (!sameTopic) continue;
    seen.add(d.matchKey);
    const hit = kw.matchQuery(text, index || []);
    if (hit) {
      if (!claimed.has(hit.id) && !hit.targetPath && hit.kind === 'blog' && ['idea', 'planned'].includes(hit.status) && !hit.supportsId && !hit.focus) {
        claimed.add(hit.id);
        out.adopt.push({ id: hit.id, keyword: hit.keyword });
      }
      continue;
    }
    out.create.push(d);
  }
  return out;
}

const mentions = (text, path) => !!text && !!path && new RegExp(`${String(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

/**
 * What state a campaign step is really in, judged from the database. Step rows are never trusted on their own:
 * the page is "done" when it is live, a link when the crawl sees it, a social post when a content item cites the URL.
 * ctx: { focus, pages: {path: page}, byId: {id: keyword}, content: [{status, grounding}] }
 */
function reconcileStep(step, ctx) {
  const { focus, pages, byId, content = [] } = ctx;
  const d = step.detail || {};
  switch (step.kind) {
    case 'page':
      if (focus.targetPath && live(pages[focus.targetPath])) return { status: 'done' };
      return { status: focus.status === 'assigned' ? 'in_progress' : 'planned' };
    case 'refresh': {
      const p = focus.targetPath ? pages[focus.targetPath] : null;
      if (p?.refreshedAt && new Date(p.refreshedAt) >= new Date(step.createdAt)) return { status: 'done' };
      return { status: focus.status === 'assigned' ? 'in_progress' : 'planned' };
    }
    case 'support': {
      const s = byId[step.refId];
      if (!s || s.status === 'retired' || s.supportsId !== focus.id) return { status: 'skipped' };
      if (s.targetPath && live(pages[s.targetPath])) return { status: 'done' };
      return { status: s.status === 'assigned' ? 'in_progress' : 'planned' };
    }
    case 'links': {
      const fp = focus.targetPath ? pages[focus.targetPath] : null;
      if (d.from && !live(pages[d.from])) return { status: 'skipped' };
      if (fp && Array.isArray(fp.linkedFrom) && fp.linkedFrom.includes(d.from)) return { status: 'done' };
      return { status: d.reportedAt ? 'in_progress' : 'planned' };
    }
    case 'social': {
      const hits = content.filter((c) => mentions(c.grounding, step.refId));
      if (hits.some((c) => ['queued', 'approved', 'published'].includes(c.status))) return { status: 'done' };
      return { status: hits.length ? 'in_progress' : 'planned' };
    }
    default:
      return { status: step.status };
  }
}

/**
 * Should the focus page be refreshed now? Sooner than the normal 45 days (first refresh at cfg.focusRefreshDays),
 * but only while it is still short of the goal. Blog posts only: service pages are hand-built.
 */
function focusRefreshDue(page, k, cfg, now = new Date()) {
  if (!page || !live(page) || page.kind !== 'blog') return false;
  const since = page.refreshedAt || page.publishedAt || k.publishedAt;
  if (!since) return false;
  const age = (now - new Date(since)) / DAY;
  const need = page.refreshedAt ? 45 : (cfg.focusRefreshDays ?? 21);
  const cur = currentPosition(k);
  return age >= need && !(cur && cur <= k.focusGoal);
}

module.exports = { OPEN_STEP, MAX_SUPPORT_TOTAL, live, currentPosition, pointPosition, progressToGoal, positionGain, hasReachedGoal, anchorFor, pickSupportKeywords, mentions, reconcileStep, focusRefreshDue, r1 };
