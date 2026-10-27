/**
 * requireAuth.js — session guard middleware
 *
 * Reads the sf_session cookie, verifies the signed token.
 * - API routes (/api/*): returns 401 JSON on failure
 * - HTML routes: redirects to /login.html on failure
 *
 * Attaches req.user = { userId, email } on success.
 */

const prisma = require('../lib/prismaClient');
const { verifyToken, getTokenFromCookies } = require('../lib/auth');

async function requireAuth(req, res, next) {
  // API callers expect JSON; HTML callers get redirected to the login page.
  // originalUrl, not path: inside a mounted router req.path is relative ('/proposals'), which
  // used to turn API 401s into HTML redirects for routes mounted before the global guard.
  const deny = () => {
    if (req.originalUrl.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Not authenticated', redirect: '/login.html' });
    }
    return res.redirect('/login.html');
  };

  const token   = getTokenFromCookies(req.cookies);
  const payload = verifyToken(token);
  if (!payload) return deny();

  // Re-validate against the DB on every request so deactivation and role changes take effect
  // immediately, instead of lingering for the token's 30-day lifetime (session revocation).
  // The token proves identity; the DB is the source of truth for isActive and role.
  let user;
  try {
    user = await prisma.user.findUnique({
      where:  { id: payload.userId },
      select: { id: true, email: true, role: true, isActive: true },
    });
  } catch (err) {
    console.error('[requireAuth] user lookup failed:', err.message);
    return deny(); // fail closed — no access if we can't confirm the account is still active
  }
  if (!user || !user.isActive) return deny();

  req.user = { userId: user.id, email: user.email, role: user.role || 'client' };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
