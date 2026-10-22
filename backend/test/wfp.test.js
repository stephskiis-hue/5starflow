// Winnipeg Fence Pros pure-logic tests (no database, no network): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const kw = require('../wfp/keywords');
const { nextPiece, roadmap, nextSlots } = require('../wfp/plan');
const { toConfig, FIELDS, resolve, DEFAULT_TEMPLATE, parseServices } = require('../wfp/settings');
const { renderPost, renderCards, renderIndex, sanitizeBody, postUrls, templateFromPage, toggleBlocks } = require('../wfp/template');
const { convertContent, redirectPlugin, clip } = require('../wfp/migrate');
const { withCity } = require('../wfp/research');
const { checkPost, keywordCoverage, normPath } = require('../wfp/check');
const { bodyOf } = require('../wfp/assign');
const fs = require('fs');

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
  const f = FIELDS.find((x) => x.key === 'SERPER_API_KEY');
  assert.deepEqual(resolve(f, {}, {}), { value: '', source: 'default' });
  assert.deepEqual(resolve(f, {}, { SERPER_API_KEY: 'srv' }), { value: 'srv', source: 'server' });
  assert.deepEqual(resolve(f, {}, { SERPER_API_KEY: 'srv', WFP_SERPER_API_KEY: 'env' }), { value: 'env', source: 'env' });
  assert.equal(resolve(f, { SERPER_API_KEY: 'page' }, { WFP_SERPER_API_KEY: 'env' }).source, 'page');
  assert.equal(FIELDS.find((x) => x.key === 'PEXELS_API_KEY').shared, 'PEXELS_API_KEY');
  assert.ok(!FIELDS.some((x) => /ANTHROPIC|WRITER_MODEL/.test(x.key)), 'no Anthropic key: the writer is a Claude routine');
  const c = cfg({ FTP_PORT: 'x', AUTOPILOT: 'on' });
  assert.equal(c.SITE_URL, 'https://www.wpgfence.ca');
  assert.equal(c.host, 'wpgfence.ca');
  assert.equal(c.ftpPort, 21);
  assert.equal(c.autopilot, true);
  assert.deepEqual(c.services.map((x) => [x.name, x.path]), [['Fence', '/'], ['Deck', '/decks.html'], ['Pergola', '/pergolas.html'], ['Landscaping', '/landscaping.html']]);
  assert.ok(c.services[0].terms.includes('chain link') && c.services[0].terms.includes('fence'));
  assert.deepEqual(parseServices('Fence|fences.html|a, b\n\nDeck'), [{ name: 'Fence', path: '/fences.html', terms: ['fence', 'a', 'b'] }, { name: 'Deck', path: '', terms: ['deck'] }]);
  assert.deepEqual(c.navLinks[1], { label: 'Deck', path: '/decks.html' });
});

test('services: each keyword gets the service it is about (longest term wins, then list order)', () => {
  const sv = cfg().services;
  const f = (q) => kw.serviceFor(q, sv);
  assert.equal(f('cedar fence cost winnipeg'), 'Fence');
  assert.equal(f('how much does a composite deck cost'), 'Deck');
  assert.equal(f('pergola vs gazebo'), 'Pergola');
  assert.equal(f('retaining wall winnipeg'), 'Landscaping');
  assert.equal(f('deck railing codes'), 'Deck');
  assert.equal(f('hot tub concrete pad'), null);
  assert.equal(kw.describe('pergola cost winnipeg', cfg()).service, 'Pergola');
});

test('plan: general queue alternates services unless the other is much weaker', () => {
  const sv = (id, service, priority, over = {}) => K(id, { service, priority, ...over });
  const live = sv('live', 'Fence', 1, { status: 'published', publishedAt: new Date(NOW - DAY) });
  const a = sv('a', 'Fence', 10); const b = sv('b', 'Deck', 8); const c = sv('c', 'Pergola', 2);
  assert.equal(nextPiece([live, a, b, c], { now: NOW }).keyword.id, 'b');
  assert.equal(nextPiece([live, a, c], { now: NOW }).keyword.id, 'a');
  assert.equal(nextPiece([a, b], { now: NOW }).keyword.id, 'a');
});

test('template: folder URLs, html URLs, list page URL', () => {
  const c = cfg({ QUOTE_URL: 'https://www.wpgfence.ca/quote' });
  assert.deepEqual(postUrls(c, 'fence-cost'), { file: 'index.html', remoteDir: 'articles/fence-cost', path: '/articles/fence-cost/', url: 'https://www.wpgfence.ca/articles/fence-cost/', image: '/images/fence-cost.webp', blogUrl: 'https://www.wpgfence.ca/articles/' });
  const h = postUrls(cfg({ URL_STYLE: 'html', BLOG_INDEX_FILE: 'blog.html', BLOG_DIR: 'blog' }), 'x');
  assert.deepEqual([h.file, h.remoteDir, h.path, h.blogUrl], ['x.html', 'blog', '/blog/x.html', 'https://www.wpgfence.ca/blog.html']);
});

test('template: article page is complete, themed, links the service page, one h1', () => {
  const c = cfg({ QUOTE_URL: 'https://www.wpgfence.ca/quote', PHONE: '204-555-0100' });
  const post = { slug: 'deck-cost', title: 'Deck Cost in Winnipeg & More', metaDescription: 'd', excerpt: 'e', category: 'Deck', readTime: 6, bodyHtml: '<h1>Big</h1><p onclick="x()">Body <a href="javascript:alert(1)">x</a></p><script>bad()</script>', faq: [{ q: 'Q?', a: 'A.' }] };
  const { html } = renderPost(c, post, '2026-10-21');
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.match(html, /<title>Deck Cost in Winnipeg &amp; More \| Winnipeg Fence Pros<\/title>/);
  assert.match(html, /rel="canonical" href="https:\/\/www.wpgfence.ca\/articles\/deck-cost\/"/);
  assert.match(html, /href="https:\/\/www.wpgfence.ca\/decks.html"[^>]*>See our Deck work/);
  assert.match(html, /"@type":"BreadcrumbList"/);
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /<img src="\/img\/logo.webp" alt="Winnipeg Fence Pros"/);
  assert.match(html, /<li class="dropdown"><a class="dropdown-item" href="https:\/\/www.wpgfence.ca\/pergolas.html">Pergola<\/a><\/li>/);
  assert.match(html, /<a class="dropdown-item active" href="https:\/\/www.wpgfence.ca\/articles\/">Articles<\/a>/);
  assert.match(html, /<header id="header"/);
  assert.match(html, /<link rel="stylesheet" href="\/css\/theme.css">/);
  assert.match(html, /<script src="\/js\/theme.init.js"><\/script>/);
  assert.match(html, /<img class="wfp-hero-img" src="\/images\/deck-cost.webp"/);
  assert.match(html, /tel:204-555-0100/);
  assert.match(html, /--wfp-orange: #fea45a/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}|<script>bad|javascript:|onclick/);
  const noPhone = renderPost(cfg({ PHONE: '' }), { ...post, image: '' }, '2026-10-21').html;
  assert.ok(!/href="tel:|<img class="wfp-hero-img"|<!--HERO/.test(noPhone));
  assert.match(DEFAULT_TEMPLATE, /\{\{BODY\}\}/);
  assert.throws(() => renderPost(cfg({ POST_TEMPLATE: '<html></html>' }), { slug: 'x', title: 't', bodyHtml: '' }, '2026-10-21'), /BODY/);
  assert.equal(sanitizeBody('<h1>Big</h1><p onclick="x()">Hi</p><iframe src="x"></iframe>'), '<h2>Big</h2><p>Hi</p>');
});

test('list page: cards newest first, image block dropped when there is none, markers inside the page', () => {
  const c = cfg();
  const cards = renderCards(c, [
    { url: '/articles/old/', title: 'Old <one>', excerpt: 'e', category: 'Fence', readTime: 4, date: '2026-01-02', image: '' },
    { url: '/articles/new/', title: 'New', excerpt: 'e', category: 'Deck', readTime: 5, date: '2026-09-02', image: '/images/new.webp' },
  ]);
  assert.ok(cards.indexOf('/articles/new/') < cards.indexOf('/articles/old/'));
  assert.match(cards, /data-category="Deck"/);
  assert.match(cards, /<img src="\/images\/new.webp"/);
  assert.match(cards, /Old &lt;one&gt;/);
  assert.equal((cards.match(/<img /g) || []).length, 1);
  const page = renderIndex(c, cards);
  assert.match(page, /<!-- 5sf:articles:start -->\n<article class="wfp-card"/);
  assert.match(page, /<!-- 5sf:articles:end -->/);
  assert.match(page, /rel="canonical" href="https:\/\/www.wpgfence.ca\/articles\/"/);
  assert.doesNotMatch(page, /\{\{[A-Z_]+\}\}/);
  assert.equal(toggleBlocks('a<!--X-->b<!--/X-->c', { X: false }), 'ac');
  assert.equal(toggleBlocks('a<!--X-->b<!--/X-->c', { X: true }), 'abc');
});

test('migrate: WordPress HTML becomes clean article HTML with local images and rewritten links', () => {
  const c = cfg();
  const base = 'https://www.wpgfence.ca/blog';
  const html = '<!-- wp:image --><figure class="wp-block-image"><img src="https://www.wpgfence.ca/blog/wp-content/uploads/2026/08/hero-1024x683.jpg" srcset="a 1x"></figure><!-- /wp:image -->'
    + '<p>See <a href="https://www.wpgfence.ca/blog/other-post/">other</a> and <a href="/blog/missing/">gone</a> and <a href="https://www.wpgfence.ca/blog/">all</a>.</p>'
    + '<p><img src="/blog/wp-content/uploads/2026/08/fence.jpg" srcset="x 2x" sizes="100vw"></p>[caption id="1"]cap[/caption]<p>&nbsp;</p>';
  const out = convertContent(html, { cfg: c, base, slugs: new Set(['other-post']), featured: 'https://www.wpgfence.ca/blog/wp-content/uploads/2026/08/hero.jpg' });
  assert.doesNotMatch(out.html, /hero|wp:image|srcset|sizes|\[caption|<p><\/p>/);
  assert.match(out.html, /href="\/articles\/other-post\/"/);
  assert.match(out.html, /href="\/blog\/missing\/"/);
  assert.match(out.html, /href="\/articles\/"/);
  assert.match(out.html, /src="\/images\/articles\/fence.jpg"/);
  assert.deepEqual([...out.images.values()], ['fence.jpg']);
});

test('migrate: excerpts are cut at a word boundary', () => {
  assert.equal(clip('short', 20), 'short');
  const c = clip('The best fencing options for Winnipeg homeowners must withstand extreme swings', 40);
  assert.ok(c.endsWith('…') && c.length <= 40 && !/\s…$/.test(c), c);
  assert.ok(!/\w…$/.test(c) || c.slice(0, -1).split(' ').every((w) => 'The best fencing options for Winnipeg homeowners must withstand extreme swings'.includes(w)));
});

test('migrate: the redirect file maps every old slug, escapes quotes and only touches the blog path', () => {
  const php = redirectPlugin(cfg(), '/blog', { 'a-post': '/articles/a-post/', "it's": '/articles/its/' });
  assert.match(php, /^<\?php/);
  assert.match(php, /'a-post' => '\/articles\/a-post\/'/);
  assert.match(php, /'it\\'s' => '\/articles\/its\/'/);
  assert.match(php, /\$base = '\/blog\/'/);
  assert.match(php, /\$site = 'https:\/\/www.wpgfence.ca'/);
  assert.match(php, /header\('Location: ' \. \$site \. \$to, true, 301\)/);
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

test('no AI on the server: nothing in wfp/ imports the Anthropic SDK', () => {
  const dir = path.join(__dirname, '..', 'wfp');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /@anthropic-ai\/sdk/, f);
  assert.ok(!fs.existsSync(path.join(dir, 'writer.js')));
});

const SITE = { origin: 'https://www.wpgfence.ca', allowedPaths: new Set(['/', '/decks.html', '/articles', '/articles/fence-permits']) };
const BRIEF = { mode: 'new', keyword: 'deck cost winnipeg', wordCount: { min: 120, max: 400 },
  requiredLinks: [{ url: 'https://www.wpgfence.ca/decks.html', why: 'the Deck service page' }, { url: 'https://www.wpgfence.ca/#contactus', why: 'the free estimate' }] };
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const GOOD = {
  title: 'Deck Cost in Winnipeg: 2026 Price Guide',
  metaDescription: 'What a new deck costs in Winnipeg in 2026: typical price ranges by size and material, permits, and what pushes the price up. Plan your build here.',
  excerpt: 'Typical deck prices in Winnipeg by size and material.',
  bodyHtml: `<p>A deck in Winnipeg costs more than you think. Deck cost depends on size. ${words(40)}</p><h2>Cost by size</h2><p>${words(40)} See our <a href="/decks.html">deck building</a> page.</p><h2>Permits</h2><p>${words(30)} <a href="https://winnipeg.ca/ppd">City</a></p><h2>Next step</h2><p>${words(20)} <a href="https://www.wpgfence.ca/#contactus">Get a free estimate</a> or read <a href="/articles/fence-permits/">fence permits</a>.</p>`,
  faq: [{ q: 'A?', a: 'a' }, { q: 'B?', a: 'b' }, { q: 'C?', a: 'c' }],
  imageQuery: 'composite deck backyard', sources: ['https://winnipeg.ca/ppd', { url: 'https://example.org/cost' }],
};

test('checks: a good post passes', () => {
  assert.deepEqual(checkPost(GOOD, BRIEF, SITE), []);
  assert.equal(normPath('/articles/x/'), '/articles/x');
  assert.equal(normPath('/index.html'), '/');
  assert.equal(keywordCoverage('Winnipeg deck costs', 'deck cost winnipeg'), 1);
});

test('checks: every rule reports its own problem and nothing slips through', () => {
  const errs = (patch, brief = BRIEF) => checkPost({ ...GOOD, ...patch }, brief, SITE).join(' | ');
  assert.match(errs({ title: 'x'.repeat(61) }), /61 characters \(max 60\)/);
  assert.match(errs({ title: 'Pergola Ideas' }), /title does not contain the keyword/);
  assert.match(errs({ metaDescription: 'short' }), /metaDescription is 5 characters/);
  assert.match(errs({ bodyHtml: `<h1>x</h1>${GOOD.bodyHtml}` }), /<h1>/);
  assert.match(errs({ bodyHtml: GOOD.bodyHtml.replace('<p>A deck', '<p style="color:red">A deck') }), /style=""/);
  assert.match(errs({ bodyHtml: GOOD.bodyHtml.replace('href="/decks.html"', 'href="/fences.html"') }), /required link missing: https:\/\/www.wpgfence.ca\/decks.html.*\/fences.html goes to a page that is not on the site|\/fences.html goes to a page that is not on the site/);
  assert.match(errs({ bodyHtml: GOOD.bodyHtml.replace('Get a free estimate', 'x').replace('https://www.wpgfence.ca/#contactus', 'https://other.com/') }), /required link missing: https:\/\/www.wpgfence.ca\/#contactus/);
  assert.match(errs({ bodyHtml: '<h2>a</h2><p>short</p>' }), /words \(at least 120\)/);
  assert.match(errs({ bodyHtml: GOOD.bodyHtml.replace('A deck in Winnipeg costs more than you think. Deck cost depends on size.', 'Hello there.') }), /not in the first 100 words/);
  assert.match(errs({ excerpt: 'We leverage cedar — always.' }), /dashes.*banned words: leverage/);
  assert.match(errs({ faq: [{ q: 'A?', a: 'a' }] }), /faq has 1 questions/);
  assert.match(errs({ faq: [{ q: 'A?', a: '<b>a</b>' }, { q: 'B?', a: 'b' }, { q: 'C?', a: 'c' }] }), /plain text/);
  assert.match(errs({ imageQuery: '' }), /imageQuery is missing/);
  assert.equal(errs({ imageQuery: '' }, { ...BRIEF, mode: 'refresh' }), '');
  assert.match(errs({ sources: ['https://a.ca'] }), /1 research URLs/);
  assert.match(errs({ bodyHtml: GOOD.bodyHtml.replace('https://winnipeg.ca/ppd', 'javascript:alert(1)') }), /must be http/);
});

test('assign: the editable body of a published post comes from its .content', () => {
  assert.equal(bodyOf('<html><body><h1>T</h1><div class="content"><p>Body</p></div><div class="cta">x</div></body></html>'), '<p>Body</p>');
  assert.equal(bodyOf('<article><p>A</p></article>'), '<p>A</p>');
});

test('plan: a queued correction comes right after focus work and leaves the roadmap once simulated', () => {
  const live = (id, over) => K(id, { status: 'ranking', publishedAt: new Date(NOW - 60 * DAY), targetUrl: `https://x/${id}/`, ...over });
  const a = live('a', { refreshAsked: new Date(NOW - 2 * DAY), refreshReason: 'low click rate' });
  const b = live('b', { refreshAsked: new Date(NOW - 5 * DAY), refreshReason: 'stuck at 14' });
  const plain = K('p', { priority: 99 });
  const first = nextPiece([a, b, plain], { now: NOW });
  assert.deepEqual([first.mode, first.keyword.id], ['refresh', 'b']);
  assert.match(first.why, /Correction: stuck at 14/);
  const focus = K('f', { focus: true, focusStatus: 'active', focusSince: NOW });
  assert.equal(nextPiece([a, focus, plain], { now: NOW }).keyword.id, 'f');
  assert.equal(nextPiece([a, plain], { now: NOW, busy: new Set(['a']) }).keyword.id, 'p');
  const road = roadmap([a, b, plain], cfg(), { now: NOW, n: 3 });
  assert.deepEqual(road.map((r) => `${r.keywordId}:${r.mode}`), ['b:refresh', 'a:refresh', 'p:new']);
});
