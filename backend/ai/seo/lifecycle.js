/**
 * Keyword lifecycle:
 *   idea -> planned -> assigned -> published -> indexed -> ranking (top 20) -> page1 -> top3
 *   stalled: 60+ days since publish/refresh without gaining 3 positions (becomes a refresh candidate)
 *   retired: owner said stop (never changes)
 */
const STATUSES = ['idea', 'planned', 'assigned', 'published', 'indexed', 'ranking', 'page1', 'top3', 'stalled', 'retired'];
const STALL_DAYS = 60;

/**
 * kw: { status, pinned, targetPath, baselinePosition, publishedAt }
 * f:  { score, planThreshold, locked, indexed, position, impressions, serpPosition, lastChangedAt (publish/refresh date) }
 */
function nextStatus(kw, f, now = new Date()) {
  if (kw.status === 'retired') return 'retired';
  if (f.locked) return 'assigned';
  if (!kw.targetPath) {
    return kw.pinned || (f.score || 0) >= (f.planThreshold || 4) ? 'planned' : 'idea';
  }
  // Search Console needs some impressions before its average position means anything; Serper fills the gap.
  const pos = (f.impressions || 0) >= 10 && f.position ? f.position : f.serpPosition || null;
  if (pos && pos <= 3) return 'top3';
  if (pos && pos <= 10) return 'page1';
  const since = f.lastChangedAt || kw.publishedAt;
  const age = since ? (now - new Date(since)) / 86400000 : 0;
  if (age >= STALL_DAYS) {
    const gained = kw.baselinePosition && pos ? kw.baselinePosition - pos : 0;
    if (!pos || gained < 3) return 'stalled';
  }
  if (pos && pos <= 20) return 'ranking';
  return f.indexed || (f.impressions || 0) > 0 ? 'indexed' : 'published';
}

module.exports = { STATUSES, STALL_DAYS, nextStatus };
