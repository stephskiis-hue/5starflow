/**
 * Picks what the daily blog run should do next: a NEW post for a keyword no page owns, a REFRESH of a
 * post that is close to page 1 / stalled / under-clicked, or a landing PAGE (service or neighbourhood).
 * Pure and deterministic: the same inputs always give the same order. assign.js locks the winner.
 */
const { CONTENT_TYPES, clusterById } = require('./config');
const { contentTypeFor } = require('./keywords');
const { lowCtrFlag } = require('./scoring');
const { live, currentPosition, focusRefreshDue } = require('./focusRules');

const DAY = 86400000;
const OPEN = ['idea', 'planned'];

function countSince(history, mode, days, now, pred = () => true) {
  return history.filter((h) => h.mode === mode && h.status !== 'expired' && h.status !== 'skipped' && now - new Date(h.createdAt) < days * DAY && pred(h)).length;
}

/** Next content type: what the keyword asks for, else the rotation skipping the last two used. */
function chooseContentType(keyword, history) {
  const asked = contentTypeFor(keyword);
  if (asked) return { contentType: asked, reason: `the search itself asks for a ${asked}` };
  const recent = history.filter((h) => h.mode !== 'page' && h.contentType).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).map((h) => h.contentType);
  const last = recent[0];
  const start = last ? (CONTENT_TYPES.indexOf(last) + 1) % CONTENT_TYPES.length : 0;
  for (let i = 0; i < CONTENT_TYPES.length; i++) {
    const t = CONTENT_TYPES[(start + i) % CONTENT_TYPES.length];
    if (!recent.slice(0, 2).includes(t)) return { contentType: t, reason: 'next type in the rotation' };
  }
  return { contentType: CONTENT_TYPES[start], reason: 'next type in the rotation' };
}

/**
 * input: { keywords, pages: {path: page}, history: recent SeoAssignment rows, cfg, modes, now, calib, pillars: {clusterId: path},
 *          linkSteps: open 'links' SeoFocusStep rows }
 * returns: [{ keyword, mode, contentType, contentTypeReason, score, why, focusId, tier, step }] best first.
 * Focus campaign pieces (the focus keyword and its supporting posts) form tier 1 while the week's focus quota lasts.
 */
function pickAssignment({ keywords, pages = {}, history = [], cfg, modes, now = new Date(), calib = 1, pillars = {}, linkSteps = [] }) {
  const allowed = (modes && modes.length ? modes : ['new']).filter((m) => cfg.modesEnabled.includes(m));
  if (cfg.focusLinks && modes?.includes('links')) allowed.push('links');
  const focusById = new Map(keywords.filter((k) => k.focus && k.focusStatus === 'active' && k.status !== 'retired').map((k) => [k.id, k]));
  const focusOf = (k) => (focusById.has(k.id) ? k : k.supportsId ? focusById.get(k.supportsId) || null : null);
  const pieceIds = new Set(keywords.filter((k) => focusOf(k)).map((k) => k.id));
  const focusUsed = history.filter((h) => pieceIds.has(h.keywordId) && h.mode !== 'links' && h.status !== 'expired' && h.status !== 'skipped' && now - new Date(h.createdAt) < 7 * DAY).length;
  const focusRoom = (cfg.focusPerWeek ?? 3) - focusUsed;
  const refreshLeft = cfg.refreshPerWeek - countSince(history, 'refresh', 7, now);
  const pagesLeft = cfg.pagesPerWeek - countSince(history, 'page', 7, now);
  const areaPages = Object.values(pages).filter((p) => p.kind === 'area' && (p.httpStatus || 200) === 200);
  const areaRecent = countSince(history, 'page', 14, now, (h) => h.kind === 'area');
  const areaRoom = areaRecent === 0 && (areaPages.length < cfg.areaPagesMax || areaPages.every((p) => (p.impressions28 || 0) >= 50));
  const out = [];

  for (const k of keywords) {
    if (k.status === 'retired' || k.cluster === 'brand') continue;
    if (k.lockedUntil && new Date(k.lockedUntil) > now) continue;
    const f = focusOf(k);
    const isFocusKw = !!f && f.id === k.id;
    if (k.lastAssignedAt && now - new Date(k.lastAssignedAt) < (isFocusKw ? Math.min(30, cfg.focusRefreshDays ?? 21) : 30) * DAY) continue;
    if (k.cluster === 'other' && !k.pinned && !f) continue;
    const base = k.priority || 0;
    if (base <= 0 && !k.pinned && !f) continue;
    // a supporting post links up to the focus page, so it waits until that page is live
    if (f && !isFocusKw && !k.targetPath && !live(f.targetPath && pages[f.targetPath])) continue;
    let mode = null;
    let why = k.scoreParts?.why || '';
    let mult = 1;

    if (!k.targetPath && OPEN.includes(k.status) && k.kind === 'blog') {
      mode = 'new';
    } else if (k.targetPath && pages[k.targetPath]?.kind === 'blog' && (pages[k.targetPath].httpStatus || 200) === 200) {
      const p = pages[k.targetPath];
      const since = p.refreshedAt || p.publishedAt || k.publishedAt;
      const age = since ? (now - new Date(since)) / DAY : 0;
      const low = lowCtrFlag(k.position28, k.impressions28 || 0, k.clicks28 || 0, calib);
      const close = k.position28 >= 4 && k.position28 <= 20 && (k.impressions28 || 0) >= 20;
      const focusDue = isFocusKw && focusRefreshDue(p, k, cfg, now);
      if ((age >= 45 && (k.status === 'stalled' || close || low)) || focusDue) {
        mode = 'refresh';
        if (focusDue) { const cur = currentPosition(k); why = `focus keyword ${cur ? `is at position ${Math.round(cur * 10) / 10}` : 'is not showing in Google'}, goal top ${k.focusGoal}: refresh the page; ${why}`; }
        else if (low) { mult *= 1.1; why = `ranks on page 1 but gets few clicks: rewrite the title and description; ${why}`; }
        else if (k.status === 'stalled') why = `${k.position28 ? 'no movement' : 'not showing in Google'} ${Math.round(age)} days after publishing; ${why}`;
        else why = `close to the top 3; ${why}`;
      }
    } else if (!k.targetPath && OPEN.includes(k.status) && (k.kind === 'service' || k.kind === 'area')) {
      // a service page needs months to rank, so build it ahead of its season (season weight neutralized) and before area pages
      if (k.kind === 'service' && !pillars[k.cluster]) { mode = 'page'; mult *= 1.5 / (k.scoreParts?.season || 1); why = `no ${clusterById(k.cluster)?.label || k.cluster} page exists yet, build it before the season; ${why}`.replace(/; off season/, ''); }
      if (k.kind === 'area' && areaRoom && (k.pinned || (k.impressions28 || 0) >= 20 || k.signals?.autocomplete)) { mode = 'page'; why = `people search for this neighbourhood; ${why}`; }
    }
    let step = null;
    if (!mode && isFocusKw && allowed.includes('links')) {
      step = linkSteps.find((st) => st.keywordId === k.id && st.status === 'planned') || null;
      if (step) { mode = 'links'; why = `focus keyword: ${step.title}`; }
    }
    if (!mode || !allowed.includes(mode)) continue;
    if (mode === 'refresh' && refreshLeft <= 0) continue;
    if (mode === 'page' && pagesLeft <= 0) continue;

    const boost = !!f && mode !== 'links' && focusRoom > 0;
    if (!f) {
      const sameCluster = history.filter((h) => h.cluster === k.cluster && h.status !== 'expired' && h.status !== 'skipped');
      if (sameCluster.some((h) => now - new Date(h.createdAt) < 3 * DAY)) mult *= 0.5;
      else if (sameCluster.filter((h) => now - new Date(h.createdAt) < 30 * DAY).length >= 3) mult *= 0.75;
    }
    if (boost) { mult *= 3; why = `${isFocusKw ? 'your focus keyword' : `supports your focus keyword "${f.keyword}"`}; ${why}`; }
    else if (k.pinned) mult *= 1.5;

    const ct = mode === 'links' ? { contentType: 'internal links', reason: 'add a link to the focus page' } : mode === 'page' ? { contentType: k.kind === 'area' ? 'area page' : 'service page', reason: 'landing page' } : chooseContentType(k.keyword, history);
    out.push({ keyword: k, mode, contentType: ct.contentType, contentTypeReason: ct.reason, score: Math.round(Math.max(base, 1) * mult * 10) / 10, why: why.replace(/;\s*$/, ''),
      focusId: f?.id || null, tier: boost ? 1 : 0, step });
  }

  return out.sort((a, b) => (b.tier - a.tier) || (b.score - a.score) || (b.keyword.pinned - a.keyword.pinned)
    || ((a.keyword.lastAssignedAt ? new Date(a.keyword.lastAssignedAt).getTime() : 0) - (b.keyword.lastAssignedAt ? new Date(b.keyword.lastAssignedAt).getTime() : 0))
    || String(a.keyword.id).localeCompare(String(b.keyword.id)));
}

module.exports = { pickAssignment, chooseContentType };
