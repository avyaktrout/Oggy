/**
 * Application Service - Main Entry Point
 * Hosts all domains: Payments, General Assistant, Diet Agent
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./shared/utils/db');
const AppEventProcessor = require('./shared/services/eventProcessor');
const logger = require('./shared/utils/logger');
const { costGovernor } = require('./shared/middleware/costGovernor');

// Shared routes
const evaluationRouter = require('./shared/routes/evaluation');
const learningRouter = require('./shared/routes/learning');
const tessaRouter = require('./shared/routes/tessa');
const sealedBenchmarkRouter = require('./shared/routes/sealedBenchmark');
const memoryPruningRouter = require('./shared/routes/memoryPruning');
const trainingRouter = require('./shared/routes/training');
const benchmarkDrivenLearningRouter = require('./shared/routes/benchmarkDrivenLearning');
const continuousLearningRouter = require('./shared/routes/continuousLearning');
const serviceHealthRouter = require('./shared/routes/serviceHealth');
const inquiriesRouter = require('./shared/routes/inquiries');
const preferencesRouter = require('./shared/routes/preferences');
const benchmarkAnalyticsRouter = require('./shared/routes/benchmarkAnalytics');
const observerRouter = require('./shared/routes/observer');
const settingsRouter = require('./shared/routes/settings');
// migrationRouter split into export/import — loaded below near mount points

const authRouter = require('./shared/routes/auth');
const authService = require('./shared/services/authService');
const { requireAuth, requireCSRF, injectUserId } = require('./shared/middleware/auth');

const auditChecker = require('./shared/utils/auditChecker');
const { getClient: getRedisClient } = require('./shared/utils/redisClient');
const chatHandler = require('./shared/services/chatHandler');
const { runMigrations } = require('./shared/utils/migrationRunner');
const { initTelemetry, seedHistoricalMetrics } = require('./shared/utils/telemetry');

// Domain routes
const expensesRouter = require('./domains/payments/routes/expenses');
const queryRouter = require('./domains/payments/routes/query');
const categorizationRouter = require('./domains/payments/routes/categorization');
const chatRouter = require('./domains/payments/routes/chat');
const generalChatRouter = require('./domains/general/routes/generalChat');
const dietRouter = require('./domains/diet/routes/diet');

const app = express();
const PORT = process.env.PORT || 3001;
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Middleware
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({
    origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));

// Request ID middleware (for tracing requests across services)
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('x-request-id', req.requestId);
    next();
});

// Request logging with structured logger
app.use((req, res, next) => {
    const startTime = Date.now();

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        logger.info('HTTP Request', {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration_ms: duration,
            userAgent: req.headers['user-agent']
        });
    });

    next();
});

// Enhanced health check with dependency verification
app.get('/health', async (req, res) => {
    const checks = {
        database: false,
        memoryService: false,
        openaiConfig: false
    };

    let overallOk = true;

    // Check database
    try {
        await query('SELECT 1');
        checks.database = true;
    } catch (error) {
        logger.error('Health check: Database failed', { error: error.message });
        checks.database = false;
        overallOk = false;
    }

    // Check memory service
    try {
        const memoryHealth = await axios.get(`${MEMORY_SERVICE_URL}/health`, {
            timeout: 3000,
            headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
        });
        checks.memoryService = memoryHealth.data.ok === true;
    } catch (error) {
        logger.warn('Health check: Memory service unavailable', { error: error.message });
        checks.memoryService = false;
        // Don't fail overall health if memory service is down (graceful degradation)
    }

    // Check OpenAI configuration
    checks.openaiConfig = !!OPENAI_API_KEY && OPENAI_API_KEY.length > 0;
    if (!checks.openaiConfig) {
        logger.error('Health check: OpenAI API key not configured');
        overallOk = false;
    }

    // Token budget status
    const budgetStatus = costGovernor.getBudgetStatus();

    const statusCode = overallOk ? 200 : 503;

    res.status(statusCode).json({
        ok: overallOk,
        service: 'application-service',
        version: '0.2.0',
        timestamp: new Date().toISOString(),
        checks,
        tokenBudget: {
            dailyLimit: budgetStatus.dailyBudget,
            currentUsage: budgetStatus.currentUsage,
            percentUsed: budgetStatus.percentUsed,
            remaining: budgetStatus.remaining
        }
    });
});

// Audit endpoints for data integrity checks
app.get('/v0/audit/full', async (req, res) => {
    try {
        const report = await auditChecker.runFullAudit();
        const statusCode = report.overall_status === 'FAIL' ? 500 : 200;
        res.status(statusCode).json(report);
    } catch (error) {
        logger.logError(error, {
            operation: 'audit-full',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Audit check failed',
            message: error.message
        });
    }
});

app.get('/v0/audit/quick', async (req, res) => {
    try {
        const report = await auditChecker.runQuickCheck();
        const statusCode = report.overall_status === 'FAIL' ? 500 : 200;
        res.status(statusCode).json(report);
    } catch (error) {
        logger.logError(error, {
            operation: 'audit-quick',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Quick audit check failed',
            message: error.message
        });
    }
});

// Auth routes (BEFORE auth middleware — must be accessible without session)
app.use('/v0/auth', authRouter);

// Serve login page and static assets without auth
const publicDir = path.join(__dirname, '..', 'public');
const noCacheStatic = { setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
} };
app.get('/login.html', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(publicDir, 'login.html'));
});
app.use('/css', express.static(path.join(publicDir, 'css'), noCacheStatic));
app.use('/js', express.static(path.join(publicDir, 'js'), noCacheStatic));

// Migration export (before auth — allows local instances to export without login)
// Import is still protected by auth middleware below.
const { migrationExportRouter, migrationImportRouter } = require('./shared/routes/migration');
app.use('/v0/migration', migrationExportRouter);

// Receive-sync endpoint (before auth — uses X-Sync-Key header for auth)
app.post('/v0/benchmark-analytics/receive-sync', benchmarkAnalyticsRouter.receiveSyncHandler);

// Auth middleware — everything below requires authentication
app.use(requireAuth);
app.use(requireCSRF);
app.use(injectUserId);

// Serve static frontend files (authenticated)
app.use(express.static(publicDir, noCacheStatic));

// API Routes
app.use('/v0/expenses', expensesRouter);
app.use('/v0/query', queryRouter);

// Apply cost governor to expensive AI routes
app.use('/v0/categorization', async (req, res, next) => {
    try {
        await costGovernor.checkBudget(2000); // Estimate 2k tokens per categorization
        next();
    } catch (error) {
        if (error.budgetExceeded) {
            logger.error('Daily token budget exceeded', {
                requestId: req.requestId,
                path: req.path
            });
            return res.status(429).json({
                error: 'Daily token budget exceeded',
                message: 'AI categorization temporarily unavailable due to budget limits',
                retryAfter: 'tomorrow'
            });
        }
        next(error);
    }
}, categorizationRouter);

app.use('/v0/evaluation', async (req, res, next) => {
    try {
        // Evaluation can use many tokens (20+ assessments × ~2k each)
        const benchmarkCount = req.body.benchmark_count || 20;
        await costGovernor.checkBudget(benchmarkCount * 4000); // Conservative estimate
        next();
    } catch (error) {
        if (error.budgetExceeded) {
            logger.error('Daily token budget exceeded for evaluation', {
                requestId: req.requestId,
                path: req.path
            });
            return res.status(429).json({
                error: 'Daily token budget exceeded',
                message: 'Evaluation temporarily unavailable due to budget limits',
                retryAfter: 'tomorrow'
            });
        }
        next(error);
    }
}, evaluationRouter);

// Self-driven learning routes
app.use('/v0/learning', learningRouter);

// Tessa assessment generation routes
app.use('/v0/tessa', tessaRouter);

// Sealed benchmark routes (OOD testing)
app.use('/v0/sealed-benchmark', sealedBenchmarkRouter);

// Memory pruning routes
app.use('/v0/memory-pruning', memoryPruningRouter);

app.use('/v0/training', trainingRouter);

// Benchmark-driven learning routes (feedback loop)
app.use('/v0/benchmark-learning', benchmarkDrivenLearningRouter);

// Continuous learning routes (long-running self-driven learning with auto-benchmark)
app.use('/v0/continuous-learning', continuousLearningRouter);

// Service health and circuit breaker management routes
app.use('/v0/service-health', serviceHealthRouter);

// Chat routes (Oggy vs Base comparison)
app.use('/v0/chat', chatRouter);

// Inquiry routes (self-driven questions)
app.use('/v0/inquiries', inquiriesRouter);

// Preference and behavior audit routes
app.use('/v0/preferences', preferencesRouter);

// Benchmark analytics + OTEL metrics
app.use('/v0/benchmark-analytics', benchmarkAnalyticsRouter);

// Observer (federated learning) routes
app.use('/v0/observer', observerRouter);

// V2: General Conversation routes
app.use('/v0/general', generalChatRouter);

// V3: Diet Agent routes
app.use('/v0/diet', dietRouter);

// Settings (BYO-Model)
app.use('/v0/settings', settingsRouter);

// Migration import (behind auth — requires authentication)
app.use('/v0/migration', migrationImportRouter);

// Event processing endpoint (for manual trigger or webhook)
app.post('/v0/process-events', async (req, res) => {
    const startTime = Date.now();
    try {
        const processor = new AppEventProcessor();
        const limit = req.body.limit || 100;

        logger.info('Processing events manually triggered', {
            requestId: req.requestId,
            limit
        });

        const processed = await processor.processUnprocessedEvents(limit);

        const duration = Date.now() - startTime;
        logger.info('Event processing completed', {
            requestId: req.requestId,
            processed,
            duration_ms: duration
        });

        res.json({
            processed_count: processed,
            message: `Processed ${processed} events`,
            duration_ms: duration
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'process-events',
            requestId: req.requestId
        });
        res.status(500).json({ error: 'Failed to process events' });
    }
});

// Error handler
app.use((error, req, res, next) => {
    logger.logError(error, {
        requestId: req.requestId,
        path: req.path,
        method: req.method
    });

    res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        requestId: req.requestId
    });
});

// 404 handler
app.use((req, res) => {
    logger.warn('Route not found', {
        requestId: req.requestId,
        path: req.path,
        method: req.method
    });

    res.status(404).json({
        error: 'Not found',
        path: req.path,
        requestId: req.requestId
    });
});

// Start server
const server = app.listen(PORT, async () => {
    logger.info('🚀 Application Service starting', {
        port: PORT,
        version: '0.2.0',
        nodeEnv: process.env.NODE_ENV || 'development'
    });

    // Verify critical dependencies on startup
    try {
        await query('SELECT 1');
        logger.info('✅ Database connection verified');
    } catch (error) {
        logger.error('❌ Database connection failed on startup', { error: error.message });
        process.exit(1);
    }

    // Auto-apply database migrations (idempotent)
    try {
        const migrationResult = await runMigrations();
        if (migrationResult.errors.length > 0) {
            logger.warn('Some migrations had errors', { errors: migrationResult.errors });
        }
        logger.info('✅ Database migrations applied');
    } catch (error) {
        logger.error('❌ Migration runner failed', { error: error.message });
        // Non-fatal: tables may already exist from a previous run
    }

    if (!OPENAI_API_KEY) {
        logger.error('❌ OPENAI_API_KEY not configured');
        process.exit(1);
    }
    logger.info('✅ OpenAI API key configured');

    // Initialize Redis for behavior system (non-blocking)
    try {
        const redisClient = await getRedisClient();
        if (redisClient) {
            chatHandler.setRedisClient(redisClient);
            const { setRedisClient: setPrefsRedis } = require('./shared/routes/preferences');
            setPrefsRedis(redisClient);
            const { suggestionGate } = require('./shared/services/suggestionGate');
            suggestionGate.setRedisClient(redisClient);
            logger.info('✅ Redis connected for behavior system');
        } else {
            logger.warn('Redis not available, behavior system running without cache');
        }
    } catch (error) {
        logger.warn('Redis init failed, continuing without cache', { error: error.message });
    }

    // Seed admin email and start auth cleanup
    try {
        await authService.seedAdminEmail();
        authService.startCleanup();
        logger.info('✅ Auth system initialized');
    } catch (error) {
        logger.warn('Auth init failed, continuing', { error: error.message });
    }

    // Start Observer schedule (federated learning every 6 hours)
    try {
        const observerService = require('./shared/services/observerService');
        observerService.startSchedule(6);
        logger.info('✅ Observer schedule started (every 6 hours)');
    } catch (error) {
        logger.warn('Observer schedule init failed', { error: error.message });
    }

    logger.info('📊 API Endpoints ready', {
        health: `http://localhost:${PORT}/health`,
        expenses: `http://localhost:${PORT}/v0/expenses`,
        query: `http://localhost:${PORT}/v0/query`,
        categorization: `http://localhost:${PORT}/v0/categorization`,
        evaluation: `http://localhost:${PORT}/v0/evaluation`
    });

    // Initialize OpenTelemetry metrics
    try {
        initTelemetry();
        await seedHistoricalMetrics(query);
        logger.info('✅ OpenTelemetry metrics initialized');
    } catch (error) {
        logger.warn('OpenTelemetry init failed, continuing without metrics', { error: error.message });
    }

    logger.info('✅ Ready to accept connections');

    // Start background event processor
    startEventProcessor();
});

// Background event processor
function startEventProcessor() {
    const processor = new AppEventProcessor();
    const INTERVAL_MS = 60000; // Process every minute

    logger.info('Starting background event processor', {
        interval_ms: INTERVAL_MS,
        interval_description: '1 minute'
    });

    setInterval(async () => {
        try {
            const processed = await processor.processUnprocessedEvents(100);
            if (processed > 0) {
                logger.info('Background event processing completed', {
                    processed,
                    job: 'background-event-processor'
                });
            }
        } catch (error) {
            logger.logError(error, {
                job: 'background-event-processor'
            });
        }
    }, INTERVAL_MS);
}

// Graceful shutdown with timeout
function gracefulShutdown(signal) {
    logger.warn(`${signal} received, initiating graceful shutdown`, {
        signal,
        uptime_seconds: process.uptime()
    });

    const SHUTDOWN_TIMEOUT_MS = 30000; // 30 seconds

    // Force shutdown after timeout
    const forceShutdownTimer = setTimeout(() => {
        logger.error('Graceful shutdown timeout exceeded, forcing exit', {
            timeout_ms: SHUTDOWN_TIMEOUT_MS
        });
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    // Stop accepting new connections
    server.close(async () => {
        logger.info('HTTP server closed, closing database connections');

        try {
            await close();
            logger.info('✅ Database connections closed');
            clearTimeout(forceShutdownTimer);
            logger.info('✅ Graceful shutdown complete');
            process.exit(0);
        } catch (error) {
            logger.error('Error during graceful shutdown', {
                error: error.message,
                stack: error.stack
            });
            clearTimeout(forceShutdownTimer);
            process.exit(1);
        }
    });

    // If server.close() takes too long, connections are still active
    setTimeout(() => {
        logger.warn('Still waiting for connections to close...', {
            elapsed_ms: 5000
        });
    }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception, shutting down', {
        error: error.message,
        stack: error.stack
    });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', {
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
    });
    // Don't exit on unhandled rejection, just log it
});

module.exports = app;
