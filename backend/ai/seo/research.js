/**
 * Keyword research: once a week (seo-roadmap) look at what people really searched for in Search Console and
 * recommend the few keywords most worth a focus campaign. Shown at the top of the Focus tab.
 *   pickRecommendations(keywords, opts)   pure: ranks candidates and explains each one in plain words
 *   researchTick(userId, opts)            picks, adds who ranks above us (Serper), stores, notifies
 *   dismiss(userId, keywordId)            "Not now": hidden for 8 weeks
 */
const prisma = require('../../lib/prismaClient');
const serper = require('./serper');
const g = require('./google');
const { currentPosition, r1 } = require('./focusRules');

const DAY = 86400000;
const WEEK = 7 * DAY;
const DISMISS_WEEKS = 8;
const MAX_PER_CLUSTER = 2;

const LABEL = {
  almost: 'On page 2: a push gets it onto page 1',
  close: 'Close to the top 3',
  rising: 'Searches are rising',
  no_page: 'People search this but no page is built for it',
  area: 'Demand in this neighbourhood',
};
const BOOST = { rising: 1.15, no_page: 1.1 };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const histImpressions = (k, weeksAgo) => {
  const h = Array.isArray(k.history) ? k.history : [];
  const p = h[h.length - 1 - weeksAgo];
  return p ? num(p.imp) : null;
};

/** The one reason a keyword is worth a campaign (first match wins), or null. */
function classify(k) {
  const imp = num(k.impressions28);
  const pos = k.position28 || null;
  const before = histImpressions(k, 4);
  if (pos && pos >= 8 && pos <= 20 && imp >= 20) return 'almost';
  if (pos && pos >= 4 && pos < 8 && imp >= 10) return 'close';
  if (before != null && imp >= 1.5 * Math.max(before, 1) && imp - before >= 15) return 'rising';
  if (imp >= 10 && (!k.targetPath || k.targetPath === '/')) return 'no_page';
  if (k.kind === 'area' && k.area && imp >= 10) return 'area';
  return null;
}

function whyText(k, reason) {
  const imp = num(k.impressions28);
  const pos = k.position28 ? r1(k.position28) : null;
  const before = histImpressions(k, 4);
  const clicks = num(k.clicks28);
  const base = `${imp} impressions and ${clicks} click${clicks === 1 ? '' : 's'} in 28 days`;
  if (reason === 'almost') return `Google shows it at position ${pos} (${base}). Page 1 is a small step away and that is where the clicks are.`;
  if (reason === 'close') return `Already at position ${pos} (${base}). A focused push can take it into the top 3.`;
  if (reason === 'rising') return `Searches went from ${before} to ${imp} impressions in 4 weeks${pos ? `, now at position ${pos}` : ''}. Demand is growing, so a page now catches it early.`;
  if (reason === 'no_page') return `${base}${pos ? `, position ${pos}` : ''}, but no page of ours is built for it. A page that matches the search should rank far higher.`;
  return `${base}${k.area ? ` for ${k.area}` : ''}. A page for that neighbourhood would own this search.`;
}

/**
 * keywords: SeoKeyword rows. opts: { dismissed: {matchKey: isoDate}, max, now }.
 * Returns up to `max` items, best first, at most MAX_PER_CLUSTER per service.
 */
function pickRecommendations(keywords, { dismissed = {}, max = 5, now = new Date() } = {}) {
  const hidden = (k) => dismissed[k.matchKey] && new Date(dismissed[k.matchKey]) > now;
  const scored = [];
  for (const k of keywords) {
    if (k.status === 'retired' || k.cluster === 'brand' || k.cluster === 'other' || k.focus || k.supportsId || hidden(k)) continue;
    const reason = classify(k);
    if (!reason) continue;
    scored.push({ k, reason, score: num(k.priority) * (BOOST[reason] || 1) });
  }
  scored.sort((a, b) => b.score - a.score);
  const perCluster = {};
  const out = [];
  for (const { k, reason } of scored) {
    if (out.length >= max) break;
    if ((perCluster[k.cluster] || 0) >= MAX_PER_CLUSTER) continue;
    perCluster[k.cluster] = (perCluster[k.cluster] || 0) + 1;
    const cur = currentPosition(k);
    out.push({
      id: k.id, keyword: k.keyword, matchKey: k.matchKey, cluster: k.cluster, kind: k.kind, reason,
      label: reason === 'area' && k.area ? `Demand in ${k.area}` : LABEL[reason],
      why: whyText(k, reason),
      position: cur ? r1(cur) : null, impressions28: num(k.impressions28), clicks28: num(k.clicks28), impressionsBefore: histImpressions(k, 4),
      queries: (k.scoreParts?.queries || []).slice(0, 3).map((q) => ({ q: q.q, imp: q.imp })),
      targetPath: k.targetPath || null, serp: k.serpPosition ?? null, competitors: (k.signals?.competitors || []).slice(0, 3),
      goal: cur && cur <= 10 ? 3 : 10,
    });
  }
  return out;
}

/** Weekly: pick, enrich with who ranks above us, store, tell the owner what is new. */
async function researchTick(userId, { now = new Date(), live = false } = {}) {
  const seo = await g.loadSeo(userId);
  const prev = seo.state.recommendations || null;
  const dismissed = Object.fromEntries(Object.entries(seo.state.recDismissed || {}).filter(([, until]) => new Date(until) > now));
  const keywords = await prisma.seoKeyword.findMany({ where: { userId } });
  const items = pickRecommendations(keywords, { dismissed, max: seo.cfg.recommendMax, now });

  if (live && serper.enabled() && items.length) {
    const b = serper.budget(seo.state, seo.cfg.serperWeeklyBudget, now);
    const host = new URL(seo.origin).hostname;
    const byId = Object.fromEntries(keywords.map((k) => [k.id, k]));
    for (const it of items) {
      const k = byId[it.id];
      if (k.serpCheckedAt && now - new Date(k.serpCheckedAt) < WEEK) continue;
      if (!b.take()) break;
      try {
        const sig = serper.serpSignals(await serper.search(k.keyword), host);
        await prisma.seoKeyword.update({ where: { id: k.id }, data: { serpPosition: sig.ourRank, serpCheckedAt: now,
          signals: { ...(k.signals || {}), paa: sig.paa.length > 0, paaQuestions: sig.paa, related: sig.related.length, relatedQueries: sig.related, competitors: sig.competitors, weakSerp: sig.weakSerp, checkedAt: now.toISOString() } } });
        it.serp = sig.ourRank; it.competitors = sig.competitors.slice(0, 3);
      } catch (e) { if ([401, 403].includes(e.response?.status)) break; }
    }
    await g.saveState(seo.row.id, { serper: b.snapshot() });
  }

  await g.saveState(seo.row.id, { recommendations: { at: now.toISOString(), week: serper.isoWeek(now), items }, recDismissed: dismissed });
  const known = new Set((prev?.items || []).map((i) => i.id));
  const fresh = items.filter((i) => !known.has(i.id));
  if (fresh.length) {
    await require('../../lib/notify').notify(userId, { category: 'seo', routineSlug: 'seo-roadmap', link: '/seo-growth.html#focus',
      title: `${fresh.length} keyword${fresh.length === 1 ? '' : 's'} worth targeting`,
      body: fresh.slice(0, 3).map((i) => `"${i.keyword}": ${i.label.toLowerCase()}`).join('; ') }).catch(() => {});
  }
  return { count: items.length, fresh: fresh.length };
}

async function dismiss(userId, keywordId, { now = new Date() } = {}) {
  const k = await prisma.seoKeyword.findFirst({ where: { id: keywordId, userId }, select: { matchKey: true } });
  if (!k) throw Object.assign(new Error('Unknown keyword'), { status: 404 });
  const seo = await g.loadSeo(userId);
  const rec = seo.state.recommendations;
  await g.saveState(seo.row.id, {
    recDismissed: { ...(seo.state.recDismissed || {}), [k.matchKey]: new Date(now.getTime() + DISMISS_WEEKS * WEEK).toISOString() },
    ...(rec ? { recommendations: { ...rec, items: rec.items.filter((i) => i.id !== keywordId) } } : {}),
  });
  return { ok: true };
}

module.exports = { pickRecommendations, researchTick, dismiss, classify, LABEL };
