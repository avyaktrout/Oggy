/**
 * Harmony Map Domain Service Entry Point
 *
 * Runs behind the API gateway. Handles harmony map routes:
 * nodes, indicators, scores, scenarios, audit, and data catalog.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./shared/utils/db');
const logger = require('./shared/utils/logger');
const { injectUserIdFromHeader } = require('./shared/middleware/internalService');

// Domain routes
const harmonyRouter = require('./domains/harmony/routes/harmony');

const app = express();
const PORT = process.env.PORT || 3013;

// ──────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));

// Request ID (forwarded from gateway)
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('x-request-id', req.requestId);
    next();
});

// Request logging
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        logger.info('HTTP Request', {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration_ms: Date.now() - startTime,
            service: 'harmony',
        });
    });
    next();
});

// Inject user_id from gateway header
app.use(injectUserIdFromHeader);

// ──────────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await query('SELECT 1');
        dbOk = true;
    } catch (_) {}

    res.status(dbOk ? 200 : 503).json({
        ok: dbOk,
        service: 'harmony-service',
        timestamp: new Date().toISOString(),
        checks: { database: dbOk },
    });
});

// ──────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────
app.use('/v0/harmony', harmonyRouter);

// ──────────────────────────────────────────────────
// Error + 404 handlers
// ──────────────────────────────────────────────────
app.use((error, req, res, _next) => {
    logger.logError(error, { requestId: req.requestId, path: req.path, service: 'harmony' });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, service: 'harmony' });
});

// ──────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
    logger.info('Harmony service starting', { port: PORT });

    // Database check
    try {
        await query('SELECT 1');
        logger.info('Database connection verified (harmony)');
    } catch (error) {
        logger.error('Database connection failed (harmony)', { error: error.message });
        process.exit(1);
    }

    logger.info('Harmony service ready');
});

// Graceful shutdown
function gracefulShutdown(signal) {
    logger.warn(`${signal} received, shutting down harmony service`);
    const timeout = setTimeout(() => process.exit(1), 30000);
    server.close(async () => {
        try { await close(); } catch (_) {}
        clearTimeout(timeout);
        process.exit(0);
    });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception (harmony)', { error: error.message, stack: error.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (harmony)', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
});

module.exports = app;
