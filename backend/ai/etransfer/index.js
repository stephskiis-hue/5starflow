/**
 * E-transfer watch (routine etransfer-watch, every 15 min 8 am-9 pm). Reads new Interac deposit emails, matches each
 * one to exactly one unpaid Jobber invoice (match.js), and texts the owner about every single one.
 *
 *   mode (Routine config.mode, else ETRANSFER_MODE, default shadow):
 *     off    nothing runs
 *     shadow match + text only ("would match"); nothing is queued for Jobber
 *     live   exact matches become to_record; the MSI recorder (prompts/etransfer-recorder.md) clicks Collect Payment and
 *            the server re-reads the invoice to confirm the balance really dropped before calling it recorded.
 *
 * Unsure matches become YES/NO approvals (OperatorProposal category etransfer_match); a YES saves a PayerAlias so the
 * same payer matches on their own next time. The first run backfills 90 days silently and scores itself against what
 * the owner actually marked paid (the go-live check on the E-transfers tab).
 *
 * Self-learning: every match gets an outcome (confirmOutcomes: the invoice was paid around the e-transfer, or a week in
 * Jobber without "Wrong match"). A confirmed reasoned match teaches the payer's name; a wrong one forgets it and makes
 * that kind of reasoning ask the owner for 60 days.
 */
const prismaDefault = require('../../lib/prismaClient');
const { parseInterac, normName } = require('./parse');
const { matchReceipt, fmt, equivalencesFrom, REASONED_KINDS } = require('./match');

const SLUG = 'etransfer-watch';
const MODES = ['off', 'shadow', 'live'];
const RETRY_NO_MATCH_DAYS = 14;
const RECORD_DEADLINE_MS = 3 * 3600 * 1000;
const MAX_RECORD_ATTEMPTS = 3;
const PROPOSAL_TTL_HOURS = 72;
const DAY = 24 * 3600 * 1000;
const DEMOTE_DAYS = 60;            // a reasoned match kind that was wrong only asks for this long
const UNCONFIRMED_DAYS = 14;       // test mode: a matched invoice still unpaid after this is "unconfirmed"
const LIVE_CONFIRM_DAYS = 7;       // live mode: a recorded match nobody called wrong for a week is "confirmed"
const SWEEP_PER_RUN = 10;
const SWEEP_EVERY_MS = 6 * 3600 * 1000;
const LEARNS_FROM = [...REASONED_KINDS, 'invoice_in_message'];
const KIND_LABEL = {
  fuzzy_name_amount: 'name looks like the client', message_name_amount: 'message names the client', address_amount: 'address in the message',
  evidence_amount: 'small clues together', unique_recent: 'only recent invoice of that amount',
};

function deps(over = {}) {
  return {
    db: over.db || prismaDefault,
    gmail: over.gmail || require('./gmail'),
    jobber: over.jobber || require('./jobber'),
    notify: over.notify || require('../../lib/notify').notify,
    op: over.op || require('../../services/operatorService'),
    createTask: over.createTask || require('../tasks').createTask,
    completeTask: over.completeTask || require('../tasks').completeByDedupKey,
    now: over.now || (() => new Date()),
  };
}

async function getMode(userId, db = prismaDefault) {
  const r = await db.routine.findUnique({ where: { userId_slug: { userId, slug: SLUG } } }).catch(() => null);
  const m = r?.config?.mode || process.env.ETRANSFER_MODE || 'shadow';
  return MODES.includes(m) ? m : 'shadow';
}

const money = (c) => fmt(c);
const short = (s, n = 40) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const invLabel = (i) => `Inv #${i.invoiceNumber}`;

async function say(d, userId, receipt, title, smsText) {
  await d.notify(userId, { category: 'payments', urgent: process.env.ETRANSFER_SMS !== 'off', routineSlug: SLUG, link: '/ai.html#payments', title, body: smsText, smsText });
  await d.db.etransferReceipt.update({ where: { id: receipt.id }, data: { notifiedAt: d.now() } });
}

// ------------------------------------------------------------------------------------------------ 1. read Gmail
async function ingest(d, userId) {
  const first = (await d.db.etransferReceipt.count({ where: { userId } })) === 0;
  const { token, ids } = await d.gmail.listInteracIds(userId, { sinceDays: first ? 90 : 3 });
  if (!ids.length) return { created: [], first };
  const known = new Set((await d.db.etransferReceipt.findMany({ where: { userId, gmailMessageId: { in: ids } }, select: { gmailMessageId: true } })).map((r) => r.gmailMessageId));
  const created = [];
  for (const id of ids.filter((x) => !known.has(x))) {
    const msg = await d.gmail.getMessage(token, id);
    const p = parseInterac(msg);
    if (p.kind === 'outgoing') continue;
    let status = 'new'; let reason = null;
    if (!p.authOk) { status = 'ignored'; reason = 'Failed the Interac sender check (possible fake email)'; }
    else if (p.kind === 'pending_accept') { status = 'needs_review'; reason = 'Not deposited yet: accept it in the bank first'; }
    else if (p.kind !== 'deposited') { status = 'ignored'; reason = `Not a deposit (${p.kind})`; }
    else if (!p.ref || !p.amountCents || !p.senderName) { status = 'needs_review'; reason = 'Could not read the reference, amount or sender'; }
    try {
      created.push(await d.db.etransferReceipt.create({
        data: {
          // a fake email must not claim the reference number the real transfer will arrive with
          userId, gmailMessageId: id, referenceNumber: p.authOk && p.ref ? p.ref : `${p.authOk ? 'gmail' : 'unverified'}:${id}`, senderName: p.senderName || '(unknown)', senderNameNorm: p.senderNameNorm || '',
          amountCents: p.amountCents || 0, sentDate: p.sentDate, receivedAt: msg.receivedAt, message: p.message, senderBank: p.bank,
          kind: p.kind, authOk: p.authOk, status, reason, backfill: first,
        },
      }));
    } catch (e) {
      if (e.code !== 'P2002') throw e;      // the same transfer seen in another email: it is already handled
    }
  }
  return { created, first };
}

// ------------------------------------------------------------------------------------------------ 2. act on a match
function plan(m) {
  return (m.invoices || []).map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, webUri: i.webUri, payCents: i.cents, balanceBefore: i.cents, clientName: i.client.name }));
}

async function applyMatch(d, userId, receipt, m, mode, { backfill = false } = {}) {
  const base = { matchKind: m.matchKind || null, reason: m.reason, candidates: m.candidates?.length ? m.candidates : null, evidence: m.evidence || null };
  if (m.decision === 'auto') {
    const list = plan(m);
    const first = list[0];
    const status = mode === 'live' && !backfill ? 'to_record' : 'matched';
    const row = await d.db.etransferReceipt.update({
      where: { id: receipt.id },
      data: {
        ...base, status, jobberInvoiceId: first.id, invoiceNumber: list.map((i) => i.invoiceNumber).join(', '), invoiceIds: list, jobberClientId: m.client.id, clientName: m.client.name, jobberWebUri: first.webUri,
        queuedAt: status === 'to_record' ? d.now() : null, ...(backfill ? {} : { outcome: 'pending', outcomeAt: null, outcomeCheckedAt: null }),
      },
    });
    if (backfill) return row;
    // it was waiting on the owner and has since worked itself out (the invoice was made, a payer name was learned)
    if ((receipt.proposalIds || []).length) await d.db.operatorProposal.updateMany({ where: { id: { in: receipt.proposalIds }, status: 'pending' }, data: { status: 'expired' } });
    const invs = list.map((i) => `#${i.invoiceNumber}`).join(' + ');
    const why = REASONED_KINDS.includes(m.matchKind) ? `: ${short(m.reason, 100)}.` : '.';
    const text = status === 'to_record'
      ? `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName} matches Inv ${invs} (${short(m.client.name, 30)})${why} Recording it as paid in Jobber now. Ref ${receipt.referenceNumber}`
      : `[Test mode] E-transfer ${money(receipt.amountCents)} from ${receipt.senderName} would be matched to Inv ${invs} (${short(m.client.name, 30)})${why} Nothing changed in Jobber. Ref ${receipt.referenceNumber}`;
    await say(d, userId, row, `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName}`, text);
    return row;
  }

  if (m.decision === 'review' && m.candidates.length) {
    const row = await d.db.etransferReceipt.update({ where: { id: receipt.id }, data: { ...base, status: 'needs_review' } });
    if (backfill) return row;
    const proposals = [];
    for (const c of m.candidates) {
      const p = await d.op.createProposal({
        userId, category: 'etransfer_match', tier: 'approval_required', ttlHours: PROPOSAL_TTL_HOURS,
        summary: `${money(receipt.amountCents)} e-transfer from ${short(receipt.senderName, 30)} = Inv #${c.invoiceNumber} ${short(c.clientName, 30)} (${money(c.cents)})?`,
        payload: { receiptId: receipt.id, invoiceId: c.invoiceId, invoiceNumber: c.invoiceNumber, webUri: c.webUri, clientId: c.clientId, clientName: c.clientName, balanceCents: c.cents, why: c.why },
      });
      proposals.push(p);
    }
    await d.db.etransferReceipt.update({ where: { id: receipt.id }, data: { proposalIds: proposals.map((p) => p.id) } });
    await d.db.operatorProposal.updateMany({ where: { id: { in: proposals.map((p) => p.id) } }, data: { smsSentAt: d.now() } });
    const opts = proposals.map((p, i) => `YES ${p.shortCode} = Inv #${m.candidates[i].invoiceNumber} ${short(m.candidates[i].clientName, 22)} ${money(m.candidates[i].cents)}`).join('; ');
    await say(d, userId, row, `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName} needs you`,
      `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName} needs you: ${short(m.reason, 110)}. Reply ${opts}. Otherwise mark it in Jobber yourself.`);
    return row;
  }

  const wasNoMatch = receipt.status === 'no_match';
  const row = await d.db.etransferReceipt.update({ where: { id: receipt.id }, data: { ...base, status: 'no_match' } });
  if (!backfill && !wasNoMatch) {
    await say(d, userId, row, `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName}: no match`,
      `E-transfer ${money(receipt.amountCents)} from ${receipt.senderName}: no invoice match. ${short(m.reason, 120)}.${receipt.message ? ` Msg: "${short(receipt.message, 60)}".` : ''} Ref ${receipt.referenceNumber}. I'll keep checking for 2 weeks.`);
  }
  return row;
}

async function announceUnmatchable(d, userId, rows) {
  for (const r of rows) {
    if (r.backfill || r.notifiedAt) continue;
    if (!r.authOk) {
      await say(d, userId, r, 'Possible fake e-transfer email', `Warning: an email claiming a ${money(r.amountCents)} e-transfer from ${r.senderName} failed Interac's security check. Nothing was matched. Don't click links in it.`);
    } else if (r.kind === 'pending_accept') {
      await say(d, userId, r, `E-transfer ${money(r.amountCents)} from ${r.senderName} is waiting`, `E-transfer ${money(r.amountCents)} from ${r.senderName} is NOT deposited yet: accept it in your bank. Nothing marked in Jobber.`);
    } else if (r.status === 'needs_review') {
      await say(d, userId, r, 'E-transfer email needs a look', `An Interac email could not be read (${r.reason}). Please check it in Gmail and mark the invoice yourself.`);
    }
  }
}

// ------------------------------------------------------------------------------------------------ 3. recorder deadline
async function sweepStale(d, userId) {
  const cutoff = new Date(d.now().getTime() - RECORD_DEADLINE_MS);
  const stale = await d.db.etransferReceipt.findMany({ where: { userId, status: 'to_record', queuedAt: { lt: cutoff } } });
  for (const r of stale) await failRecording(d, userId, r, 'Not recorded within 3 hours');
  return stale.length;
}

async function failRecording(d, userId, r, why) {
  const row = await d.db.etransferReceipt.update({ where: { id: r.id }, data: { status: 'failed', error: why } });
  await say(d, userId, row, `Mark Inv #${r.invoiceNumber} paid by hand`, `Could not record the ${money(r.amountCents)} e-transfer from ${r.senderName} on Inv #${r.invoiceNumber} (${why}). Please mark it paid: ${r.jobberWebUri || 'Jobber'}`);
}

// ------------------------------------------------------------------------------------------------ the tick
async function etransferWatchTick(ctx = {}, over = {}) {
  const d = deps(over);
  const userId = ctx.userId || await require('../owner').resolveOwnerId();
  const mode = await getMode(userId, d.db);
  if (mode === 'off') return { skipped: true, summary: 'E-transfer watch is off' };

  let ing;
  try { ing = await ingest(d, userId); }
  catch (e) {
    if (!['NEEDS_SCOPE', 'NOT_CONNECTED', 'API_DISABLED'].includes(e.code)) throw e;
    await d.createTask(userId, { dedupKey: 'etransfer:gmail-read', title: e.code === 'API_DISABLED' ? 'Turn on the Gmail API so e-transfers can be matched' : 'Reconnect Gmail so e-transfers can be matched', source: 'system', agent: 'operations', urgency: 'high', routineSlug: SLUG, whatHappened: e.message, recommended: e.code === 'API_DISABLED' ? 'Google Cloud console → APIs and services → Library → Gmail API → Enable.' : 'Connections page → Gmail → Reconnect, and allow 5StarFlow to read email.' }).catch(() => {});
    return { skipped: true, requires_attention: 1, summary: e.message };
  }
  await d.completeTask(userId, 'etransfer:gmail-read').catch(() => {});   // reading works again

  // owner YES replies the SMS path did not get to (it executes them immediately; this is the safety net)
  const approved = await d.db.operatorProposal.findMany({ where: { userId, category: 'etransfer_match', status: 'approved', executedAt: null } });
  for (const p of approved) await d.op.executeProposal(p.id).catch(() => {});

  const stale = mode === 'live' ? await sweepStale(d, userId) : 0;
  const confirmed = await confirmOutcomes(d, userId);
  await announceUnmatchable(d, userId, ing.created.filter((r) => r.status !== 'new'));

  // new e-transfers, plus anything from the last 2 weeks still waiting (no match yet, or waiting on the owner), including
  // the newest history rows: their invoice may still be open. The owner's "wrong" verdicts are never retried.
  const since = new Date(d.now().getTime() - RETRY_NO_MATCH_DAYS * DAY);
  const open = (await d.db.etransferReceipt.findMany({
    where: { userId, OR: [{ status: 'new' }, { status: { in: ['no_match', 'needs_review'] }, kind: 'deposited', authOk: true, receivedAt: { gte: since } }] },
    orderBy: { receivedAt: 'asc' },
  })).filter((r) => r.outcome !== 'wrong');
  if (!open.length) {
    return { items_found: ing.created.length, skipped: !ing.created.length && !approved.length && !stale && !confirmed, summary: ing.created.length ? `${ing.created.length} Interac email(s), nothing to match` : 'No new e-transfers' };
  }

  // the first run's history is graded silently (also when an interrupted first run left some of it for this one)
  const old = open.filter((r) => r.backfill && r.status === 'new');
  if (old.length) return backfill(d, userId, old);

  const { invoices, complete } = await d.jobber.fetchUnpaidInvoices(userId);
  const known = await matchContext(d, userId);
  const taken = await queuedInvoiceIds(d, userId);
  const counts = { auto: 0, review: 0, none: 0 };
  for (const r of open) {
    let m = guard(matchReceipt(r, invoices.filter((i) => !taken.has(i.id)), known.aliases, known), r, known, { complete });
    if (m.decision === 'none' && !complete) m = { ...m, reason: `${m.reason} (only part of Jobber's invoice list could be read)` };
    // a waiting row only speaks up again when it can now be matched, or can now be asked about for the first time
    if (r.status !== 'new' && (m.decision === 'none' || (m.decision === 'review' && (r.proposalIds || []).length))) continue;
    await applyMatch(d, userId, r, m, mode);
    if (m.decision === 'auto') for (const i of m.invoices) taken.add(i.id);   // two payments in one run never claim the same invoice
    counts[m.decision]++;
  }
  return {
    items_found: open.length, requires_attention: counts.review + counts.none,
    actions_taken: [`${counts.auto} matched${mode === 'shadow' ? ' (test mode)' : ''}, ${counts.review} sent for your OK, ${counts.none} unmatched`],
    summary: `${open.length} e-transfer(s): ${counts.auto} matched, ${counts.review} need you, ${counts.none} no match (${mode})`,
  };
}

/** Invoices another e-transfer is already paying (queued or awaiting proof), so a second payment can't match them too. */
async function queuedInvoiceIds(d, userId) {
  const rows = await d.db.etransferReceipt.findMany({ where: { userId, status: { in: ['to_record', 'matched'] }, OR: [{ backfill: false }, { outcome: 'pending' }] }, select: { invoiceIds: true } });
  return new Set(rows.flatMap((r) => (r.invoiceIds || []).map((i) => i.id)));
}

// ------------------------------------------------------------------------------------------------ reasoning context + guards
/**
 * What the matcher knows besides the invoices: payer names it learned, first names that proved to be the same person,
 * Jobber clients by exact name, and the reasoned match kinds that were wrong lately (those only ask, for 60 days).
 */
async function matchContext(d, userId) {
  const since = new Date(d.now().getTime() - DEMOTE_DAYS * DAY);
  const [aliasRows, wrong, clients] = await Promise.all([
    d.db.payerAlias.findMany({ where: { userId } }),
    d.db.etransferReceipt.findMany({ where: { userId, outcome: 'wrong', outcomeAt: { gte: since } }, select: { matchKind: true } }),
    d.db.cachedJobberClient.findMany({ where: { userId }, select: { jobberClientId: true, name: true } }).catch(() => []),
  ]);
  const clientsByName = new Map();
  for (const c of clients) {
    const n = normName(c.name);
    if (n.split(' ').length < 2) continue;
    if (!clientsByName.has(n)) clientsByName.set(n, new Set());
    clientsByName.get(n).add(c.jobberClientId);
  }
  return {
    aliases: new Map(aliasRows.map((a) => [a.payerNameNorm, a.jobberClientId])),
    equivalences: equivalencesFrom(aliasRows),
    demoted: new Set(wrong.map((w) => w.matchKind).filter((k) => REASONED_KINDS.includes(k))),
    clientsByName,
  };
}

/** A reasoned match records itself only when nothing argues against it; otherwise the owner is asked, same candidates. */
function guard(m, r, ctx, { complete = true } = {}) {
  if (m.decision !== 'auto' || !REASONED_KINDS.includes(m.matchKind)) return m;
  const named = ctx.clientsByName.get(r.senderNameNorm);
  const aliasTo = ctx.aliases.get(r.senderNameNorm);
  let why = null;
  if (!complete) why = "only part of Jobber's invoice list could be read";
  else if (ctx.demoted.has(m.matchKind)) why = 'a match like this was wrong recently, so I ask for now';
  else if (named && !named.has(m.client.id)) why = `${r.senderName} is a Jobber client of their own (their invoice may not be made yet)`;
  else if (aliasTo && aliasTo !== m.client.id) why = `${r.senderName} has paid for a different client before`;
  return why ? { ...m, decision: 'review', reason: `Not sure: ${why} (${m.reason})` } : m;
}

// ------------------------------------------------------------------------------------------------ outcomes + learning
/**
 * Did the matches turn out right? In test mode the owner still marks invoices paid by hand, so the invoice being paid
 * around the e-transfer confirms the match; in live mode a recorded match counts once a week passes without "Wrong
 * match". Confirmed reasoned matches teach the payer's name.
 */
async function confirmOutcomes(d, userId) {
  const now = d.now().getTime();
  const rows = await d.db.etransferReceipt.findMany({ where: { userId, outcome: 'pending' } });
  const due = rows.filter((r) => !r.outcomeCheckedAt || now - new Date(r.outcomeCheckedAt).getTime() > SWEEP_EVERY_MS).slice(0, SWEEP_PER_RUN);
  let confirmed = 0;
  for (const r of due) {
    const t = r.receivedAt.getTime();
    let outcome = null;
    if (r.status === 'recorded') {
      if (r.verifiedAt && now - new Date(r.verifiedAt).getTime() > LIVE_CONFIRM_DAYS * DAY) outcome = 'confirmed';
    } else if (r.status === 'matched') {
      const first = (r.invoiceIds || [])[0];
      const live = first ? await d.jobber.recheckInvoice(userId, first.id, { paid: true }).catch(() => undefined) : null;
      if (live === undefined) continue;   // Jobber did not answer: next run
      const paidAt = live?.receivedDate ? new Date(live.receivedDate).getTime() : null;
      if (live && (live.status === 'paid' || live.cents === 0)) outcome = paidAt == null || (paidAt >= t - DAY && paidAt - t < 30 * DAY) ? 'confirmed' : 'unconfirmed';
      else if (!live || now - t > UNCONFIRMED_DAYS * DAY) outcome = 'unconfirmed';
    } else if (r.status !== 'to_record') outcome = 'unconfirmed';
    await d.db.etransferReceipt.update({ where: { id: r.id }, data: outcome ? { outcome, outcomeAt: d.now(), outcomeCheckedAt: d.now() } : { outcomeCheckedAt: d.now() } });
    if (outcome === 'confirmed') { confirmed++; await learnPayer(d, userId, r, 'learned'); }
  }
  return confirmed;
}

/** Remember who this payer pays for, so next time it is a known payer. An existing name (owner-confirmed or learned) is kept. */
async function learnPayer(d, userId, r, source) {
  if (!r.senderNameNorm || !r.jobberClientId || !LEARNS_FROM.includes(r.matchKind)) return false;
  if (await d.db.payerAlias.findFirst({ where: { userId, payerNameNorm: r.senderNameNorm } })) return false;
  try {
    await d.db.payerAlias.create({ data: { userId, payerNameNorm: r.senderNameNorm, jobberClientId: r.jobberClientId, clientName: r.clientName || '', source } });
    return true;
  } catch (e) {
    if (e.code === 'P2002') return false;
    throw e;
  }
}

/** The owner says a match is wrong: stop it, forget what it taught, and make that kind of reasoning ask for 60 days. */
async function markWrong(userId, id, over = {}) {
  const d = deps(over);
  const r = await d.db.etransferReceipt.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, error: 'not found' };
  if (!r.jobberInvoiceId) return { ok: false, error: 'this e-transfer is not matched to an invoice' };
  const wrongIds = new Set((r.invoiceIds || []).map((i) => i.id));
  await d.db.etransferReceipt.update({
    where: { id },
    data: {
      status: 'needs_review', outcome: 'wrong', outcomeAt: d.now(), queuedAt: null, reason: `You said Inv #${r.invoiceNumber} (${r.clientName || ''}) was wrong. ${r.reason || ''}`.trim(),
      candidates: (r.candidates || []).filter((c) => !wrongIds.has(c.invoiceId)),
    },
  });
  const alias = r.senderNameNorm ? await d.db.payerAlias.findFirst({ where: { userId, payerNameNorm: r.senderNameNorm } }) : null;
  if (alias && alias.jobberClientId === r.jobberClientId && (alias.source !== 'owner_confirmed' || r.matchKind === 'alias_amount')) await d.db.payerAlias.delete({ where: { id: alias.id } });
  if (REASONED_KINDS.includes(r.matchKind)) {
    await d.createTask(userId, {
      dedupKey: `etransfer:demoted:${r.matchKind}`, title: `E-transfers: "${KIND_LABEL[r.matchKind]}" matches will ask you for 60 days`, source: 'system', agent: 'operations', urgency: 'normal', routineSlug: SLUG,
      whatHappened: `${money(r.amountCents)} from ${r.senderName} was matched to Inv #${r.invoiceNumber} (${r.clientName}) by "${KIND_LABEL[r.matchKind]}" and you said it was wrong.`,
      recommended: 'Nothing to do. If this keeps happening, tell Claude which clue misled the matcher.',
    }).catch(() => {});
  }
  return { ok: true, status: 'needs_review', note: r.status === 'recorded' ? `It was already recorded in Jobber: remove that payment from Inv #${r.invoiceNumber} by hand.` : null };
}

// ------------------------------------------------------------------------------------------------ backfill (first run)
/**
 * Replays the inbox's e-transfers against the invoices as they stood then, and grades each prediction with Jobber's
 * own payment records: correct (the invoice we'd pick got that payment), wrong (we'd have picked a different invoice),
 * review / none. Nothing is texted per receipt and nothing is queued; one summary goes to the owner.
 */
async function backfill(d, userId, receipts, { again = false } = {}) {
  const all = await d.jobber.fetchRecentInvoicesWithPayments(userId);
  const tally = { correct: 0, wrong: 0, review: 0, none: 0, unknown: 0 };
  let learned = 0;
  const hasRecords = all.some((i) => i.payments.length);
  for (const r of receipts) {
    const t = r.receivedAt.getTime();
    // what was still owing then, and which invoices were paid around this payment: Jobber's payment records when the API
    // exposes them, otherwise the invoice's own paid date (receivedDate) on a now-paid invoice of exactly this total
    const paidAt = (i) => (i.receivedDate && i.status === 'paid' ? new Date(i.receivedDate).getTime() : null);
    const paidBefore = (i) => i.payments.some((p) => p.at && new Date(p.at).getTime() < t - 12 * 3600 * 1000) || (paidAt(i) != null && paidAt(i) < t - 12 * 3600 * 1000);
    const asThen = all.filter((i) => i.totalCents > 0 && i.client.id && (!i.issuedDate || new Date(i.issuedDate).getTime() <= t + DAY) && !paidBefore(i))
      .map((i) => ({ ...i, cents: i.totalCents }));
    const m = matchReceipt(r, asThen);
    const near = (at) => at != null && at >= t - DAY && at - t < 30 * DAY;
    const paidBy = all.filter((i) => (i.payments.length
      ? i.payments.some((p) => p.cents === r.amountCents && p.at && near(new Date(p.at).getTime()))
      : near(paidAt(i))));
    let verdict = m.decision === 'review' ? 'review' : m.decision === 'none' ? 'none' : 'unknown';
    // without payment records a different invoice paid that day proves nothing, so a miss is "unknown", never "wrong"
    if (m.decision === 'auto') verdict = m.invoices.every((i) => paidBy.some((p) => p.id === i.id)) ? 'correct' : paidBy.length && hasRecords ? 'wrong' : 'unknown';
    tally[verdict]++;
    await applyMatch(d, userId, r, m, 'shadow', { backfill: true });
    await d.db.etransferReceipt.update({ where: { id: r.id }, data: { backfillVerdict: verdict, notifiedAt: d.now() } });
    if (verdict === 'correct' && await learnPayer(d, userId, { ...r, matchKind: m.matchKind, jobberClientId: m.client.id, clientName: m.client.name }, 'backfill')) learned++;
  }
  // unsure history that Jobber proved right is remembered at once (the tab lists every learned name, with Forget)
  learned += await saveLearnedPayers(userId, await learnPreview(userId, d), d.db);
  const n = receipts.length;
  const counts = `${tally.correct} it would have matched correctly, ${tally.wrong} wrong, ${tally.review} it would ask you about, ${tally.none + tally.unknown} no match or unsure${learned ? `; learned ${learned} payer name(s)` : ''}`;
  await d.notify(userId, {
    category: 'payments', urgent: process.env.ETRANSFER_SMS !== 'off', routineSlug: SLUG, link: '/ai.html#payments',
    title: again ? 'E-transfer matcher: history re-checked' : 'E-transfer matcher: first look at your last 90 days',
    smsText: again
      ? `E-transfer matcher re-checked ${n} past e-transfers with the new rules: ${counts}. Details: E-transfers tab.`
      : `E-transfer matcher is set up (test mode). Checked your last ${n} e-transfers: ${counts}. Details: E-transfers tab.`,
    body: JSON.stringify({ ...tally, learned }),
  });
  return { items_found: n, actions_taken: [`Backfill graded ${n} e-transfers`], summary: `Backfill: ${tally.correct} correct, ${tally.wrong} wrong, ${tally.review} review, ${tally.none} none, ${tally.unknown} unknown, ${learned} learned`, learnings: [] };
}

/** Re-run the history check with today's rules (after the matcher learns new tricks). One summary text, nothing queued. */
async function regrade(userId, over = {}) {
  const d = deps(over);
  const rows = (await d.db.etransferReceipt.findMany({ where: { userId, backfill: true, kind: 'deposited', authOk: true }, orderBy: { receivedAt: 'asc' } }))
    .filter((r) => r.amountCents > 0 && !(r.proposalIds || []).length && !r.outcome && ['matched', 'needs_review', 'no_match'].includes(r.status));
  if (!rows.length) return { items_found: 0, summary: 'No history to re-check' };
  return backfill(d, userId, rows, { again: true });
}

// ------------------------------------------------------------------------------------------------ owner picks (YES / dashboard)
/** executeProposal('etransfer_match'): the owner said which invoice this payment is for. */
async function applyOwnerPick(proposal, over = {}) {
  const d = deps(over);
  const pl = proposal.payload || {};
  const r = await d.db.etransferReceipt.findFirst({ where: { id: pl.receiptId, userId: proposal.userId } });
  if (!r) return { ok: false, error: 'e-transfer not found' };
  if (!['needs_review', 'no_match', 'new'].includes(r.status)) return { ok: true, note: `already ${r.status}` };
  return pickInvoice(d, proposal.userId, r, { id: pl.invoiceId, invoiceNumber: pl.invoiceNumber, webUri: pl.webUri, clientId: pl.clientId, clientName: pl.clientName, balanceCents: pl.balanceCents }, { exceptProposal: proposal.id });
}

async function pickInvoice(d, userId, r, inv, { exceptProposal } = {}) {
  const mode = await getMode(userId, d.db);
  const live = await d.jobber.recheckInvoice(userId, inv.id).catch(() => null);
  const balance = live?.cents ?? inv.balanceCents;
  const pay = Math.min(r.amountCents, balance);
  const status = mode === 'live' ? 'to_record' : 'matched';
  const item = { id: inv.id, invoiceNumber: inv.invoiceNumber, webUri: live?.webUri || inv.webUri, payCents: pay, balanceBefore: balance, clientName: inv.clientName };
  const row = await d.db.etransferReceipt.update({
    where: { id: r.id },
    data: { status, matchKind: 'owner_pick', reason: 'You picked this invoice', outcome: 'confirmed', outcomeAt: d.now(), jobberInvoiceId: inv.id, invoiceNumber: String(inv.invoiceNumber), invoiceIds: [item], jobberClientId: inv.clientId, clientName: inv.clientName, jobberWebUri: item.webUri, queuedAt: status === 'to_record' ? d.now() : null },
  });
  if (r.senderNameNorm && inv.clientId) {
    await d.db.payerAlias.upsert({
      where: { userId_payerNameNorm: { userId, payerNameNorm: r.senderNameNorm } },
      update: { jobberClientId: inv.clientId, clientName: inv.clientName || '', source: 'owner_confirmed' },
      create: { userId, payerNameNorm: r.senderNameNorm, jobberClientId: inv.clientId, clientName: inv.clientName || '', source: 'owner_confirmed' },
    });
  }
  const siblings = (r.proposalIds || []).filter((id) => id !== exceptProposal);
  if (siblings.length) await d.db.operatorProposal.updateMany({ where: { id: { in: siblings }, status: 'pending' }, data: { status: 'expired' } });
  const partial = pay < balance ? ` (partial: ${money(pay)} of ${money(balance)})` : r.amountCents > balance ? ` (they paid ${money(r.amountCents - balance)} more than owing)` : '';
  await say(d, userId, row, `Got it: Inv #${inv.invoiceNumber}`, status === 'to_record'
    ? `Got it: ${money(r.amountCents)} from ${r.senderName} goes on Inv #${inv.invoiceNumber}${partial}. Recording it in Jobber now, and I'll remember ${r.senderName} pays for ${short(inv.clientName, 30)}.`
    : `[Test mode] Got it: ${money(r.amountCents)} from ${r.senderName} = Inv #${inv.invoiceNumber}${partial}. Remembered for next time; nothing changed in Jobber.`);
  return { ok: true, status };
}

// ------------------------------------------------------------------------------------------------ the recorder hand-off
/**
 * What the MSI recorder should enter in Jobber now. Each invoice is re-read first: one the owner already marked paid
 * is closed as recorded, one whose balance moved some other way goes back to the owner.
 */
async function claimToRecord(userId, over = {}) {
  const d = deps(over);
  if (process.env.DRY_RUN === 'true') return [];
  if (await getMode(userId, d.db) !== 'live') return [];
  const rows = await d.db.etransferReceipt.findMany({ where: { userId, status: 'to_record' }, orderBy: { queuedAt: 'asc' }, take: 10 });
  const out = [];
  for (const r of rows) {
    const items = [];
    let state = 'todo';
    for (const it of r.invoiceIds || []) {
      const live = await d.jobber.recheckInvoice(userId, it.id);
      if (!live) { state = 'gone'; break; }
      if (live.cents <= it.balanceBefore - it.payCents) { items.push({ ...it, done: true }); continue; }
      if (live.cents !== it.balanceBefore) { state = 'moved'; break; }
      items.push(it);
    }
    if (state === 'gone') { await failRecording(d, userId, r, 'the invoice is no longer in Jobber'); continue; }
    if (state === 'moved') { await failRecording(d, userId, r, 'the invoice balance changed since the match'); continue; }
    if (items.every((i) => i.done)) { await markRecorded(d, userId, r, 'It was already marked paid in Jobber'); continue; }
    if (r.recordAttempts >= MAX_RECORD_ATTEMPTS) { await failRecording(d, userId, r, `the recorder tried ${r.recordAttempts} times`); continue; }
    await d.db.etransferReceipt.update({ where: { id: r.id }, data: { recordAttempts: { increment: 1 }, recordClaimedAt: d.now() } });
    out.push({
      id: r.id, ref: r.referenceNumber, payer: r.senderName, date: (r.sentDate || r.receivedAt).toISOString().slice(0, 10), message: r.message,
      invoices: items.filter((i) => !i.done).map((i) => ({ invoiceNumber: i.invoiceNumber, url: i.webUri, amount: (i.payCents / 100).toFixed(2), client: i.clientName })),
      note: `Interac e-Transfer ref ${r.referenceNumber} from ${r.senderName}`,
    });
  }
  return out;
}

/** Cheap check for the MSI gate (no Jobber calls, claims nothing): is there anything for the recorder to do? */
async function pendingRecordCount(userId, db = prismaDefault) {
  if (process.env.DRY_RUN === 'true' || await getMode(userId, db) !== 'live') return 0;
  return db.etransferReceipt.count({ where: { userId, status: 'to_record' } });
}

async function markRecorded(d, userId, r, how) {
  const row = await d.db.etransferReceipt.update({ where: { id: r.id }, data: { status: 'recorded', verifiedAt: d.now(), error: null } });
  await say(d, userId, row, `Inv #${r.invoiceNumber} marked paid`, `Done: Inv #${r.invoiceNumber} (${short(r.clientName, 30)}) is marked paid in Jobber. ${money(r.amountCents)} e-transfer from ${r.senderName}, ref ${r.referenceNumber}.${how ? ` ${how}.` : ''}`);
  return row;
}

/** The recorder says it saved the payment. Believe Jobber, not the report: every invoice balance must have dropped. */
async function reportRecorded(userId, id, { ok, note } = {}, over = {}) {
  const d = deps(over);
  const r = await d.db.etransferReceipt.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, error: 'not found' };
  if (r.status !== 'to_record') return { ok: true, status: r.status };
  if (ok) await d.db.etransferReceipt.update({ where: { id: r.id }, data: { markedAt: d.now() } });
  let verified = true;
  for (const it of r.invoiceIds || []) {
    const live = await d.jobber.recheckInvoice(userId, it.id).catch(() => null);
    if (!live || live.cents > it.balanceBefore - it.payCents) { verified = false; break; }
  }
  if (verified) { await markRecorded(d, userId, r, null); return { ok: true, status: 'recorded', verified: true }; }
  const why = ok ? 'Jobber still shows the old balance' : `the recorder could not do it${note ? `: ${String(note).slice(0, 120)}` : ''}`;
  if (r.recordAttempts >= MAX_RECORD_ATTEMPTS) { await failRecording(d, userId, r, why); return { ok: false, status: 'failed', verified: false }; }
  await d.db.etransferReceipt.update({ where: { id: r.id }, data: { error: why } });
  return { ok: false, status: 'to_record', verified: false, retry: true, error: why };
}

/** Dashboard: pick an invoice for an e-transfer, or ignore it (cash already counted, a refund, not a customer). */
async function resolveFromDashboard(userId, id, { invoiceId, ignore } = {}, over = {}) {
  const d = deps(over);
  const r = await d.db.etransferReceipt.findFirst({ where: { id, userId } });
  if (!r) return { ok: false, error: 'not found' };
  if (ignore) {
    await d.db.etransferReceipt.update({ where: { id }, data: { status: 'ignored', reason: 'Ignored by the owner' } });
    if ((r.proposalIds || []).length) await d.db.operatorProposal.updateMany({ where: { id: { in: r.proposalIds }, status: 'pending' }, data: { status: 'expired' } });
    return { ok: true, status: 'ignored' };
  }
  if (!['needs_review', 'no_match', 'failed'].includes(r.status)) return { ok: false, error: `already ${r.status}` };
  const live = await d.jobber.recheckInvoice(userId, invoiceId);
  if (!live) return { ok: false, error: 'invoice not found in Jobber' };
  if (!(live.cents > 0)) return { ok: false, error: `Inv #${live.invoiceNumber} has nothing owing` };
  return pickInvoice(d, userId, r, { id: live.id, invoiceNumber: live.invoiceNumber, webUri: live.webUri, clientId: live.client.id, clientName: live.client.name, balanceCents: live.cents });
}

/**
 * Payer names worth remembering, learned from the first run's history: an e-transfer the matcher was unsure about
 * (one suggested invoice, a name hint only) whose suggested invoice Jobber shows as paid within days of it. Nothing
 * is saved here; the owner reviews the list and saveLearnedPayers stores the ones they keep.
 */
async function learnPreview(userId, over = {}) {
  const d = deps(over);
  const [rows, known] = await Promise.all([
    d.db.etransferReceipt.findMany({ where: { userId, backfill: true, status: 'needs_review' }, orderBy: { receivedAt: 'asc' } }),
    d.db.payerAlias.findMany({ where: { userId } }),
  ]);
  const have = new Set(known.map((a) => a.payerNameNorm));
  const byPayer = new Map();
  for (const r of rows) {
    const c = r.candidates || [];
    // an amount coincidence teaches nothing: the suggestion must have come from the name, the message or the address
    if (c.length !== 1 || c[0].why === 'same client, different amount' || !/name|street/i.test(c[0].why || '') || !r.senderNameNorm || have.has(r.senderNameNorm)) continue;
    const live = await d.jobber.recheckInvoice(userId, c[0].invoiceId, { paid: true }).catch(() => null);
    const paidAt = live?.status === 'paid' && live.receivedDate ? new Date(live.receivedDate).getTime() : null;
    const t = r.receivedAt.getTime();
    const ok = paidAt != null && paidAt >= t - DAY && paidAt - t < 30 * DAY;
    const prev = byPayer.get(r.senderNameNorm);
    if (prev && prev.jobberClientId !== c[0].clientId) { prev.conflict = true; continue; }
    if (!ok) continue;
    const entry = prev || { payer: r.senderName, payerNameNorm: r.senderNameNorm, jobberClientId: c[0].clientId, clientName: c[0].clientName, evidence: [] };
    entry.evidence.push({ amount: money(r.amountCents), invoiceNumber: c[0].invoiceNumber, paidOn: new Date(paidAt).toISOString().slice(0, 10), why: c[0].why });
    byPayer.set(r.senderNameNorm, entry);
  }
  return [...byPayer.values()].filter((e) => !e.conflict && e.evidence.length);
}

/** Store the payer → client pairs the owner kept from learnPreview. */
async function saveLearnedPayers(userId, pairs = [], db = prismaDefault) {
  let saved = 0;
  for (const p of pairs) {
    if (!p?.payerNameNorm || !p?.jobberClientId) continue;
    await db.payerAlias.upsert({
      where: { userId_payerNameNorm: { userId, payerNameNorm: String(p.payerNameNorm) } },
      update: { jobberClientId: String(p.jobberClientId), clientName: String(p.clientName || ''), source: 'backfill' },
      create: { userId, payerNameNorm: String(p.payerNameNorm), jobberClientId: String(p.jobberClientId), clientName: String(p.clientName || ''), source: 'backfill' },
    });
    saved++;
  }
  return saved;
}

async function setMode(userId, mode, db = prismaDefault) {
  if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
  const r = await db.routine.findUnique({ where: { userId_slug: { userId, slug: SLUG } } });
  if (!r) throw new Error('etransfer-watch has not run yet');
  await db.routine.update({ where: { id: r.id }, data: { config: { ...(r.config || {}), mode } } });
  return mode;
}

async function overview(userId, { status, limit = 100 } = {}, db = prismaDefault) {
  const where = { userId, ...(status ? { status } : {}) };
  const [rows, byStatus, verdicts, mode, outcomes, history, learned, ctx] = await Promise.all([
    db.etransferReceipt.findMany({ where, orderBy: { receivedAt: 'desc' }, take: limit }),
    db.etransferReceipt.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
    db.etransferReceipt.groupBy({ by: ['backfillVerdict'], where: { userId, backfill: true }, _count: { _all: true } }),
    getMode(userId, db),
    db.etransferReceipt.groupBy({ by: ['matchKind', 'outcome'], where: { userId, outcome: { not: null } }, _count: { _all: true } }),
    db.etransferReceipt.groupBy({ by: ['matchKind', 'backfillVerdict'], where: { userId, backfill: true, matchKind: { not: null } }, _count: { _all: true } }),
    db.payerAlias.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 200 }),
    matchContext({ db, now: () => new Date() }, userId),
  ]);
  // how each kind of match has done: live outcomes, and how it graded on the history
  const accuracy = {};
  const slot = (k) => (accuracy[k] = accuracy[k] || { pending: 0, confirmed: 0, unconfirmed: 0, wrong: 0, history: { correct: 0, wrong: 0, unknown: 0 } });
  for (const g of outcomes) if (g.matchKind) slot(g.matchKind)[g.outcome] = g._count._all;
  for (const g of history) if (['correct', 'wrong', 'unknown'].includes(g.backfillVerdict)) slot(g.matchKind).history[g.backfillVerdict] = g._count._all;
  return {
    mode, dryRun: process.env.DRY_RUN === 'true',
    counts: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    backfill: Object.fromEntries(verdicts.map((g) => [g.backfillVerdict || 'unknown', g._count._all])),
    accuracy, demoted: [...ctx.demoted], kindLabels: KIND_LABEL,
    learned: learned.map((a) => ({ payer: a.payerNameNorm, clientName: a.clientName, source: a.source, at: a.updatedAt })),
    items: rows,
  };
}

/** Forget a learned payer name (the owner's Forget button). */
async function forgetPayer(userId, payerNameNorm, db = prismaDefault) {
  const r = await db.payerAlias.deleteMany({ where: { userId, payerNameNorm: String(payerNameNorm || '') } });
  return r.count;
}

module.exports = {
  etransferWatchTick, applyOwnerPick, claimToRecord, pendingRecordCount, reportRecorded, learnPreview, saveLearnedPayers, resolveFromDashboard, setMode, overview, getMode, SLUG,
  markWrong, regrade, forgetPayer,
};
