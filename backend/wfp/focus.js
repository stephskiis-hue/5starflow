/**
 * Focus campaigns: the owner picks up to FOCUS_MAX keywords and a goal (top 3 or top 10). The campaign is the main
 * post, FOCUS_SUPPORT supporting posts that link to it (People Also Ask, related searches and Search Console queries
 * on the same topic), weekly rank tracking and a refresh after 21 days while it is short of the goal (wfp/plan.js).
 * research.rescore() marks a campaign won when Search Console or Serper shows it at the goal.
 */
const prisma = require('../lib/prismaClient');
const { getConfig } = require('./settings');
const kw = require('./keywords');
const g = require('./google');
const { getState, setState, note } = require('./runner');
const { addKeywords, fits, withCity } = require('./research');

async function startFocus(id, goal = 3) {
  const cfg = await getConfig();
  const k = await prisma.wfpKeyword.findUnique({ where: { id } });
  if (!k) throw Object.assign(new Error('Keyword not found'), { status: 404 });
  const active = await prisma.wfpKeyword.count({ where: { focus: true, focusStatus: 'active', id: { not: id } } });
  if (active >= cfg.focusMax) throw Object.assign(new Error(`Already ${active} focus keywords (max ${cfg.focusMax}). Stop one first or raise the limit in Settings.`), { status: 409 });
  await prisma.wfpKeyword.update({
    where: { id },
    data: { focus: true, focusStatus: 'active', focusGoal: goal === 10 ? 10 : 3, focusSince: new Date(), rankTrack: true, recommended: false, supportsId: null,
      status: k.status === 'idea' || k.status === 'retired' ? 'planned' : k.status },
  });
  const added = await planSupports(id, cfg);
  await note('system', 'milestone', `Focus started: ${k.keyword}`, `Goal: top ${goal === 10 ? 10 : 3}. ${added} supporting post${added === 1 ? '' : 's'} planned.`);
  return { ok: true, supports: added };
}

/** Plan supporting keywords up to FOCUS_SUPPORT. Returns how many were attached. */
async function planSupports(id, cfg) {
  const f = await prisma.wfpKeyword.findUnique({ where: { id } });
  const have = await prisma.wfpKeyword.count({ where: { supportsId: id } });
  const need = cfg.focusSupport - have;
  if (need <= 0) return 0;

  let signals = f.signals || {};
  if (!(signals.paa?.length || signals.related?.length) && cfg.SERPER_API_KEY) {
    const budget = g.serperBudget(await getState('serper'), cfg.serperWeeklyBudget);
    if (budget.take()) {
      const sr = await g.serper(cfg, '/search', { q: withCity(f.keyword, cfg.CITY), num: 20 }).catch(() => null);
      await setState('serper', budget.snapshot());
      if (sr) {
        signals = { ...signals, paa: (sr.peopleAlsoAsk || []).map((p) => p.question).slice(0, 8), related: (sr.relatedSearches || []).map((r) => r.query).slice(0, 8) };
        await prisma.wfpKeyword.update({ where: { id }, data: { signals } });
      }
    }
  }

  // same topic: the focus keyword's words (minus generic ones) must all be there
  const core = f.matchKey.split(' ').filter((w) => !['cost', 'best', 'company', 'contractor', 'installation'].includes(w));
  const onTopic = (phrase) => { const m = ` ${kw.matchKey(phrase)} `; return kw.matchKey(phrase) !== f.matchKey && core.some((w) => m.includes(` ${w} `)); };
  const ideas = [];
  for (const p of [...(signals.paa || []), ...(signals.related || [])]) ideas.push(p);
  const queries = await prisma.wfpQuery.findMany({ orderBy: { impressions: 'desc' }, take: 300 });
  for (const q of queries) ideas.push(q.query);
  const existing = await prisma.wfpKeyword.findMany({ where: { status: { in: ['idea', 'planned'] }, supportsId: null, focus: false, service: f.service || undefined }, orderBy: { priority: 'desc' }, take: 50 });
  for (const e of existing) ideas.push(e.keyword);

  const seen = new Set();
  const chosen = [];
  for (const phrase of ideas) {
    if (chosen.length >= need) break;
    const m = kw.matchKey(phrase);
    if (!m || seen.has(m) || !onTopic(phrase) || kw.isOffTopic(phrase) || kw.isBranded(phrase, cfg.brandTerms)) continue;
    seen.add(m);
    const row = await prisma.wfpKeyword.findUnique({ where: { matchKey: m } });
    if (row && (row.focus || row.supportsId || !['idea', 'planned'].includes(row.status))) continue;
    chosen.push(phrase);
  }
  let attached = 0;
  for (const phrase of chosen) {
    const m = kw.matchKey(phrase);
    const row = await prisma.wfpKeyword.findUnique({ where: { matchKey: m } });
    if (row) await prisma.wfpKeyword.update({ where: { id: row.id }, data: { supportsId: id, status: 'planned' } });
    else await addKeywords([{ keyword: phrase, source: 'focus', supportsId: id, status: 'planned' }], cfg);
    attached += 1;
  }
  return attached;
}

async function stopFocus(id) {
  const k = await prisma.wfpKeyword.update({ where: { id }, data: { focus: false, focusStatus: 'stopped' } });
  await prisma.wfpKeyword.updateMany({ where: { supportsId: id, status: { in: ['idea', 'planned'] } }, data: { supportsId: null } });
  await note('system', 'milestone', `Focus stopped: ${k.keyword}`, 'Unwritten supporting posts went back to the general keyword list.');
  return { ok: true };
}

/** Focus campaigns with their supporting keywords and posts, for the Focus tab. */
async function focusBoard() {
  const focus = await prisma.wfpKeyword.findMany({ where: { focus: true }, orderBy: { focusSince: 'asc' } });
  const ids = focus.map((f) => f.id);
  const supports = ids.length ? await prisma.wfpKeyword.findMany({ where: { supportsId: { in: ids } }, orderBy: { priority: 'desc' } }) : [];
  const posts = ids.length ? await prisma.wfpPost.findMany({ where: { keywordId: { in: [...ids, ...supports.map((s) => s.id)] } }, orderBy: { createdAt: 'desc' }, select: { id: true, keywordId: true, title: true, url: true, status: true, mode: true, publishedAt: true, createdAt: true } }) : [];
  return focus.map((f) => ({ ...f, supports: supports.filter((s) => s.supportsId === f.id), posts: posts.filter((p) => p.keywordId === f.id || supports.some((s) => s.id === p.keywordId && s.supportsId === f.id)) }));
}

module.exports = { startFocus, stopFocus, planSupports, focusBoard };
