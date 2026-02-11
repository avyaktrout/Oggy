/**
 * Service Health Routes
 * API endpoints for health checking and circuit breaker management
 */

const express = require('express');
const router = express.Router();
const serviceHealthManager = require('../services/serviceHealthManager');
const sessionCleanupManager = require('../services/sessionCleanupManager');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const { dataPruningManager } = require('../services/memoryPruner');
const logger = require('../utils/logger');

/**
 * GET /v0/service-health/status
 * Get comprehensive status of all services and circuit breakers
 */
router.get('/status', async (req, res) => {
    try {
        const health = await serviceHealthManager.checkAllServices();
        const breakerStatus = circuitBreakerRegistry.getStatus();

        res.json({
            services: {
                memory: health.memory,
                openai: health.openai,
                claude: health.claude
            },
            allHealthy: health.allHealthy,
            circuitBreakers: breakerStatus,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get service health status', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/check
 * Force fresh health checks on all services (invalidates cache)
 */
router.post('/check', async (req, res) => {
    try {
        // Invalidate cache to force fresh checks
        serviceHealthManager.invalidateCache();

        const health = await serviceHealthManager.checkAllServices();

        res.json({
            services: {
                memory: health.memory,
                openai: health.openai,
                claude: health.claude
            },
            allHealthy: health.allHealthy,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to run health checks', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v0/service-health/circuit-breakers
 * Get status of all circuit breakers
 */
router.get('/circuit-breakers', (req, res) => {
    try {
        const status = circuitBreakerRegistry.getStatus();
        res.json(status);
    } catch (error) {
        logger.error('Failed to get circuit breaker status', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/circuit-breakers/reset
 * Reset all circuit breakers to CLOSED state
 */
router.post('/circuit-breakers/reset', async (req, res) => {
    try {
        const { force = false } = req.body || {};

        let results;
        if (force) {
            // Force close all without logging
            circuitBreakerRegistry.forceCloseAll();
            results = {
                action: 'forceCloseAll',
                total: circuitBreakerRegistry.getStatus().total,
                reset: circuitBreakerRegistry.getStatus().total,
                errors: []
            };
        } else {
            // Standard reset with logging
            results = circuitBreakerRegistry.resetAll();
        }

        logger.info('Circuit breakers reset via API', results);

        res.json({
            success: true,
            results,
            currentStatus: circuitBreakerRegistry.getStatus(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to reset circuit breakers', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/circuit-breakers/reset/:name
 * Reset a specific circuit breaker by name
 */
router.post('/circuit-breakers/reset/:name', (req, res) => {
    try {
        const { name } = req.params;

        if (!circuitBreakerRegistry.has(name)) {
            return res.status(404).json({
                error: `Circuit breaker '${name}' not found`,
                available: circuitBreakerRegistry.getNames()
            });
        }

        const success = circuitBreakerRegistry.reset(name);

        res.json({
            success,
            name,
            currentState: circuitBreakerRegistry.get(name)?.getFullState(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to reset circuit breaker', { name: req.params.name, error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/reset-healthy
 * Reset circuit breakers only for services that are now healthy
 */
router.post('/reset-healthy', async (req, res) => {
    try {
        const results = await serviceHealthManager.resetHealthyCircuitBreakers();

        res.json({
            success: true,
            results,
            currentStatus: circuitBreakerRegistry.getStatus(),
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to reset healthy circuit breakers', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/prepare-benchmark
 * Prepare system for benchmark (health checks + reset healthy breakers)
 */
router.post('/prepare-benchmark', async (req, res) => {
    try {
        const readiness = await sessionCleanupManager.prepareForBenchmark();

        res.json(readiness);
    } catch (error) {
        logger.error('Failed to prepare for benchmark', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/force-reset
 * Emergency reset - force close all breakers and clear caches
 */
router.post('/force-reset', async (req, res) => {
    try {
        const results = await sessionCleanupManager.forceReset();

        res.json({
            success: true,
            results,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to force reset', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v0/service-health/session-history
 * Get recent session history
 */
router.get('/session-history', (req, res) => {
    try {
        const history = sessionCleanupManager.getSessionHistory();
        res.json({
            sessions: history,
            count: history.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Failed to get session history', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v0/service-health/data-stats
 * Get database table row counts
 */
router.get('/data-stats', async (req, res) => {
    try {
        const stats = await dataPruningManager.getDatabaseStats();
        res.json(stats);
    } catch (error) {
        logger.error('Failed to get data stats', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /v0/service-health/data-prune
 * Prune old data from database tables
 */
router.post('/data-prune', async (req, res) => {
    try {
        const { dry_run = true, tables } = req.body || {};

        let results;
        if (tables && Array.isArray(tables)) {
            // Prune specific tables
            results = { dryRun: dry_run, tables: {}, timestamp: new Date().toISOString() };
            for (const table of tables) {
                switch (table) {
                    case 'retrieval_traces':
                        results.tables[table] = await dataPruningManager.pruneRetrievalTraces(dry_run);
                        break;
                    case 'app_events':
                        results.tables[table] = await dataPruningManager.pruneAppEvents(dry_run);
                        break;
                    case 'sealed_benchmark_results':
                        results.tables[table] = await dataPruningManager.pruneBenchmarkResults(dry_run);
                        break;
                    case 'memory_audit_events':
                        results.tables[table] = await dataPruningManager.pruneMemoryAuditEvents(dry_run);
                        break;
                    default:
                        results.tables[table] = { error: 'Unknown table' };
                }
            }
        } else {
            // Prune all tables
            results = await dataPruningManager.pruneAll({ dryRun: dry_run });
        }

        res.json(results);
    } catch (error) {
        logger.error('Failed to prune data', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /v0/service-health/prune-config
 * Get current prune configuration
 */
router.get('/prune-config', (req, res) => {
    try {
        const config = dataPruningManager.getConfig();
        res.json(config);
    } catch (error) {
        logger.error('Failed to get prune config', { error: error.message });
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
