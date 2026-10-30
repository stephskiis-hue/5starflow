/**
 * Interac e-Transfer deposit emails → structured receipts. Pure: no I/O, so every format quirk has a test.
 *
 * Incoming payments come from notify@payments.interac.ca:
 *   "Interac e-Transfer: You've received $97.11 from MARGARET HAY and it has been automatically deposited."
 *   "Interac e-Transfer: MENEER DEVELOPMENT LTD sent you $70.00. Claim your deposit!"   (not deposited yet)
 * catch@payments.interac.ca is OUR outgoing transfers ("Your $621.73 transfer to X has been successfully deposited")
 * and must never be read as money in.
 */
const SENDER = 'notify@payments.interac.ca';
const DOMAIN = 'payments.interac.ca';

/** "$1,993.95" / "1993.95" → 199395. Integer cents only; floats are never compared. */
function toCents(s) {
  const m = String(s || '').replace(/[,\s]/g, '').match(/\$?(\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + (m[2] ? parseInt(m[2].padEnd(2, '0'), 10) : 0);
}

/** Uppercase, no accents/punctuation, hyphens as spaces, single-letter middle initials dropped. */
function normName(s) {
  const words = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[-_/]/g, ' ').replace(/[^A-Z0-9& ]/g, '')
    .split(/\s+/).filter(Boolean);
  const kept = words.filter((w, i) => !(w.length === 1 && i > 0 && i < words.length - 1));
  return kept.join(' ');
}

function emailOf(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

/**
 * Trust Google's own verdict only: the first Authentication-Results header from mx.google.com (headers are newest
 * first, so a forged one inside the message sits below it). DMARC pass for payments.interac.ca, or DKIM pass signed
 * by that domain, counts as genuine.
 */
function authPassed(headers = []) {
  const ar = headers.filter((h) => /^authentication-results$/i.test(h.name)).map((h) => String(h.value || ''))
    .find((v) => /^\s*mx\.google\.com\b/i.test(v));
  if (!ar) return false;
  const v = ar.toLowerCase();
  const dmarc = /dmarc=pass\b[^;]*header\.from=payments\.interac\.ca/.test(v);
  const dkim = /dkim=pass\b[^;]*header\.(?:i=@|d=)(?:[a-z0-9-]+\.)*payments\.interac\.ca/.test(v);
  return dmarc || dkim;
}

const field = (body, label) => {
  const m = body.match(new RegExp(`^\\s*${label}:[ \\t]*(.+)$`, 'im'));
  return m ? m[1].trim() : null;
};

/**
 * @param {{subject:string, body:string, from:string, headers?:{name,value}[], internalDate?:number|string}} msg
 * @returns {{kind, ref, senderName, senderNameNorm, amountCents, sentDate, message, bank, authOk, fromOk}}
 *   kind: deposited | pending_accept | cancelled | request | outgoing | other
 */
function parseInterac(msg) {
  const subject = String(msg.subject || '').replace(/\s+/g, ' ').trim();
  const body = String(msg.body || '').replace(/\r/g, '');
  const from = emailOf(msg.from);
  const fromOk = from === SENDER;
  const out = { kind: 'other', ref: null, senderName: null, senderNameNorm: '', amountCents: null, sentDate: null, message: null, bank: null, authOk: false, fromOk };
  if (from.endsWith(`@${DOMAIN}`) && !fromOk) { out.kind = 'outgoing'; return out; }

  let m;
  if ((m = subject.match(/You've received \$([\d,]+(?:\.\d{1,2})?) from (.+?) and it has been automatically deposited/i))) {
    out.kind = 'deposited'; out.amountCents = toCents(m[1]); out.senderName = m[2].trim();
  } else if ((m = subject.match(/e-Transfer:\s*(.+?) sent you \$([\d,]+(?:\.\d{1,2})?)/i))) {
    out.kind = 'pending_accept'; out.senderName = m[1].trim(); out.amountCents = toCents(m[2]);
  } else if (/cancel/i.test(subject)) out.kind = 'cancelled';
  else if (/request/i.test(subject)) out.kind = 'request';

  // the body's Transfer Details are the authority; the subject is only a fallback
  const sentFrom = field(body, 'Sent From');
  const amount = field(body, 'Amount');
  if (sentFrom) out.senderName = sentFrom;
  if (amount && toCents(amount) != null) out.amountCents = toCents(amount);
  out.ref = field(body, 'Reference Number');
  const date = field(body, 'Date');
  if (date) { const d = new Date(date.replace(/\bSept\b/i, 'Sep')); if (!Number.isNaN(d.getTime())) out.sentDate = d; }
  const msgM = body.match(/^\s*Message:[ \t]*\n?([\s\S]*?)\n\s*\n/im);
  if (msgM && msgM[1].trim()) out.message = msgM[1].trim().slice(0, 500);
  const bankM = body.match(/on behalf of .+? at (.+?)\.?\s*$/im);
  if (bankM) out.bank = bankM[1].trim().slice(0, 80);
  if (out.senderName) out.senderNameNorm = normName(out.senderName);
  // a deposited email that does not say so in the body (format change) is not trusted as money in
  if (out.kind === 'deposited' && !/deposited/i.test(body)) out.kind = 'other';
  out.authOk = fromOk && authPassed(msg.headers || []);
  return out;
}

module.exports = { parseInterac, normName, toCents, authPassed, SENDER };
