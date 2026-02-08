/**
 * Auth Middleware - Session validation, CSRF protection, user ID injection
 * Private Domain Hosting v0.1
 *
 * Three middleware functions applied in order:
 * 1. requireAuth - validates session cookie, sets req.userId
 * 2. requireCSRF - checks CSRF token for mutating requests
 * 3. injectUserId - overwrites user_id in body/query with session user
 */

const authService = require('../services/authService');

/**
 * Parse cookies from request header (no external dependency).
 */
function parseCookies(req) {
    const cookies = {};
    const header = req.headers.cookie;
    if (!header) return cookies;

    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx < 0) return;
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        cookies[key] = decodeURIComponent(val);
    });
    return cookies;
}

/**
 * Require authentication via session cookie.
 * Sets req.userId and req.userSession on success.
 */
async function requireAuth(req, res, next) {
    const cookies = parseCookies(req);
    const sessionToken = cookies['oggy_session'];

    if (!sessionToken) {
        // API requests get 401, page requests redirect to login
        if (req.path.startsWith('/v0/') || req.xhr || req.headers.accept?.includes('application/json')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login.html');
    }

    try {
        const session = await authService.validateSession(sessionToken);
        if (!session) {
            if (req.path.startsWith('/v0/') || req.xhr || req.headers.accept?.includes('application/json')) {
                return res.status(401).json({ error: 'Session expired' });
            }
            return res.redirect('/login.html');
        }

        req.userId = session.user_id;
        req.userSession = session;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Authentication error' });
    }
}

/**
 * Require valid CSRF token for POST/PUT/DELETE requests.
 */
async function requireCSRF(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const csrfToken = req.headers['x-csrf-token'];
    if (!csrfToken || !req.userSession || csrfToken !== req.userSession.csrf_token) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    next();
}

/**
 * Inject authenticated user_id into request body and query.
 * This enforces data isolation without changing any existing route handler.
 */
function injectUserId(req, res, next) {
    if (req.userId) {
        if (req.body && typeof req.body === 'object') {
            req.body.user_id = req.userId;
        }
        if (req.query) {
            req.query.user_id = req.userId;
        }
    }
    next();
}

module.exports = { requireAuth, requireCSRF, injectUserId, parseCookies };
