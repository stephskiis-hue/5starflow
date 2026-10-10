// SEO Growth Engine pure-logic tests (no database, no network): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalPath, siteOrigin, dupKey, kindForPath, isAsset } = require('../ai/seo/urls');
const { parseSitemap, sitemapHash, robotsSitemaps } = require('../ai/seo/sitemap');
const { extractPageFacts } = require('../ai/seo/html');
const kw = require('../ai/seo/keywords');
const { expectedCtr, calibrate, seasonFactor, scoreKeyword, lowCtrFlag, findCannibalization, weightedPosition } = require('../ai/seo/scoring');
const { nextStatus } = require('../ai/seo/lifecycle');
const { pickAssignment, chooseContentType } = require('../ai/seo/assignPick');
const { mergeConfig } = require('../ai/seo/config');

const O = 'https://www.no-bs-yardwork.com';
const DAY = 86400000;
const NOW = new Date('2026-10-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

test('urls: .html, index.html, slashes, query and hash collapse to one path', () => {
  for (const href of ['/about.html', '/about', '/about/', 'about.html?x=1#top', `${O}/about.html`, 'http://no-bs-yardwork.com/about']) {
    assert.equal(canonicalPath(href, `${O}/blog`), '/about', href);
  }
  assert.equal(canonicalPath('/index.html', O), '/');
  assert.equal(canonicalPath(O, O), '/');
  assert.equal(canonicalPath('https://example.com/about', O), null);
  assert.equal(canonicalPath('mailto:a@b.c', O), null);
  assert.equal(canonicalPath('blog/partnership-opportunities', `${O}/blog/x`), '/blog/blog/partnership-opportunities');
});

test('urls: case is kept but duplicates share a key; origin + kind', () => {
  assert.equal(canonicalPath('/Spring-Fall-Cleanups', O), '/Spring-Fall-Cleanups');
  assert.equal(dupKey('/Spring-Fall-Cleanups'), dupKey('/spring-fall-cleanups'));
  assert.equal(siteOrigin('https://www.no-bs-yardwork.com/'), O);
  assert.equal(siteOrigin('sc-domain:no-bs-yardwork.com'), O);
  assert.equal(siteOrigin('no-bs-yardwork.com'), O);
  assert.equal(kindForPath('/blog-mulch-cost-winnipeg'), 'blog');
  assert.equal(kindForPath('/blog'), 'hub');
  assert.equal(kindForPath('/'), 'home');
  assert.equal(kindForPath('/fencing-winnipeg', ['/fencing-winnipeg']), 'service');
  assert.ok(isAsset('/images/a.webp') && !isAsset('/blog-a'));
});

test('sitemap: parses an index and a urlset; hash ignores order and whitespace', () => {
  const index = parseSitemap(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc> ${O}/sitemap.xml </loc><lastmod>2026-10-08</lastmod></sitemap><sitemap><loc>${O}/blog-sitemap.xml</loc></sitemap></sitemapindex>`);
  assert.equal(index.isIndex, true);
  assert.deepEqual(index.entries.map((e) => e.loc), [`${O}/sitemap.xml`, `${O}/blog-sitemap.xml`]);
  assert.equal(index.entries[1].lastmod, null);
  const a = parseSitemap(`<urlset><url><loc>${O}/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>${O}/b</loc></url></urlset>`);
  const b = parseSitemap(`<urlset>\n<url><loc>${O}/b</loc></url>\n  <url><loc>${O}/a</loc><lastmod>2026-01-01</lastmod></url></urlset>`);
  assert.equal(a.isIndex, false);
  assert.equal(sitemapHash(a.entries), sitemapHash(b.entries));
  const c = parseSitemap(`<urlset><url><loc>${O}/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>${O}/b</loc></url></urlset>`);
  assert.notEqual(sitemapHash(a.entries), sitemapHash(c.entries));
  assert.deepEqual(robotsSitemaps('User-agent: *\nDisallow:/tag/\n\nSitemap: https://x.com/sitemap_index.xml\nsitemap:https://x.com/b.xml'), ['https://x.com/sitemap_index.xml', 'https://x.com/b.xml']);
});

test('html: canonical, noindex, h1, links and word count', () => {
  const f = extractPageFacts(`<html><head><title> Fence Repair | No-BS </title><link rel="canonical" href="${O}/x.html">
    <meta name="robots" content="noindex, follow"></head><body><h1>Fence repair</h1><p>one two three</p>
    <script>var hidden = "not counted words here";</script><a href="/a.html">A</a><a href="tel:1">call</a></body></html>`);
  assert.equal(f.title, 'Fence Repair | No-BS');
  assert.equal(f.canonical, `${O}/x.html`);
  assert.equal(f.noindex, true);
  assert.equal(f.h1, 'Fence repair');
  assert.deepEqual(f.links, ['/a.html', 'tel:1']);
  assert.equal(f.wordCount, 7);
});

test('keywords: synonyms, plurals, places and years collapse to one key', () => {
  assert.equal(kw.matchKey('Snow clearing in Winnipeg, MB'), kw.matchKey('snow removal winnipeg'));
  assert.equal(kw.matchKey('Fall clean-ups Winnipeg'), kw.matchKey('fall cleanup near me'));
  assert.equal(kw.matchKey('lawn aeration winnipeg'), kw.matchKey('aeration winnipeg'));
  assert.equal(kw.matchKey('fence repair cost winnipeg 2026'), kw.matchKey('fence repair cost winnipeg'));
  assert.equal(kw.matchKey('snow removal cost'), kw.matchKey('snow removal cost winnipeg'));      // local business: place is implied
  assert.equal(kw.matchKey('snow removal winnipeg prices'), kw.matchKey('how much does snow removal cost in winnipeg'));
  assert.notEqual(kw.matchKey('snow removal winnipeg'), kw.matchKey('snow removal cost winnipeg'));
  assert.equal(kw.normalizeKeyword("  What's the BEST time?? "), 'whats the best time');
  assert.ok(kw.isBranded('No BS Yardwork reviews'));
  assert.ok(!kw.isBranded('snow removal winnipeg'));
});

test('keywords: intent, kind, cluster, area and content type', () => {
  assert.deepEqual(kw.describeKeyword('snow removal winnipeg'), { keyword: 'snow removal winnipeg', matchKey: kw.matchKey('snow removal winnipeg'), cluster: 'snow-removal', intent: 'transactional', kind: 'service', area: null });
  assert.equal(kw.classifyIntent('how much does aeration cost in winnipeg'), 'commercial');
  assert.equal(kw.kindFor('how much does aeration cost in winnipeg'), 'blog');
  assert.equal(kw.classifyIntent('when to aerate lawn winnipeg'), 'informational');
  assert.equal(kw.classifyIntent('last mow of the season winnipeg'), 'informational');
  assert.equal(kw.classifyIntent('yellow grass winnipeg'), 'informational');
  assert.equal(kw.kindFor('best snow removal winnipeg'), 'service');
  assert.equal(kw.kindFor('snow removal winnipeg reviews'), 'service');
  assert.equal(kw.classifyIntent('best time to aerate lawn winnipeg'), 'informational');
  assert.equal(kw.kindFor('lawn care st vital'), 'area');
  assert.equal(kw.areaFor('snow removal in Saint Boniface'), 'St. Boniface');
  assert.equal(kw.clusterFor('snow mold on my lawn'), 'spring-cleanup');
  assert.equal(kw.clusterFor('dethatching winnipeg'), 'power-raking');
  assert.equal(kw.clusterFor('wood vs vinyl fence'), 'fencing');
  assert.equal(kw.clusterFor('no bs yardwork'), 'brand');
  assert.equal(kw.contentTypeFor('fence repair cost winnipeg'), 'cost guide');
  assert.equal(kw.contentTypeFor('wood vs vinyl fence'), 'comparison');
  assert.equal(kw.contentTypeFor('when to stop watering lawn'), 'timing guide');
  assert.equal(kw.contentTypeFor('how to winterize a lawn'), 'how-to');
  assert.equal(kw.contentTypeFor('fall lawn care tips'), 'tips');
  assert.equal(kw.contentTypeFor('lawn care winnipeg'), null);
});

test('keywords: matchQuery prefers exact, then filler-only containment, then overlap', () => {
  const idx = ['aeration cost winnipeg', 'snow removal winnipeg', 'aeration winnipeg'].map((k) => ({ id: k, matchKey: kw.matchKey(k) }));
  assert.equal(kw.matchQuery('how much does aeration cost in winnipeg', idx)?.id, 'aeration cost winnipeg');
  assert.equal(kw.matchQuery('best snow removal company winnipeg', idx)?.id, 'snow removal winnipeg');
  assert.equal(kw.matchQuery('core aeration near me', idx)?.id, 'aeration winnipeg');
  assert.equal(kw.matchQuery('snow removal cost winnipeg', idx), null);   // "cost" changes the intent
  assert.equal(kw.matchQuery('fence installation', idx), null);
});

test('scoring: CTR curve is exact at the table points, interpolates and never rises', () => {
  assert.equal(expectedCtr(1), 0.27);
  assert.equal(expectedCtr(10), 0.017);
  assert.ok(Math.abs(expectedCtr(2.5) - 0.125) < 1e-9);
  let prev = 1;
  for (let p = 1; p <= 100; p += 0.5) { const c = expectedCtr(p); assert.ok(c <= prev + 1e-12, `pos ${p}`); prev = c; }
  assert.equal(calibrate([]), 1);
  const rows = Array.from({ length: 12 }, () => ({ position: 3, impressions: 100, clicks: 50 }));
  assert.equal(calibrate(rows), 1.5);                      // clamped
});

test('scoring: striking distance beats top 3 and deep positions; season and intent weigh in', () => {
  const base = { impressions: 300, clicks: 3, intent: 'informational', peaks: [] };
  const s = (pos) => scoreKeyword({ ...base, position: pos }, { month: 10 }).score;
  assert.ok(s(8) > s(2), 'page 1 bottom > top 3');
  assert.ok(s(8) > s(45), 'page 1 bottom > page 5');
  assert.ok(s(14) > s(45));
  const t = scoreKeyword({ ...base, position: 8, intent: 'transactional' }, { month: 10 }).score;
  assert.ok(t > s(8));
  assert.ok(seasonFactor(7, [8, 9]) > seasonFactor(1, [8, 9]), 'aeration: July (pre-peak) > January');
  assert.ok(seasonFactor(9, [10, 11, 12, 1, 2]) > seasonFactor(5, [10, 11, 12, 1, 2]), 'snow: Sept > May');
  assert.equal(seasonFactor(5, []), 1);
  const gap = scoreKeyword({ impressions: 0, position: null, intent: 'commercial', peaks: [10], signals: { autocomplete: true, paa: true, related: 3 } }, { month: 9 });
  assert.equal(gap.parts.gap, true);
  assert.ok(gap.score > 0 && /Google suggests/.test(gap.parts.why));
  assert.ok(/position 8/.test(scoreKeyword({ ...base, position: 8 }, { month: 10 }).parts.why));
});

test('scoring: low CTR flag, cannibalization and weighted position', () => {
  assert.equal(lowCtrFlag(4, 200, 1), true);
  assert.equal(lowCtrFlag(4, 200, 20), false);
  assert.equal(lowCtrFlag(15, 200, 0), false);
  assert.equal(lowCtrFlag(4, 30, 0), false);
  const c = findCannibalization([{ page: '/a', impressions: 60 }, { page: '/b', impressions: 40 }, { page: '/c', impressions: 2 }]);
  assert.deepEqual(c.pages.map((p) => p.page), ['/a', '/b']);
  assert.equal(c.severity, 42);
  assert.equal(findCannibalization([{ page: '/a', impressions: 95 }, { page: '/b', impressions: 5 }]), null);
  assert.equal(weightedPosition([{ position: 2, impressions: 10 }, { position: 10, impressions: 30 }]), 8);
});

test('lifecycle: transitions', () => {
  const f = { planThreshold: 4 };
  assert.equal(nextStatus({ status: 'idea' }, { ...f, score: 2 }, NOW), 'idea');
  assert.equal(nextStatus({ status: 'idea' }, { ...f, score: 5 }, NOW), 'planned');
  assert.equal(nextStatus({ status: 'idea', pinned: true }, { ...f, score: 0 }, NOW), 'planned');
  assert.equal(nextStatus({ status: 'planned' }, { ...f, locked: true }, NOW), 'assigned');
  assert.equal(nextStatus({ status: 'retired', targetPath: '/a' }, { position: 1, impressions: 99 }, NOW), 'retired');
  const pub = { status: 'published', targetPath: '/a', publishedAt: daysAgo(10) };
  assert.equal(nextStatus(pub, {}, NOW), 'published');
  assert.equal(nextStatus(pub, { indexed: true }, NOW), 'indexed');
  assert.equal(nextStatus(pub, { position: 15, impressions: 40 }, NOW), 'ranking');
  assert.equal(nextStatus(pub, { position: 7, impressions: 40 }, NOW), 'page1');
  assert.equal(nextStatus(pub, { position: 2, impressions: 40 }, NOW), 'top3');
  assert.equal(nextStatus(pub, { position: 2, impressions: 3, serpPosition: 9 }, NOW), 'page1');   // too few impressions: use Serper
  const old = { status: 'ranking', targetPath: '/a', publishedAt: daysAgo(70), baselinePosition: 16 };
  assert.equal(nextStatus(old, { position: 15, impressions: 40 }, NOW), 'stalled');
  assert.equal(nextStatus(old, { position: 12, impressions: 40 }, NOW), 'ranking');
  assert.equal(nextStatus({ ...old, baselinePosition: null }, { indexed: true }, NOW), 'stalled');
});

const cfg = mergeConfig({}, {});
const K = (o) => ({ id: o.keyword, status: 'planned', kind: 'blog', cluster: 'aeration', intent: 'informational', priority: 10, pinned: false, ...o });

test('assign: new posts for unowned keywords; head terms never become blog posts', () => {
  const out = pickAssignment({ keywords: [K({ keyword: 'when to aerate winnipeg' }), K({ keyword: 'aeration winnipeg', kind: 'service', priority: 50 })], cfg, modes: ['new'], now: NOW });
  assert.deepEqual(out.map((o) => [o.keyword.keyword, o.mode]), [['when to aerate winnipeg', 'new']]);
  assert.equal(out[0].contentType, 'timing guide');
});

test('assign: an owned keyword becomes a refresh, capped per week', () => {
  const pages = { '/blog-a': { kind: 'blog', publishedAt: daysAgo(90), httpStatus: 200 } };
  const k = K({ keyword: 'aeration cost winnipeg', status: 'ranking', targetPath: '/blog-a', position28: 8, impressions28: 120, clicks28: 1 });
  const out = pickAssignment({ keywords: [k], pages, cfg, modes: ['new', 'refresh'], now: NOW });
  assert.equal(out[0].mode, 'refresh');
  assert.match(out[0].why, /few clicks/);
  const history = [{ mode: 'refresh', status: 'published', createdAt: daysAgo(1), cluster: 'x' }, { mode: 'refresh', status: 'published', createdAt: daysAgo(3), cluster: 'y' }];
  assert.equal(pickAssignment({ keywords: [k], pages, history, cfg, modes: ['new', 'refresh'], now: NOW }).length, 0);
  assert.equal(pickAssignment({ keywords: [k], pages, cfg, modes: ['new'], now: NOW }).length, 0, 'writer without refresh support');
  const young = { '/blog-a': { ...pages['/blog-a'], publishedAt: daysAgo(10) } };
  assert.equal(pickAssignment({ keywords: [k], pages: young, cfg, modes: ['refresh'], now: NOW }).length, 0, 'too soon to refresh');
});

test('assign: landing pages for services without a page, gated area pages, weekly cap', () => {
  const svc = K({ keyword: 'aeration winnipeg', kind: 'service', intent: 'transactional' });
  const area = K({ keyword: 'lawn care st vital', kind: 'area', cluster: 'lawn-care', signals: { autocomplete: true } });
  const areaNoDemand = K({ keyword: 'lawn care tuxedo', kind: 'area', cluster: 'lawn-care' });
  const out = pickAssignment({ keywords: [svc, area, areaNoDemand], cfg, modes: ['page'], now: NOW, pillars: { 'lawn-care': '/lawn-care-winnipeg' } });
  assert.deepEqual(out.map((o) => o.keyword.keyword).sort(), ['aeration winnipeg', 'lawn care st vital']);
  assert.equal(out.find((o) => o.keyword.kind === 'service').contentType, 'service page');
  const withPillar = pickAssignment({ keywords: [svc], cfg, modes: ['page'], now: NOW, pillars: { aeration: '/lawn-aeration-winnipeg' } });
  assert.equal(withPillar.length, 0, 'the service page exists');
  const history = [{ mode: 'page', status: 'published', createdAt: daysAgo(2), cluster: 'fencing' }];
  assert.equal(pickAssignment({ keywords: [svc], history, cfg, modes: ['page'], now: NOW }).length, 0);
});

test('assign: cluster diversity, locks, cooldown and deterministic ties', () => {
  const a = K({ keyword: 'aeration tips winnipeg', priority: 10 });
  const b = K({ keyword: 'fence care tips winnipeg', cluster: 'fencing', priority: 7 });
  const history = [{ mode: 'new', status: 'published', createdAt: daysAgo(1), cluster: 'aeration', contentType: 'tips' }];
  assert.equal(pickAssignment({ keywords: [a, b], history, cfg, modes: ['new'], now: NOW })[0].keyword.keyword, 'fence care tips winnipeg');
  assert.equal(pickAssignment({ keywords: [{ ...a, lockedUntil: new Date(NOW.getTime() + 3600e3) }], cfg, modes: ['new'], now: NOW }).length, 0);
  assert.equal(pickAssignment({ keywords: [{ ...a, lastAssignedAt: daysAgo(5) }], cfg, modes: ['new'], now: NOW }).length, 0);
  const t1 = K({ id: 'b', keyword: 'aeration guide x', priority: 5 });
  const t2 = K({ id: 'a', keyword: 'aeration guide y', priority: 5 });
  assert.equal(pickAssignment({ keywords: [t1, t2], cfg, modes: ['new'], now: NOW })[0].keyword.id, 'a');
});

test('assign: content type rotation skips the last two used', () => {
  const h = (t, d) => ({ mode: 'new', contentType: t, createdAt: daysAgo(d) });
  assert.equal(chooseContentType('aeration benefits', [h('tips', 1), h('how-to', 2)]).contentType, 'comparison');
  assert.equal(chooseContentType('aeration benefits', []).contentType, 'cost guide');
  assert.equal(chooseContentType('aeration cost', [h('cost guide', 1)]).contentType, 'cost guide');
});

test('google: an API-disabled error yields the enable link, other errors do not', () => {
  const { apiDisabledLink } = require('../ai/seo/google');
  const msg = 'Search Console GET /sites: Google Search Console API has not been used in project 944252538921 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=944252538921 then retry.';
  assert.equal(apiDisabledLink(new Error(msg)), 'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=944252538921');
  assert.equal(apiDisabledLink(new Error('User does not have sufficient permission for site')), null);
  assert.equal(apiDisabledLink(null), null);
});
