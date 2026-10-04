/**
 * Express middleware — rejects Twilio webhooks whose X-Twilio-Signature doesn't verify.
 *
 * The inbound-SMS and status-callback routes are public (Twilio posts without a session), and
 * the inbound route drives owner approvals (YES/NO, rain reschedules, STOP opt-outs). Without
 * this check anyone who knows the URL can forge a text "from" the owner's phone.
 *
 * Must run AFTER express.urlencoded() so req.body holds the signed form params.
 * The auth token is per-user (TwilioCredential) with an env fallback, so we accept the request
 * if any configured token validates it. Fails closed when no token is configured at all.
 * Local dev escape hatch: TWILIO_SKIP_SIGNATURE=true.
 */
const twilio = require('twilio');
const prisma = require('./prismaClient');

function publicUrl(req) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}${req.originalUrl}` : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
}

async function candidateTokens() {
  const tokens = new Set();
  if (process.env.TWILIO_AUTH_TOKEN) tokens.add(process.env.TWILIO_AUTH_TOKEN);
  try {
    const rows = await prisma.twilioCredential.findMany({ select: { authToken: true } });
    rows.forEach((r) => r.authToken && tokens.add(r.authToken));
  } catch (err) {
    console.warn('[twilio-signature] credential lookup failed:', err.message);
  }
  return [...tokens];
}

async function validateTwilioSignature(req, res, next) {
  if (process.env.TWILIO_SKIP_SIGNATURE === 'true') return next();

  const signature = req.get('X-Twilio-Signature');
  if (!signature) {
    console.warn(`[twilio-signature] missing signature on ${req.originalUrl} from ${req.ip}`);
    return res.status(403).send('Forbidden');
  }

  const tokens = await candidateTokens();
  const url = publicUrl(req);
  const ok = tokens.some((t) => twilio.validateRequest(t, signature, url, req.body || {}));
  if (!ok) {
    console.warn(`[twilio-signature] INVALID signature on ${req.originalUrl} from ${req.ip}`);
    return res.status(403).send('Forbidden');
  }
  next();
}

module.exports = { validateTwilioSignature };
