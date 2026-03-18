const crypto = require('crypto');

/**
 * Express middleware that verifies Jobber webhook HMAC-SHA256 signatures.
 *
 * Jobber signs each webhook with:
 *   X-Jobber-Hmac-SHA256: base64( HMAC-SHA256(rawBody, JOBBER_CLIENT_SECRET) )
 *
 * Jobber uses the OAuth Client Secret as the signing key — there is no separate
 * webhook secret. JOBBER_CLIENT_SECRET must be set in .env.
 *
 * CRITICAL: This middleware must be mounted with express.raw() as its body parser
 * so that req.body is a raw Buffer. If express.json() runs first, the raw bytes
 * are lost and signature verification will always fail.
 *
 * After verification passes, req.parsedBody contains the decoded JSON object.
 */
function verifyWebhookSignature(req, res, next) {
  // Jobber signs webhooks with the OAuth Client Secret
  const secret = process.env.JOBBER_CLIENT_SECRET;
  if (!secret || secret.startsWith('<') || secret.trim() === '') {
    console.error(
      '[verifyWebhook] JOBBER_CLIENT_SECRET not configured — set it in .env and restart.'
    );
    return res.status(500).json({ error: 'Server misconfiguration: client secret missing' });
  }

  const signature = req.headers['x-jobber-hmac-sha256'];

  if (!signature) {
    console.warn('[verifyWebhook] Request missing X-Jobber-Hmac-SHA256 header');
    return res.status(401).json({ error: 'Missing webhook signature' });
  }

  if (!Buffer.isBuffer(req.body)) {
    console.error('[verifyWebhook] req.body is not a Buffer — ensure express.raw() is used before this middleware');
    return res.status(500).json({ error: 'Server misconfiguration: body not raw' });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.body)
    .digest('base64');

  // timingSafeEqual prevents timing-based side-channel attacks
  let valid = false;
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    valid = false;
  }

  if (!valid) {
    console.warn('[verifyWebhook] Signature mismatch — rejecting possible spoofed request');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // Decode the verified raw body into a JS object for downstream handlers
  try {
    req.parsedBody = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('[verifyWebhook] Failed to parse webhook body as JSON:', err.message);
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  next();
}

module.exports = { verifyWebhookSignature };
