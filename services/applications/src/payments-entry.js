/**
 * Payments Domain Service Entry Point
 *
 * Runs behind the API gateway. Handles all payments-related routes:
 * expenses, categorization, chat, evaluation, training, benchmarks, etc.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./shared/utils/db');
const logger = require('./shared/utils/logger');
const { costGovernor } = require('./shared/middleware/costGovernor');
const { injectUserIdFromHeader } = require('./shared/middleware/internalService');
const { getClient: getRedisClient } = require('./shared/utils/redisClient');
const chatHandler = require('./shared/services/chatHandler');
const AppEventProcessor = require('./shared/services/eventProcessor');

// Domain routes
const expensesRouter = require('./domains/payments/routes/expenses');
const queryRouter = require('./domains/payments/routes/query');
const categorizationRouter = require('./domains/payments/routes/categorization');
const chatRouter = require('./domains/payments/routes/chat');

// Shared routes used by payments
const evaluationRouter = require('./shared/routes/evaluation');
const learningRouter = require('./shared/routes/learning');
const tessaRouter = require('./shared/routes/tessa');
const sealedBenchmarkRouter = require('./shared/routes/sealedBenchmark');
const trainingRouter = require('./shared/routes/training');
const benchmarkDrivenLearningRouter = require('./shared/routes/benchmarkDrivenLearning');
const continuousLearningRouter = require('./shared/routes/continuousLearning');
const inquiriesRouter = require('./shared/routes/inquiries');
const observerRouter = require('./shared/routes/observer');

const app = express();
const PORT = process.env.PORT || 3010;

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
            service: 'payments',
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

    const budgetStatus = costGovernor.getBudgetStatus();
    res.status(dbOk ? 200 : 503).json({
        ok: dbOk,
        service: 'payments-service',
        timestamp: new Date().toISOString(),
        checks: { database: dbOk },
        tokenBudget: {
            dailyLimit: budgetStatus.dailyBudget,
            currentUsage: budgetStatus.currentUsage,
            percentUsed: budgetStatus.percentUsed,
        },
    });
});

// ──────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────
app.use('/v0/expenses', expensesRouter);
app.use('/v0/query', queryRouter);

// Cost-governed routes
app.use('/v0/categorization', async (req, res, next) => {
    try {
        await costGovernor.checkBudget(2000);
        next();
    } catch (error) {
        if (error.budgetExceeded) {
            return res.status(429).json({
                error: 'Daily token budget exceeded',
                message: 'AI categorization temporarily unavailable due to budget limits',
            });
        }
        next(error);
    }
}, categorizationRouter);

app.use('/v0/evaluation', async (req, res, next) => {
    try {
        const benchmarkCount = req.body.benchmark_count || 20;
        await costGovernor.checkBudget(benchmarkCount * 4000);
        next();
    } catch (error) {
        if (error.budgetExceeded) {
            return res.status(429).json({
                error: 'Daily token budget exceeded',
                message: 'Evaluation temporarily unavailable due to budget limits',
            });
        }
        next(error);
    }
}, evaluationRouter);

app.use('/v0/chat', chatRouter);
app.use('/v0/learning', learningRouter);
app.use('/v0/tessa', tessaRouter);
app.use('/v0/sealed-benchmark', sealedBenchmarkRouter);
app.use('/v0/training', trainingRouter);
app.use('/v0/benchmark-learning', benchmarkDrivenLearningRouter);
app.use('/v0/continuous-learning', continuousLearningRouter);
app.use('/v0/inquiries', inquiriesRouter);
app.use('/v0/observer', observerRouter);

// Event processing
app.post('/v0/process-events', async (req, res) => {
    const startTime = Date.now();
    try {
        const processor = new AppEventProcessor();
        const limit = req.body.limit || 100;
        const processed = await processor.processUnprocessedEvents(limit);
        res.json({
            processed_count: processed,
            message: `Processed ${processed} events`,
            duration_ms: Date.now() - startTime,
        });
    } catch (error) {
        logger.logError(error, { operation: 'process-events', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to process events' });
    }
});

// ──────────────────────────────────────────────────
// Error + 404 handlers
// ──────────────────────────────────────────────────
app.use((error, req, res, _next) => {
    logger.logError(error, { requestId: req.requestId, path: req.path, service: 'payments' });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, service: 'payments' });
});

// ──────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
    logger.info('Payments service starting', { port: PORT });

    // Database check
    try {
        await query('SELECT 1');
        logger.info('Database connection verified (payments)');
    } catch (error) {
        logger.error('Database connection failed (payments)', { error: error.message });
        process.exit(1);
    }

    // Redis for chat + behavior
    try {
        const redisClient = await getRedisClient();
        if (redisClient) {
            chatHandler.setRedisClient(redisClient);
            const { suggestionGate } = require('./shared/services/suggestionGate');
            suggestionGate.setRedisClient(redisClient);
            logger.info('Redis connected (payments)');
        }
    } catch (error) {
        logger.warn('Redis init failed (payments)', { error: error.message });
    }

    // Observer schedule (federated learning every 6 hours)
    try {
        const observerService = require('./shared/services/observerService');
        observerService.startSchedule(6);
        logger.info('Observer schedule started (every 6 hours)');
    } catch (error) {
        logger.warn('Observer schedule init failed', { error: error.message });
    }

    // Background event processor
    startEventProcessor();

    logger.info('Payments service ready');
});

// Background event processor
function startEventProcessor() {
    const processor = new AppEventProcessor();
    const INTERVAL_MS = 60000;
    setInterval(async () => {
        try {
            const processed = await processor.processUnprocessedEvents(100);
            if (processed > 0) {
                logger.info('Background events processed', { processed, service: 'payments' });
            }
        } catch (error) {
            logger.logError(error, { job: 'background-event-processor', service: 'payments' });
        }
    }, INTERVAL_MS);
}

// Graceful shutdown
function gracefulShutdown(signal) {
    logger.warn(`${signal} received, shutting down payments service`);
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
    logger.error('Uncaught exception (payments)', { error: error.message, stack: error.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (payments)', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
});

module.exports = app;
