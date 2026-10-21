/**
 * Focus campaigns: the owner picks a keyword to win, 5StarFlow plans and tracks everything around it.
 *   startFocus / setFocus   owner actions (routes/aiSeo.js)
 *   advanceFocus(userId)    after every rescore, publish and site crawl: reconcile each step with reality,
 *                           plan the next round, record milestones, notify the owner
 *   board(userId, ...)      what seo-growth.html shows
 *   promotions(userId)      live pieces waiting for a social post (handed to Night Studio through the work packet)
 * Claude only writes (posts, link sentences, social posts); every decision and every check lives here.
 */
const prisma = require('../../lib/prismaClient');
const { recordActivity } = require('../ledger');
const kw = require('./keywords');
const serper = require('./serper');
const g = require('./google');
const { toUrl } = require('./urls');
const R = require('./focusRules');

const DAY = 86400000;
const GOALS = [3, 10];
const err = (status, message) => Object.assign(new Error(message), { status });

async function notifyOwner(userId, title, body) {
  await require('../../lib/notify').notify(userId, { category: 'seo', title, body, link: '/seo-growth.html#focus', routineSlug: 'seo-gsc-sync' }).catch(() => {});
}

async function createStep(userId, keywordId, s) {
  return prisma.seoFocusStep.create({ data: { userId, keywordId, status: 'planned', ...s } });
}

/** One-time events on the timeline (started, top 10, goal reached, stalled). Returns true when it was new. */
async function milestone(userId, fk, key, title, detail = {}, { notify = null } = {}) {
  const exists = await prisma.seoFocusStep.findFirst({ where: { userId, keywordId: fk.id, kind: 'milestone', refId: key } });
  if (exists) return false;
  await createStep(userId, fk.id, { kind: 'milestone', status: 'done', doneAt: new Date(), title, refId: key, detail });
  if (notify) await notifyOwner(userId, notify.title, notify.body);
  return true;
}

const keywordIndex = (userId) => prisma.seoKeyword.findMany({
  where: { userId }, select: { id: true, keyword: true, matchKey: true, targetPath: true, kind: true, status: true, supportsId: true, focus: true, cluster: true, priority: true },
});

/** The candidate searches for supporting posts, best evidence first. */
function supportPhrases(fk, index, suggestions = []) {
  const ideas = index.filter((k) => k.cluster === fk.cluster && k.kind === 'blog' && !k.targetPath && ['idea', 'planned'].includes(k.status) && !k.supportsId && !k.focus)
    .sort((a, b) => b.priority - a.priority).slice(0, 40).map((k) => k.keyword);
  return [...(fk.scoreParts?.queries || []).map((q) => q.q), ...(fk.signals?.paaQuestions || []), ...(fk.signals?.relatedQueries || []), ...suggestions, ...ideas];
}

/** Plan one round of supporting posts when none are open. Returns how many were planned. */
async function planSupport(userId, fk, steps, cfg, suggestions = []) {
  const support = steps.filter((s) => s.kind === 'support');
  if (support.some((s) => R.OPEN_STEP.includes(s.status)) || support.length >= R.MAX_SUPPORT_TOTAL) return 0;
  const index = await keywordIndex(userId);
  const want = Math.min(cfg.focusSupportPosts, R.MAX_SUPPORT_TOTAL - support.length);
  const pick = R.pickSupportKeywords({ focus: fk, phrases: supportPhrases(fk, index, suggestions), index, max: want });
  let planned = 0;
  const attach = async (row) => {
    steps.push(await createStep(userId, fk.id, { kind: 'support', title: `Supporting post: "${row.keyword}"`, refId: row.id, detail: { keyword: row.keyword } }));
    planned++;
  };
  for (const a of pick.adopt) {
    await prisma.seoKeyword.update({ where: { id: a.id }, data: { supportsId: fk.id, status: 'planned', statusChangedAt: new Date() } });
    await attach(a);
  }
  for (const d of pick.create) {
    try {
      const row = await prisma.seoKeyword.create({ data: { userId, ...d, cluster: fk.cluster, intent: d.intent === 'transactional' ? 'informational' : d.intent, kind: 'blog', source: 'focus', status: 'planned', supportsId: fk.id } });
      await attach(row);
    } catch (e) { if (e.code !== 'P2002') throw e; }
  }
  return planned;
}

/** A researched idea from Claude (POST /seo/keywords with supportsId) joins the campaign if it passes the same filter. */
async function attachSupport(userId, focusId, row) {
  const fk = await prisma.seoKeyword.findFirst({ where: { id: focusId, userId, focus: true, focusStatus: 'active' } });
  if (!fk) return { attached: false, reason: 'that keyword has no active focus campaign' };
  if (row.id === fk.id) return { attached: false, reason: 'the focus keyword cannot support itself' };
  if (row.targetPath || row.supportsId || row.focus || row.status === 'retired') return { attached: false, reason: 'already owned by a page or another campaign' };
  const pick = R.pickSupportKeywords({ focus: fk, phrases: [row.keyword], index: [{ ...row }], max: 1 });
  if (!pick.adopt.length && !pick.create.length) return { attached: false, reason: 'off topic for this campaign, or a service/area head term' };
  const steps = await prisma.seoFocusStep.findMany({ where: { userId, keywordId: fk.id, kind: 'support' } });
  if (steps.length >= R.MAX_SUPPORT_TOTAL) return { attached: false, reason: 'the campaign already has the maximum number of supporting posts' };
  await prisma.seoKeyword.update({ where: { id: row.id }, data: { supportsId: fk.id, cluster: fk.cluster, kind: 'blog', status: row.status === 'idea' ? 'planned' : row.status, statusChangedAt: new Date() } });
  await createStep(userId, fk.id, { kind: 'support', title: `Supporting post: "${row.keyword}"`, refId: row.id, detail: { keyword: row.keyword, from: 'claude' } });
  return { attached: true };
}

/** Owner picked a keyword: mark it, take a rank reading, plan the campaign. */
async function startFocus(userId, keywordId, { goal, now = new Date(), live = true } = {}) {
  const seo = await g.loadSeo(userId);
  const k = await prisma.seoKeyword.findFirst({ where: { id: keywordId, userId } });
  if (!k) throw err(404, 'Unknown keyword');
  if (k.status === 'retired' || k.cluster === 'brand') throw err(400, 'That keyword cannot be focused');
  const active = await prisma.seoKeyword.count({ where: { userId, focus: true, focusStatus: 'active', id: { not: k.id } } });
  if (active >= seo.cfg.focusMax) throw err(409, `You can focus ${seo.cfg.focusMax} keywords at a time. Pause or stop one first.`);

  const data = { focus: true, focusStatus: 'active', focusSince: k.focus && k.focusSince ? k.focusSince : now, focusGoal: GOALS.includes(Number(goal)) ? Number(goal) : (k.focusGoal || 3),
    pinned: true, rankTrack: true, supportsId: null, ...(k.status === 'idea' ? { status: 'planned', statusChangedAt: now } : {}) };
  let suggestions = [];
  let note = null;
  if (live && serper.enabled()) {
    const b = serper.budget(seo.state, seo.cfg.serperWeeklyBudget, now);
    try {
      const host = new URL(seo.origin).hostname;
      if (b.take()) {
        const sig = serper.serpSignals(await serper.search(k.keyword), host);
        Object.assign(data, { serpPosition: sig.ourRank, serpCheckedAt: now,
          signals: { ...(k.signals || {}), paa: sig.paa.length > 0, paaQuestions: sig.paa, related: sig.related.length, relatedQueries: sig.related, competitors: sig.competitors, weakSerp: sig.weakSerp, checkedAt: now.toISOString() } });
        if ((k.kind === 'service' || k.kind === 'area') && b.take()) data.mapPackPosition = serper.ourPlacesRank(await serper.places(k.keyword), host);
      }
      if (b.take()) suggestions = ((await serper.autocomplete(k.keyword)).suggestions || []).map((s) => s.value || s).filter((s) => typeof s === 'string');
    } catch (e) { note = `Serper check failed: ${e.response?.status || e.message}`; }
    await g.saveState(seo.row.id, { serper: b.snapshot() });
  }
  const merged = { ...k, ...data };
  const cur = R.currentPosition(merged);
  if (!k.baselineAt && cur) Object.assign(data, { baselinePosition: cur, baselineImpressions: k.impressions28, baselineAt: now });
  const fk = await prisma.seoKeyword.update({ where: { id: k.id }, data });

  await milestone(userId, fk, `started:${now.toISOString().slice(0, 10)}`, 'Focus started', { position: cur, serp: fk.serpPosition, map: fk.mapPackPosition, goal: fk.focusGoal });
  const plan = await planSteps(userId, fk, seo, suggestions);
  await advanceFocus(userId, { now });
  await recordActivity(userId, { agent: 'research', routineSlug: 'seo-roadmap', action: `Focus started: ${fk.keyword}`, summary: `${plan.summary}${note ? `; ${note}` : ''}`, result: 'ok', source: 'owner' });
  return { keyword: fk, plan: { ...plan, note } };
}

/** First plan for a campaign: the page that owns the keyword, a round of supporting posts. Idempotent. */
async function planSteps(userId, fk, seo, suggestions = []) {
  const steps = await prisma.seoFocusStep.findMany({ where: { userId, keywordId: fk.id } });
  const made = { page: 0, support: 0 };
  const page = fk.targetPath ? await prisma.seoPage.findUnique({ where: { userId_path: { userId, path: fk.targetPath } } }) : null;
  if (!R.live(page) && !steps.some((s) => s.kind === 'page' && s.status !== 'skipped')) {
    await createStep(userId, fk.id, { kind: 'page', title: fk.kind === 'blog' ? `Write the post for "${fk.keyword}"` : `Build the ${fk.keyword} page`, detail: { kind: fk.kind } });
    made.page = 1;
  }
  made.support = await planSupport(userId, fk, steps, seo.cfg, suggestions);
  const parts = [made.page ? (fk.kind === 'blog' ? '1 post' : '1 landing page') : null, made.support ? `${made.support} supporting post${made.support === 1 ? '' : 's'}` : null].filter(Boolean);
  return { ...made, summary: parts.length ? `Planned: ${parts.join(', ')}; links and social posts are added as pages go live` : 'Nothing new to plan yet; the campaign is already set up' };
}

/** Pause, resume, stop or change the goal. */
async function setFocus(userId, id, { status, goal } = {}) {
  const seo = await g.loadSeo(userId);
  const k = await prisma.seoKeyword.findFirst({ where: { id, userId, focus: true } });
  if (!k) throw err(404, 'That keyword has no focus campaign');
  const data = {};
  if (GOALS.includes(Number(goal))) data.focusGoal = Number(goal);
  if (status === 'active') {
    const active = await prisma.seoKeyword.count({ where: { userId, focus: true, focusStatus: 'active', id: { not: k.id } } });
    if (active >= seo.cfg.focusMax) throw err(409, `You can focus ${seo.cfg.focusMax} keywords at a time. Pause or stop one first.`);
    data.focusStatus = 'active';
  } else if (status === 'paused') data.focusStatus = 'paused';
  else if (status === 'stopped') {
    Object.assign(data, { focus: false, focusStatus: 'stopped' });
    await prisma.seoFocusStep.updateMany({ where: { userId, keywordId: k.id, status: { in: R.OPEN_STEP }, kind: { not: 'milestone' } }, data: { status: 'skipped' } });
    await prisma.seoKeyword.updateMany({ where: { userId, supportsId: k.id, targetPath: null, status: 'planned' }, data: { supportsId: null, status: 'idea' } });
  }
  const fk = await prisma.seoKeyword.update({ where: { id: k.id }, data });
  if (data.focusStatus === 'active') await advanceFocus(userId);
  return fk;
}

/**
 * Bring every active campaign up to date: reconcile steps with reality, plan what comes next, record milestones.
 * Safe to call as often as you like.
 */
async function advanceFocus(userId, { now = new Date() } = {}) {
  const camps = await prisma.seoKeyword.findMany({ where: { userId, focus: true, focusStatus: 'active' } });
  if (!camps.length) return { campaigns: 0, changed: 0 };
  const seo = await g.loadSeo(userId);
  const campIds = camps.map((c) => c.id);
  const [pageRows, supporters, content, allSteps] = await Promise.all([
    prisma.seoPage.findMany({ where: { userId } }),
    prisma.seoKeyword.findMany({ where: { userId, supportsId: { in: campIds } } }),
    prisma.contentItem.findMany({ where: { userId, grounding: { not: null }, status: { in: ['draft', 'rendered', 'queued', 'approved', 'published'] } }, select: { status: true, grounding: true }, orderBy: { createdAt: 'desc' }, take: 300 }),
    prisma.seoFocusStep.findMany({ where: { userId, keywordId: { in: campIds } }, orderBy: { createdAt: 'asc' } }),
  ]);
  const pages = Object.fromEntries(pageRows.map((p) => [p.path, p]));
  const byId = Object.fromEntries([...supporters, ...camps].map((k) => [k.id, k]));
  let changed = 0;

  for (const fk of camps) {
    const steps = allSteps.filter((s) => s.keywordId === fk.id);
    const ctx = { focus: fk, pages, byId, content };
    for (const s of steps) {
      if (s.kind === 'milestone' || s.status === 'skipped') continue;
      const next = R.reconcileStep(s, ctx).status;
      if (next === s.status) continue;
      const upd = await prisma.seoFocusStep.update({ where: { id: s.id }, data: { status: next, ...(next === 'done' ? { doneAt: now } : {}) } });
      Object.assign(s, upd);
      changed++;
    }
    const page = fk.targetPath ? pages[fk.targetPath] : null;
    const pageLive = R.live(page);

    // the focus page itself needs a social post once it is live, and so does each supporting post
    const promoted = new Set(steps.filter((s) => s.kind === 'social').map((s) => s.refId));
    const pieces = [];
    if (pageLive) pieces.push({ path: fk.targetPath, title: page.title || fk.keyword, keyword: fk.keyword, role: 'focus page' });
    for (const s of steps.filter((x) => x.kind === 'support' && x.status === 'done')) {
      const sk = byId[s.refId];
      if (sk?.targetPath) pieces.push({ path: sk.targetPath, title: pages[sk.targetPath]?.title || sk.keyword, keyword: sk.keyword, role: 'supporting post' });
    }
    const openSocial = steps.filter((s) => s.kind === 'social' && R.OPEN_STEP.includes(s.status)).length;
    let room = Math.max(0, 3 - openSocial);
    for (const p of pieces) {
      if (!room || promoted.has(p.path)) continue;
      steps.push(await createStep(userId, fk.id, { kind: 'social', title: `Promote on social: ${p.title}`, refId: p.path, detail: { url: toUrl(p.path, seo.origin), keyword: p.keyword, role: p.role } }));
      room--; changed++;
    }

    if (pageLive && R.focusRefreshDue(page, fk, seo.cfg, now) && !steps.some((s) => s.kind === 'refresh' && (R.OPEN_STEP.includes(s.status) || now - new Date(s.createdAt) < 45 * DAY))) {
      const cur = R.currentPosition(fk);
      steps.push(await createStep(userId, fk.id, { kind: 'refresh', title: `Refresh the page: ${cur ? `at position ${R.r1(cur)}` : 'not showing in Google'}, goal ${fk.focusGoal}` }));
      changed++;
    }

    if (seo.cfg.focusLinks && pageLive) {
      const has = new Set(steps.filter((s) => s.kind === 'links' && s.status !== 'skipped').map((s) => s.detail?.from));
      const open = steps.filter((s) => s.kind === 'links' && R.OPEN_STEP.includes(s.status)).length;
      const already = new Set(Array.isArray(page.linkedFrom) ? page.linkedFrom : []);
      const sources = pageRows.filter((p) => p.kind === 'blog' && R.live(p) && p.cluster === fk.cluster && p.path !== fk.targetPath && !already.has(p.path) && !has.has(p.path))
        .sort((a, b) => b.impressions28 - a.impressions28).slice(0, Math.max(0, seo.cfg.focusLinkPosts - open));
      const done = steps.filter((s) => ['support', 'links'].includes(s.kind) && s.status === 'done').length;
      for (const [i, p] of sources.entries()) {
        steps.push(await createStep(userId, fk.id, { kind: 'links', title: `Link to the focus page from "${p.title || p.path}"`, refId: p.path, detail: { from: p.path, to: fk.targetPath, anchor: R.anchorFor(fk, done + i) } }));
        changed++;
      }
    }

    if (pageLive && !steps.some((s) => s.kind === 'support' && R.OPEN_STEP.includes(s.status))) changed += await planSupport(userId, fk, steps, seo.cfg);

    const cur = R.currentPosition(fk);
    const started = steps.find((s) => s.kind === 'milestone' && String(s.refId).startsWith('started:'));
    const startPos = started?.detail?.position ?? fk.baselinePosition ?? null;
    if (cur && cur <= 10 && await milestone(userId, fk, 'top10', 'Reached the top 10 on Google', { position: R.r1(cur) },
      { notify: { title: `"${fk.keyword}" is in Google's top 10`, body: `Now at position ${R.r1(cur)}. Goal: top ${fk.focusGoal}.` } })) changed++;
    if (R.hasReachedGoal(fk.history, fk.focusGoal)) {
      await prisma.seoKeyword.update({ where: { id: fk.id }, data: { focusStatus: 'won' } });
      await milestone(userId, fk, 'won', `Goal reached: top ${fk.focusGoal}`, { position: R.r1(cur) },
        { notify: { title: `Goal reached: "${fk.keyword}" is in the top ${fk.focusGoal}`, body: 'Two weekly rank checks in a row. The campaign is marked won; pick the next keyword to focus.' } });
      changed++;
      continue;
    }
    if (pageLive && fk.focusSince && now - new Date(fk.focusSince) > 45 * DAY && startPos && (!cur || startPos - cur < 3)
      && await milestone(userId, fk, 'stalled', 'Not moving yet', { position: cur ? R.r1(cur) : null, startPosition: startPos },
        { notify: { title: `"${fk.keyword}" has not moved in 45 days`, body: 'The campaign keeps going. Check the Focus tab for what is still waiting.' } })) changed++;
  }
  return { campaigns: camps.length, changed };
}

const stepUrl = (s, fk, pages, byId, origin) => {
  if (s.kind === 'page' || s.kind === 'refresh') return fk.targetPath && R.live(pages[fk.targetPath]) ? toUrl(fk.targetPath, origin) : null;
  if (s.kind === 'support') { const sk = byId[s.refId]; return sk?.targetPath && R.live(pages[sk.targetPath]) ? toUrl(sk.targetPath, origin) : null; }
  if (s.kind === 'links') return s.detail?.from ? toUrl(s.detail.from, origin) : null;
  if (s.kind === 'social') return s.detail?.url || null;
  return null;
};

const NEXT_TEXT = {
  page: (s, fk) => (fk.kind === 'blog' ? `The daily blog run writes the post for "${fk.keyword}" next` : `The daily blog run builds the ${fk.keyword} page next`),
  refresh: () => 'The next blog run rewrites the page to push it up',
  support: (s) => `Next supporting post: ${s.detail?.keyword || s.title}`,
  links: (s) => s.title,
  social: () => 'Night Studio makes a social post about it tonight',
};

/** What seo-growth.html shows: one card per campaign (best momentum first) and the ranked list of everything being worked on. */
async function board(userId, { keywords, pages, seo, now = new Date() }) {
  const camps = keywords.filter((k) => k.focus && ['active', 'paused', 'won'].includes(k.focusStatus));
  const steps = camps.length ? await prisma.seoFocusStep.findMany({ where: { userId, keywordId: { in: camps.map((c) => c.id) } }, orderBy: { createdAt: 'asc' } }) : [];
  const byId = Object.fromEntries(keywords.map((k) => [k.id, k]));
  const cards = camps.map((fk) => {
    const mine = steps.filter((s) => s.keywordId === fk.id);
    const started = mine.find((s) => s.kind === 'milestone' && String(s.refId).startsWith('started:'));
    const start = started?.detail?.position ?? fk.baselinePosition ?? null;
    const cur = R.currentPosition(fk);
    const work = mine.filter((s) => s.kind !== 'milestone' && s.status !== 'skipped');
    const count = (kind) => ({ done: work.filter((s) => s.kind === kind && s.status === 'done').length, total: work.filter((s) => s.kind === kind).length });
    const open = ['page', 'refresh', 'support', 'links', 'social'].map((kind) => work.find((s) => s.kind === kind && R.OPEN_STEP.includes(s.status))).find(Boolean);
    const timeline = mine.filter((s) => s.status === 'done' && s.doneAt).map((s) => ({ at: s.doneAt, kind: s.kind, text: s.kind === 'milestone' ? s.title : s.title.replace(/^(Supporting post|Promote on social|Write the post for|Build the)/, (m) => ({ 'Supporting post': 'Published supporting post', 'Promote on social': 'Social post queued', 'Write the post for': 'Published the post for', 'Build the': 'Built the' }[m])) }))
      .sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);
    return { id: fk.id, keyword: fk.keyword, kind: fk.kind, status: fk.focusStatus, goal: fk.focusGoal, since: fk.focusSince, start: R.r1(start), position: R.r1(cur), best: R.r1(fk.bestPosition),
      serp: fk.serpPosition, map: fk.mapPackPosition, impressions28: fk.impressions28, clicks28: fk.clicks28, targetPath: fk.targetPath, url: fk.targetPath ? toUrl(fk.targetPath, seo.origin) : null,
      progress: R.progressToGoal(start, cur, fk.focusGoal), gain4w: R.positionGain(fk.history, 4), history: (Array.isArray(fk.history) ? fk.history : []).slice(-12),
      counts: { support: count('support'), links: count('links'), social: count('social'), refresh: count('refresh') },
      steps: work.map((s) => ({ id: s.id, kind: s.kind, status: s.status, title: s.title, doneAt: s.doneAt, url: stepUrl(s, fk, pages, byId, seo.origin) })),
      timeline, next: fk.focusStatus === 'paused' ? 'Paused: nothing new is planned or assigned' : fk.focusStatus === 'won' ? 'Goal reached' : open ? NEXT_TEXT[open.kind](open, fk) : 'Watching the weekly rank check for movement' };
  }).sort((a, b) => ((b.gain4w ?? -99) - (a.gain4w ?? -99)) || (b.progress - a.progress));

  const working = keywords.filter((k) => k.status !== 'retired' && k.cluster !== 'brand' && (k.focus || k.pinned || k.supportsId || (k.targetPath && k.priority > 0)))
    .sort((a, b) => b.priority - a.priority).slice(0, 25)
    .map((k, i) => ({ rank: i + 1, id: k.id, keyword: k.keyword, status: k.status, role: k.focus ? 'focus' : k.supportsId ? 'supporting' : k.pinned ? 'pinned' : 'owned', priority: R.r1(k.priority),
      position: R.r1(R.currentPosition(k)), gain4w: R.positionGain(k.history, 4), impressions28: k.impressions28, targetPath: k.targetPath, why: k.scoreParts?.why || '' }));
  return { max: seo.cfg.focusMax, active: camps.filter((c) => c.focusStatus === 'active').length, campaigns: cards, working };
}

/** Live pieces still waiting for a social post: the content agent's to-do list, one per piece. */
async function promotions(userId, { limit = 3 } = {}) {
  const steps = await prisma.seoFocusStep.findMany({ where: { userId, kind: 'social', status: 'planned' }, orderBy: { createdAt: 'asc' }, take: 30 });
  if (!steps.length) return [];
  const camps = await prisma.seoKeyword.findMany({ where: { userId, id: { in: [...new Set(steps.map((s) => s.keywordId))] }, focusStatus: 'active' } });
  const out = [];
  for (const c of camps) {
    const promote = steps.filter((s) => s.keywordId === c.id).slice(0, limit).map((s) => ({ stepId: s.id, url: s.detail?.url, title: s.title.replace(/^Promote on social: /, ''), keyword: s.detail?.keyword, role: s.detail?.role }));
    if (promote.length) out.push({ keyword: c.keyword, goal: c.focusGoal, position: R.r1(R.currentPosition(c)), promote });
  }
  return out.slice(0, limit);
}

/** The writer reported a links edit on `path`: the matching step moves to in progress until the crawl confirms the link. */
async function noteLinked(userId, path) {
  const steps = await prisma.seoFocusStep.findMany({ where: { userId, kind: 'links', status: { in: R.OPEN_STEP }, refId: path } });
  for (const s of steps) await prisma.seoFocusStep.update({ where: { id: s.id }, data: { status: 'in_progress', detail: { ...(s.detail || {}), reportedAt: new Date().toISOString() } } });
  return steps.length;
}

module.exports = { startFocus, planSteps, setFocus, advanceFocus, attachSupport, board, promotions, noteLinked, GOALS };
