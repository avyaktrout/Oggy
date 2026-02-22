/**
 * API Gateway - Slim entry point for the Oggy microservices architecture
 *
 * Responsibilities:
 * - Auth (session cookies, CSRF, magic link)
 * - Static file serving (HTML/CSS/JS)
 * - CORS
 * - Shared domain-agnostic routes (preferences, settings, analytics, etc.)
 * - Proxies domain-specific requests to downstream services
 *
 * Does NOT contain any business logic for payments, general, or diet domains.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./shared/utils/db');
const logger = require('./shared/utils/logger');
const { runMigrations } = require('./shared/utils/migrationRunner');
const { initTelemetry, seedHistoricalMetrics } = require('./shared/utils/telemetry');
const auditChecker = require('./shared/utils/auditChecker');
const { getClient: getRedisClient } = require('./shared/utils/redisClient');

// Auth
const authRouter = require('./shared/routes/auth');
const authService = require('./shared/services/authService');
const { requireAuth, requireCSRF, injectUserId } = require('./shared/middleware/auth');

// Shared domain-agnostic routes
const preferencesRouter = require('./shared/routes/preferences');
const settingsRouter = require('./shared/routes/settings');
const serviceHealthRouter = require('./shared/routes/serviceHealth');
const benchmarkAnalyticsRouter = require('./shared/routes/benchmarkAnalytics');
const memoryPruningRouter = require('./shared/routes/memoryPruning');
const { migrationExportRouter, migrationImportRouter } = require('./shared/routes/migration');
const receiptAnalysisRouter = require('./shared/routes/receiptAnalysis');

const app = express();
const PORT = process.env.PORT || 3001;

// Downstream service URLs
const PAYMENTS_SERVICE_URL = process.env.PAYMENTS_SERVICE_URL || 'http://payments-service:3010';
const GENERAL_SERVICE_URL = process.env.GENERAL_SERVICE_URL || 'http://general-service:3011';
const DIET_SERVICE_URL = process.env.DIET_SERVICE_URL || 'http://diet-service:3012';
const HARMONY_SERVICE_URL = process.env.HARMONY_SERVICE_URL || 'http://harmony-service:3013';
const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

// Domain routing map for continuous-learning
const DOMAIN_SERVICE_MAP = {
    payments: PAYMENTS_SERVICE_URL,
    general: GENERAL_SERVICE_URL,
    diet: DIET_SERVICE_URL,
    harmony: HARMONY_SERVICE_URL,
};

// ──────────────────────────────────────────────────
// Proxy helper (uses existing axios — no new deps)
// ──────────────────────────────────────────────────
async function proxyRequest(req, res, targetBaseUrl) {
    try {
        const resp = await axios({
            method: req.method,
            url: `${targetBaseUrl}${req.originalUrl}`,
            data: req.body,
            headers: {
                'content-type': req.headers['content-type'] || 'application/json',
                'x-user-id': req.userId || '',
                'x-request-id': req.requestId,
            },
            timeout: 120000,
            validateStatus: () => true, // forward all status codes as-is
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });
        res.status(resp.status).json(resp.data);
    } catch (err) {
        logger.error('Proxy request failed', {
            target: targetBaseUrl,
            path: req.originalUrl,
            error: err.message,
        });
        res.status(502).json({ error: 'Service unavailable' });
    }
}

// ──────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────

// Redirect HTTP → HTTPS in production (before CORS so origin matches)
if (process.env.NODE_ENV === 'production') {
    app.use((req, res, next) => {
        const proto = req.headers['x-forwarded-proto'];
        if (proto === 'http') {
            return res.redirect(301, `https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({
    origin: function(origin, callback) {
        if (!origin) return callback(null, true);
        if (CORS_ORIGIN === '*') return callback(null, true);
        const allowed = CORS_ORIGIN.split(',').map(s => s.trim());
        if (allowed.includes(origin)) return callback(null, true);
        callback(new Error('CORS not allowed'));
    },
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.disable('etag'); // Prevent stale 304 responses for API calls

// Request ID
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
        });
    });
    next();
});

// ──────────────────────────────────────────────────
// Health check (aggregated)
// ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    const checks = { database: false, memoryService: false, payments: false, general: false, diet: false, harmony: false };
    let overallOk = true;

    // Database
    try {
        await query('SELECT 1');
        checks.database = true;
    } catch (err) {
        checks.database = false;
        overallOk = false;
    }

    // Memory service
    try {
        const r = await axios.get(`${MEMORY_SERVICE_URL}/health`, {
            timeout: 3000,
            headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
        });
        checks.memoryService = r.data.ok === true;
    } catch (_) {
        checks.memoryService = false;
    }

    // Domain services
    const domainChecks = [
        { name: 'payments', url: PAYMENTS_SERVICE_URL },
        { name: 'general', url: GENERAL_SERVICE_URL },
        { name: 'diet', url: DIET_SERVICE_URL },
        { name: 'harmony', url: HARMONY_SERVICE_URL },
    ];
    await Promise.all(domainChecks.map(async ({ name, url }) => {
        try {
            const r = await axios.get(`${url}/health`, { timeout: 3000 });
            checks[name] = r.data?.ok === true;
        } catch (_) {
            checks[name] = false;
            // Don't fail overall health for domain services (may be starting up)
        }
    }));

    const statusCode = overallOk ? 200 : 503;
    res.status(statusCode).json({
        ok: overallOk,
        service: 'gateway',
        version: '0.3.0',
        timestamp: new Date().toISOString(),
        checks,
    });
});

// ──────────────────────────────────────────────────
// Audit endpoints
// ──────────────────────────────────────────────────
app.get('/v0/audit/full', async (req, res) => {
    try {
        const report = await auditChecker.runFullAudit();
        res.status(report.overall_status === 'FAIL' ? 500 : 200).json(report);
    } catch (error) {
        logger.logError(error, { operation: 'audit-full', requestId: req.requestId });
        res.status(500).json({ error: 'Audit check failed', message: error.message });
    }
});

app.get('/v0/audit/quick', async (req, res) => {
    try {
        const report = await auditChecker.runQuickCheck();
        res.status(report.overall_status === 'FAIL' ? 500 : 200).json(report);
    } catch (error) {
        logger.logError(error, { operation: 'audit-quick', requestId: req.requestId });
        res.status(500).json({ error: 'Quick audit check failed', message: error.message });
    }
});

// ──────────────────────────────────────────────────
// Pre-auth routes
// ──────────────────────────────────────────────────
app.use('/v0/auth', authRouter);

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
app.use('/v0/migration', migrationExportRouter);

// Receive-sync endpoint (before auth — uses X-Sync-Key header for auth)
app.post('/v0/benchmark-analytics/receive-sync', benchmarkAnalyticsRouter.receiveSyncHandler);

// ──────────────────────────────────────────────────
// Auth middleware — everything below requires auth
// ──────────────────────────────────────────────────
app.use(requireAuth);
app.use(requireCSRF);
app.use(injectUserId);

// Serve authenticated static files
app.use(express.static(publicDir, noCacheStatic));

// ──────────────────────────────────────────────────
// Shared routes (domain-agnostic, served by gateway)
// ──────────────────────────────────────────────────
app.use('/v0/preferences', preferencesRouter);
app.use('/v0/settings', settingsRouter);
app.use('/v0/service-health', serviceHealthRouter);
app.use('/v0/benchmark-analytics', benchmarkAnalyticsRouter);
app.use('/v0/memory-pruning', memoryPruningRouter);
app.use('/v0/receipt', receiptAnalysisRouter);
app.use('/v0/migration', migrationImportRouter);

// ──────────────────────────────────────────────────
// Proxy: Payments domain
// ──────────────────────────────────────────────────
const PAYMENTS_ROUTES = [
    '/v0/expenses', '/v0/query', '/v0/categorization', '/v0/chat',
    '/v0/evaluation', '/v0/learning', '/v0/tessa', '/v0/sealed-benchmark',
    '/v0/training', '/v0/benchmark-learning', '/v0/inquiries', '/v0/observer',
];
PAYMENTS_ROUTES.forEach(prefix => {
    app.use(prefix, (req, res) => proxyRequest(req, res, PAYMENTS_SERVICE_URL));
});
app.post('/v0/process-events', (req, res) => proxyRequest(req, res, PAYMENTS_SERVICE_URL));

// ──────────────────────────────────────────────────
// Proxy: General domain
// ──────────────────────────────────────────────────
app.use('/v0/general', (req, res) => proxyRequest(req, res, GENERAL_SERVICE_URL));

// ──────────────────────────────────────────────────
// Proxy: Diet domain
// ──────────────────────────────────────────────────
app.use('/v0/diet', (req, res) => proxyRequest(req, res, DIET_SERVICE_URL));

// ──────────────────────────────────────────────────
// Proxy: Harmony domain
// ──────────────────────────────────────────────────
app.use('/v0/harmony', (req, res) => proxyRequest(req, res, HARMONY_SERVICE_URL));

// ──────────────────────────────────────────────────
// Proxy: Continuous learning (route by domain param)
// ──────────────────────────────────────────────────
app.use('/v0/continuous-learning', (req, res) => {
    const domain = req.body?.domain || req.query?.domain || 'payments';
    const target = DOMAIN_SERVICE_MAP[domain] || PAYMENTS_SERVICE_URL;
    proxyRequest(req, res, target);
});

// ──────────────────────────────────────────────────
// Error + 404 handlers
// ──────────────────────────────────────────────────
app.use((error, req, res, _next) => {
    logger.logError(error, { requestId: req.requestId, path: req.path });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, requestId: req.requestId });
});

// ──────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
    logger.info('Gateway starting', { port: PORT, version: '0.3.0' });

    // Database check
    try {
        await query('SELECT 1');
        logger.info('Database connection verified');
    } catch (error) {
        logger.error('Database connection failed on startup', { error: error.message });
        process.exit(1);
    }

    // Migrations (only gateway runs these)
    try {
        const result = await runMigrations();
        if (result.errors.length > 0) {
            logger.warn('Some migrations had errors', { errors: result.errors });
        }
        logger.info('Database migrations applied');
    } catch (error) {
        logger.error('Migration runner failed', { error: error.message });
    }

    // Redis for shared routes (preferences, etc.)
    try {
        const redisClient = await getRedisClient();
        if (redisClient) {
            const { setRedisClient: setPrefsRedis } = require('./shared/routes/preferences');
            setPrefsRedis(redisClient);
            logger.info('Redis connected for gateway');
        }
    } catch (error) {
        logger.warn('Redis init failed, continuing without cache', { error: error.message });
    }

    // Auth system
    try {
        await authService.seedAdminEmail();
        authService.startCleanup();
        logger.info('Auth system initialized');
    } catch (error) {
        logger.warn('Auth init failed, continuing', { error: error.message });
    }

    // Telemetry
    try {
        initTelemetry();
        await seedHistoricalMetrics(query);
        logger.info('Telemetry initialized');
    } catch (error) {
        logger.warn('Telemetry init failed, continuing', { error: error.message });
    }

    logger.info('Gateway ready', {
        health: `http://localhost:${PORT}/health`,
        payments: PAYMENTS_SERVICE_URL,
        general: GENERAL_SERVICE_URL,
        diet: DIET_SERVICE_URL,
        harmony: HARMONY_SERVICE_URL,
    });
});

// ──────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────
function gracefulShutdown(signal) {
    logger.warn(`${signal} received, shutting down gateway`);
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
    logger.error('Uncaught exception in gateway', { error: error.message, stack: error.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection in gateway', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
});

module.exports = app;
