/**
 * Picks what the daily blog run should do next: a NEW post for a keyword no page owns, a REFRESH of a
 * post that is close to page 1 / stalled / under-clicked, or a landing PAGE (service or neighbourhood).
 * Pure and deterministic: the same inputs always give the same order. assign.js locks the winner.
 */
const { CONTENT_TYPES, clusterById } = require('./config');
const { contentTypeFor } = require('./keywords');
const { lowCtrFlag } = require('./scoring');

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
 * input: { keywords, pages: {path: page}, history: recent SeoAssignment rows, cfg, modes, now, calib, pillars: {clusterId: path} }
 * returns: [{ keyword, mode, contentType, contentTypeReason, score, why }] best first
 */
function pickAssignment({ keywords, pages = {}, history = [], cfg, modes, now = new Date(), calib = 1, pillars = {} }) {
  const allowed = (modes && modes.length ? modes : ['new']).filter((m) => cfg.modesEnabled.includes(m));
  const refreshLeft = cfg.refreshPerWeek - countSince(history, 'refresh', 7, now);
  const pagesLeft = cfg.pagesPerWeek - countSince(history, 'page', 7, now);
  const areaPages = Object.values(pages).filter((p) => p.kind === 'area' && (p.httpStatus || 200) === 200);
  const areaRecent = countSince(history, 'page', 14, now, (h) => h.kind === 'area');
  const areaRoom = areaRecent === 0 && (areaPages.length < cfg.areaPagesMax || areaPages.every((p) => (p.impressions28 || 0) >= 50));
  const out = [];

  for (const k of keywords) {
    if (k.status === 'retired' || k.cluster === 'brand') continue;
    if (k.lockedUntil && new Date(k.lockedUntil) > now) continue;
    if (k.lastAssignedAt && now - new Date(k.lastAssignedAt) < 30 * DAY) continue;
    if (k.cluster === 'other' && !k.pinned) continue;
    const base = k.priority || 0;
    if (base <= 0 && !k.pinned) continue;
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
      if (age >= 45 && (k.status === 'stalled' || close || low)) {
        mode = 'refresh';
        if (low) { mult *= 1.1; why = `ranks on page 1 but gets few clicks: rewrite the title and description; ${why}`; }
        else if (k.status === 'stalled') why = `${k.position28 ? 'no movement' : 'not showing in Google'} ${Math.round(age)} days after publishing; ${why}`;
        else why = `close to the top 3; ${why}`;
      }
    } else if (!k.targetPath && OPEN.includes(k.status) && (k.kind === 'service' || k.kind === 'area')) {
      if (k.kind === 'service' && !pillars[k.cluster]) { mode = 'page'; mult *= 1.2; why = `no ${clusterById(k.cluster)?.label || k.cluster} page exists yet; ${why}`; }
      if (k.kind === 'area' && areaRoom && (k.pinned || (k.impressions28 || 0) >= 20 || k.signals?.autocomplete)) { mode = 'page'; why = `people search for this neighbourhood; ${why}`; }
    }
    if (!mode || !allowed.includes(mode)) continue;
    if (mode === 'refresh' && refreshLeft <= 0) continue;
    if (mode === 'page' && pagesLeft <= 0) continue;

    const sameCluster = history.filter((h) => h.cluster === k.cluster && h.status !== 'expired' && h.status !== 'skipped');
    if (sameCluster.some((h) => now - new Date(h.createdAt) < 3 * DAY)) mult *= 0.5;
    else if (sameCluster.filter((h) => now - new Date(h.createdAt) < 30 * DAY).length >= 3) mult *= 0.75;
    if (k.pinned) mult *= 1.5;

    const ct = mode === 'page' ? { contentType: k.kind === 'area' ? 'area page' : 'service page', reason: 'landing page' } : chooseContentType(k.keyword, history);
    out.push({ keyword: k, mode, contentType: ct.contentType, contentTypeReason: ct.reason, score: Math.round(Math.max(base, 1) * mult * 10) / 10, why: why.replace(/;\s*$/, '') });
  }

  return out.sort((a, b) => (b.score - a.score) || (b.keyword.pinned - a.keyword.pinned)
    || ((a.keyword.lastAssignedAt ? new Date(a.keyword.lastAssignedAt).getTime() : 0) - (b.keyword.lastAssignedAt ? new Date(b.keyword.lastAssignedAt).getTime() : 0))
    || String(a.keyword.id).localeCompare(String(b.keyword.id)));
}

module.exports = { pickAssignment, chooseContentType };
