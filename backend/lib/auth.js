/**
 * auth.js — password hashing + signed cookie tokens
 *
 * No external dependencies. Uses Node's built-in crypto module:
 *   - scryptSync for password hashing (bcrypt-equivalent strength)
 *   - HMAC-SHA256 for signing session tokens (no JWT library needed)
 *
 * Token format:  base64url(JSON payload) + "." + base64url(HMAC signature)
 * Cookie name:   sf_session
 * Expiry:        30 days (embedded in payload, verified on read)
 */

const crypto = require('crypto');

const COOKIE_NAME = 'sf_session';
const TOKEN_EXPIRY_DAYS = 30;

function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.startsWith('<') || s.length < 16) {
    throw new Error('SESSION_SECRET not configured or too short — set a random 32+ char string in .env');
  }
  return s;
}

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password.
 * Returns a string in the format "salt:hash" (both hex-encoded).
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const hashBuf   = Buffer.from(hash, 'hex');
    const checkBuf  = crypto.scryptSync(password, salt, 64);
    return hashBuf.length === checkBuf.length && crypto.timingSafeEqual(hashBuf, checkBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

/**
 * Sign a payload and return a token string safe to store in a cookie.
 * Embeds exp (Unix timestamp) so the token is self-expiring.
 */
function signToken(payload) {
  const secret = getSessionSecret();
  const full = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_DAYS * 86400,
  };
  const data = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/**
 * Verify a token string. Returns the decoded payload or null if invalid/expired.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  try {
    const secret   = getSessionSecret();
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const sigBuf   = Buffer.from(sig);
    const expBuf   = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // expired
    }
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function setCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TOKEN_EXPIRY_DAYS * 86400 * 1000,
    path: '/',
  });
}

function clearCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function getTokenFromCookies(cookies) {
  return cookies?.[COOKIE_NAME] || null;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  setCookie,
  clearCookie,
  getTokenFromCookies,
};
