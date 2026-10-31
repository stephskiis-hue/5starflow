process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInterac, normName, toCents } = require('../ai/etransfer/parse');
const { matchReceipt, equivalencesFrom } = require('../ai/etransfer/match');

// Real Interac layouts (Oct 2026 inbox), names and references changed.
const AUTH_OK = [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@payments.interac.ca header.s=s1 header.b=abc; spf=pass (google.com: domain of bounce@payments.interac.ca designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@payments.interac.ca; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=payments.interac.ca' }];
const body = ({ amount, name, ref, date = 'Oct 21, 2026', message, bank = 'RBC Royal Bank' }) => `Hi NO-BS YARDWORK,

Funds Deposited!
$${amount}

Your funds have been automatically deposited into your account at BMO Bank of Montreal.

BMO Bank of Montreal
Account ending in 6007

Transfer Details
${message ? `\nMessage:\n${message}\n` : ''}
Date: ${date}
Reference Number: ${ref}
Sent From: ${name}
Amount: $${amount} (CAD)

FAQ: https://www.interac.ca/en/interac-etransfer/etransfer-faq | This is a secure transaction.

This email was sent to you by Interac Corp., the owner of the Interac e-Transfer service, on behalf of ${name} at ${bank}.`;
const email = (o) => ({
  from: 'Interac e-Transfer <notify@payments.interac.ca>', headers: AUTH_OK,
  subject: `Interac e-Transfer: You've received $${o.amount} from ${o.name} and it has been automatically deposited.`,
  body: body(o), ...o.over,
});

test('parses a plain deposit', () => {
  const r = parseInterac(email({ amount: '97.11', name: 'MARGARET HALE', ref: 'C1Ak5P5ajvJM' }));
  assert.equal(r.kind, 'deposited');
  assert.equal(r.amountCents, 9711);
  assert.equal(r.senderName, 'MARGARET HALE');
  assert.equal(r.ref, 'C1Ak5P5ajvJM');
  assert.equal(r.message, null);
  assert.equal(r.bank, 'RBC Royal Bank');
  assert.equal(r.authOk, true);
  assert.equal(r.sentDate.getFullYear(), 2026);
});

test('parses a comma amount, a message and a "Sept" date', () => {
  const r = parseInterac(email({ amount: '1,993.95', name: 'CHANDRA PARK', ref: 'C1AHCdknruZH', date: 'Sept 18, 2026', message: '1391 side walk done', bank: 'Steinbach Credit Union' }));
  assert.equal(r.amountCents, 199395);
  assert.equal(r.message, '1391 side walk done');
  assert.equal(r.sentDate.getMonth(), 8);
});

test('middle initials and hyphens normalize', () => {
  assert.equal(normName('MAXINE M MILLER'), 'MAXINE MILLER');
  assert.equal(normName('Laurie-Anne Régula'), 'LAURIE ANNE REGULA');
  assert.equal(toCents('$3,000.00 (CAD)'), 300000);
  assert.equal(toCents('5.5'), 550);
});

test('not-yet-deposited, outgoing and failed-auth emails are flagged', () => {
  const pending = parseInterac({ from: 'notify@payments.interac.ca', headers: AUTH_OK, subject: 'Interac e-Transfer: MENEER DEVELOPMENT LTD sent you $70.00. Claim your deposit!', body: 'Reference Number: C1Xx\nSent From: MENEER DEVELOPMENT LTD\nAmount: $70.00 (CAD)\n' });
  assert.equal(pending.kind, 'pending_accept');
  assert.equal(pending.amountCents, 7000);

  const out = parseInterac({ from: 'catch@payments.interac.ca', headers: AUTH_OK, subject: 'Interac e-Transfer: Your $621.73 transfer to NICK CRANE has been successfully deposited.', body: 'deposited' });
  assert.equal(out.kind, 'outgoing');

  const forged = parseInterac(email({ amount: '97.11', name: 'MARGARET HALE', ref: 'C1Fake', over: { headers: [{ name: 'Authentication-Results', value: 'mx.google.com; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=payments.interac.ca' }, AUTH_OK[0]] } }));
  assert.equal(forged.authOk, false, 'a forged Authentication-Results below Google\'s must not count');

  const spoofFrom = parseInterac(email({ amount: '97.11', name: 'MARGARET HALE', ref: 'C1Fake2', over: { from: 'notify@payments-interac.ca' } }));
  assert.equal(spoofFrom.authOk, false);

  const cancelled = parseInterac({ from: 'notify@payments.interac.ca', headers: AUTH_OK, subject: 'Interac e-Transfer: The transfer from JO DOE has been cancelled', body: '' });
  assert.equal(cancelled.kind, 'cancelled');
});

// ------------------------------------------------------------------ matching
let seq = 0;
const inv = (client, cents, over = {}) => ({ id: `inv${++seq}`, invoiceNumber: String(900 + seq), cents, issuedDate: `2026-10-${String(10 + (seq % 18)).padStart(2, '0')}`, webUri: `https://secure.getjobber.com/invoices/${seq}`, street: null, client, ...over });
const cl = (id, name, firstName, lastName, companyName = null) => ({ id, name, firstName, lastName, companyName });
const rec = (senderName, amountCents, message = null, over = {}) => ({ senderName, senderNameNorm: normName(senderName), amountCents, message, ...over });

const P = 31395;   // the spring price
const crowd = () => Array.from({ length: 50 }, (_, i) => inv(cl(`c${i}`, `Client ${i} Person`, `Client${i}`, 'Person'), P));

test('50 invoices of the same amount: the amount alone never matches', () => {
  const r = matchReceipt(rec('JANE SMITH', P), crowd());
  assert.equal(r.decision, 'none');
  assert.equal(r.sameAmountCount, 50);
});

test('full name + exact amount → auto, even in the crowd', () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const target = inv(jane, P);
  const r = matchReceipt(rec('JANE SMITH', P), [...crowd(), target]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.matchKind, 'name_amount');
  assert.equal(r.invoices[0].id, target.id);
});

test('reversed name order and a middle initial still match', () => {
  const m = cl('cm', 'Maxine Miller', 'Maxine', 'Miller');
  const target = inv(m, 16800);
  assert.equal(matchReceipt(rec('MAXINE M MILLER', 16800), [target]).decision, 'auto');
  assert.equal(matchReceipt(rec('MILLER MAXINE', 16800), [target]).decision, 'auto');
});

test('two clients with the same name → review, never auto', () => {
  const a = inv(cl('a', 'John Lee', 'John', 'Lee'), P);
  const b = inv(cl('b', 'John Lee', 'John', 'Lee'), P);
  const r = matchReceipt(rec('JOHN LEE', P), [a, b]);
  assert.equal(r.decision, 'review');
  assert.equal(r.candidates.length, 2);
});

test('name matches but partial payment → review', () => {
  const k = cl('k', 'Kyle Ross', 'Kyle', 'Ross');
  const r = matchReceipt(rec('KYLE ROSS', 10000), [inv(k, 18900)]);
  assert.equal(r.decision, 'review');
  assert.match(r.reason, /owes \$189\.00/);
});

test('one payment for two invoices that add up exactly → auto', () => {
  const s = cl('s', 'Sid Sy', 'Sid', 'Sy');
  const a = inv(s, 6600); const b = inv(s, 6000); const c = inv(s, 4500);
  const r = matchReceipt(rec('SID SY', 12600), [a, b, c]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.matchKind, 'multi_invoice');
  assert.deepEqual(r.invoices.map((i) => i.id).sort(), [a.id, b.id].sort());
});

test('same client, two invoices of the same balance → the oldest is paid', () => {
  const s = cl('s2', 'Ana Diaz', 'Ana', 'Diaz');
  const newer = inv(s, 9711, { issuedDate: '2026-10-20' });
  const older = inv(s, 9711, { issuedDate: '2026-10-01' });
  const r = matchReceipt(rec('ANA DIAZ', 9711), [newer, older]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.invoices[0].id, older.id);
  assert.match(r.reason, /oldest/);
});

test('spouse pays and names the invoice in the message → auto only with the same last name', () => {
  const john = cl('jd', 'John Doe', 'John', 'Doe');
  const target = inv(john, P, { invoiceNumber: '1432' });
  const ok = matchReceipt(rec('JANE DOE', P, 'for invoice #1432 thanks'), [...crowd(), target]);
  assert.equal(ok.decision, 'auto');
  assert.equal(ok.matchKind, 'invoice_in_message');

  const stranger = matchReceipt(rec('PAT KING', P, 'Inv 1432'), [...crowd(), target]);
  assert.equal(stranger.decision, 'review', 'a different last name only suggests it');

  const wrongAmount = matchReceipt(rec('JANE DOE', P + 100, '#1432'), [target]);
  assert.notEqual(wrongAmount.decision, 'auto');
});

test('a confirmed payer alias matches on its own', () => {
  const irina = cl('ir', 'Irina', 'Irina', '');
  const target = inv(irina, 9711);
  const others = [inv(cl('x1', 'Muhammad', 'Muhammad', ''), 9711), inv(cl('x2', 'Mubina', 'Mubina', ''), 9711)];
  const before = matchReceipt(rec('IRINA PETROVA', 9711), [target, ...others]);
  assert.equal(before.decision, 'review', 'first-name-only client is just a hint');
  assert.equal(before.candidates[0].invoiceId, target.id);
  const after = matchReceipt(rec('IRINA PETROVA', 9711), [target, ...others], new Map([['IRINA PETROVA', 'ir']]));
  assert.equal(after.decision, 'auto');
  assert.equal(after.matchKind, 'alias_amount');
});

test('a company payer matches the Jobber company name without the Ltd.', () => {
  const co = cl('co', 'Meneer Development', null, null, 'Meneer Development Ltd.');
  assert.equal(matchReceipt(rec('MENEER DEVELOPMENT LTD', 7000), [inv(co, 7000)]).decision, 'auto');
});

test('street number in the message is a hint for review, not a match', () => {
  const c = cl('st', 'Chander', 'Chander', '');
  const target = inv(c, 199395, { street: '1391 Some Road' });
  const r = matchReceipt(rec('CHANDRA PARK', 199395, '1391 side walk done'), [target, inv(cl('o', 'Other Guy', 'Other', 'Guy'), 199395)]);
  assert.equal(r.decision, 'review');
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].invoiceId, target.id);
});

test('a payment made before the invoice exists matches once it does', () => {
  const pat = cl('pt', 'Pat Ng', 'Pat', 'Ng');
  const r1 = matchReceipt(rec('PAT NG', 4300), [inv(cl('z', 'Zed Ox', 'Zed', 'Ox'), 4300)]);
  assert.equal(r1.decision, 'review', 'someone else\'s old invoice of that amount is only flagged');
  const r2 = matchReceipt(rec('PAT NG', 4300), [inv(pat, 4300)]);
  assert.equal(r2.decision, 'auto');
});


// ------------------------------------------------------------------ reasoning: evidence beyond the full name
const R = 18900;
const few = () => [inv(cl('o1', 'Olive Brand', 'Olive', 'Brand'), R), inv(cl('o2', 'Hugo Lane', 'Hugo', 'Lane'), R)];

test('Rostosky: same last name, the client and the street in the message → auto, with every clue in the reason', () => {
  const jen = cl('kr', 'Jen Rostosky', 'Jen', 'Rostosky');
  const target = inv(jen, R, { street: '37 Tallgrass Cres' });
  const r = matchReceipt(rec('KYLE ROSTOSKY', R, 'Rostosky 37 Tallgrass'), [...few(), target]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.invoices[0].id, target.id);
  assert.match(r.reason, /same last name/);
  assert.match(r.reason, /message names the client/);
  assert.match(r.reason, /street address in the message/);
});

test('a first-name-only client ("Kyle", "Mr Kyle") is found by the street, or by being the only invoice of that amount', () => {
  const kyle = inv(cl('ky', 'Kyle', 'Kyle', ''), R, { street: '37 Tallgrass Cres' });
  const r = matchReceipt(rec('KYLE ROSTOSKY', R, 'Rostosky 37 Tallgrass'), [...few(), kyle]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.invoices[0].id, kyle.id);
  const mr = inv(cl('mk', 'Mr Kyle', 'Mr', 'Kyle'), R, { issuedDate: '2026-01-05' });
  const r2 = matchReceipt(rec('KYLE ROSTOSKY', R), [mr]);
  assert.equal(r2.decision, 'auto');
  assert.equal(r2.matchKind, 'evidence_amount');
});

test('MAXIME pays for Max: the same person, even in the spring crowd', () => {
  const max = inv(cl('mx', 'Max Tremblay', 'Max', 'Tremblay'), P);
  const r = matchReceipt(rec('MAXIME TREMBLAY', P), [...crowd(), max]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.matchKind, 'fuzzy_name_amount');
  assert.equal(r.invoices[0].id, max.id);
  const bob = matchReceipt(rec('ROBERT KING', P), [...crowd(), inv(cl('bk', 'Bob King', 'Bob', 'King'), P)]);
  assert.equal(bob.decision, 'auto', 'a known nickname');
});

test('MAXIME is not Maxine: a different first name with the same last name only asks', () => {
  const r = matchReceipt(rec('MAXIME SMITH', P), [...crowd(), inv(cl('ms', 'Maxine Smith', 'Maxine', 'Smith'), P)]);
  assert.equal(r.decision, 'review');
});

test('the only open invoice of that amount, made days before the payment → auto; an old one is only flagged', () => {
  const zed = inv(cl('z', 'Zed Ox', 'Zed', 'Ox'), 4300, { issuedDate: '2026-10-15' });
  const r = matchReceipt(rec('PAT NG', 4300, null, { receivedAt: new Date('2026-10-20T15:00:00Z') }), [zed, ...few()]);
  assert.equal(r.decision, 'auto');
  assert.equal(r.matchKind, 'unique_recent');
  assert.match(r.reason, /5 day\(s\) before/);
  const old = matchReceipt(rec('PAT NG', 4300, null, { receivedAt: new Date('2026-10-20T15:00:00Z') }), [{ ...zed, issuedDate: '2026-08-01' }]);
  assert.equal(old.decision, 'review');
  assert.equal(old.candidates.length, 1);
});

test('two invoices of the same amount and nothing tells them apart → flagged, never matched (recency does not break the tie)', () => {
  const at = { receivedAt: new Date('2026-10-20T15:00:00Z') };
  const a = inv(cl('a1', 'Ann Bee', 'Ann', 'Bee'), 5500, { issuedDate: '2026-10-18' });
  const b = inv(cl('b1', 'Cal Dee', 'Cal', 'Dee'), 5500, { issuedDate: '2026-07-01' });
  const r = matchReceipt(rec('PAT NG', 5500, null, at), [a, b]);
  assert.equal(r.decision, 'review');
  assert.equal(r.candidates.length, 2);
});

test('a first-name pair learned from a confirmed payer helps the next person with those names', () => {
  const gus = () => [...crowd(), inv(cl('ka', 'Konstantinos Allen', 'Konstantinos', 'Allen'), P)];
  assert.equal(matchReceipt(rec('GUS ALLEN', P), gus()).decision, 'review');
  const equivalences = equivalencesFrom([{ payerNameNorm: 'GUS PETERS', clientName: 'Konstantinos Peters' }]);
  const r = matchReceipt(rec('GUS ALLEN', P), gus(), new Map(), { equivalences });
  assert.equal(r.decision, 'auto');
  assert.equal(r.matchKind, 'fuzzy_name_amount');
});

// ------------------------------------------------------------------ the tick, with fakes for Prisma, Gmail and Jobber
const et = require('../ai/etransfer');

function fakeDb(mode = 'live') {
  const t = { etransferReceipt: [], payerAlias: [], operatorProposal: [], cachedJobberClient: [] };
  let n = 0;
  const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => match(row, w));
    if (k === 'userId_payerNameNorm') return row.userId === v.userId && row.payerNameNorm === v.payerNameNorm;
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('gte' in v) return row[k] >= v.gte;
      if ('lt' in v) return row[k] != null && row[k] < v.lt;
    }
    return row[k] === v;
  });
  const apply = (row, data) => { for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? (row[k] || 0) + v.increment : v; return row; };
  const model = (name, uniq = []) => ({
    count: async ({ where } = {}) => t[name].filter((r) => match(r, where)).length,
    findMany: async ({ where } = {}) => t[name].filter((r) => match(r, where)),
    findFirst: async ({ where } = {}) => t[name].find((r) => match(r, where)) || null,
    create: async ({ data }) => {
      for (const u of uniq) if (t[name].some((r) => u.every((k) => r[k] === data[k]))) throw Object.assign(new Error('unique'), { code: 'P2002' });
      const row = { id: `${name}${++n}`, createdAt: new Date(), notifiedAt: null, recordAttempts: 0, proposalIds: null, invoiceIds: null, ...data }; t[name].push(row); return row;
    },
    update: async ({ where, data }) => apply(t[name].find((r) => r.id === where.id), data),
    updateMany: async ({ where, data }) => { const rows = t[name].filter((r) => match(r, where)); rows.forEach((r) => apply(r, data)); return { count: rows.length }; },
    upsert: async ({ where, create, update }) => { const r = t[name].find((x) => match(x, where)); return r ? apply(r, update) : model(name).create({ data: create }); },
    delete: async ({ where }) => { const i = t[name].findIndex((r) => r.id === where.id); return t[name].splice(i, 1)[0]; },
  });
  return {
    t,
    etransferReceipt: model('etransferReceipt', [['userId', 'referenceNumber'], ['userId', 'gmailMessageId']]),
    payerAlias: model('payerAlias'), operatorProposal: model('operatorProposal'), cachedJobberClient: model('cachedJobberClient'),
    routine: { findUnique: async () => ({ id: 'r1', config: { mode } }) },
  };
}

function rig({ mode = 'live', emails = {}, invoices = [], seeded = true } = {}) {
  const db = fakeDb(mode);
  const texts = [];
  const live = new Map(invoices.map((i) => [i.id, { ...i }]));
  let codes = 0;
  const over = {
    db,
    gmail: { listInteracIds: async () => ({ token: 't', ids: Object.keys(emails) }), getMessage: async (_t, id) => ({ id, ...emails[id], receivedAt: new Date() }) },
    jobber: {
      fetchUnpaidInvoices: async () => ({ complete: true, invoices: [...live.values()].filter((i) => i.cents > 0) }),
      recheckInvoice: async (_u, id) => (live.has(id) ? { ...live.get(id) } : null),
      fetchRecentInvoicesWithPayments: async () => [],
    },
    notify: async (_u, n) => { texts.push(n.smsText); },
    op: { createProposal: async ({ payload, summary }) => db.operatorProposal.create({ data: { shortCode: String(++codes).padStart(4, '0'), status: 'pending', category: 'etransfer_match', payload, summary } }), executeProposal: async () => ({}) },
    createTask: async () => ({}),
    completeTask: async () => ({}),
  };
  if (seeded) db.t.etransferReceipt.push({ id: 'seed', userId: 'u1', gmailMessageId: 'old', referenceNumber: 'OLD', status: 'recorded', backfill: true, receivedAt: new Date(0) });
  return { db, texts, live, over, tick: () => et.etransferWatchTick({ userId: 'u1' }, over) };
}

const ok = (o) => email(o);

test('the same e-transfer is handled and texted once, however often the tick runs', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ emails: { m1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1Same' }) }, invoices: [inv(jane, P, { id: 'iJ' })] });
  await r.tick(); await r.tick(); await r.tick();
  const rows = r.db.t.etransferReceipt.filter((x) => x.referenceNumber === 'C1Same');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'to_record');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /matches Inv #\d+ \(Jane Smith\)/);
});

test('shadow mode texts "would match" and queues nothing', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ mode: 'shadow', emails: { m1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1Sh' }) }, invoices: [inv(jane, P, { id: 'iS' })] });
  await r.tick();
  assert.equal(r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Sh').status, 'matched');
  assert.match(r.texts[0], /^\[Test mode\]/);
  assert.deepEqual(await et.claimToRecord('u1', r.over), []);
});

test('two identical payments from one client never claim the same invoice twice', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ emails: { m1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1A' }), m2: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1B' }) }, invoices: [inv(jane, P, { id: 'one' })] });
  await r.tick();
  const st = r.db.t.etransferReceipt.filter((x) => !x.backfill).map((x) => x.status).sort();
  assert.equal(st.filter((s) => s === 'to_record').length, 1);
});

test('a reported recording only counts when Jobber shows the balance dropped', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ emails: { m1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1Rec' }) }, invoices: [inv(jane, P, { id: 'iR' })] });
  await r.tick();
  const [item] = await et.claimToRecord('u1', r.over);
  assert.equal(item.invoices[0].amount, '313.95');
  assert.match(item.note, /C1Rec/);

  const lie = await et.reportRecorded('u1', item.id, { ok: true }, r.over);
  assert.equal(lie.verified, false, 'balance unchanged: not believed');
  assert.equal(r.db.t.etransferReceipt.find((x) => x.id === item.id).status, 'to_record');

  r.live.get('iR').cents = 0;
  const real = await et.reportRecorded('u1', item.id, { ok: true }, r.over);
  assert.equal(real.status, 'recorded');
  assert.match(r.texts.at(-1), /^Done: Inv #\d+ .* marked paid/);
});

test('an invoice the owner already marked paid is closed without recording it again', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ emails: { m1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1Hand' }) }, invoices: [inv(jane, P, { id: 'iH' })] });
  await r.tick();
  r.live.get('iH').cents = 0;
  assert.deepEqual(await et.claimToRecord('u1', r.over), []);
  assert.equal(r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Hand').status, 'recorded');
});

test('unsure match: one text with YES codes, and a YES remembers the payer', async () => {
  const olga = cl('ir', 'Olga', 'Olga', '');
  const r = rig({ emails: { m1: ok({ amount: '97.11', name: 'IRINA PETROVA', ref: 'C1Ir' }) }, invoices: [inv(olga, 9711, { id: 'iI', invoiceNumber: '955', issuedDate: '2026-01-05' })] });
  await r.tick();
  const row = r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Ir');
  assert.equal(row.status, 'needs_review');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /Reply YES 0001 = Inv #955/);
  const p = r.db.t.operatorProposal[0];
  const res = await et.applyOwnerPick({ ...p, userId: 'u1' }, r.over);
  assert.equal(res.status, 'to_record');
  assert.equal(r.db.t.payerAlias[0].payerNameNorm, 'IRINA PETROVA');
  assert.equal(r.db.t.payerAlias[0].jobberClientId, 'ir');
});

test('fake and not-yet-deposited emails are texted as warnings and never matched', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const forged = ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1Forged', over: { headers: [] } });
  const pending = { from: 'notify@payments.interac.ca', headers: AUTH_OK, subject: 'Interac e-Transfer: JANE SMITH sent you $313.95. Claim your deposit!', body: 'Reference Number: C1Pend\nSent From: JANE SMITH\nAmount: $313.95 (CAD)\n' };
  const r = rig({ emails: { f: forged, p: pending }, invoices: [inv(jane, P, { id: 'iF' })] });
  await r.tick();
  const rows = r.db.t.etransferReceipt.filter((x) => !x.backfill);
  assert.deepEqual(rows.map((x) => x.status).sort(), ['ignored', 'needs_review']);
  assert.ok(rows.every((x) => !x.jobberInvoiceId));
  assert.ok(!rows.some((x) => x.referenceNumber === 'C1Forged'), 'a forged email does not take the real reference number');
  assert.equal(r.texts.length, 2);
  assert.ok(r.texts.some((s) => /failed Interac's security check/.test(s)));
  assert.ok(r.texts.some((s) => /NOT deposited yet/.test(s)));
});

test('the first run grades history silently and sends one summary', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ seeded: false, emails: { h1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1H1' }), h2: ok({ amount: '50.00', name: 'NOBODY HERE', ref: 'C1H2' }) }, invoices: [inv(jane, P, { id: 'iB' })] });
  r.over.jobber.fetchRecentInvoicesWithPayments = async () => [{ ...inv(jane, P, { id: 'iB', issuedDate: '2020-01-01' }), totalCents: P, payments: [{ cents: P, at: new Date().toISOString() }] }];
  await r.tick();
  const rows = r.db.t.etransferReceipt;
  assert.ok(rows.every((x) => x.backfill));
  assert.equal(rows.find((x) => x.referenceNumber === 'C1H1').backfillVerdict, 'correct');
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /1 it would have matched correctly, 0 wrong/);
  assert.deepEqual(await et.claimToRecord('u1', r.over), []);
});

test('without payment records the backfill grades by the invoice paid date', async () => {
  const jane = cl('cj', 'Jane Smith', 'Jane', 'Smith');
  const r = rig({ seeded: false, emails: { h1: ok({ amount: '313.95', name: 'JANE SMITH', ref: 'C1RD' }) }, invoices: [] });
  r.over.jobber.fetchRecentInvoicesWithPayments = async () => [{ ...inv(jane, 0, { id: 'iRD', issuedDate: '2020-01-01' }), status: 'paid', totalCents: P, receivedDate: new Date().toISOString(), payments: [] }];
  await r.tick();
  assert.equal(r.db.t.etransferReceipt[0].backfillVerdict, 'correct');
});

test('history teaches a payer name only when the suggested invoice was the one actually paid', async () => {
  const r = rig({});
  const at = new Date('2026-10-01T12:00:00Z');
  const row = (id, name, invId, client, why = 'same first name (no last name in Jobber), exact amount') => ({ id, userId: 'u1', backfill: true, status: 'needs_review', senderName: name, senderNameNorm: name, amountCents: 18900, receivedAt: at, candidates: [{ invoiceId: invId, invoiceNumber: invId, clientId: client, clientName: client, cents: 18900, why }] });
  r.db.t.etransferReceipt.push(row('a', 'KYLE ROSTOSKY', 'paidSoon', 'mrkyle'), row('b', 'DIANNE BOURBONNAIS', 'stillOpen', 'dianne'), row('c', 'SIDY SY', 'x', 'sidy', 'same client, different amount'));
  r.over.jobber.recheckInvoice = async (_u, id) => (id === 'paidSoon' ? { status: 'paid', receivedDate: '2026-10-02T15:00:00Z' } : { status: 'awaiting_payment', receivedDate: null });
  const pairs = await et.learnPreview('u1', r.over);
  assert.deepEqual(pairs.map((p) => [p.payer, p.jobberClientId]), [['KYLE ROSTOSKY', 'mrkyle']]);
  assert.equal(await et.saveLearnedPayers('u1', pairs, r.db), 1);
  assert.equal(r.db.t.payerAlias[0].source, 'backfill');
  assert.deepEqual(await et.learnPreview('u1', r.over), [], 'an already-known payer is not offered again');
});

// ------------------------------------------------------------------ guards, re-checks and learning in the tick
test('a payer who is a Jobber client of their own is never matched to someone else by reasoning', async () => {
  const r = rig({ emails: { m1: ok({ amount: '189.00', name: 'KYLE ROSTOSKY', ref: 'C1Own' }) }, invoices: [inv(cl('ky', 'Kyle', 'Kyle', ''), R, { id: 'iK', issuedDate: '2026-01-05' })] });
  r.db.t.cachedJobberClient.push({ userId: 'u1', jobberClientId: 'other', name: 'Kyle Rostosky' });
  await r.tick();
  const row = r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Own');
  assert.equal(row.status, 'needs_review');
  assert.match(r.texts[0], /Jobber client of their own/);
});

test('a waiting e-transfer matches itself once the invoice is made, and its YES codes expire', async () => {
  const r = rig({ emails: { m1: ok({ amount: '43.00', name: 'PAT NG', ref: 'C1Wait' }) }, invoices: [inv(cl('a', 'Ann Bee', 'Ann', 'Bee'), 4300, { id: 'x1' }), inv(cl('b', 'Cal Dee', 'Cal', 'Dee'), 4300, { id: 'x2' })] });
  await r.tick();
  const row = r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Wait');
  assert.equal(row.status, 'needs_review');
  assert.equal(r.db.t.operatorProposal.length, 2);
  await r.tick();
  assert.equal(r.texts.length, 1, 'still unsure: no second text');
  r.live.set('iP', inv(cl('pt', 'Pat Ng', 'Pat', 'Ng'), 4300, { id: 'iP' }));
  await r.tick();
  assert.equal(row.status, 'to_record');
  assert.equal(row.jobberInvoiceId, 'iP');
  assert.ok(r.db.t.operatorProposal.every((p) => p.status === 'expired'));
  assert.equal(r.texts.length, 2);
});

test('a recent history row the first run only flagged (Rostosky, 3 days ago) is solved when its invoice is still open', async () => {
  const jen = cl('kr', 'Jen Rostosky', 'Jen', 'Rostosky');
  const r = rig({ mode: 'shadow', invoices: [inv(jen, R, { id: 'iRo', street: '37 Tallgrass Cres' }), ...few()] });
  r.db.t.etransferReceipt.push({ id: 'hist', userId: 'u1', backfill: true, status: 'needs_review', kind: 'deposited', authOk: true, senderName: 'KYLE ROSTOSKY', senderNameNorm: 'KYLE ROSTOSKY', amountCents: R, message: 'Rostosky 37 Tallgrass', referenceNumber: 'C1AJ', receivedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000), proposalIds: null });
  await r.tick();
  const row = r.db.t.etransferReceipt.find((x) => x.id === 'hist');
  assert.equal(row.status, 'matched');
  assert.equal(row.jobberInvoiceId, 'iRo');
  assert.match(r.texts[0], /^\[Test mode\].*KYLE ROSTOSKY.*same last name/);
});

test('a confirmed reasoned match teaches the payer name; a wrong one forgets it and makes that kind ask', async () => {
  const max = cl('mx', 'Max Tremblay', 'Max', 'Tremblay');
  const r = rig({ mode: 'shadow', emails: { m1: ok({ amount: '313.95', name: 'MAXIME TREMBLAY', ref: 'C1Mx' }) }, invoices: [inv(max, P, { id: 'iMx' }), ...crowd()] });
  await r.tick();
  const row = r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Mx');
  assert.equal(row.status, 'matched');
  assert.equal(row.outcome, 'pending');

  Object.assign(r.live.get('iMx'), { cents: 0, status: 'paid', receivedDate: new Date().toISOString() });
  await r.tick();
  assert.equal(row.outcome, 'confirmed');
  assert.deepEqual(r.db.t.payerAlias.map((a) => [a.payerNameNorm, a.jobberClientId, a.source]), [['MAXIME TREMBLAY', 'mx', 'learned']]);

  const tasks = [];
  r.over.createTask = async (_u, t) => { tasks.push(t); };
  const res = await et.markWrong('u1', row.id, r.over);
  assert.equal(res.ok, true);
  assert.equal(row.status, 'needs_review');
  assert.equal(row.outcome, 'wrong');
  assert.equal(r.db.t.payerAlias.length, 0, 'what the wrong match taught is forgotten');
  assert.match(tasks[0].title, /name looks like the client/);

  const jones = cl('mj', 'Max Jones', 'Max', 'Jones');
  r.live.set('iJn', inv(jones, P, { id: 'iJn' }));
  r.over.gmail.listInteracIds = async () => ({ token: 't', ids: ['m2'] });
  r.over.gmail.getMessage = async (_t, id) => ({ id, ...ok({ amount: '313.95', name: 'MAXIME JONES', ref: 'C1Mj' }), receivedAt: new Date() });
  await r.tick();
  const next = r.db.t.etransferReceipt.find((x) => x.referenceNumber === 'C1Mj');
  assert.equal(next.status, 'needs_review', 'the same kind of reasoning now asks');
  assert.match(next.reason, /wrong recently/);
  assert.equal(row.status, 'needs_review', 'the wrong one is not matched again');
});
