// Winnipeg Fence Pros pure-logic tests (no database, no network): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const kw = require('../wfp/keywords');
const { nextPiece, roadmap, nextSlots } = require('../wfp/plan');
const { toConfig, FIELDS, resolve, DEFAULT_TEMPLATE } = require('../wfp/settings');
const { renderPost, sanitizeBody, postUrls, templateFromPage } = require('../wfp/template');
const { withCity } = require('../wfp/research');

const DAY = 86400000;
const NOW = new Date('2026-10-21T15:00:00Z');
const SERVICES = ['fence installation', 'fence repair', 'wood fence', 'vinyl fence', 'chain link fence', 'gate installation', 'deck building'];
const cfg = (over = {}) => {
  const raw = Object.fromEntries(FIELDS.map((f) => [f.key, f.def ?? '']));
  return toConfig({ ...raw, SITE_URL: 'https://www.wpgfence.ca/', PHONE: '204-555-0100', POST_DAYS: 'mon,thu', POSTS_PER_WEEK: '2', ...over });
};

test('keywords: phrasings collapse to one key, location words drop out', () => {
  assert.equal(kw.matchKey('How much does a fence cost in Winnipeg MB'), kw.matchKey('fence cost winnipeg'));
  assert.equal(kw.matchKey('Fencing prices Winnipeg'), kw.matchKey('fence cost'));
  assert.equal(kw.matchKey('chainlink fence 2026'), kw.matchKey('chain link fences'));
});

test('keywords: most specific service wins; generic words do not block a match', () => {
  assert.equal(kw.serviceFor('wood fence cost winnipeg', SERVICES), 'wood fence');
  assert.equal(kw.serviceFor('chain link fence repair', SERVICES), 'chain link fence');
  assert.equal(kw.serviceFor('fence company winnipeg', SERVICES), 'fence installation');
  assert.equal(kw.serviceFor('deck cost winnipeg', SERVICES), 'deck building');
  assert.equal(kw.serviceFor('lawn aeration', SERVICES), null);
});

test('keywords: brand, off-topic, intent', () => {
  assert.equal(kw.isBranded('winnipeg fence pros reviews', ['winnipeg fence pros']), true);
  assert.equal(kw.isOffTopic('fence jobs winnipeg'), true);
  assert.equal(kw.isOffTopic('cedar fence home depot'), true);
  assert.equal(kw.intentFor('fence company near me'), 'transactional');
  assert.equal(kw.intentFor('vinyl vs wood fence'), 'commercial');
  assert.equal(kw.intentFor('how tall can a fence be in winnipeg'), 'informational');
});

test('keywords: score uses Search Console upside, else a base by source; in-season higher', () => {
  const summer = new Date('2026-06-01T12:00:00Z');
  const winter = new Date('2026-12-01T12:00:00Z');
  const withData = kw.scoreKeyword({ impressions28: 400, position28: 12, intent: 'commercial', source: 'gsc' }, summer);
  const noData = kw.scoreKeyword({ impressions28: 0, position28: null, intent: 'informational', source: 'serper' }, summer);
  assert.ok(withData > noData);
  assert.ok(kw.scoreKeyword({ impressions28: 0, intent: 'informational', source: 'owner' }, summer) > kw.scoreKeyword({ impressions28: 0, intent: 'informational', source: 'owner' }, winter));
});

test('keywords: lifecycle never moves an unpublished keyword and follows the best position', () => {
  assert.equal(kw.statusFor({ status: 'planned', position28: 2 }), 'planned');
  assert.equal(kw.statusFor({ status: 'published', impressions28: 0 }), 'published');
  assert.equal(kw.statusFor({ status: 'published', impressions28: 5, position28: 40 }), 'indexed');
  assert.equal(kw.statusFor({ status: 'indexed', position28: 14 }), 'ranking');
  assert.equal(kw.statusFor({ status: 'ranking', position28: 14, serpPosition: 6 }), 'page1');
  assert.equal(kw.statusFor({ status: 'page1', position28: 2.6 }), 'top3');
});

test('keywords: recommendation reasons and max 2 per service', () => {
  assert.equal(kw.recommendation({ keyword: 'fence cost', impressions28: 120, position28: 12 }).reason, 'page2');
  assert.equal(kw.recommendation({ keyword: 'fence cost', impressions28: 120, position28: 5 }).reason, 'close');
  assert.equal(kw.recommendation({ keyword: 'fence cost', impressions28: 60, position28: 30, prevImpressions28: 20 }).reason, 'rising');
  assert.equal(kw.recommendation({ keyword: 'fence cost', impressions28: 60, position28: 30, prevImpressions28: 55 }).reason, 'no_page');
  assert.equal(kw.recommendation({ keyword: 'fence cost', impressions28: 60, position28: 30, prevImpressions28: 55 }, { hasPost: true }), null);
  assert.match(kw.recommendation({ keyword: 'fence cost', impressions28: 120, position28: 12 }).why, /page 2 .*120 searches/);
  const cands = [1, 2, 3].map((i) => ({ id: `w${i}`, service: 'wood fence', rec: { score: 10 - i } })).concat([{ id: 'v1', service: 'vinyl fence', rec: { score: 1 } }]);
  assert.deepEqual(kw.pickRecommendations(cands, 5).map((c) => c.id), ['w1', 'w2', 'v1']);
});

test('keywords: slugs and city suffix', () => {
  assert.equal(kw.slugify('The Cost of a Cedar Fence in Winnipeg (2026)!'), 'cost-of-a-cedar-fence-in-winnipeg-2026');
  assert.equal(withCity('fence cost', 'Winnipeg'), 'fence cost winnipeg');
  assert.equal(withCity('fence cost winnipeg', 'Winnipeg'), 'fence cost winnipeg');
  assert.equal(withCity('fence company near me', 'Winnipeg'), 'fence company near me');
});

const K = (id, over = {}) => ({ id, keyword: id, matchKey: id, status: 'planned', priority: 1, focus: false, focusStatus: null, focusGoal: 3, supportsId: null, position28: null, serpPosition: null, publishedAt: null, refreshedAt: null, ...over });

test('plan: focus main post first, supports wait for it, then supports, then refresh, then priority', () => {
  const focus = K('f', { focus: true, focusStatus: 'active', focusSince: new Date(NOW - 5 * DAY), priority: 0.5 });
  const sup = K('s', { supportsId: 'f', priority: 2 });
  const other = K('o', { priority: 9 });
  assert.equal(nextPiece([focus, sup, other], { now: NOW }).keyword.id, 'f');
  // main post being written: supporting posts must not jump ahead, the general queue continues
  assert.equal(nextPiece([focus, sup, other], { now: NOW, busy: new Set(['f']) }).keyword.id, 'o');
  const liveFocus = { ...focus, status: 'published', publishedAt: new Date(NOW - 3 * DAY) };
  const p = nextPiece([liveFocus, sup, other], { now: NOW });
  assert.equal(p.mode, 'support');
  assert.equal(p.keyword.id, 's');
  const old = { ...liveFocus, publishedAt: new Date(NOW - 30 * DAY), position28: 9 };
  assert.equal(nextPiece([old, { ...sup, status: 'published' }, other], { now: NOW }).mode, 'refresh');
  assert.equal(nextPiece([{ ...old, position28: 2 }, { ...sup, status: 'published' }, other], { now: NOW }).keyword.id, 'o');
  assert.equal(nextPiece([K('idea1', { status: 'idea', priority: 99 })], { now: NOW }), null);
});

test('plan: slots respect post days and posts per week; roadmap simulates each piece', () => {
  const slots = nextSlots(cfg(), NOW, 4); // 2026-10-21 is a Wednesday
  assert.deepEqual(slots, ['2026-10-22', '2026-10-26', '2026-10-29', '2026-11-02']);
  assert.deepEqual(nextSlots(cfg({ POST_DAYS: 'mon,tue,wed,thu,fri', POSTS_PER_WEEK: '1' }), NOW, 2), ['2026-10-22', '2026-10-29']);
  const focus = K('f', { focus: true, focusStatus: 'active', focusSince: NOW });
  const road = roadmap([focus, K('s', { supportsId: 'f' }), K('o', { priority: 5 })], cfg(), { now: NOW, n: 5 });
  assert.deepEqual(road.map((r) => `${r.keywordId}:${r.mode}`), ['f:new', 's:support', 'o:new']);
  assert.equal(road[0].date, '2026-10-22');
});

test('settings: page value beats env beats server key beats default', () => {
  const f = FIELDS.find((x) => x.key === 'ANTHROPIC_API_KEY');
  assert.deepEqual(resolve(f, {}, {}), { value: '', source: 'default' });
  assert.deepEqual(resolve(f, {}, { ANTHROPIC_API_KEY: 'srv' }), { value: 'srv', source: 'server' });
  assert.deepEqual(resolve(f, {}, { ANTHROPIC_API_KEY: 'srv', WFP_ANTHROPIC_API_KEY: 'env' }), { value: 'env', source: 'env' });
  assert.equal(resolve(f, { ANTHROPIC_API_KEY: 'page' }, { WFP_ANTHROPIC_API_KEY: 'env' }).source, 'page');
  const c = cfg({ FTP_PORT: 'x', AUTOPILOT: 'on' });
  assert.equal(c.SITE_URL, 'https://www.wpgfence.ca');
  assert.equal(c.host, 'wpgfence.ca');
  assert.equal(c.ftpPort, 21);
  assert.equal(c.autopilot, true);
  assert.ok(c.services.includes('vinyl fence'));
});

test('template: URLs, sanitized body, one h1, schema, placeholders filled', () => {
  const c = cfg({ BLOG_DIR: 'blog', QUOTE_URL: 'https://www.wpgfence.ca/quote' });
  assert.deepEqual(postUrls(c, 'fence-cost'), { file: 'fence-cost.html', remoteDir: 'blog', path: '/blog/fence-cost.html', url: 'https://www.wpgfence.ca/blog/fence-cost.html', image: '/images/fence-cost.webp', blogUrl: 'https://www.wpgfence.ca/blog.html' });
  assert.equal(postUrls(cfg({ CLEAN_URLS: 'true' }), 'x').url, 'https://www.wpgfence.ca/x');
  const body = sanitizeBody('<h1>Big</h1><p onclick="x()">Hi <a href="javascript:alert(1)">x</a></p><script>bad()</script><iframe src="x"></iframe>');
  assert.equal(body, '<h2>Big</h2><p>Hi <a>x</a></p>');
  const { html } = renderPost(c, { slug: 'fence-cost', title: 'Fence Cost in Winnipeg & More', metaDescription: 'd', excerpt: 'e', category: 'Fencing', readTime: 6, bodyHtml: '<p>Body</p>', faq: [{ q: 'Q?', a: 'A.' }] }, '2026-10-21');
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.match(html, /<title>Fence Cost in Winnipeg &amp; More \| Winnipeg Fence Pros<\/title>/);
  assert.match(html, /href="https:\/\/www.wpgfence.ca\/blog\/fence-cost.html"/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /<!--HERO-->.*\/images\/fence-cost.webp.*<!--\/HERO-->/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/);
  assert.match(DEFAULT_TEMPLATE, /\{\{BODY\}\}/);
  assert.throws(() => renderPost(cfg({ POST_TEMPLATE: '<html></html>' }), { slug: 'x', title: 't', bodyHtml: '' }, '2026-10-21'), /BODY/);
});

test('template: import turns a site page into a template', () => {
  const page = '<html><head><title>Old</title><meta name="description" content="old"></head><body><h1>Site</h1><nav>menu</nav><article><h1>Old post</h1><p>text</p></article><footer>f</footer></body></html>';
  const { template, replaced } = templateFromPage(page);
  assert.deepEqual(replaced, ['title', 'article']);
  assert.match(template, /\{\{BODY\}\}/);
  assert.match(template, /content="\{\{META_DESCRIPTION\}\}"/);
  assert.match(template, /<nav>menu<\/nav>/);
  assert.equal((template.match(/<h1>/g) || []).length, 1);
  assert.equal(templateFromPage('<html><body><div>x</div></body></html>').template, null);
});

test('blog_publish.py: blog index and sitemap patching', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not installed' }, () => {
  const r = spawnSync('python3', ['-I', path.join(__dirname, 'wfp_publish_test.py')], { encoding: 'utf8', env: { ...process.env, WFP_SCRIPT_DIR: path.join(__dirname, '..', 'wfp') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
