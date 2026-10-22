/**
 * What the writer does next, and the roadmap of the pieces after it (pure: keyword rows in, decisions out).
 *
 * Order: focus campaigns first (oldest first): the focus keyword's own post, then its supporting posts (which link
 * to it), then a refresh once the focus post is 21 days old and still short of the goal. After that, the highest
 * priority planned keyword.
 */
const DAY = 86400000;
const LIVE = new Set(['published', 'indexed', 'ranking', 'page1', 'top3']);
const OPEN = new Set(['idea', 'planned']);
const REFRESH_DAYS = 21;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const bestPosition = (k) => {
  const p = [k.position28, k.serpPosition].filter((x) => x != null && Number.isFinite(x));
  return p.length ? Math.min(...p) : null;
};

function nextPiece(keywords, { busy = new Set(), now = new Date() } = {}) {
  const free = (k) => !busy.has(k.id);
  const focus = keywords.filter((k) => k.focus && k.focusStatus === 'active').sort((a, b) => new Date(a.focusSince || 0) - new Date(b.focusSince || 0));
  for (const f of focus) {
    if (!LIVE.has(f.status)) {
      if (free(f)) return { mode: 'new', keyword: f, focus: f, why: `Focus campaign: the main post for "${f.keyword}"` };
      continue; // supporting posts link to the main post, so they wait until it is live
    }
    const sup = keywords.filter((k) => k.supportsId === f.id && OPEN.has(k.status) && free(k)).sort((a, b) => b.priority - a.priority)[0];
    if (sup) return { mode: 'support', keyword: sup, focus: f, why: `Supporting post for the focus keyword "${f.keyword}" (links to its post)` };
    const since = f.refreshedAt || f.publishedAt;
    const best = bestPosition(f);
    if (since && now - new Date(since) >= REFRESH_DAYS * DAY && (best == null || best > f.focusGoal) && free(f)) {
      return { mode: 'refresh', keyword: f, focus: f, why: `Refresh: "${f.keyword}" is at ${best == null ? 'no position yet' : `position ${best}`} after ${REFRESH_DAYS}+ days, goal top ${f.focusGoal}` };
    }
  }
  // corrections queued by the weekly check or the research job (low click rate, stuck rankings), oldest first
  const fix = keywords.filter((k) => k.refreshAsked && LIVE.has(k.status) && free(k)).sort((a, b) => new Date(a.refreshAsked) - new Date(b.refreshAsked))[0];
  if (fix) return { mode: 'refresh', keyword: fix, why: `Correction: ${fix.refreshReason || 'refresh asked for'}` };
  const waiting = new Set(focus.map((f) => f.id));
  const queue = keywords
    .filter((k) => k.status === 'planned' && !k.focus && !waiting.has(k.supportsId) && free(k))
    .sort((a, b) => b.priority - a.priority);
  if (!queue.length) return null;
  // spread the posts over the services: skip the service of the latest post unless nothing else is nearly as good
  const last = keywords.filter((k) => LIVE.has(k.status) && k.publishedAt && k.service).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))[0]?.service;
  const other = last ? queue.find((k) => k.service && k.service !== last) : null;
  const next = other && other.priority >= queue[0].priority * 0.7 ? other : queue[0];
  return { mode: 'new', keyword: next, why: next === queue[0] ? `Highest priority planned keyword (score ${next.priority})` : `Next best keyword for a different service than the last post (${last}): score ${next.priority}` };
}

/** Business-timezone weekday ("mon") and hour for a Date. */
function localParts(d, tz = process.env.BUSINESS_TZ || 'America/Winnipeg') {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: get('weekday').toLowerCase().slice(0, 3), hour: parseInt(get('hour'), 10), date: `${get('year')}-${get('month')}-${get('day')}` };
}

/** The next n posting days (YYYY-MM-DD) from `from`, at most postsPerWeek in any 7-day window. */
function nextSlots(cfg, from, n) {
  const out = [];
  const days = cfg.postDays.filter((d) => DAYS.includes(d));
  if (!days.length || !cfg.postsPerWeek) return out;
  for (let i = 0; out.length < n && i < 120; i += 1) {
    const d = new Date(from.getTime() + i * DAY);
    const p = localParts(d);
    if (i === 0 && p.hour >= cfg.postHour) continue; // today's slot has passed
    if (!days.includes(p.day)) continue;
    const window = out.filter((s) => (new Date(`${p.date}T12:00:00Z`) - new Date(`${s}T12:00:00Z`)) < 7 * DAY);
    if (window.length >= cfg.postsPerWeek) continue;
    out.push(p.date);
  }
  return out;
}

/** The next n pieces in order, as if each one were written on its slot. */
function roadmap(keywords, cfg, { busy = new Set(), now = new Date(), n = 8 } = {}) {
  const sim = keywords.map((k) => ({ ...k }));
  const slots = nextSlots(cfg, now, n);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const at = slots[i] ? new Date(`${slots[i]}T18:00:00Z`) : new Date(now.getTime() + (i + 1) * 3 * DAY);
    const p = nextPiece(sim, { busy, now: at });
    if (!p) break;
    out.push({ date: slots[i] || null, mode: p.mode, keywordId: p.keyword.id, keyword: p.keyword.keyword, focus: p.focus?.keyword || null, why: p.why });
    const k = sim.find((x) => x.id === p.keyword.id);
    if (p.mode === 'refresh') { k.refreshedAt = at; k.refreshAsked = null; }
    else { k.status = 'published'; k.publishedAt = at; }
  }
  return out;
}

module.exports = { nextPiece, roadmap, nextSlots, localParts, bestPosition, LIVE, REFRESH_DAYS };
