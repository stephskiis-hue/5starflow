/**
 * Winnipeg Fence Pros research jobs.
 *   gscSyncTick   (daily)  Search Console: [query, page] for the last 28 days and the 28 before, [date] totals for 90
 *                          days, then rescore every keyword from those numbers.
 *   researchTick  (Monday) import the queries people really searched, Serper discovery (autocomplete, People Also Ask,
 *                          related searches), weekly Google + map-pack rank checks, the weekly history point and up to
 *                          RECOMMEND_MAX focus recommendations with a plain "why".
 */
const prisma = require('../lib/prismaClient');
const { getConfig } = require('./settings');
const g = require('./google');
const kw = require('./keywords');
const { getState, setState, note } = require('./runner');

const DAY = 86400000;
const ymd = (d) => d.toISOString().slice(0, 10);
const LIVE = new Set(['published', 'indexed', 'ranking', 'page1', 'top3']);
const PLAN_THRESHOLD = 3;
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

async function gscSyncTick(ctx) {
  const cfg = await getConfig();
  if (!cfg.GSC_PROPERTY) return { skipped: true, summary: 'Search Console property not set (Settings tab)' };
  const a = await g.auth(cfg);
  if (a.error) throw new Error(a.error);

  const end = new Date(Date.now() - 2 * DAY); // Search Console lags about two days
  const start = new Date(end.getTime() - 27 * DAY);
  const prevEnd = new Date(start.getTime() - DAY);
  const prevStart = new Date(prevEnd.getTime() - 27 * DAY);
  const cur = await g.query(a, cfg.GSC_PROPERTY, { startDate: ymd(start), endDate: ymd(end), dimensions: ['query', 'page'] });
  const prev = await g.query(a, cfg.GSC_PROPERTY, { startDate: ymd(prevStart), endDate: ymd(prevEnd), dimensions: ['query', 'page'] });
  ctx.log(`Search Console: ${cur.length} query/page rows now, ${prev.length} the 28 days before`);

  const map = new Map();
  for (const r of cur) {
    const [query, page] = r.keys;
    map.set(`${query}\u0000${pathOf(page)}`, { query, page: pathOf(page), clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10, prevImpressions: 0, prevPosition: null });
  }
  for (const r of prev) {
    const [query, page] = r.keys;
    const key = `${query}\u0000${pathOf(page)}`;
    const row = map.get(key) || { query, page: pathOf(page), clicks: 0, impressions: 0, position: 0 };
    row.prevImpressions = r.impressions;
    row.prevPosition = Math.round(r.position * 10) / 10;
    map.set(key, row);
  }
  const rows = [...map.values()].filter((r) => r.query.length <= 300);
  await prisma.$transaction(async (tx) => {
    await tx.wfpQuery.deleteMany({});
    for (let i = 0; i < rows.length; i += 1000) await tx.wfpQuery.createMany({ data: rows.slice(i, i + 1000), skipDuplicates: true });
  }, { timeout: 120000 });

  const days = await g.query(a, cfg.GSC_PROPERTY, { startDate: ymd(new Date(end.getTime() - 89 * DAY)), endDate: ymd(end), dimensions: ['date'] });
  for (const d of days) {
    const date = new Date(`${d.keys[0]}T00:00:00Z`);
    const data = { clicks: d.clicks, impressions: d.impressions, ctr: d.ctr, position: d.position };
    await prisma.wfpDaily.upsert({ where: { date }, update: data, create: { date, ...data } });
  }
  const changed = await rescore(cfg);
  const clicks = cur.reduce((s, r) => s + r.clicks, 0);
  const imp = cur.reduce((s, r) => s + r.impressions, 0);
  return { summary: `${clicks} clicks and ${imp} impressions in 28 days; ${changed} keywords updated`, detail: { rows: rows.length, days: days.length } };
}

/** Recompute every keyword's Search Console numbers, status and priority. Returns how many rows changed. */
async function rescore(cfg, now = new Date()) {
  const queries = await prisma.wfpQuery.findMany();
  const byKey = new Map();
  for (const q of queries) {
    const k = kw.matchKey(q.query);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(q);
  }
  const keywords = await prisma.wfpKeyword.findMany();
  let changed = 0;
  for (const k of keywords) {
    const rows = byKey.get(k.matchKey) || [];
    const pages = {};
    for (const r of rows) pages[r.page] = (pages[r.page] || 0) + r.impressions;
    const nums = {
      clicks28: rows.reduce((s, r) => s + r.clicks, 0),
      impressions28: rows.reduce((s, r) => s + r.impressions, 0),
      position28: kw.weightedPosition(rows),
      prevImpressions28: rows.reduce((s, r) => s + (r.prevImpressions || 0), 0),
      prevPosition28: kw.weightedPosition(rows.filter((r) => r.prevPosition != null), 'prevPosition', 'prevImpressions'),
      topPage: Object.entries(pages).sort((x, y) => y[1] - x[1])[0]?.[0] || null,
    };
    const merged = { ...k, ...nums };
    const data = { ...nums, priority: kw.scoreKeyword(merged, now) };
    let status = kw.statusFor(merged);
    if (status === 'idea' && (data.priority >= PLAN_THRESHOLD || k.supportsId || k.focus)) status = 'planned';
    if (status !== k.status) { data.status = status; data.statusChangedAt = now; }

    if (k.focus && k.focusStatus === 'active') {
      const best = Math.min(...[nums.position28, k.serpPosition].filter((p) => p != null && Number.isFinite(p)), Infinity);
      if (best <= k.focusGoal && LIVE.has(status)) {
        data.focusStatus = 'won';
        await note('system', 'milestone', `Goal reached: ${k.keyword}`, `"${k.keyword}" reached position ${best} (goal: top ${k.focusGoal}). The focus campaign is marked won; start another from the Keywords tab.`);
      }
    }
    const differs = Object.entries(data).some(([f, v]) => JSON.stringify(k[f] ?? null) !== JSON.stringify(v ?? null));
    if (differs) { await prisma.wfpKeyword.update({ where: { id: k.id }, data }); changed += 1; }
  }
  return changed;
}

/** Create keywords that do not exist yet (by matchKey). Returns how many were created. */
async function addKeywords(list, cfg) {
  let created = 0;
  for (const item of list) {
    const d = kw.describe(item.keyword, cfg);
    if (!d.matchKey || d.keyword.length > 120) continue;
    try {
      await prisma.wfpKeyword.create({ data: { ...d, source: item.source, signals: item.signals || undefined, notes: item.notes || '', supportsId: item.supportsId || null, status: item.status || 'idea' } });
      created += 1;
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      if (item.signals) {
        const row = await prisma.wfpKeyword.findUnique({ where: { matchKey: d.matchKey } });
        if (row) await prisma.wfpKeyword.update({ where: { id: row.id }, data: { signals: { ...(row.signals || {}), ...item.signals } } });
      }
    }
  }
  return created;
}

/** "fence cost" -> "fence cost winnipeg"; leaves "fence cost winnipeg" and "fence company near me" alone. */
const withCity = (k, city) => (new RegExp(`\\b(${String(city).toLowerCase()}|near me)\\b`).test(String(k).toLowerCase()) ? k : `${k} ${String(city).toLowerCase()}`);

const fits = (phrase, cfg) => !kw.isOffTopic(phrase) && !kw.isBranded(phrase, cfg.brandTerms) && !!kw.serviceFor(phrase, cfg.services);

async function researchTick(ctx, now = new Date()) {
  const cfg = await getConfig();
  if (!cfg.GSC_PROPERTY && !cfg.SERPER_API_KEY) return { skipped: true, summary: 'Neither Search Console nor Serper is set up' };
  const stats = { gsc: 0, serper: 0, tracked: 0, recommended: 0 };

  // 1. what people really searched (Search Console), grouped by matchKey
  const queries = await prisma.wfpQuery.findMany();
  const groups = new Map();
  for (const q of queries) {
    if (!fits(q.query, cfg)) continue;
    const k = kw.matchKey(q.query);
    const gr = groups.get(k) || { text: q.query, imp: 0, best: 0 };
    gr.imp += q.impressions;
    if (q.impressions > gr.best) { gr.best = q.impressions; gr.text = q.query; }
    groups.set(k, gr);
  }
  stats.gsc = await addKeywords([...groups.values()].filter((gr) => gr.imp >= 5).map((gr) => ({ keyword: gr.text, source: 'gsc' })), cfg);
  ctx.log(`Search Console: ${stats.gsc} new keywords from real searches`);

  // 2. Serper discovery, three services a week in rotation
  const budget = g.serperBudget(await getState('serper'), cfg.serperWeeklyBudget, now);
  if (cfg.SERPER_API_KEY && cfg.services.length) {
    const week = parseInt(g.isoWeek(now).split('-W')[1], 10);
    const n = cfg.services.length;
    const pick = [...new Set([0, 1, 2].map((i) => cfg.services[(week * 3 + i) % n]))];
    const found = [];
    for (const svc of pick) {
      const q = `${svc.name} ${cfg.CITY}`.toLowerCase();
      if (budget.left() < 2 + cfg.rankTrackMax) break; // rank tracking matters more
      budget.take();
      const ac = await g.serper(cfg, '/autocomplete', { q }).catch((e) => { ctx.log(`autocomplete failed: ${e.message}`); return {}; });
      for (const s of ac.suggestions || []) found.push({ keyword: s.value, source: 'serper', signals: { autocomplete: true } });
      budget.take();
      const sr = await g.serper(cfg, '/search', { q, num: 20 }).catch((e) => { ctx.log(`search failed: ${e.message}`); return {}; });
      for (const p of sr.peopleAlsoAsk || []) found.push({ keyword: p.question, source: 'serper', signals: { paa: true } });
      for (const r of sr.relatedSearches || []) found.push({ keyword: r.query, source: 'serper', signals: { related: true } });
    }
    stats.serper = await addKeywords(found.filter((f) => fits(f.keyword, cfg)).slice(0, 40), cfg);
    ctx.log(`Serper discovery (${pick.map((x) => x.name).join(', ')}): ${stats.serper} new keywords`);
  }
  await rescore(cfg, now);

  // 3. weekly rank check: focus campaigns first, then live posts and last week's recommendations, by priority
  const all = await prisma.wfpKeyword.findMany({ where: { status: { not: 'retired' } } });
  const focusIds = new Set(all.filter((k) => k.focus && k.focusStatus === 'active').map((k) => k.id));
  const tier = (k) => (focusIds.has(k.id) || focusIds.has(k.supportsId) ? 0 : LIVE.has(k.status) ? 1 : k.recommended || k.rankTrack ? 2 : 3);
  const track = all.filter((k) => tier(k) < 3).sort((x, y) => tier(x) - tier(y) || y.priority - x.priority).slice(0, cfg.rankTrackMax);
  if (cfg.SERPER_API_KEY && cfg.host) {
    for (const k of track) {
      if (budget.left() < 2) { ctx.log('Serper weekly budget used up'); break; }
      const q = withCity(k.keyword, cfg.CITY);
      budget.take();
      const sr = await g.serper(cfg, '/search', { q, num: 30 }).catch(() => null);
      budget.take();
      const pl = await g.serper(cfg, '/places', { q }).catch(() => null);
      if (!sr) continue;
      const serpPosition = g.organicRank(sr, cfg.host);
      const serpTop = (sr.organic || []).filter((r) => g.bareHost(r.link) !== cfg.host).slice(0, 3).map((r) => ({ title: r.title, link: r.link }));
      await prisma.wfpKeyword.update({ where: { id: k.id }, data: { rankTrack: true, serpPosition, mapPackPosition: pl ? g.placesRank(pl, cfg.host, cfg.BUSINESS_NAME) : null, serpTop, serpCheckedAt: now } });
      stats.tracked += 1;
    }
  }
  await setState('serper', budget.snapshot());
  await rescore(cfg, now);

  // 4. one history point per week
  const week = g.isoWeek(now);
  for (const k of await prisma.wfpKeyword.findMany({ where: { OR: [{ rankTrack: true }, { impressions28: { gt: 0 } }] } })) {
    const hist = (Array.isArray(k.history) ? k.history : []).filter((h) => h.w !== week);
    hist.push({ w: week, pos: k.position28, imp: k.impressions28, clk: k.clicks28, serp: k.serpPosition, map: k.mapPackPosition });
    await prisma.wfpKeyword.update({ where: { id: k.id }, data: { history: hist.slice(-52) } });
  }

  // 5. focus recommendations
  const pool = await prisma.wfpKeyword.findMany({ where: { focus: false, supportsId: null, status: { not: 'retired' } } });
  const cands = [];
  for (const k of pool) {
    if (k.dismissedUntil && k.dismissedUntil > now) continue;
    const rec = kw.recommendation(k, { hasPost: LIVE.has(k.status) });
    if (rec) cands.push({ ...k, rec });
  }
  const picked = kw.pickRecommendations(cands, cfg.recommendMax);
  const pickedIds = new Set(picked.map((p) => p.id));
  await prisma.wfpKeyword.updateMany({ where: { recommended: true, id: { notIn: [...pickedIds] } }, data: { recommended: false } });
  for (const p of picked) {
    await prisma.wfpKeyword.update({ where: { id: p.id }, data: { recommended: true, why: p.rec.why, recommendedAt: p.recommended ? p.recommendedAt : now } });
  }
  stats.recommended = picked.length;
  const fresh = picked.filter((p) => !p.recommended);
  if (fresh.length) await note('system', 'note', `${fresh.length} new keyword recommendation${fresh.length > 1 ? 's' : ''}`, fresh.map((p) => `• ${p.keyword}: ${p.rec.why}`).join('\n'));

  return {
    summary: `${stats.gsc} keywords from Search Console, ${stats.serper} from Serper, ${stats.tracked} rank-checked, ${stats.recommended} recommended`,
    detail: { ...stats, serper: budget.snapshot() },
  };
}

module.exports = { gscSyncTick, researchTick, rescore, addKeywords, fits, withCity };
