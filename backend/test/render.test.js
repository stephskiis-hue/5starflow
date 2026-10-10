// Browser render checks: skipped when no Chromium is available (set CHROMIUM_PATH, or `npx playwright install chromium`).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPost, storyProblems, closeBrowser } = require('../ai/design/renderer');

let skip = false;
test.before(async () => {
  try { await renderPost({ layout: 'StoryPoll', slots: { kicker: 'K', question: 'Q', body: 'B' } }); } catch (e) { skip = `no Chromium: ${e.message.split('\n')[0]}`; }
});
test.after(() => closeBrowser());

// The real tip story that went out looking zoomed out (Oct 10 2026): it must now fill a phone screen.
const STORIES = {
  TipPost: { number: '04', kicker: 'WINNIPEG FALL TIP', headline: 'Stop snow mold now.', body: 'Make your last mow 2 inches. Skip late fertilizer. Rake up thick leaf mats before snow.' },
  GridPost: { kicker: 'WINNIPEG · BEFORE FREEZE UP', headline: 'Your October yard plan', tiles: [{ num: '01', label: 'Last mows' }, { num: '02', label: 'Leaves off' }, { num: '03', label: 'Blow out lines' }, { num: '04', label: 'Soak the cedars' }] },
  StatementPost: { kicker: 'SNOW SEASON 2026', headline: 'Snow spots are [[filling up]].', body: 'Monthly contracts only. Priority or budget friendly. Ask for a quote today.' },
  FAQPost: { kicker: 'YOU ASKED', question: 'When should I do my last mow?', answer_headline: 'Late October.', answer: 'Once the grass stops growing, cut it to about 2 inches and leave it for winter.' },
  ComparePost: { kicker: 'SNOW PLANS', headline: 'Pick your plan', a_label: 'PRIORITY', a_big: '24h', a_items: ['Cleared within the day', 'Monthly contract'], b_label: 'BUDGET', b_big: '48h', b_items: ['Cleared within 48 hours', 'Monthly contract'] },
  PrintPost: { headline: 'Leaves fall. [[We don\'t.]]', body: 'Fall cleanups across Winnipeg. Book before the snow.' },
  ReviewPost: { quote: 'They showed up when they said, cleaned up everything, and the lawn has never looked better.', reviewer: 'Sarah · Charleswood', rating: '5' },
};

for (const [layout, slots] of Object.entries(STORIES)) {
  test(`story render: ${layout} fills a 1080x1920 frame with phone-legible text`, async (t) => {
    if (skip) return t.skip(skip);
    const r = await renderPost({ layout, slots, size: 'story' });
    assert.deepEqual([r.width, r.height], [1080, 1920]);
    assert.deepEqual(storyProblems(r), [], JSON.stringify(r.story));
  });
}

test('story render: a near-empty frame is caught', async (t) => {
  if (skip) return t.skip(skip);
  const r = await renderPost({ layout: 'StatementPost', slots: { kicker: 'K', headline: 'Hi', body: 'Ok' }, size: 'story' });
  assert.match(storyProblems(r).join(), /mostly empty/);
});
