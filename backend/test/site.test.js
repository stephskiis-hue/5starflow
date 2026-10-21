// Server-side site publisher tests (no database, no network): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { renderPage, extractPage, dateLabel } = require('../ai/site/render');
const { checkPage, checkFragment, normalizeLinks, hasKeyword } = require('../ai/site/check');
const { mergePosts, postsJson, patchBlogHtml, postFacts, START, END, A, B } = require('../ai/site/blogIndex');
const { buildSitemaps, eligible, readLastmods } = require('../ai/site/sitemaps');
const { composeNote } = require('../ai/morningNote');

const O = 'https://www.no-bs-yardwork.com';
const live = (...paths) => Object.fromEntries(paths.map((p) => [p, { path: p, httpStatus: 200 }]));
const PAGES = live('/', '/contact', '/premium-lawn-care', '/lawn-care-winnipeg', '/blog-lawn-aeration-winnipeg');

const filler = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const BODY = (extra = '') => `
<p>When to aerate your lawn in Winnipeg: late August to mid September is the sweet spot for Winnipeg bluegrass. ${filler(60)}</p>
<h2>Why timing matters in Winnipeg</h2>
<p>${filler(250)} See our <a href="premium-lawn-care.html">premium lawn care in Winnipeg</a> plan.</p>
<div class="blog-inline-cta"><p>Want it handled? <a href="contact.html">Get a free quote</a>.</p></div>
<h2>Aeration FAQ for Winnipeg</h2>
<h3>Can I aerate in spring?</h3>
<p>${filler(300)}</p>
${extra}`;

const draft = (o = {}) => ({ kind: 'post', mode: 'new', slug: 'blog-when-to-aerate-winnipeg', title: 'When to Aerate Your Lawn in Winnipeg (Best Dates)', description: 'When to aerate your lawn in Winnipeg: late August to mid September for most bluegrass lawns. Timing, tools and mistakes to avoid this fall.',
  h1: 'When to Aerate Your Lawn in Winnipeg', keyword: 'when to aerate lawn winnipeg', bodyHtml: BODY(), requiredLinks: [], ...o });

test('render: a full page with one H1, the clean canonical, valid JSON-LD, hero, byline and quote box', () => {
  const html = renderPage({ kind: 'post', origin: O, slug: 'blog-when-to-aerate-winnipeg', title: 'When to Aerate Your Lawn in Winnipeg', description: 'Dates & tips for "aeration".', keywords: ['aeration', 'winnipeg'],
    h1: 'When to Aerate Your Lawn', crumb: 'When to Aerate', image: 'images/blog-when-to-aerate-winnipeg.webp', imageAlt: 'A lawn', date: '2026-10-19', modified: '', bodyHtml: '<p>Hello</p>' });
  const $ = cheerio.load(html);
  assert.equal($('h1').length, 1);
  assert.equal($('link[rel=canonical]').attr('href'), `${O}/blog-when-to-aerate-winnipeg`);
  assert.equal($('title').text(), 'When to Aerate Your Lawn in Winnipeg | No-BS Yardwork');
  assert.equal($('meta[name=description]').attr('content'), 'Dates & tips for "aeration".');
  const ld = $('script[type="application/ld+json"]').map((_, e) => JSON.parse($(e).text())).get();
  assert.deepEqual(ld.map((o) => o['@type']), ['Article', 'BreadcrumbList']);
  assert.equal(ld[0].datePublished, '2026-10-19');
  assert.equal(ld[0].dateModified, undefined);
  assert.equal(ld[1].itemListElement.length, 3);
  assert.match($('.blog-meta').text(), /October 19, 2026/);
  assert.equal($('.blog-cta-box').length, 1);
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(html), 'no placeholder left behind');
  assert.ok(html.includes('<header class="main-header">') && html.includes('<footer class="main-footer">'));
});

test('render: a refresh adds dateModified; a landing page has no byline and a two-step breadcrumb', () => {
  const base = { origin: O, slug: 'x', title: 'T', description: 'D', h1: 'H', image: '', date: '2026-01-02', bodyHtml: '<p>x</p>' };
  const post = cheerio.load(renderPage({ ...base, kind: 'post', slug: 'blog-x', modified: '2026-10-20' }));
  assert.equal(JSON.parse(post('script[type="application/ld+json"]').first().text()).dateModified, '2026-10-20');
  const page = cheerio.load(renderPage({ ...base, kind: 'page', modified: '' }));
  assert.equal(page('.blog-meta').length, 0);
  assert.equal(page('.breadcrumb .breadcrumb-item').length, 2);
  assert.equal(page('meta[property="og:type"]').attr('content'), 'website');
  assert.equal(dateLabel('2026-03-05'), 'March 5, 2026');
});

test('render: what extractPage reads back is what was put in', () => {
  const body = '<p>Intro paragraph here.</p>\n<h2>Section</h2>\n<p>More text with <a href="https://www.no-bs-yardwork.com/contact">a link</a>.</p>';
  const html = renderPage({ kind: 'post', origin: O, slug: 'blog-x', title: 'Title', description: 'Desc', keywords: ['a', 'b'], h1: 'Heading', crumb: 'Crumb', image: 'images/blog-x.webp', imageAlt: 'Alt', date: '2026-10-19', modified: '', bodyHtml: body });
  const e = extractPage(html);
  assert.deepEqual([e.title, e.description, e.h1, e.crumb, e.kind, e.image, e.imageAlt, e.date, e.keywords], ['Title', 'Desc', 'Heading', 'Crumb', 'post', 'images/blog-x.webp', 'Alt', '2026-10-19', ['a', 'b']]);
  assert.equal(e.bodyHtml.replace(/\s+/g, ' '), body.replace(/\s+/g, ' '), 'no hero, byline or quote box in the editable body');
  assert.equal(extractPage('<html><body><p>not a blog layout</p></body></html>'), null);
});

test('check: a good page passes, with internal links normalized to clean absolute URLs', () => {
  const body = normalizeLinks(BODY(), O);
  assert.match(body, /href="https:\/\/www\.no-bs-yardwork\.com\/premium-lawn-care"/);
  assert.match(body, /href="https:\/\/www\.no-bs-yardwork\.com\/contact"/);
  const r = checkPage(draft({ bodyHtml: body, requiredLinks: [`${O}/premium-lawn-care`] }), { pages: PAGES, origin: O });
  assert.deepEqual(r.errors, []);
  assert.ok(r.words >= 630 && r.words <= 1100, `words ${r.words}`);
});

test('check: every rule fails with a plain message', () => {
  const run = (o, pages = PAGES) => checkPage(draft(o), { pages, origin: O }).errors.join(' | ');
  assert.match(run({ title: 'x'.repeat(61) + ' winnipeg' }), /title is \d+ characters/);
  assert.match(run({ description: 'd'.repeat(156) }), /meta description is 156/);
  assert.match(run({ slug: 'when-to-aerate' }), /must start with "blog-"/);
  assert.match(run({ slug: 'blog-lawn-aeration-winnipeg' }), /already exists/);
  assert.doesNotMatch(run({ slug: 'blog-lawn-aeration-winnipeg', mode: 'refresh' }), /already exists/);
  assert.match(run({ keyword: 'sod installation winnipeg' }), /title must contain the keyword/);
  assert.match(run({ bodyHtml: `<h1>Hi</h1>${BODY()}` }), /must not contain an H1/);
  assert.match(run({ bodyHtml: `${BODY()}<script>alert(1)</script>` }), /<script> is not allowed/);
  assert.match(run({ bodyHtml: `${BODY()}<p onclick="x()">a</p>` }), /onclick/);
  assert.match(run({ bodyHtml: `${BODY()}<div class="foo">a</div>` }), /not allowed: use blog-inline-cta/);
  assert.match(run({ bodyHtml: BODY('<p>See <a href="/blog-gone">this</a>.</p>') }), /\/blog-gone does not go to a live page/);
  assert.match(run({ bodyHtml: BODY('<p>See <a href="http://example.com">this</a>.</p>') }), /must be https/);
  assert.match(run({ requiredLinks: [`${O}/lawn-care-winnipeg`] }), /required link to .*lawn-care-winnipeg is missing/);
  assert.match(run({ bodyHtml: BODY('<p>We leverage experience.</p>') }), /Banned word: "leverage"/);
  assert.match(run({ bodyHtml: BODY('<p>Aeration — done right.</p>') }), /Mid-sentence dash/);
  assert.match(run({ bodyHtml: BODY('<p>Call 204-555-1234 now.</p>') }), /Wrong phone number/);
  assert.match(run({ bodyHtml: BODY('<p>We are the cheapest.</p>') }), /Unsubstantiated claim/);
  assert.match(run({ bodyHtml: '<h2>x</h2><p>too short</p>' }), /body is \d+ words/);
  assert.equal(checkPage(draft({ bodyHtml: BODY('<p>Typical lawn aeration in Winnipeg runs $120 to $250 a visit.</p>') }), { pages: PAGES, origin: O }).errors.length, 0, 'market price ranges in a cost guide are allowed');
});

test('check: keyword matching folds plurals and synonyms; single sentences for link edits', () => {
  assert.ok(hasKeyword('Lawn Aeration Costs in Winnipeg', 'aeration cost winnipeg'));
  assert.ok(hasKeyword('When should you aerate a lawn?', 'when to aerate lawn winnipeg'));
  assert.ok(!hasKeyword('Fence repair prices', 'aeration cost winnipeg'));
  const ctx = { pages: PAGES, origin: O, requiredLinks: [`${O}/premium-lawn-care`] };
  assert.equal(checkFragment(`<p>For feeding after aeration see <a href="${O}/premium-lawn-care">premium lawn care in Winnipeg</a>.</p>`, ctx).ok, true);
  assert.match(checkFragment('<p>No link here.</p>', ctx).errors.join(), /required link/);
  assert.match(checkFragment('<p>a</p><p>b</p>', { ...ctx, requiredLinks: [] }).errors.join(), /exactly one <p>/);
  assert.match(checkFragment(`<p>${filler(70)} <a href="${O}/premium-lawn-care">x</a></p>`, ctx).errors.join(), /short/);
});

const BLOG = `<div id="blog-posts-container"></div>
<div id="blog-pagination"></div>
${START}
    <ul class="seo-post-list">
      <li><a href="old">Old</a> <time datetime="2026-01-01">2026-01-01</time></li>
    </ul>
    ${END}
<script>
  var POSTS = ${A}[ {"title": "Old ]", "url": "old"} ]${B};
  render(POSTS);
</script>`;

test('blog index: posts merge newest first, the list and the array are rewritten, and a second pass changes nothing', () => {
  const current = [{ title: 'Old ]', date: '2026-01-01', url: 'old', image: 'images/old.webp', excerpt: 'o', category: 'Lawn Care', readTime: 3 }];
  const next = mergePosts(current, [{ title: 'New & "better"', date: '2026-10-19', url: 'blog-new', image: 'images/n.webp', excerpt: 'n', category: 'Lawn Care', readTime: 4 }]);
  assert.deepEqual(next.map((p) => p.url), ['blog-new', 'old']);
  const once = patchBlogHtml(BLOG, next);
  assert.deepEqual(once.notes, []);
  assert.match(once.html, /<a href="blog-new">New &amp; &quot;better&quot;<\/a> <time datetime="2026-10-19">/);
  assert.equal(once.html.match(/seo-post-list">/g).length, 1);
  const arr = once.html.slice(once.html.indexOf(A) + A.length, once.html.indexOf(B));
  assert.deepEqual(JSON.parse(arr).map((p) => p.url), ['blog-new', 'old']);
  assert.ok(once.html.includes('render(POSTS);') && once.html.startsWith('<div id="blog-posts-container">'));
  assert.equal(patchBlogHtml(once.html, next).html, once.html);
  assert.equal(postsJson(next).endsWith('\n'), true);
  assert.equal(mergePosts(next, [], ['blog-new']).length, 1, 'drop');
  assert.equal(mergePosts(next, [{ url: 'old', title: 'Renamed' }])[1].title, 'Renamed');
  assert.equal(mergePosts(next, [{ url: 'old', title: 'Renamed' }])[1].date, '2026-01-01', 'a refresh keeps the original date');
  assert.match(patchBlogHtml('<html></html>', next).notes.join(' '), /no .*markers/);
});

test('blog index: facts for a post missing from posts.json come from its own page', () => {
  const html = renderPage({ kind: 'post', origin: O, slug: 'blog-x', title: 'Title X', description: 'Desc X', keywords: [], h1: 'H', image: 'images/blog-x.webp', date: '2026-05-06', bodyHtml: `<p>${filler(400)}</p>` });
  const f = postFacts('blog-x', html);
  assert.deepEqual([f.title, f.date, f.image, f.excerpt, f.url, f.category], ['Title X', '2026-05-06', 'images/blog-x.webp', 'Desc X', 'blog-x', 'Lawn Care']);
  assert.ok(f.readTime >= 3);
});

const P = (path, o = {}) => ({ path, httpStatus: 200, redirectTo: null, noindex: false, excluded: false, canonicalOk: true, createdAt: new Date('2026-10-01'), contentChangedAt: new Date('2026-10-01'), publishedAt: null, refreshedAt: null, ...o });

test('sitemaps: only live, indexable, self-canonical pages; blog newest first; lastmod never moves back', () => {
  const pages = [P('/'), P('/about'), P('/blog'), P('/blog-b', { publishedAt: new Date('2026-10-18') }), P('/blog-a', { publishedAt: new Date('2026-10-19') }),
    P('/old', { httpStatus: 404 }), P('/moved', { redirectTo: '/about' }), P('/hidden', { noindex: true }), P('/dup', { canonicalOk: false }), P('/skip', { excluded: true }),
    P('/thankyou-k4r9x2m7qp'), P('/404'), P('/blog/old-wordpress'), P('/Spring-Fall-Cleanups'), P('/spring-fall-cleanups'), P('/style.css')];
  assert.deepEqual(eligible(pages).map((p) => p.path).sort(), ['/', '/about', '/blog', '/blog-a', '/blog-b', '/spring-fall-cleanups']);
  const liveMain = '<urlset><url><loc>https://www.no-bs-yardwork.com/about</loc><lastmod>2026-06-11</lastmod></url><url><loc>https://www.no-bs-yardwork.com/gone</loc><lastmod>2026-01-01</lastmod></url></urlset>';
  const r = buildSitemaps({ origin: O, pages, live: { sitemap: liveMain, blog: '' }, today: '2026-10-20' });
  assert.deepEqual(r.counts, { main: 4, blog: 2 });
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(O, ''));
  assert.deepEqual(locs(r.files['sitemap.xml']), ['/', '/about', '/blog', '/spring-fall-cleanups'], 'home first, then by path');
  assert.deepEqual(locs(r.files['blog-sitemap.xml']), ['/blog-a', '/blog-b'], 'newest first');
  assert.equal(readLastmods(r.files['sitemap.xml']).get(`${O}/about`), '2026-06-11', 'unchanged page keeps its date (the crawl only saw it for the first time)');
  assert.equal(readLastmods(r.files['blog-sitemap.xml']).get(`${O}/blog-a`), '2026-10-19');
  assert.match(r.files['sitemap_index.xml'], /<loc>https:\/\/www\.no-bs-yardwork\.com\/blog-sitemap\.xml<\/loc>\s*<lastmod>2026-10-19<\/lastmod>/);
  assert.deepEqual(r.diff.removed, [`${O}/gone`]);
  assert.ok(r.diff.added.includes(`${O}/blog-a`));
  const changed = buildSitemaps({ origin: O, pages: [P('/about', { createdAt: new Date('2026-10-01'), contentChangedAt: new Date('2026-10-15') })], live: { sitemap: liveMain, blog: '' }, today: '2026-10-20' });
  assert.equal(readLastmods(changed.files['sitemap.xml']).get(`${O}/about`), '2026-10-15', 'content changed after first seen: lastmod advances');
  assert.ok(r.files['sitemap.xml'].startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns='));
});

test('morning note: a plain template that lists everything and stays quiet on a quiet day', () => {
  const quiet = { tasks: { top: [], open: 0 }, approvals: { items: [] }, routines: { unhealthy: [] }, inbound: { items: [], unansweredSms: 0 }, requests: { pending: 0 } };
  assert.equal(composeNote(quiet), null);
  const n = composeNote({ ...quiet, tasks: { top: [{ title: 'Stuck quote', urgency: 'high', customer: 'Jane' }], open: 3 }, approvals: { items: [{ summary: 'Refund Bob' }] },
    inbound: { items: [{ name: 'Al' }], unansweredSms: 2, oldestWaitingMinutes: 300 }, routines: { unhealthy: [{ name: 'Sync', status: 'failed' }] } });
  assert.match(n.title, /^Morning: 5 things need you$/);
  for (const piece of ['Stuck quote (Jane)', '2 customers waiting on a reply: Al', 'longest has waited 5 hours', 'Refund Bob', 'Sync (failed)', '3 open tasks']) assert.ok(n.body.includes(piece), piece);
});
