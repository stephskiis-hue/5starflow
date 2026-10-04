// Pure-logic tests (no database, no browser): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyConversation } = require('../ai/comms');
const { lintContent } = require('../ai/design/qa');
const { buildHtml, validate } = require('../ai/design/renderer');
const { toDateString, localHour, tzOffsetFor, dayBounds } = require('../lib/tz');
const { normalizeResult, classifyError } = require('../ai/ledger');
const { autoTags } = require('../ai/vault');

const ago = (min) => new Date(Date.now() - min * 60000);
const inbound = (body, min, extra = {}) => ({ direction: 'in', body, at: ago(min), source: 'inbound', sentiment: null, ...extra });
const outbound = (body, min, source) => ({ direction: 'out', body, at: ago(min), source, status: 'queued' });

test('conversation: a quote request nobody answered is waiting on us', () => {
  const c = classifyConversation([inbound('Hi, can you give me a quote for fall cleanup?', 300)]);
  assert.match(c.state, /NEW|WAITING_ON_NOBS/);
  assert.equal(c.urgency, 'high');
});

test('conversation: automated texts (campaign, review, rain) never count as a reply', () => {
  for (const source of ['campaign', 'review', 'rain', 'loyalty']) {
    const c = classifyConversation([inbound('Do you do aeration?', 200), outbound('Fall special!', 100, source)]);
    assert.notEqual(c.state, 'WAITING_ON_CUSTOMER', source);
  }
});

test('conversation: a delivered human reply answers; a carrier-rejected one does not', () => {
  assert.equal(classifyConversation([inbound('Do you do aeration?', 200), outbound('Yes we do!', 100, 'manual')]).state, 'WAITING_ON_CUSTOMER');
  const failed = { ...outbound('Yes we do!', 100, 'manual'), status: 'undelivered' };
  assert.notEqual(classifyConversation([inbound('Do you do aeration?', 200), failed]).state, 'WAITING_ON_CUSTOMER');
});

test('conversation: thanks with a request in it is NOT resolved', () => {
  assert.equal(classifyConversation([inbound('Thanks so much, the crew did an amazing job!', 90, { sentiment: 'promoter' })]).state, 'RESOLVED');
  const c = classifyConversation([outbound('Rain moved you to Friday', 500, 'rain'), inbound("Thanks, Friday doesn't work for me. Monday instead please.", 90, { sentiment: 'promoter' })]);
  assert.notEqual(c.state, 'RESOLVED');
});

test('conversation: a bare NO only closes a thread when it answers an automated message', () => {
  assert.equal(classifyConversation([outbound('Fall special, reply Y or N', 100, 'campaign'), inbound('No', 50)]).state, 'RESOLVED');
  assert.notEqual(classifyConversation([outbound('Is the gate locked?', 100, 'manual'), inbound('No', 50)]).state, 'RESOLVED');
});

test('conversation: complaints escalate, STOP resolves, old silence escalates', () => {
  assert.equal(classifyConversation([inbound('You damaged my sprinkler, I want a refund', 30)]).state, 'ESCALATION_REQUIRED');
  assert.equal(classifyConversation([inbound('STOP', 10)]).state, 'RESOLVED');
  assert.equal(classifyConversation([inbound('Are you coming Tuesday?', 1600), outbound('Fall special!', 100, 'campaign')]).state, 'ESCALATION_REQUIRED');
});

test('qa: prices, mid-sentence dashes, bad name, wrong phone and banned words are errors', () => {
  assert.equal(lintContent({ slots: { headline: 'Snow plans from $99' } }).ok, false);
  assert.equal(lintContent({ slots: { body: 'Monthly only — no per visit bills' } }).ok, false);
  assert.equal(lintContent({ caption: 'By No BS Yardwork team. Call 204-900-0438' }).ok, false);
  assert.equal(lintContent({ caption: 'Call or text 204-900-0348' }).ok, false);
  assert.equal(lintContent({ caption: 'We leverage synergy. 204-900-0438' }).ok, false);
});

test('qa: clean copy passes', () => {
  const r = lintContent({ slots: { headline: 'Drop the mower. Slowly.', body: 'Last cut of the year: 2 to 2.5 inches.' }, caption: 'Winnipeg fall tip. Call or text 204-900-0438.', platform: 'facebook' });
  assert.deepEqual(r.errors, []);
});

test('renderer: required slots, photo requirement and length caps are enforced', () => {
  assert.throws(() => validate('StatementPost', { kicker: 'K' }, 'feed'), /needs: headline, body/);
  assert.throws(() => validate('BeforeAfterPost', { kicker: 'K', headline: 'H', before: 'x', after: 'y' }, 'feed', {}), /real photo/);
  validate('BeforeAfterPost', { kicker: 'K', headline: 'H', before: 'vault:a', after: 'vault:b' }, 'feed', { before: 'data:x', after: 'data:y' });
  assert.throws(() => validate('StatementPost', { kicker: 'K', headline: 'H', body: 'x'.repeat(601) }, 'feed'), /too long|characters/i);
  assert.doesNotThrow(() => validate('StoryPoll', { kicker: 'K', question: 'Q', body: 'B' }, 'square'));   // story-only layouts coerce the size
});

test('renderer: story-only layouts ignore the default size', () => {
  const { w, h } = buildHtml('StoryPoll', { kicker: 'K', question: 'Q', body: 'B' }, 'feed');
  assert.deepEqual([w, h], [1080, 1920]);
});

test('renderer: slot text cannot inject HTML', () => {
  const { html } = buildHtml('StatementPost', { kicker: '<img src=x onerror=alert(1)>', headline: 'A\n[[B]]', body: '"><script>alert(1)</script>' }, 'feed');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('<span>B</span>'));
});

test('renderer: a long run of "[" is not a ReDoS', () => {
  const t0 = Date.now();
  assert.throws(() => buildHtml('StatementPost', { kicker: 'K', headline: '['.repeat(100000), body: 'B' }, 'feed'));
  assert.ok(Date.now() - t0 < 500);
});

test('tz: Winnipeg offset follows DST and day bounds are 24h', () => {
  assert.equal(tzOffsetFor('2026-07-15'), '-05:00');
  assert.equal(tzOffsetFor('2026-12-15'), '-06:00');
  assert.equal(toDateString(new Date('2026-10-04T03:00:00Z')), '2026-10-03');
  assert.equal(localHour(new Date('2026-07-15T14:00:00Z')), 9);
  const { start, end } = dayBounds('2026-10-03');
  assert.equal(end - start, 24 * 3600 * 1000);
});

test('ledger: results are normalized and errors classified', () => {
  assert.equal(normalizeResult(undefined).items_found, 0);
  assert.equal(normalizeResult({ items_found: 3, summary: 's' }).summary, 's');
  assert.equal(classifyError(new Error("You've hit your weekly limit")), 'rate_limit');
  assert.equal(classifyError({ message: 'x', response: { status: 401 } }), 'auth');
  assert.equal(classifyError(new Error('ECONNRESET')), 'network');
});

test('vault: filenames auto-tag', () => {
  const t = autoTags('fall-cleanup-patio-before.png');
  for (const want of ['FALL', 'PATIOS', 'BEFORE']) assert.ok(t.includes(want), want);
});

const { isMoneyTopic, quotesAmount } = require('../ai/money');
const { compose } = require('../ai/digest');

test('money: amounts and payment talk are money, a plain quote request is not', () => {
  for (const t of ['how much for fall cleanup?', 'I sent the e-transfer', 'I want a refund', 'is it $200?', 'can you send the invoice']) assert.ok(isMoneyTopic(t), t);
  for (const t of ['can you give me a quote for fall cleanup?', 'are you available Thursday?', 'do you do aeration']) assert.ok(!isMoneyTopic(t), t);
  assert.ok(quotesAmount('about $150 for that') && !quotesAmount('we will send a quote'));
});

test('digest: nothing needed means no text; otherwise one short summary', () => {
  assert.equal(compose({ moneyHolds: [], waiting: [], failing: [] }), null);
  const msg = compose({ moneyHolds: [{ customerName: 'Jane Doe' }, { customerName: 'Bob' }], waiting: [{}], failing: [] });
  assert.match(msg, /2 money questions \(Jane, Bob\)/);
  assert.match(msg, /1 customer waiting 4h\+/);
  assert.ok(msg.length < 200);
});

const { extractPrices, classifyService, stats } = require('../ai/learning/pricing');
test('pricing: amounts, services and stats', () => {
  assert.deepEqual(extractPrices('Fall cleanup would be $220, plus $15 for bags'), [220]);   // <20 ignored as noise
  assert.deepEqual(extractPrices('about $1,200 for the sod'), [1200]);
  assert.equal(classifyService('how much for aeration?'), 'aeration');
  assert.equal(classifyService('snow removal monthly'), 'snow');
  assert.deepEqual(stats([200, 240, 220]), { count: 3, min: 200, median: 220, max: 240 });
});

test('vault: HEIC is told apart from MP4/MOV clips and converted to a real JPEG', async () => {
  const fs = require('node:fs'); const path = require('node:path');
  const { sniff, heicToJpeg } = require('../ai/vault');
  const heic = fs.readFileSync(path.join(__dirname, 'fixtures', 'iphone-sample.heic'));
  assert.equal(sniff(heic), 'image/heic');
  assert.equal(sniff(Buffer.from('\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00', 'binary')), 'video/mp4');
  assert.equal(sniff(Buffer.from('\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00', 'binary')), 'video/quicktime');
  assert.equal(sniff(await heicToJpeg(heic)), 'image/jpeg');
  await assert.rejects(heicToJpeg(Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00junkjunk', 'binary')), { code: 'INVALID_ASSET' });
});
