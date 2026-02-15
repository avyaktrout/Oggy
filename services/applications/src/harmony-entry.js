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
const { getClient: getRedisClient } = require('./shared/utils/redisClient');

// Domain routes
const harmonyRouter = require('./domains/harmony/routes/harmony');
const harmonyObserverRouter = require('./domains/harmony/routes/harmonyObserver');
const continuousLearningRouter = require('./shared/routes/continuousLearning');
const harmonyEngine = require('./domains/harmony/services/harmonyEngine');
const harmonySuggestionService = require('./domains/harmony/services/harmonySuggestionService');
const harmonyObserverService = require('./domains/harmony/services/harmonyObserverService');

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
app.use('/v0/harmony/observer', harmonyObserverRouter);
app.use('/v0/continuous-learning', continuousLearningRouter);

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

    // Database check + migrations
    try {
        await query('SELECT 1');
        logger.info('Database connection verified (harmony)');

        // Initialize Redis and inject into domain services
        try {
            const redis = await getRedisClient();
            if (redis) {
                harmonyEngine.setRedisClient(redis);
                harmonySuggestionService.setRedisClient(redis);
                harmonyObserverService.setRedisClient(redis);
                logger.info('Redis connected and injected into harmony services');
            } else {
                logger.warn('Redis unavailable — NEW indicator badges disabled');
            }
        } catch (redisErr) {
            logger.warn('Redis init failed (non-blocking)', { error: redisErr.message });
        }

        // Auto-migrate: add 'new_city' to suggestion type constraint
        try {
            await query(`ALTER TABLE harmony_suggestions DROP CONSTRAINT IF EXISTS valid_suggestion_type`);
            await query(`ALTER TABLE harmony_suggestions ADD CONSTRAINT valid_suggestion_type CHECK (suggestion_type IN ('new_indicator', 'new_data_point', 'weight_adjustment', 'model_update', 'new_city'))`);
            logger.info('Harmony suggestion type constraint updated (includes new_city)');
        } catch (migErr) {
            logger.debug('Suggestion constraint migration skipped', { error: migErr.message });
        }

        // Auto-fix: populate indicator values for cities that have no data
        try {
            const emptyCities = await query(`
                SELECT n.node_id, n.name, s.balance, s.flow, s.compassion, s.discernment, s.awareness, s.expression
                FROM harmony_nodes n
                LEFT JOIN harmony_scores s ON n.node_id = s.node_id
                WHERE n.scope = 'city'
                  AND NOT EXISTS (SELECT 1 FROM harmony_indicator_values iv WHERE iv.node_id = n.node_id)
            `);
            if (emptyCities.rows.length > 0) {
                const suggestionService = require('./domains/harmony/services/harmonySuggestionService');
                for (const city of emptyCities.rows) {
                    const scores = {
                        balance: city.balance ? Math.round(parseFloat(city.balance) * 100) : 50,
                        flow: city.flow ? Math.round(parseFloat(city.flow) * 100) : 50,
                        compassion: city.compassion ? Math.round(parseFloat(city.compassion) * 100) : 50,
                        discernment: city.discernment ? Math.round(parseFloat(city.discernment) * 100) : 50,
                        awareness: city.awareness ? Math.round(parseFloat(city.awareness) * 100) : 50,
                        expression: city.expression ? Math.round(parseFloat(city.expression) * 100) : 50,
                    };
                    await suggestionService._populateCityIndicatorValues(city.node_id, scores);
                    const harmonyEngine = require('./domains/harmony/services/harmonyEngine');
                    await harmonyEngine.computeScores(city.node_id);
                    logger.info('Auto-populated indicator values for empty city', { name: city.name, node_id: city.node_id });
                }
            }
        } catch (migErr) {
            logger.debug('Empty city indicator migration skipped', { error: migErr.message });
        }
    } catch (error) {
        logger.error('Database connection failed (harmony)', { error: error.message });
        process.exit(1);
    }

    // Schedule daily 6pm snapshot
    function scheduleSnapshot() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(18, 0, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        const delay = target.getTime() - now.getTime();

        setTimeout(async () => {
            try {
                logger.info('Running daily harmony snapshot');
                const result = await harmonyEngine.snapshotAllNodes('city');
                logger.info('Daily snapshot complete', result);
            } catch (err) {
                logger.error('Daily snapshot failed', { error: err.message });
            }
            scheduleSnapshot(); // schedule next day
        }, delay);

        logger.info('Next harmony snapshot scheduled', { at: target.toISOString(), delay_ms: delay });
    }
    scheduleSnapshot();

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
