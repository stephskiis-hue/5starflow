/**
 * Deterministic keyword scoring. The score is roughly "extra clicks a month we could win", weighted by
 * how close we are, how ready the searcher is to hire, and whether the season is about to start.
 * Every score carries its parts and a plain-English `why` so the dashboard and the writer can explain it.
 */

// Organic CTR by position for a local results page (ads + map pack push organic down), from public CTR studies.
const CTR_POINTS = [[1, 0.27], [2, 0.15], [3, 0.10], [4, 0.07], [5, 0.05], [6, 0.04], [7, 0.03], [8, 0.025], [9, 0.02], [10, 0.017],
  [11, 0.012], [12, 0.011], [13, 0.010], [14, 0.009], [15, 0.008], [20, 0.005], [30, 0.002], [50, 0.001]];

function expectedCtr(pos) {
  if (!Number.isFinite(pos) || pos <= 1) return CTR_POINTS[0][1];
  for (let i = 1; i < CTR_POINTS.length; i++) {
    const [p1, c1] = CTR_POINTS[i - 1];
    const [p2, c2] = CTR_POINTS[i];
    if (pos <= p2) return c1 + ((c2 - c1) * (pos - p1)) / (p2 - p1);
  }
  return CTR_POINTS[CTR_POINTS.length - 1][1];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const median = (a) => { const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** How this site's real CTR compares to the curve (rows: [{position, impressions, clicks}]); 1 until there is data. */
function calibrate(rows) {
  const ratios = (rows || []).filter((r) => r.position <= 10 && r.impressions >= 30).map((r) => (r.clicks / r.impressions) / expectedCtr(r.position));
  return ratios.length < 10 ? 1 : clamp(median(ratios), 0.5, 1.5);
}

/** Season weight for month (1-12): rising just before the peak, so posts are indexed when demand arrives. */
function seasonFactor(month, peaks, lead = 2) {
  if (!Array.isArray(peaks) || !peaks.length || peaks.length >= 10) return 1;
  const m = (k) => ((month - 1 + k + 12) % 12) + 1;
  for (let k = 1; k <= lead; k++) if (peaks.includes(m(k)) && !peaks.includes(month)) return 1.5;
  if (peaks.includes(month)) return 1.25;
  if (peaks.includes(m(-1))) return 0.8;
  return 0.6;
}

const INTENT_WEIGHT = { transactional: 1.6, commercial: 1.3, informational: 1 };

function weightedPosition(rows) {
  let imp = 0; let sum = 0;
  for (const r of rows || []) { imp += r.impressions; sum += r.position * r.impressions; }
  return imp ? sum / imp : null;
}

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * k: { impressions, clicks, position, intent, peaks, signals:{autocomplete,paa,related,weakSerp}, serpPosition }
 * ctx: { month, calib, clusterBoost }
 */
function scoreKeyword(k, ctx = {}) {
  const month = ctx.month || 1;
  const calib = ctx.calib || 1;
  const Wi = INTENT_WEIGHT[k.intent] || 1;
  const Ws = seasonFactor(month, k.peaks);
  const boost = ctx.clusterBoost || 1;
  const I = k.impressions || 0;
  const P = Number.isFinite(k.position) && k.position > 0 ? k.position : null;

  if (!I || !P) {
    // No Search Console data: score from Serper demand signals (Google suggests it, people ask about it).
    const s = k.signals || {};
    const demand = 1 + 0.25 * (s.autocomplete ? 1 : 0) + 0.25 * (s.paa ? 1 : 0) + 0.1 * Math.min(5, s.related || 0) + (s.weakSerp ? 0.25 : 0);
    const rankBonus = k.serpPosition && k.serpPosition <= 30 ? 1.2 : 1;
    const score = 3 * Wi * Ws * demand * rankBonus * boost;
    const why = [s.autocomplete ? 'Google suggests this search' : 'not in Search Console yet', s.paa ? 'people ask about it' : null,
      s.weakSerp ? 'weak competitors rank for it' : null, Ws > 1.25 ? 'its season starts soon' : Ws < 1 ? 'off season' : null].filter(Boolean).join('; ');
    return { score: r1(score), parts: { gap: true, demand: r1(demand), intent: Wi, season: Ws, clusterBoost: boost, why } };
  }

  const ctr = (k.clicks || 0) / Math.max(I, 1);
  const E = (p) => expectedCtr(p) * calib;
  const target = P > 20 ? 10 : P > 10 ? 5 : P > 3 ? 3 : 1;
  const upside = I * Math.max(0, E(target) - ctr);
  const stage = P <= 3 ? 0.3 : P <= 10 ? 1 : P <= 20 ? 0.9 : P <= 40 ? 0.5 : 0.25;
  const confidence = Math.sqrt(Math.min(1, I / 100));
  let score = (upside + 0.02 * I) * stage * Wi * Ws * (0.5 + 0.5 * confidence) * boost;
  // Off page 1, a few impressions prove the search exists: never score below the same keyword with no data.
  if (P > 10) score = Math.max(score, 0.8 * scoreKeyword({ ...k, impressions: 0, position: null }, ctx).score);
  const monthly = Math.round(upside * (30 / 28));
  const why = [`position ${r1(P)} with ${I} impressions in 28 days`,
    monthly > 0 ? `reaching the top ${target === 1 ? 'spot' : target} is worth about ${monthly} more clicks a month` : P > 10 ? 'Google already shows it; more depth and links can lift it' : 'already near its best',
    Ws > 1.25 ? 'its season starts soon' : Ws < 1 ? 'off season' : null, boost > 1 ? 'its service page is close to page 1' : null].filter(Boolean).join('; ');
  return { score: r1(score), parts: { upside: r1(upside), stage, intent: Wi, season: Ws, confidence: r1(confidence), clusterBoost: boost, target, why } };
}

/** Ranking on page 1 but getting far fewer clicks than the position should: a title/description rewrite. */
function lowCtrFlag(position, impressions, clicks, calib = 1) {
  if (!position || position > 10 || impressions < 60) return false;
  return clicks / impressions < 0.5 * expectedCtr(position) * calib;
}

/**
 * Two or more of our pages splitting one keyword. pages: [{ page, impressions }].
 * Returns null, or { pages, severity } where severity = impressions not landing on the top page.
 */
function findCannibalization(pages) {
  const total = (pages || []).reduce((s, p) => s + p.impressions, 0);
  if (!total) return null;
  const strong = pages.filter((p) => p.impressions >= 10 && p.impressions / total >= 0.15).sort((a, b) => b.impressions - a.impressions);
  if (strong.length < 2) return null;
  return { pages: strong.map((p) => ({ page: p.page, impressions: p.impressions, share: r1((p.impressions / total) * 100) })), severity: Math.round(total - strong[0].impressions) };
}

module.exports = { CTR_POINTS, expectedCtr, calibrate, seasonFactor, scoreKeyword, lowCtrFlag, findCannibalization, weightedPosition, INTENT_WEIGHT };
