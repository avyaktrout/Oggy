/**
 * Simple API key authentication middleware
 * For internal service-to-service communication
 */

function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.INTERNAL_API_KEY;

  // If no INTERNAL_API_KEY is set, allow all requests (dev mode)
  if (!expectedKey) {
    console.warn('WARNING: INTERNAL_API_KEY not set - auth disabled');
    return next();
  }

  // Validate API key
  if (!apiKey || apiKey !== expectedKey) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing API key',
        details: { header: 'x-api-key' }
      }
    });
  }

  next();
}

module.exports = authenticate;
