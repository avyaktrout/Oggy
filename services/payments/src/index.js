/**
 * Payments Service - Main Entry Point
 * Stage 0, Week 7: Hardened with Resilience & Observability
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./utils/db');
const AppEventProcessor = require('./services/eventProcessor');
const logger = require('./utils/logger');
const { costGovernor } = require('./middleware/costGovernor');

// Import routes
const expensesRouter = require('./routes/expenses');
const queryRouter = require('./routes/query');
const categorizationRouter = require('./routes/categorization');
const evaluationRouter = require('./routes/evaluation');
const learningRouter = require('./routes/learning');
const tessaRouter = require('./routes/tessa');

const auditChecker = require('./utils/auditChecker');

const app = express();
const PORT = process.env.PORT || 3001;
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());

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
        service: 'payments-service',
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
    logger.info('🚀 Payments Service starting', {
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

    if (!OPENAI_API_KEY) {
        logger.error('❌ OPENAI_API_KEY not configured');
        process.exit(1);
    }
    logger.info('✅ OpenAI API key configured');

    logger.info('📊 API Endpoints ready', {
        health: `http://localhost:${PORT}/health`,
        expenses: `http://localhost:${PORT}/v0/expenses`,
        query: `http://localhost:${PORT}/v0/query`,
        categorization: `http://localhost:${PORT}/v0/categorization`,
        evaluation: `http://localhost:${PORT}/v0/evaluation`
    });

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
