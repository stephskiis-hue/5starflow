/**
 * requireAuth.js — session guard middleware
 *
 * Reads the sf_session cookie, verifies the signed token.
 * - API routes (/api/*): returns 401 JSON on failure
 * - HTML routes: redirects to /login.html on failure
 *
 * Attaches req.user = { userId, email } on success.
 */

const { verifyToken, getTokenFromCookies } = require('../lib/auth');

function requireAuth(req, res, next) {
  const token   = getTokenFromCookies(req.cookies);
  const payload = verifyToken(token);

  if (!payload) {
    // API callers expect JSON
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ error: 'Not authenticated', redirect: '/login.html' });
    }
    return res.redirect('/login.html');
  }

  req.user = { userId: payload.userId, email: payload.email, role: payload.role || 'client' };
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
