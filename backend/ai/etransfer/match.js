/**
 * Which unpaid Jobber invoice does this e-transfer pay? Pure, and deliberately strict: in spring dozens of invoices
 * share the same total ($97.11, $313.95), so the AMOUNT ALONE NEVER MATCHES. A payment is only matched on its own when
 * the payer is exactly one Jobber client (by full name or a name the owner confirmed before) AND that client's open
 * balance gives exactly one answer for the amount. Everything else goes to the owner with candidates, or is reported
 * as unmatched.
 *
 * invoices: [{ id, invoiceNumber, cents, issuedDate, webUri, street, client: { id, name, firstName, lastName, companyName } }]
 * aliases:  Map(payerNameNorm → jobberClientId)
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

/**
 * @returns {{ decision: 'auto'|'review'|'none', matchKind?: string, invoices?: object[], client?: object,
 *             candidates: object[], reason: string, sameAmountCount: number }}
 */
function matchReceipt(receipt, invoices, aliases = new Map()) {
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

  // No client by that name. Only an explicit invoice number in the e-transfer message can make this automatic.
  const payerLast = payerTok[payerTok.length - 1];
  const invNums = [...String(receipt.message || '').matchAll(/(?:#|\binv(?:oice)?\.?\s*(?:no\.?|number)?\s*#?)\s*(\d{2,7})\b/gi)].map((m) => m[1]);
  for (const num of invNums) {
    const inv = invoices.find((i) => String(i.invoiceNumber) === num);
    if (!inv || inv.cents !== cents) continue;
    if (payerTok.length >= 2 && lastNameOf(inv.client) === payerLast) {
      return { ...base, decision: 'auto', matchKind: 'invoice_in_message', invoices: [inv], client: inv.client, reason: `Message names invoice #${num}, amount matches and the last name matches` };
    }
    return { ...base, decision: 'review', candidates: [cand(inv, `message names invoice #${num}`)], reason: `Message names invoice #${num} and the amount matches, but the payer's name is not on that client` };
  }

  // Hints worth showing the owner: same last name, same first name on a first-name-only client, street number in the message.
  const streetNums = new Set(String(receipt.message || '').match(/\b\d{2,5}\b/g) || []);
  const hints = [];
  for (const inv of sameAmount) {
    const c = inv.client;
    const ct = tokens(c.name);
    let why = null;
    if (payerTok.length >= 2 && lastNameOf(c) === payerLast) why = 'same last name, exact amount';
    else if (ct.length === 1 && !c.lastName && ct[0] === payerTok[0]) why = 'same first name (no last name in Jobber), exact amount';
    else if (inv.street && streetNums.has((String(inv.street).match(/^\s*(\d+)/) || [])[1])) why = 'street number from the message, exact amount';
    if (why) hints.push(cand(inv, why));
  }
  if (hints.length && hints.length <= MAX_CANDIDATES) {
    return { ...base, decision: 'review', candidates: hints, reason: `No Jobber client is named ${receipt.senderName}; ${hints.length === 1 ? 'one invoice looks likely' : 'a few invoices look likely'}` };
  }
  return {
    ...base, decision: 'none', candidates: [],
    reason: hints.length ? `${hints.length} invoices could be it, too many to guess` : sameAmount.length ? `No Jobber client is named ${receipt.senderName}; ${sameAmount.length} unpaid invoice(s) are ${fmt(cents)} so the amount alone can't tell` : `No unpaid invoice is ${fmt(cents)} and no client is named ${receipt.senderName}`,
  };
}

function fmt(cents) {
  return `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { matchReceipt, clientKeys, fmt };
