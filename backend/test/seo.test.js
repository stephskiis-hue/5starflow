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

test('config: off-topic searches (jobs, equipment, other cities) are filtered', () => {
  const { isOffTopic } = require('../ai/seo/config');
  for (const q of ['lawn care jobs hiring near me', 'snow removal machine', 'lawn watering tractor', 'snow removal equipment', 'lawn care calgary', 'recommend top lawn fertilizing companies near me']) assert.ok(isOffTopic(q), q);
  for (const q of ['lawn aeration and overseeding near me', 'snow removal cost winnipeg', 'lawn watering schedule', 'fence installation near me']) assert.ok(!isOffTopic(q), q);
});

test('serper: our map-pack listing is found whatever the punctuation', () => {
  const { ourPlacesRank } = require('../ai/seo/serper');
  const places = (title, website) => ({ places: [{ title: 'Other Co', position: 1 }, { title, website, position: 2 }] });
  assert.equal(ourPlacesRank(places('No.BS Yardworks'), 'www.no-bs-yardwork.com'), 2);
  assert.equal(ourPlacesRank(places('No-BS Yardwork & Landscaping'), 'www.no-bs-yardwork.com'), 2);
  assert.equal(ourPlacesRank(places('Green Co', 'https://www.no-bs-yardwork.com/'), 'www.no-bs-yardwork.com'), 2);
  assert.equal(ourPlacesRank(places('Green Co'), 'www.no-bs-yardwork.com'), null);
});

test('assign: a missing service page comes before area pages, even off season', () => {
  const svc = K({ keyword: 'lawn aeration winnipeg', kind: 'service', intent: 'transactional', priority: 4, scoreParts: { season: 0.8, why: 'off season' } });
  const area = K({ keyword: 'lawn care charleswood', kind: 'area', cluster: 'lawn-care', priority: 6, signals: { autocomplete: true }, scoreParts: { season: 1 } });
  const out = pickAssignment({ keywords: [svc, area], cfg, modes: ['page'], now: NOW, pillars: { 'lawn-care': '/lawn-care-winnipeg' } });
  assert.equal(out[0].keyword.keyword, 'lawn aeration winnipeg');
  assert.doesNotMatch(out[0].why, /off season/);
});

// --------------------------------------------------------------------------- site access (server-side fallback for the PC)
const sa = require('../ai/seo/siteAccess');
const ORIGIN = 'https://www.no-bs-yardwork.com';

test('site access: the verification tag goes right after <head> and keeps CRLF', () => {
  assert.equal(sa.verificationContent('<meta name="google-site-verification" content="AbC_123-xyz" />'), 'AbC_123-xyz');
  const html = '﻿<!DOCTYPE html>\r\n<html>\r\n<head lang="en">\r\n  <title>No-Bs</title>\r\n</head>\r\n</html>';
  const out = sa.withVerificationTag(html, 'AbC_123-xyz');
  assert.ok(out.startsWith('﻿<!DOCTYPE html>\r\n<html>\r\n<head lang="en">\r\n  <meta name="google-site-verification" content="AbC_123-xyz" />\r\n  <title>'));
  assert.equal(sa.withVerificationTag(out, 'AbC_123-xyz'), out);
  assert.equal(sa.withVerificationTag('<html><body>no head</body></html>', 'x'), null);
});

test('site access: the .htaccess block lands after the first RewriteEngine On, once, rules untouched', () => {
  const text = 'Options -MultiViews\r\nRewriteEngine On\r\nRewriteCond %{REQUEST_FILENAME}.html -f\r\nRewriteRule ^(.*)$ $1.html [L]\r\n';
  const out = sa.withSeoRedirects(text, ORIGIN);
  const lines = out.split('\r\n');
  assert.deepEqual(lines.slice(0, 2), ['Options -MultiViews', 'RewriteEngine On']);
  assert.deepEqual(lines.slice(2, 10), sa.seoRedirectLines(ORIGIN));
  assert.equal(lines[5], 'RewriteRule ^ https://www.no-bs-yardwork.com%{REQUEST_URI} [L,R=301]');
  assert.ok(out.endsWith('RewriteCond %{REQUEST_FILENAME}.html -f\r\nRewriteRule ^(.*)$ $1.html [L]\r\n'));
  assert.ok(!out.includes('\n\n') && !/[^\r]\n/.test(out));
  assert.equal(sa.withSeoRedirects(out, ORIGIN), out);
  const none = sa.withSeoRedirects('ErrorDocument 404 /404.html\n', ORIGIN);
  assert.ok(none.startsWith(`RewriteEngine On\n${sa.HTACCESS_MARK}\n`) && none.endsWith('\n\nErrorDocument 404 /404.html\n'));
});

test('site access: the live check passes the right answers and reverts on 5xx, loops and wrong targets', () => {
  const checks = sa.htaccessChecks(ORIGIN);
  const bare = checks.find((c) => c.url === 'https://no-bs-yardwork.com/');
  assert.equal(bare.to, `${ORIGIN}/`);
  const home = checks[0];
  const hop = (url, status, location = null) => ({ url, status, location });
  assert.ok(sa.judge(home, [hop(home.url, 200)]).ok);
  assert.ok(sa.judge(bare, [hop(bare.url, 301, `${ORIGIN}/`), hop(`${ORIGIN}/`, 200)]).ok);
  assert.deepEqual(sa.judge(home, [hop(home.url, 500)]), { ok: false, fatal: true, line: `500  ${home.url}`, why: 'server error' });
  const loop = sa.judge(bare, [hop(bare.url, 301, 'https://a/'), hop('https://a/', 301, 'https://b/'), hop('https://b/', 301, 'https://c/'), hop('https://c/', 301, 'https://a/')]);
  assert.ok(!loop.ok && loop.fatal && loop.why === 'redirect loop');
  const wrong = sa.judge(bare, [hop(bare.url, 301, `${ORIGIN}/home`), hop(`${ORIGIN}/home`, 200)]);
  assert.ok(!wrong.ok && !wrong.fatal && /expected/.test(wrong.why));
  const notYet = sa.judge(bare, [hop(bare.url, 200)]);
  assert.ok(!notYet.ok && !notYet.fatal);
  assert.ok(!sa.judge(home, [hop(home.url, 301, `${ORIGIN}/x`), hop(`${ORIGIN}/x`, 200)]).ok);
});

// ------------------------------------------------------------------------------------------ focus campaigns
const FR = require('../ai/seo/focusRules');
const FOCUS = (o = {}) => K({ keyword: 'when to aerate winnipeg', status: 'published', focus: true, focusStatus: 'active', focusGoal: 3, pinned: true, targetPath: '/blog-when-to-aerate', ...o });
const livePage = (o = {}) => ({ kind: 'blog', httpStatus: 200, publishedAt: daysAgo(10), ...o });

test('focus: the focus keyword and its supporting posts outrank everything else while the week has room', () => {
  const f = FOCUS({ status: 'planned', targetPath: null, priority: 2 });
  const sup = K({ keyword: 'aeration cost winnipeg', supportsId: f.id, priority: 2 });
  const rival = K({ keyword: 'fence care tips winnipeg', cluster: 'fencing', priority: 30 });
  const first = pickAssignment({ keywords: [rival, f, sup], cfg, modes: ['new'], now: NOW });
  assert.equal(first[0].keyword.keyword, 'when to aerate winnipeg');
  assert.equal(first[0].tier, 1);
  assert.match(first[0].why, /focus keyword/);
  assert.equal(first.find((o) => o.keyword.keyword === 'aeration cost winnipeg'), undefined, 'a supporting post waits for the focus page');
  const pages = { '/blog-when-to-aerate': livePage() };
  const live = pickAssignment({ keywords: [rival, FOCUS(), sup], pages, cfg, modes: ['new'], now: NOW });
  assert.deepEqual(live.map((o) => o.keyword.keyword), ['aeration cost winnipeg', 'fence care tips winnipeg']);
  assert.match(live[0].why, /supports your focus keyword/);
  const spent = [1, 2, 3].map((i) => ({ keywordId: sup.id, mode: 'new', status: 'published', createdAt: daysAgo(i), cluster: 'aeration' }));
  const capped = pickAssignment({ keywords: [rival, FOCUS(), sup], pages, history: spent, cfg, modes: ['new'], now: NOW });
  assert.equal(capped[0].keyword.keyword, 'fence care tips winnipeg', 'weekly focus quota used up: no more boost');
});

test('focus: a paused or stopped campaign is just a pinned keyword again', () => {
  const sup = K({ keyword: 'aeration cost winnipeg', supportsId: 'when to aerate winnipeg', priority: 0 });
  const paused = FOCUS({ focusStatus: 'paused' });
  assert.equal(pickAssignment({ keywords: [paused, sup], pages: { '/blog-when-to-aerate': livePage() }, cfg, modes: ['new'], now: NOW }).length, 0);
});

test('focus: a focus page is refreshed after 21 days while short of the goal, not after it is won', () => {
  const pages = { '/blog-when-to-aerate': livePage({ publishedAt: daysAgo(25) }) };
  const behind = FOCUS({ position28: 14, impressions28: 40, clicks28: 4, lastAssignedAt: daysAgo(25) });
  const out = pickAssignment({ keywords: [behind], pages, cfg, modes: ['new', 'refresh'], now: NOW });
  assert.equal(out[0].mode, 'refresh');
  assert.match(out[0].why, /goal top 3/);
  assert.equal(pickAssignment({ keywords: [{ ...behind, position28: 2, clicks28: 20 }], pages, cfg, modes: ['new', 'refresh'], now: NOW }).length, 0, 'already at the goal');
  assert.equal(pickAssignment({ keywords: [behind], pages: { '/blog-when-to-aerate': livePage({ publishedAt: daysAgo(10) }) }, cfg, modes: ['refresh'], now: NOW }).length, 0, 'too soon');
  const after = { '/blog-when-to-aerate': livePage({ publishedAt: daysAgo(80), refreshedAt: daysAgo(25) }) };
  assert.equal(pickAssignment({ keywords: [behind], pages: after, cfg, modes: ['refresh'], now: NOW }).length, 0, 'a second refresh waits 45 days');
});

test('focus: links mode needs the flag (on by default) and an open links step, and asks for one edit per source post', () => {
  const step = { id: 's1', keywordId: 'when to aerate winnipeg', status: 'planned', title: 'Link from /blog-a', detail: { from: '/blog-a', to: '/blog-when-to-aerate', anchor: 'aeration in Winnipeg' } };
  const pages = { '/blog-when-to-aerate': livePage() };
  const args = { keywords: [FOCUS()], pages, modes: ['links'], now: NOW, linkSteps: [step] };
  assert.equal(pickAssignment({ ...args, cfg: { ...cfg, focusLinks: false } }).length, 0, 'off when the flag is off');
  const on = pickAssignment({ ...args, cfg });
  assert.equal(on[0].mode, 'links');
  assert.equal(on[0].step.detail.from, '/blog-a');
});

test('focus rules: supporting keywords stay on topic and never take over a page', () => {
  const f = { id: 'f', keyword: 'lawn aeration winnipeg', matchKey: kw.matchKey('lawn aeration winnipeg'), cluster: 'aeration' };
  const idea = { id: 'i1', keyword: 'when to aerate lawn winnipeg', matchKey: kw.matchKey('when to aerate lawn winnipeg'), kind: 'blog', status: 'idea' };
  const owned = { id: 'o1', keyword: 'aeration cost winnipeg', matchKey: kw.matchKey('aeration cost winnipeg'), kind: 'blog', status: 'published', targetPath: '/blog-aeration-cost' };
  const index = [{ ...f, kind: 'service', status: 'planned' }, idea, owned];
  const out = FR.pickSupportKeywords({ focus: f, index, max: 5, phrases: [
    'when to aerate lawn winnipeg', 'aeration cost winnipeg', 'How long after aerating can I mow?', 'lawn aeration winnipeg', 'aeration winnipeg',
    'lawn aeration jobs winnipeg', 'snow removal cost winnipeg', 'best aeration company winnipeg', 'aeration machine rental' ] });
  assert.deepEqual(out.adopt.map((a) => a.id), ['i1'], 'an existing idea is adopted, not duplicated');
  assert.deepEqual(out.create.map((c) => c.keyword), ['how long after aerating can i mow']);
  assert.equal(FR.pickSupportKeywords({ focus: f, index, max: 1, phrases: ['how long after aerating can i mow', 'is aerating worth it'] }).create.length, 1, 'respects the cap');
});

test('focus rules: anchors rotate deterministically', () => {
  const f = { keyword: 'lawn aeration winnipeg', cluster: 'aeration' };
  const seq = [0, 1, 2, 3, 4, 5].map((n) => FR.anchorFor(f, n));
  assert.equal(seq[0], seq[4]);
  assert.equal(new Set(seq.slice(0, 4)).size, 4);
  assert.deepEqual(seq, [0, 1, 2, 3, 4, 5].map((n) => FR.anchorFor(f, n)));
});

test('focus rules: progress, momentum and winning', () => {
  assert.equal(FR.progressToGoal(25, 3, 3), 100);
  assert.equal(FR.progressToGoal(25, 14, 3), 50);
  assert.equal(FR.progressToGoal(null, null, 3), 0);
  assert.equal(FR.progressToGoal(25, 30, 3), 0, 'moving backwards is not progress');
  const h = (...pos) => pos.map((p, i) => ({ w: `w${i}`, pos: p, imp: 50, serp: null }));
  assert.equal(FR.positionGain(h(20, 18, 15, 12, 9), 4), 11);
  assert.equal(FR.positionGain(h(9), 4), null);
  assert.equal(FR.hasReachedGoal(h(8, 2.5, 2), 3), true);
  assert.equal(FR.hasReachedGoal(h(8, 5, 2), 3), false, 'one good week is not a win');
  assert.equal(FR.hasReachedGoal(h(2), 3), false);
  assert.equal(FR.currentPosition({ impressions28: 4, position28: 3, serpPosition: 12 }), 12, 'too few impressions: use the Serper check');
});

test('focus rules: steps are judged from what is really on the site', () => {
  const focus = FOCUS({ targetPath: '/blog-focus' });
  const pages = { '/blog-focus': livePage({ linkedFrom: ['/blog-a'], refreshedAt: daysAgo(1) }), '/blog-a': livePage(), '/blog-sup': livePage() };
  const sup = K({ id: 'sup', keyword: 'aeration cost winnipeg', supportsId: focus.id, status: 'published', targetPath: '/blog-sup' });
  const ctx = { focus, pages, byId: { sup, [focus.id]: focus }, content: [{ status: 'queued', grounding: 'Source: https://www.no-bs-yardwork.com/blog-sup' }] };
  const st = (kind, o = {}) => ({ kind, status: 'planned', createdAt: daysAgo(5), detail: {}, ...o });
  assert.equal(FR.reconcileStep(st('page'), ctx).status, 'done');
  assert.equal(FR.reconcileStep(st('page'), { ...ctx, focus: { ...focus, targetPath: null, status: 'assigned' } }).status, 'in_progress');
  assert.equal(FR.reconcileStep(st('refresh'), ctx).status, 'done');
  assert.equal(FR.reconcileStep(st('support', { refId: 'sup' }), ctx).status, 'done');
  assert.equal(FR.reconcileStep(st('support', { refId: 'gone' }), ctx).status, 'skipped');
  assert.equal(FR.reconcileStep(st('links', { detail: { from: '/blog-a' } }), ctx).status, 'done', 'the crawl sees the link');
  assert.equal(FR.reconcileStep(st('links', { detail: { from: '/blog-b' } }), ctx).status, 'skipped', 'the source page is gone');
  const notYet = { ...ctx, pages: { ...pages, '/blog-focus': livePage({ linkedFrom: [] }) } };
  assert.equal(FR.reconcileStep(st('links', { detail: { from: '/blog-a', reportedAt: '2026-10-01' } }), notYet).status, 'in_progress', 'reported but not seen yet');
  assert.equal(FR.reconcileStep(st('social', { refId: '/blog-sup' }), ctx).status, 'done');
  assert.equal(FR.reconcileStep(st('social', { refId: '/blog-su' }), ctx).status, 'planned', 'a longer slug is a different page');
});

// ---------------------------------------------------------------- keyword research
const { pickRecommendations, classify } = require('../ai/seo/research');
const hist = (imp) => [{ imp }, { imp }, { imp }, { imp }, { imp }, { imp: 40 }];
const rk = (o) => ({ id: o.keyword, keyword: 'x', matchKey: o.keyword, cluster: 'aeration', kind: 'blog', status: 'idea', priority: 5, impressions28: 30, clicks28: 1, position28: 12, targetPath: '/a', history: [], ...o });

test('research: each reason is recognised from real numbers', () => {
  assert.equal(classify(rk({ keyword: 'a', position28: 12, impressions28: 30 })), 'almost');
  assert.equal(classify(rk({ keyword: 'b', position28: 5, impressions28: 15 })), 'close');
  assert.equal(classify(rk({ keyword: 'c', position28: 30, impressions28: 40, history: hist(10) })), 'rising');
  assert.equal(classify(rk({ keyword: 'd', position28: 30, impressions28: 40, targetPath: null })), 'no_page');
  assert.equal(classify(rk({ keyword: 'e', position28: 30, impressions28: 12, kind: 'area', area: 'Transcona' })), 'area');
  assert.equal(classify(rk({ keyword: 'f', position28: 2, impressions28: 100 })), null);
  assert.equal(classify(rk({ keyword: 'g', position28: 30, impressions28: 4 })), null);
});

test('research: focused, supporting, retired, brand, off-topic and dismissed keywords are skipped', () => {
  const list = [rk({ keyword: 'ok' }), rk({ keyword: 'foc', focus: true }), rk({ keyword: 'sup', supportsId: 'ok' }), rk({ keyword: 'ret', status: 'retired' }),
    rk({ keyword: 'brd', cluster: 'brand' }), rk({ keyword: 'oth', cluster: 'other' }), rk({ keyword: 'dis' })];
  const out = pickRecommendations(list, { dismissed: { dis: new Date(NOW.getTime() + DAY).toISOString() }, now: NOW });
  assert.deepEqual(out.map((i) => i.id), ['ok']);
  const expired = pickRecommendations([rk({ keyword: 'dis' })], { dismissed: { dis: new Date(NOW.getTime() - DAY).toISOString() }, now: NOW });
  assert.equal(expired.length, 1);
});

test('research: at most 2 per service, capped at max, best score first, goal follows position', () => {
  const list = [1, 2, 3].map((n) => rk({ keyword: `aer${n}`, priority: 10 - n }))
    .concat([rk({ keyword: 'sod1', cluster: 'sod', priority: 1 }), rk({ keyword: 'mow1', cluster: 'lawn-mowing', priority: 20, position28: 5, impressions28: 20 })]);
  const out = pickRecommendations(list, { max: 4, now: NOW });
  assert.deepEqual(out.map((i) => i.id), ['mow1', 'aer1', 'aer2', 'sod1']);
  assert.equal(out[0].goal, 3);
  assert.equal(out[1].goal, 10);
  assert.match(out[1].why, /position 12/);
});

// ---------------------------------------------------------------- recent jobs
const rj = require('../ai/seo/recentJobs');

test('recent jobs: postal code -> first three characters, anything else -> null', () => {
  assert.equal(rj.fsaOf('R3M 3P9'), 'R3M');
  assert.equal(rj.fsaOf('r2h0a1'), 'R2H');
  assert.equal(rj.fsaOf('90210'), null);
  assert.equal(rj.fsaOf(null), null);
});

test('recent jobs: an invoice becomes a fact row only when paid, recent and for a service we sell', () => {
  const inv = (o) => ({ id: 'i1', invoiceStatus: 'PAID', issuedDate: '2026-10-05T12:00:00Z', billingAddress: { postalCode: 'R3T 2B2' }, lineItems: { nodes: [{ name: 'Fall cleanup' }] }, ...o });
  const f = rj.factsFromInvoice(inv(), NOW);
  assert.deepEqual({ ...f, doneAt: undefined }, { invoiceId: 'i1', cluster: 'fall-cleanup', fsa: 'R3T', area: 'Fort Garry', doneAt: undefined });
  assert.equal(rj.factsFromInvoice(inv({ invoiceStatus: 'AWAITING_PAYMENT' }), NOW), null);
  assert.equal(rj.factsFromInvoice(inv({ lineItems: { nodes: [{ name: 'Eavestrough cleaning' }] } }), NOW), null);
  assert.equal(rj.factsFromInvoice(inv({ issuedDate: '2024-01-01T00:00:00Z' }), NOW), null);
  assert.equal(rj.factsFromInvoice(inv({ billingAddress: { postalCode: 'M5V 1A1' } }), NOW).area, null);
  assert.equal(JSON.stringify(f).includes('street'), false);
});

test('recent jobs: feed gives each page its own jobs, month-deduped, with photos that fit and are not repeated', () => {
  const jobs = [
    { cluster: 'fall-cleanup', area: 'Fort Garry', doneAt: daysAgo(5) }, { cluster: 'fall-cleanup', area: 'Fort Garry', doneAt: daysAgo(6) },
    { cluster: 'fall-cleanup', area: 'Tuxedo', doneAt: daysAgo(9) }, { cluster: 'sod', area: null, doneAt: daysAgo(70) },
  ];
  const pages = [{ path: '/spring-fall-cleanups', kind: 'service', clusters: ['spring-cleanup', 'fall-cleanup'] }, { path: '/fort-garry', kind: 'area', area: 'Fort Garry' }, { path: '/mow', kind: 'service', clusters: ['lawn-mowing'] }];
  const photos = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, tags: i < 3 ? ['FALL'] : ['SOD'], width: 800, height: 600 }));
  const feed = rj.buildFeed({ jobs, pages, photos, now: NOW });
  assert.deepEqual(feed.map((e) => e.path), ['/spring-fall-cleanups', '/fort-garry']);
  const svc = feed[0];
  assert.equal(svc.count, 3);
  assert.deepEqual(svc.jobs.map((j) => j.label), ['Fall cleanup in Fort Garry', 'Fall cleanup in Tuxedo']);
  assert.deepEqual(svc.photos.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(svc.photos[0].alt, 'Our yard work in Winnipeg');
  assert.equal(feed[1].heading, 'Recent jobs in Fort Garry');
  assert.deepEqual(feed[1].jobs.map((j) => j.label), ['Fall cleanup']);
  assert.match(feed[1].photos[0].alt, /Fort Garry/);
});
