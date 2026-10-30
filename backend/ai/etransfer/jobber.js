/**
 * Jobber reads for the e-transfer matcher. Field names are taken from introspection once per process instead of being
 * guessed (the balance field, the client name parts, the status filter and the payment-record connection), so a schema
 * difference costs a skipped field, not a failed run. Every nested connection has first: (CLAUDE.md rule 9).
 */
const { jobberGraphQL } = require('../../services/jobberClient');
const { toCents } = require('./parse');

const UNPAID = ['awaiting_payment', 'sent_not_due', 'past_due'];
const PAGE = 50;
const MAX_PAGES = 40;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (t) => { while (t && !t.name && t.ofType) t = t.ofType; return t || {}; };

let schemaCache = null;

async function typeFields(name, userId) {
  const d = await jobberGraphQL(`query T($n: String!) { __type(name: $n) { fields { name type { name kind ofType { name kind ofType { name kind } } } args { name type { name kind ofType { name kind } } } } inputFields { name type { name kind ofType { name kind } } } enumValues { name } } }`, { n: name }, userId);
  return d?.__type || null;
}

/** What this Jobber API version calls things. Cached; reset with resetSchema(). */
async function schemaInfo(userId) {
  if (schemaCache) return schemaCache;
  const [inv, query, mutation] = await Promise.all([typeFields('Invoice', userId), typeFields('Query', userId), typeFields('Mutation', userId)]);
  if (!inv) throw new Error('Jobber schema has no Invoice type');
  const invField = (n) => inv.fields.find((f) => f.name === n);
  const amountsType = unwrap(invField('amounts')?.type).name;
  const clientType = unwrap(invField('client')?.type).name || 'Client';
  const addrType = unwrap(invField('billingAddress')?.type).name;
  const payField = ['paymentRecords', 'payments'].find((n) => invField(n));
  const [amounts, client, addr, payConn] = await Promise.all([
    amountsType ? typeFields(amountsType, userId) : null, typeFields(clientType, userId),
    addrType ? typeFields(addrType, userId) : null, payField ? typeFields(unwrap(invField(payField).type).name, userId) : null,
  ]);
  const has = (t, n) => !!t?.fields?.some((f) => f.name === n);
  const balance = ['invoiceBalance', 'outstandingAmount', 'balance'].find((n) => has(amounts, n));
  if (!balance) throw new Error(`Jobber ${amountsType || 'amounts'} has no balance field`);

  // invoices(filter: { status: … }) if this version has it, with its exact enum spelling
  let statusFilter = null;
  const filterArg = query?.fields?.find((f) => f.name === 'invoices')?.args?.find((a) => a.name === 'filter');
  if (filterArg) {
    const ft = await typeFields(unwrap(filterArg.type).name, userId);
    const st = ft?.inputFields?.find((f) => f.name === 'status');
    if (st) {
      const et = await typeFields(unwrap(st.type).name, userId);
      const values = (et?.enumValues || []).map((v) => v.name);
      const pick = UNPAID.map((u) => values.find((v) => v.toLowerCase() === u)).filter(Boolean);
      if (pick.length) statusFilter = pick;
    }
  }
  let payNode = null;
  if (payConn) {
    const nodesT = unwrap(payConn.fields.find((f) => f.name === 'nodes')?.type).name;
    if (nodesT) payNode = await typeFields(nodesT, userId);
  }
  schemaCache = {
    balance,
    clientFields: ['firstName', 'lastName', 'companyName'].filter((n) => has(client, n)),
    street: ['street1', 'street'].find((n) => has(addr, n)) || null,
    webUri: !!invField('jobberWebUri'),
    issuedDate: !!invField('issuedDate'),
    receivedDate: !!invField('receivedDate'),     // when the invoice was paid: the backfill's truth when payment records are not exposed
    invoicePayFields: inv.fields.filter((f) => /pay|paid|receiv/i.test(f.name)).map((f) => f.name),
    statusFilter,
    payments: payField && payNode ? { field: payField, amount: has(payNode, 'amount'), entryDate: has(payNode, 'entryDate') } : null,
    paymentMutations: (mutation?.fields || []).filter((f) => /payment/i.test(f.name)).map((f) => ({ name: f.name, args: (f.args || []).map((a) => `${a.name}: ${unwrap(a.type).name}`) })),
  };
  return schemaCache;
}
function resetSchema() { schemaCache = null; }

function invoiceSelection(s, { payments = false } = {}) {
  return `id invoiceNumber invoiceStatus ${s.issuedDate ? 'issuedDate' : ''} ${s.webUri ? 'jobberWebUri' : ''}
    amounts { total ${s.balance} }
    ${s.street ? `billingAddress { ${s.street} }` : ''}
    client { id name ${s.clientFields.join(' ')} }
    ${payments && s.receivedDate ? 'receivedDate' : ''}
    ${payments && s.payments ? `${s.payments.field}(first: 5) { nodes { ${s.payments.amount ? 'amount' : ''} ${s.payments.entryDate ? 'entryDate' : ''} } }` : ''}`;
}

function shape(n, s) {
  const toC = (v) => (v == null ? null : toCents(Number(v).toFixed(2)));
  return {
    id: n.id, invoiceNumber: String(n.invoiceNumber ?? ''), status: String(n.invoiceStatus || '').toLowerCase(),
    issuedDate: n.issuedDate || null, receivedDate: n.receivedDate || null, webUri: n.jobberWebUri || null,
    cents: toC(n.amounts?.[s.balance]), totalCents: toC(n.amounts?.total),
    street: s.street ? n.billingAddress?.[s.street] || null : null,
    client: { id: n.client?.id, name: n.client?.name || '', firstName: n.client?.firstName || '', lastName: n.client?.lastName || '', companyName: n.client?.companyName || null },
    payments: s.payments ? (n[s.payments.field]?.nodes || []).map((p) => ({ cents: toC(p.amount), at: p.entryDate || null })) : [],
  };
}

async function pace(extensions) {
  const t = extensions?.cost?.throttleStatus;
  if (!t) return sleep(parseInt(process.env.JOBBER_PAGE_DELAY_MS, 10) || 1500);
  const need = (t.actualQueryCost || 1000) * 1.5;
  return sleep(t.currentlyAvailable < need ? Math.ceil((need - t.currentlyAvailable) / t.restoreRate * 1000) + 250 : 400);
}

async function pageInvoices(userId, s, { filter = '', payments = false, maxPages = MAX_PAGES } = {}) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const q = `query Inv($after: String) { invoices(first: ${PAGE}, after: $after${filter}) { nodes { ${invoiceSelection(s, { payments })} } pageInfo { hasNextPage endCursor } } }`;
    const { data, extensions } = await jobberGraphQL(q, { after }, userId, { returnExtensions: true });
    out.push(...(data?.invoices?.nodes || []).map((n) => shape(n, s)));
    if (!data?.invoices?.pageInfo?.hasNextPage) return { list: out, complete: true };
    after = data.invoices.pageInfo.endCursor;
    await pace(extensions);
  }
  return { list: out, complete: false };
}

/**
 * Every invoice that still has money owing. `complete:false` means the page cap was hit, so a missing invoice is
 * possible: callers then never report "no unpaid invoice matches" as fact.
 */
async function fetchUnpaidInvoices(userId) {
  const s = await schemaInfo(userId);
  let list = []; let complete = true;
  if (s.statusFilter) {
    for (const st of s.statusFilter) {
      const r = await pageInvoices(userId, s, { filter: `, filter: { status: ${st} }` });
      list.push(...r.list); complete = complete && r.complete;
    }
  } else {
    const r = await pageInvoices(userId, s);
    list = r.list; complete = r.complete;
  }
  const seen = new Set();
  return {
    complete,
    invoices: list.filter((i) => UNPAID.includes(i.status) && i.cents > 0 && i.client.id && !seen.has(i.id) && seen.add(i.id)),
  };
}

/** Recent invoices of every status with their payment records, for the backfill check. */
async function fetchRecentInvoicesWithPayments(userId, { maxPages = 30 } = {}) {
  const s = await schemaInfo(userId);
  return (await pageInvoices(userId, s, { payments: true, maxPages })).list;
}

/** One invoice's live state: re-read right before it is handed out to be recorded, and again after. */
async function recheckInvoice(userId, id) {
  const s = await schemaInfo(userId);
  const d = await jobberGraphQL(`query One($id: EncodedId!) { invoice(id: $id) { ${invoiceSelection(s)} } }`, { id }, userId);
  return d?.invoice ? shape(d.invoice, s) : null;
}

module.exports = { fetchUnpaidInvoices, fetchRecentInvoicesWithPayments, recheckInvoice, schemaInfo, resetSchema, UNPAID };
