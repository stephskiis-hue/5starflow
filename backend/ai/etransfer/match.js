/**
 * Which unpaid Jobber invoice does this e-transfer pay? Pure. In spring dozens of invoices share the same total ($97.11,
 * $313.95), so the AMOUNT ALONE NEVER MATCHES a crowd. The order of reasoning:
 *   1. the payer is exactly one Jobber client (full name, company, or a payer name learned/confirmed before) and that
 *      client's open balance gives one answer for the amount;
 *   2. the message names the invoice number (spouse paying);
 *   3. evidence on the invoices of exactly this amount: a name that looks like the client (MAXIME = Max, a spouse with
 *      the same last name, a first-name-only client), the client's name or street in the message, and, for the only
 *      open invoice of this amount, a recent invoice date. Auto only when one invoice clearly stands out.
 * Two or more invoices that nothing tells apart are only flagged for the owner, never matched.
 *
 * invoices: [{ id, invoiceNumber, cents, issuedDate, webUri, street, client: { id, name, firstName, lastName, companyName } }]
 * aliases:  Map(payerNameNorm → jobberClientId)
 * opts:     { equivalences: Map(FIRST → Set(FIRST)) learned from confirmed payers }
 */
const { normName } = require('./parse');

const MAX_CANDIDATES = 3;
const SUFFIX = /\s+(?:LTD|LTEE|INC|CORP|CORPORATION|CO|LLC|LIMITED)$/;

const tokens = (s) => normName(s).split(' ').filter(Boolean);
const bare = (s) => normName(s).replace(SUFFIX, '');

/** Full-name keys a client can be paid under (at least two words, or a company name). */
function clientKeys(c) {
  const keys = new Set();
  const add = (s) => { const n = bare(s); if (n.split(' ').length >= 2) keys.add(n); };
  add(`${c.firstName || ''} ${c.lastName || ''}`);
  add(`${c.lastName || ''} ${c.firstName || ''}`);
  add(c.name);
  if (c.companyName) { const n = bare(c.companyName); if (n) keys.add(n); }
  return keys;
}

function lastNameOf(c) {
  if (c.lastName) return tokens(c.lastName).pop() || null;
  const t = tokens(c.name);
  return t.length >= 2 ? t[t.length - 1] : null;
}

const oldestFirst = (a, b) => String(a.issuedDate || '').localeCompare(String(b.issuedDate || '')) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber), undefined, { numeric: true });

/** Every combination of 2-4 of one client's invoices whose balances add up to the amount (capped so it stays cheap). */
function sumCombos(invs, cents) {
  const list = invs.slice(0, 10);
  const out = [];
  const walk = (start, picked, total) => {
    if (picked.length >= 2 && total === cents) out.push([...picked]);
    if (picked.length === 4 || total >= cents || out.length > 1) return;
    for (let i = start; i < list.length; i++) { picked.push(list[i]); walk(i + 1, picked, total + list[i].cents); picked.pop(); }
  };
  walk(0, [], 0);
  return out;
}

const cand = (inv, why) => ({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, clientId: inv.client.id, clientName: inv.client.name, cents: inv.cents, webUri: inv.webUri || null, why });

// ------------------------------------------------------------------------------------------------ evidence
const DAY = 24 * 3600 * 1000;
const RECENT_DAYS = 14;
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR']);
// first names people pay under that a prefix can't explain (MAX/MAXIME, CHRIS/CHRISTOPHER are caught by the prefix rule)
const NICKNAMES = [
  ['ROBERT', 'BOB', 'BOBBY', 'ROB', 'ROBBIE'], ['WILLIAM', 'BILL', 'BILLY', 'WILL', 'LIAM'], ['RICHARD', 'RICK', 'RICKY', 'DICK', 'RICH'],
  ['ELIZABETH', 'LIZ', 'LIZZIE', 'BETH', 'BETTY', 'ELIZA'], ['MARGARET', 'MAGGIE', 'PEGGY', 'MEG', 'MARG'], ['JAMES', 'JIM', 'JIMMY', 'JAMIE'],
  ['JOHN', 'JACK', 'JOHNNY', 'JON'], ['MICHAEL', 'MIKE', 'MIKEY', 'MICK'], ['KATHERINE', 'KATHRYN', 'CATHERINE', 'KATE', 'KATIE', 'KATHY', 'CATHY', 'KAT'],
  ['JENNIFER', 'JEN', 'JENNY'], ['ANTHONY', 'TONY'], ['EDWARD', 'ED', 'EDDIE', 'TED', 'NED'], ['THEODORE', 'TED', 'THEO'], ['STEPHEN', 'STEVEN', 'STEVE'],
  ['JOSEPH', 'JOE', 'JOEY'], ['CHARLES', 'CHARLIE', 'CHUCK'], ['PATRICK', 'PAT'], ['PATRICIA', 'PAT', 'PATTY', 'TRISH'], ['SUSAN', 'SUE', 'SUZY'],
  ['DEBORAH', 'DEBRA', 'DEB', 'DEBBIE'], ['ALEXANDER', 'ALEXANDRA', 'ALEX', 'SASHA'], ['JEFFREY', 'GEOFFREY', 'JEFF'], ['GERALD', 'GERRY', 'JERRY'],
  ['LAWRENCE', 'LARRY'], ['CHRISTINE', 'CHRISTINA', 'CHRIS', 'TINA'], ['ANDREW', 'ANDY', 'DREW'], ['REBECCA', 'BECKY'], ['ABIGAIL', 'ABBY'],
  ['VICTORIA', 'VICKY', 'TORI'], ['DOROTHY', 'DOT', 'DOTTIE'], ['NICHOLAS', 'NICK', 'NICKY'], ['THOMAS', 'TOM', 'TOMMY'], ['MATTHEW', 'MATT'],
];
const NICK = new Map();
for (const g of NICKNAMES) for (const a of g) for (const b of g) if (a !== b) { if (!NICK.has(a)) NICK.set(a, new Set()); NICK.get(a).add(b); }
// words in a message that are about the job, not a name
const NOT_NAMES = new Set(['LAWN', 'YARD', 'YARDWORK', 'GRASS', 'MOWING', 'CUTTING', 'SNOW', 'CLEAN', 'CLEANUP', 'LEAVES', 'HEDGE', 'TRIM', 'FALL', 'SPRING', 'SUMMER', 'WINTER', 'THANKS', 'THANK', 'INVOICE', 'PAYMENT', 'SERVICE', 'SERVICES', 'WEEK', 'WEEKS', 'MONTH', 'WORK', 'DONE', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'APRIL', 'GREAT', 'GOOD', 'HOUSE', 'HOME', 'FROM', 'WITH', 'THIS', 'THAT', 'YOUR']);
const STREET_WORDS = new Set(['STREET', 'ROAD', 'AVENUE', 'DRIVE', 'CRESCENT', 'CRES', 'BLVD', 'BOULEVARD', 'PLACE', 'COURT', 'LANE', 'TRAIL', 'CLOSE', 'COVE', 'GATE', 'HIGHWAY', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'UNIT', 'SUITE']);

const nameTokens = (s) => { const t = tokens(s); while (t.length > 1 && TITLES.has(t[0])) t.shift(); return TITLES.has(t[0]) ? [] : t; };

/** "MAXIME" and "MAX" can be the same person: equal, a 3+ letter prefix, a known nickname, or a pair learned from confirmed payers. */
function firstsCompatible(a, b, eq) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];   // an initial; only ever counted together with the last name
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return !!(NICK.get(a)?.has(b) || eq?.get(a)?.has(b));
}

/** The ways a Jobber client's name can be read: { first, last }. "Mr Kyle" could be a first or a last name, so both. */
function clientReadings(c) {
  if (c.firstName || c.lastName) {
    const first = nameTokens(c.firstName || '')[0] || null;
    const last = c.lastName ? tokens(c.lastName).pop() || null : null;
    if (!first && last && TITLES.has(tokens(c.firstName || '')[0])) return [{ first: null, last }, { first: last, last: null }];
    return [{ first, last }];
  }
  const t = nameTokens(c.name);
  if (t.length >= 2) return [{ first: t[0], last: t[t.length - 1] }];
  return t.length ? [{ first: t[0], last: null }] : [];
}

/** 'name' (same person: same last name and a compatible first name), 'last' (same last name, e.g. a spouse), 'first' (first-name-only client), or null. */
function nameRelation(payerTok, c, eq) {
  const pFirst = payerTok[0];
  const pLast = payerTok.length >= 2 ? payerTok[payerTok.length - 1] : null;
  if (!pFirst || c.companyName) return null;
  let best = null;
  for (const { first, last } of clientReadings(c)) {
    if (last && pLast === last) {
      if (!first || firstsCompatible(pFirst, first, eq)) return 'name';
      best = 'last';
    } else if (!last && first && pFirst.length > 1 && firstsCompatible(pFirst, first, eq)) best = best || 'first';
  }
  return best;
}

function messageClues(message) {
  const t = tokens(message);
  return { words: new Set(t.filter((w) => /^[A-Z]{4,}$/.test(w) && !NOT_NAMES.has(w))), nums: new Set(t.filter((w) => /^\d{1,5}$/.test(w))) };
}

/** The message names this client: their last name or company. */
function clientNamed(c, clues) {
  if (!clues.words.size) return false;
  const names = clientReadings(c).map((r) => r.last).filter(Boolean);
  if (c.companyName) names.push(bare(c.companyName).split(' ')[0]);
  return names.some((n) => clues.words.has(n));
}

/** 'address' when the house number and a street word are both in the message ("37 Tallgrass"), 'street_number' for the number alone. */
function addressClue(street, clues) {
  const t = tokens(street);
  const num = t.find((w) => /^\d{1,5}$/.test(w));
  if (!num || !clues.nums.has(num)) return null;
  if (t.some((w) => /^[A-Z]{4,}$/.test(w) && !STREET_WORDS.has(w) && clues.words.has(w))) return 'address';
  return num.length >= 2 ? 'street_number' : null;
}

const EVIDENCE = {
  name: [2, 'name looks like the client'], message_name: [2, 'message names the client'], address: [2, 'street address in the message'],
  last: [1, 'same last name'], first: [1, 'same first name (no last name in Jobber)'], street_number: [1, 'street number in the message'],
  unique: [0, 'only open invoice of this amount'], recent: [0, 'invoice made within 2 weeks of the payment'],
};
const KIND_BY_EVIDENCE = [['name', 'fuzzy_name_amount'], ['message_name', 'message_name_amount'], ['address', 'address_amount']];
/** The match kinds that come from reasoning rather than an exact name: guarded and self-demoting (index.js). */
const REASONED_KINDS = ['fuzzy_name_amount', 'message_name_amount', 'address_amount', 'evidence_amount', 'unique_recent'];
const describe = (ev) => ev.map((e) => EVIDENCE[e][1]).join(' + ');

function evidenceFor(inv, payerTok, clues, eq) {
  const ev = [];
  const rel = nameRelation(payerTok, inv.client, eq);
  if (rel) ev.push(rel);
  if (clientNamed(inv.client, clues)) ev.push('message_name');
  const a = inv.street ? addressClue(inv.street, clues) : null;
  if (a) ev.push(a);
  return { inv, ev, score: ev.reduce((s, e) => s + EVIDENCE[e][0], 0) };
}

/** First names that turned out to be the same person, from payer names the owner confirmed or history proved (MAXIME ↔ MAX). */
function equivalencesFrom(aliases = []) {
  const eq = new Map();
  const add = (a, b) => { if (!eq.has(a)) eq.set(a, new Set()); eq.get(a).add(b); };
  for (const a of aliases) {
    const p = nameTokens(a.payerNameNorm); const c = nameTokens(a.clientName);
    if (p.length < 2 || c.length < 2 || p[p.length - 1] !== c[c.length - 1]) continue;
    if (p[0] !== c[0] && p[0].length > 1 && c[0].length > 1) { add(p[0], c[0]); add(c[0], p[0]); }
  }
  return eq;
}

/**
 * @returns {{ decision: 'auto'|'review'|'none', matchKind?: string, invoices?: object[], client?: object,
 *             candidates: object[], reason: string, sameAmountCount: number }}
 */
function matchReceipt(receipt, invoices, aliases = new Map(), { equivalences } = {}) {
  const cents = receipt.amountCents;
  const payer = bare(receipt.senderNameNorm || receipt.senderName);
  const payerTok = payer.split(' ').filter(Boolean);
  const sameAmount = invoices.filter((i) => i.cents === cents);
  const base = { candidates: [], sameAmountCount: sameAmount.length };
  if (!Number.isInteger(cents) || cents <= 0 || !payer) return { ...base, decision: 'none', reason: 'Could not read the payer or the amount' };

  const byClient = new Map();
  for (const inv of invoices) {
    if (!byClient.has(inv.client.id)) byClient.set(inv.client.id, { client: inv.client, invs: [] });
    byClient.get(inv.client.id).invs.push(inv);
  }
  for (const g of byClient.values()) g.invs.sort(oldestFirst);

  const aliasId = aliases.get(normName(receipt.senderNameNorm || receipt.senderName)) || aliases.get(payer);
  const strong = [...byClient.values()].filter((g) => g.client.id === aliasId || clientKeys(g.client).has(payer));

  if (strong.length === 1) {
    const { client, invs } = strong[0];
    const kind = client.id === aliasId ? 'alias_amount' : 'name_amount';
    const exact = invs.filter((i) => i.cents === cents);
    if (exact.length) {
      const inv = exact[0];
      const note = exact.length > 1 ? ` (${client.name} has ${exact.length} open invoices of this amount; the oldest was picked)` : '';
      return { ...base, decision: 'auto', matchKind: kind, invoices: [inv], client, reason: `${kind === 'alias_amount' ? 'Known payer' : 'Name'} and amount match exactly${note}` };
    }
    const combos = sumCombos(invs, cents);
    if (combos.length === 1) {
      return { ...base, decision: 'auto', matchKind: 'multi_invoice', invoices: combos[0], client, reason: `Pays ${combos[0].length} of ${client.name}'s invoices exactly (#${combos[0].map((i) => i.invoiceNumber).join(', #')})` };
    }
    const owed = invs.reduce((s, i) => s + i.cents, 0);
    return {
      ...base, decision: 'review', client, candidates: invs.slice(0, MAX_CANDIDATES).map((i) => cand(i, 'same client, different amount')),
      reason: combos.length > 1 ? `Several combinations of ${client.name}'s invoices add up to this amount` : `${client.name} matches but owes ${fmt(owed)} across ${invs.length} invoice(s), not ${fmt(cents)} (partial payment, tip or a different invoice?)`,
    };
  }

  if (strong.length > 1) {
    const list = strong.flatMap((g) => g.invs.filter((i) => i.cents === cents).map((i) => cand(i, 'same name, exact amount')));
    return { ...base, decision: list.length ? 'review' : 'none', candidates: list.slice(0, MAX_CANDIDATES), reason: `${strong.length} Jobber clients are named ${receipt.senderName}` };
  }

  // No client by that name. An invoice number in the message, then the evidence on the invoices of exactly this amount.
  const payerLast = payerTok[payerTok.length - 1];
  const invNums = [...String(receipt.message || '').matchAll(/(?:#|\binv(?:oice)?\.?\s*(?:no\.?|number)?\s*#?)\s*(\d{2,7})\b/gi)].map((m) => m[1]);
  for (const num of invNums) {
    const inv = invoices.find((i) => String(i.invoiceNumber) === num);
    if (!inv || inv.cents !== cents) continue;
    if (payerTok.length >= 2 && lastNameOf(inv.client) === payerLast) {
      return { ...base, decision: 'auto', matchKind: 'invoice_in_message', invoices: [inv], client: inv.client, evidence: ['invoice_number', 'last'], reason: `Message names invoice #${num}, amount matches and the last name matches` };
    }
    return { ...base, decision: 'review', candidates: [cand(inv, `message names invoice #${num}`)], reason: `Message names invoice #${num} and the amount matches, but the payer's name is not on that client` };
  }

  const payAt = receipt.sentDate || receipt.receivedAt;
  const dayOf = (v) => Date.parse(new Date(v).toISOString().slice(0, 10));   // calendar days: an invoice date has no time
  const daysApart = (inv) => (payAt && inv.issuedDate ? Math.round((dayOf(inv.issuedDate) - dayOf(payAt)) / DAY) : null);
  const recent = (inv) => { const d = daysApart(inv); return d != null && Math.abs(d) <= RECENT_DAYS; };
  const unique = sameAmount.length === 1;
  const clues = messageClues(receipt.message);
  const scored = sameAmount.map((i) => evidenceFor(i, payerTok, clues, equivalences)).sort((a, b) => b.score - a.score || oldestFirst(a.inv, b.inv));
  const [top, next] = scored;

  if (top && top.score > 0) {
    const ev = [...top.ev, ...(unique ? ['unique'] : []), ...(recent(top.inv) ? ['recent'] : [])];
    const clear = !next || next.score <= top.score - 2;
    const enough = top.score >= 2 || ev.length > top.ev.length;   // one weak clue needs the invoice to be the only one or recent
    const pointing = scored.filter((x) => x.score > 0);
    const candidates = pointing.slice(0, MAX_CANDIDATES).map((x) => cand(x.inv, `${describe(x.ev)}, exact amount`));
    if (clear && enough) {
      const kind = (KIND_BY_EVIDENCE.find(([e]) => top.ev.includes(e)) || [null, 'evidence_amount'])[1];
      return { ...base, decision: 'auto', matchKind: kind, invoices: [top.inv], client: top.inv.client, evidence: ev, candidates, reason: `Exact amount + ${describe(ev)}` };
    }
    return {
      ...base, decision: 'review', candidates, evidence: ev,
      reason: clear ? `One invoice looks likely (${describe(ev)}), but that alone is not enough to be sure` : `${pointing.length} invoices of ${fmt(cents)} look possible and nothing tells them apart`,
    };
  }

  // nothing about the name, the message or the address points anywhere
  if (unique) {
    const only = sameAmount[0];
    const d = daysApart(only);
    if (recent(only)) {
      return { ...base, decision: 'auto', matchKind: 'unique_recent', invoices: [only], client: only.client, evidence: ['unique', 'recent'], candidates: [cand(only, 'only open invoice of this amount, made recently')],
        reason: `The only open invoice of ${fmt(cents)}, made ${d === 0 ? 'the same day as' : `${Math.abs(d)} day(s) ${d < 0 ? 'before' : 'after'}`} the payment` };
    }
    return { ...base, decision: 'review', evidence: ['unique'], candidates: [cand(only, 'only open invoice of this amount')], reason: `The only open invoice of ${fmt(cents)} is ${only.client.name}'s, but it is older than 2 weeks and nothing else links it to ${receipt.senderName}` };
  }
  if (sameAmount.length >= 2 && sameAmount.length <= MAX_CANDIDATES) {
    return { ...base, decision: 'review', candidates: [...sameAmount].sort(oldestFirst).map((i) => cand(i, 'exact amount')), reason: `${sameAmount.length} open invoices are ${fmt(cents)} and nothing tells them apart` };
  }
  return {
    ...base, decision: 'none', candidates: [],
    reason: sameAmount.length ? `No Jobber client is named ${receipt.senderName}; ${sameAmount.length} unpaid invoices are ${fmt(cents)} so the amount alone can't tell` : `No unpaid invoice is ${fmt(cents)} and no client is named ${receipt.senderName}`,
  };
}

function fmt(cents) {
  return `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { matchReceipt, clientKeys, equivalencesFrom, firstsCompatible, fmt, REASONED_KINDS };
