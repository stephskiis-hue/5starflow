/**
 * Express middleware — rejects Twilio webhooks whose X-Twilio-Signature doesn't verify.
 *
 * The inbound-SMS and status-callback routes are public (Twilio posts without a session), and
 * the inbound route drives owner approvals (YES/NO, rain reschedules, STOP opt-outs). Without
 * this check anyone who knows the URL can forge a text "from" the owner's phone.
 *
 * Must run AFTER express.urlencoded() so req.body holds the signed form params.
 *
 * Multi-tenant rule: the token that verifies a request must belong to the account the request is
 * ABOUT (matched by the body's AccountSid or the To/From number). Accepting "any tenant's token"
 * would let one portal user store a made-up token and forge webhooks aimed at another tenant.
 * On success `req.twilioUserId` is the tenant whose credential verified it (null = env token);
 * handlers that resolve a tenant themselves (inbound-sms looks it up by `To`) must check they agree.
 * Fails closed when nothing matches. Local dev escape hatch: TWILIO_SKIP_SIGNATURE=true.
 */
const twilio = require('twilio');
const prisma = require('./prismaClient');

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);

function publicUrl(req) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

async function matchingCredentials(body) {
  const numbers = new Set([last10(body.To), last10(body.From)].filter((n) => n.length === 10));
  const rows = await prisma.twilioCredential.findMany({ select: { userId: true, accountSid: true, authToken: true, fromNumber: true } }).catch((err) => {
    console.warn('[twilio-signature] credential lookup failed:', err.message);
    return [];
  });
  return rows.filter((r) => r.authToken && ((body.AccountSid && r.accountSid === body.AccountSid) || numbers.has(last10(r.fromNumber))));
}

async function validateTwilioSignature(req, res, next) {
  if (process.env.TWILIO_SKIP_SIGNATURE === 'true') return next();

  const signature = req.get('X-Twilio-Signature');
  if (!signature) {
    console.warn(`[twilio-signature] missing signature on ${req.originalUrl} from ${req.ip}`);
    return res.status(403).send('Forbidden');
  }

  const body = req.body || {};
  const url = publicUrl(req);
  const candidates = (await matchingCredentials(body)).map((c) => ({ userId: c.userId, token: c.authToken }));
  // single-tenant env fallback: only for requests addressed to the env account
  if (process.env.TWILIO_AUTH_TOKEN && (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID === body.AccountSid)) {
    candidates.push({ userId: null, token: process.env.TWILIO_AUTH_TOKEN });
  }

  const hit = candidates.find((c) => twilio.validateRequest(c.token, signature, url, body));
  if (!hit) {
    console.warn(`[twilio-signature] INVALID signature on ${req.originalUrl} from ${req.ip}`);
    return res.status(403).send('Forbidden');
  }
  req.twilioUserId = hit.userId;
  next();
}

module.exports = { validateTwilioSignature };
