/**
 * Internal Service Middleware
 * Used by domain services (payments, general, diet) running behind the gateway.
 * The gateway validates auth and forwards X-User-Id; domain services trust it.
 */

function injectUserIdFromHeader(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (userId) {
        req.userId = userId;
        if (req.body && typeof req.body === 'object') {
            req.body.user_id = userId;
        }
        if (req.query) {
            req.query.user_id = userId;
        }
    }
    next();
}

module.exports = { injectUserIdFromHeader };
