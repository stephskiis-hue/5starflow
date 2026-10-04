// Money-topic detector. "Quote me / book me" is fine for the AI to answer (we send a quote); anything about
// amounts, prices, payment, invoices or refunds is the owner's, until a service's pricing autonomy is on.
const AMOUNT = /\$\s?\d|\b\d+\s?(dollars|bucks)\b/i;
const TOPIC = /\b(price|prices|pricing|cost|costs|how much|rate|rates|fee|fees|charge|charged|charging|invoice|invoiced|bill|billed|billing|refund|refunded|pay|paid|payment|paying|e-?transfer|interac|deposit|owe|owing|overcharg\w*|discount|cheaper|cheap|expensive|budget|per (visit|month|hour|cut)|credit card|cash|cheque|check)\b/i;

/** true when the text asks about or states an amount / payment / billing. */
function isMoneyTopic(text) {
  const t = String(text || '');
  return AMOUNT.test(t) || TOPIC.test(t);
}

/** true when a DRAFT reply itself quotes an amount (the AI may never do this unless pricing autonomy is on). */
function quotesAmount(text) {
  return AMOUNT.test(String(text || ''));
}

module.exports = { isMoneyTopic, quotesAmount };
