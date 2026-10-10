const test = require('node:test');
const assert = require('node:assert');
const social = require('../ai/social');
const shifts = require('../ai/socialShifts');

const PHONE = '204-900-0438';

// A tiny in-memory stand-in for Prisma. $transaction runs one callback at a time, the way the advisory lock does in Postgres.
function fakeDb({ groups = [] } = {}) {
  const actions = [];
  let n = 0; let chain = Promise.resolve();
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('gte' in v || 'lt' in v || 'gt' in v || 'lte' in v) {
        const x = row[k]; if (x == null) return false;
        return (!('gte' in v) || x >= v.gte) && (!('lt' in v) || x < v.lt) && (!('gt' in v) || x > v.gt) && (!('lte' in v) || x <= v.lte);
      }
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
    }
    return row[k] === v;
  });
  const socialAction = {
    updateMany: async ({ where, data }) => { let c = 0; for (const r of actions) if (match(r, where)) { Object.assign(r, data); c++; } return { count: c }; },
    count: async ({ where }) => actions.filter((r) => match(r, where)).length,
    findMany: async ({ where }) => actions.filter((r) => match(r, where)),
    findFirst: async ({ where }) => [...actions].reverse().find((r) => match(r, where)) || null,
    create: async ({ data }) => { const r = { id: `a${++n}`, createdAt: new Date(), summary: '', url: null, ...data }; actions.push(r); return r; },
    update: async ({ where, data }) => Object.assign(actions.find((r) => r.id === where.id), data),
  };
  const socialGroup = {
    findFirst: async ({ where }) => groups.find((g) => g.id === where.id) || null,
    updateMany: async ({ where, data }) => { const g = groups.find((x) => x.id === where.id); if (g) { g.lastPostedAt = data.lastPostedAt; g.postsCount = (g.postsCount || 0) + 1; } return { count: g ? 1 : 0 }; },
  };
  const tx = { socialAction, socialGroup, $executeRaw: async () => 0 };
  const db = { ...tx, actions, $transaction: (fn) => { const run = chain.then(() => fn(tx)); chain = run.catch(() => {}); return run; } };
  return db;
}

// reserveAction/expireReservations take the db through options, but expireReservations inside defaults to prisma; route it to the fake
const reserve = (db, a) => social.reserveAction('u1', { platform: 'facebook', ...a }, { db });
const refusedWith = async (p, re) => { await assert.rejects(p, (e) => e.code === 'REFUSED' && re.test(e.reasons.join(' | '))); };

const member = (over = {}) => ({ id: 'g1', name: 'Winnipeg Homeowners', membership: 'member', promoPolicy: 'allowed', cooldownDays: 14, lastPostedAt: null, ...over });

test('social: a clean engagement comment is reserved and counts against the cap straight away', async () => {
  const db = fakeDb();
  const r = await reserve(db, { kind: 'comment', target: 'https://fb.com/p/1', text: 'Great looking yard, those edges are sharp!' });
  assert.equal(r.status, 'reserved');
  assert.ok(r.expiresAt > new Date());
});

test('social: price, mid-sentence dash and wrong name are refused by the server', async () => {
  const db = fakeDb();
  await refusedWith(reserve(db, { kind: 'comment', target: 't1', text: 'We do it for $50 total' }), /price/i);
  await refusedWith(reserve(db, { kind: 'comment', target: 't2', text: 'Nice work - looks great' }), /dash/i);
  await refusedWith(reserve(db, { kind: 'comment', target: 't3', text: 'Call No Bs Yardwork today' }), /spelled exactly/);
  assert.equal(db.actions.length, 0, 'refused text must not create a row');
});

test('social: casual comments carry no phone number, lead comments must', async () => {
  const db = fakeDb();
  await refusedWith(reserve(db, { kind: 'comment', target: 't1', text: `Love this! Call ${PHONE}` }), /must not include a phone/);
  await refusedWith(reserve(db, { kind: 'comment', target: 't2', promo: true, text: 'We can help with that cleanup.' }), /must include/);
  const ok = await reserve(db, { kind: 'comment', target: 't3', promo: true, text: `We can help with that cleanup. No-Bs Yardwork, call or text ${PHONE}.` });
  assert.equal(ok.status, 'reserved');
});

test('social: cap is enforced by the server, per platform, and reservations count', async () => {
  const db = fakeDb();
  for (let i = 0; i < 10; i++) await reserve(db, { kind: 'comment', target: `t${i}`, text: `Nice one number ${i}` });
  await assert.rejects(reserve(db, { kind: 'comment', target: 't-extra', text: 'One more nice one' }), (e) => e.code === 'CAP_REACHED' && e.cap === 10);
  const ig = await reserve(db, { platform: 'instagram', kind: 'comment', target: 'ig1', text: 'Beautiful lawn' });
  assert.equal(ig.platform, 'instagram', 'caps are per platform');
});

test('social: parallel reserves at cap minus one let exactly one through', async () => {
  const db = fakeDb();
  for (let i = 0; i < 4; i++) await reserve(db, { kind: 'group_join', target: `grp${i}` });
  const results = await Promise.allSettled([0, 1, 2].map((i) => reserve(db, { kind: 'group_join', target: `race${i}` })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'CAP_REACHED').length, 2);
});

test('social: an unconfirmed reservation expires and stops counting', async () => {
  const db = fakeDb();
  for (let i = 0; i < 10; i++) await reserve(db, { kind: 'like', target: `p${i}` });
  db.actions[0].expiresAt = new Date(Date.now() - 1000);
  const r = await reserve(db, { kind: 'like', target: 'p-new' });
  assert.equal(r.status, 'reserved');
  assert.equal(db.actions[0].status, 'skipped');
});

test('social: the same target is never commented on, liked or followed twice', async () => {
  const db = fakeDb();
  await reserve(db, { kind: 'like', target: 'https://fb.com/p/9' });
  await refusedWith(reserve(db, { kind: 'like', target: 'https://fb.com/p/9' }), /Already did/);
  await reserve(db, { kind: 'comment', target: 'https://fb.com/p/9', text: 'Great post' });
  await refusedWith(reserve(db, { kind: 'comment', target: 'https://fb.com/p/9', text: 'Another thought' }), /Already did/);
});

test('social: a follow-up comment needs the first one to be 2+ days old', async () => {
  const db = fakeDb();
  const first = await reserve(db, { kind: 'comment', target: 'lead1', text: 'Happy to help with that' });
  await refusedWith(reserve(db, { kind: 'comment', target: 'lead1', followUp: true, text: 'Just checking in' }), /2\+ days/);
  first.createdAt = new Date(Date.now() - 3 * 86400000);
  const f = await reserve(db, { kind: 'comment', target: 'lead1', followUp: true, text: 'Just checking in' });
  assert.equal(f.status, 'reserved');
});

test('social: group posts need membership, promo allowed, no cooldown, and never the same text twice', async () => {
  const g = member();
  const db = fakeDb({ groups: [g, member({ id: 'g2', name: 'Strict', promoPolicy: 'restricted' }), member({ id: 'g3', name: 'Rested', lastPostedAt: new Date(Date.now() - 20 * 86400000) }), member({ id: 'g4', name: 'Pending', membership: 'requested' })] });
  const text = `Fall cleanups booked now in Winnipeg. No-Bs Yardwork, call or text ${PHONE}.`;
  const post = await reserve(db, { kind: 'group_post', groupId: 'g1', text });
  await social.confirmAction('u1', post.id, { status: 'done', url: 'https://fb.com/groups/1/posts/2' }, { db });
  assert.ok(g.lastPostedAt, 'a confirmed group post starts the cooldown');
  await refusedWith(reserve(db, { kind: 'group_post', groupId: 'g1', text: text + ' ' }), /cooldown/);
  await refusedWith(reserve(db, { kind: 'group_post', groupId: 'g2', text }), /does not allow promo/);
  await refusedWith(reserve(db, { kind: 'group_post', groupId: 'g4', text }), /Not a member/);
  const rested = await reserve(db, { kind: 'group_post', groupId: 'g3', text });
  assert.equal(rested.status, 'reserved');
});
});

test('social: the exact same group text is refused even after the cooldown passes', async () => {
  const g = member({ lastPostedAt: new Date(Date.now() - 30 * 86400000) });
  const db = fakeDb({ groups: [g] });
  const text = `Weed control booked now. No-Bs Yardwork, call or text ${PHONE}.`;
  const p = await reserve(db, { kind: 'group_post', groupId: 'g1', text });
  await social.confirmAction('u1', p.id, { status: 'done', url: 'https://fb.com/groups/1/posts/3' }, { db });
  g.lastPostedAt = new Date(Date.now() - 30 * 86400000);
  await refusedWith(reserve(db, { kind: 'group_post', groupId: 'g1', text: `  ${text.toUpperCase().replace('NO-BS YARDWORK', 'No-Bs Yardwork')}` }), /already posted/);
});

test('social: Instagram feed posts must be reels, and groups are Facebook only', async () => {
  const db = fakeDb();
  const cap = `Fall cleanup season. No-Bs Yardwork, call or text ${PHONE}.`;
  await refusedWith(reserve(db, { platform: 'instagram', kind: 'page_post', text: cap }), /reels only/);
  const reel = await reserve(db, { platform: 'instagram', kind: 'page_post', format: 'reel', text: cap });
  assert.equal(reel.status, 'reserved');
  await refusedWith(reserve(db, { platform: 'instagram', kind: 'group_join', target: 'g' }), /Facebook only/);
});

test('social: comments, DMs and likes without a target are refused (nothing could be verified)', async () => {
  const db = fakeDb();
  await refusedWith(reserve(db, { kind: 'like' }), /target/);
  await refusedWith(reserve(db, { kind: 'comment', text: 'Nice' }), /target/);
});

test('social: confirm needs a link to the result and cannot be done twice', async () => {
  const db = fakeDb();
  const r = await reserve(db, { kind: 'follow', target: 'https://instagram.com/acct1' });
  await assert.rejects(social.confirmAction('u1', r.id, { status: 'done' }, { db }), /url/);
  const done = await social.confirmAction('u1', r.id, { status: 'done', url: 'https://instagram.com/acct1' }, { db });
  assert.equal(done.status, 'done');
  await assert.rejects(social.confirmAction('u1', r.id, { status: 'failed' }, { db }), (e) => e.code === 'ALREADY_CLOSED');
});

// ---------------------------------------------------------------------------------------------- shifts
// Winnipeg is UTC-5 in October (CDT), so 12:30Z is 07:30 local.
const at = (hhmm, day = '2026-10-12') => new Date(`${day}T${hhmm}:00-05:00`);   // 2026-10-12 is a Monday
const row = (kind, over = {}) => ({ kind, status: 'due', attempts: 0, ...over });

test('shifts: nothing is due before 7:30; morning opens at 7:30', () => {
  assert.deepEqual(shifts.openShifts(at('07:00'), []), []);
  assert.deepEqual(shifts.openShifts(at('07:31'), []).map((s) => s.kind), ['morning']);
});

test('shifts: the Monday studio shift only exists on Mondays', () => {
  assert.ok(shifts.openShifts(at('10:45', '2026-10-12'), []).some((s) => s.kind === 'studio'));
  assert.ok(!shifts.openShifts(at('10:45', '2026-10-13'), []).some((s) => s.kind === 'studio'));
});

test('shifts: a PC that comes back at 3:14 PM still gets the missed morning shift (power-loss catch-up)', () => {
  const kinds = shifts.openShifts(at('15:14', '2026-10-13'), []).map((s) => s.kind);
  assert.deepEqual(kinds, ['morning', 'midday']);
});

test('shifts: done and needs_owner shifts stay closed, a fresh claim is not handed out twice', () => {
  const now = at('08:00');
  assert.deepEqual(shifts.openShifts(now, [row('morning', { status: 'done' })]), []);
  assert.deepEqual(shifts.openShifts(now, [row('morning', { status: 'needs_owner' })]), []);
  assert.deepEqual(shifts.openShifts(now, [row('morning', { status: 'running', claimedAt: at('07:55'), attempts: 1 })]), []);
});

test('shifts: a crashed run (stale claim) is released; failures retry after a gap, max 3 attempts', () => {
  const now = at('10:00');
  assert.equal(shifts.openShifts(now, [row('morning', { status: 'running', claimedAt: at('07:35'), attempts: 1 })]).length, 1);
  assert.equal(shifts.openShifts(at('08:05'), [row('morning', { status: 'failed', attempts: 1, finishedAt: at('08:00') })]).length, 0, 'too soon to retry');
  assert.equal(shifts.openShifts(at('08:20'), [row('morning', { status: 'failed', attempts: 1, finishedAt: at('08:00') })]).length, 1);
  assert.equal(shifts.openShifts(at('09:30'), [row('morning', { status: 'failed', attempts: 3, finishedAt: at('08:00') })]).length, 0, 'out of attempts');
});

test('shifts: past the deadline a shift is dropped, not run at night', () => {
  assert.deepEqual(shifts.openShifts(at('22:30'), []), []);
  assert.ok(!shifts.openShifts(at('16:30'), []).some((s) => s.kind === 'morning'));
});
