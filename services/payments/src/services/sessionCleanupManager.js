/**
 * Session Cleanup Manager
 * Manages clean state between training sessions
 *
 * Features:
 * - Reset circuit breakers at session boundaries
 * - Clear in-memory stats from learning services
 * - Ensure clean state for benchmark generation
 * - Pre-session health validation
 */

const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const serviceHealthManager = require('./serviceHealthManager');
const logger = require('../utils/logger');

class SessionCleanupManager {
    constructor() {
        this.lastSessionId = null;
        this.sessionHistory = [];
    }

    /**
     * Prepare for a new session - reset everything to clean state
     * @param {string} userId - User ID starting the session
     * @returns {object} Readiness status
     */
    async prepareNewSession(userId) {
        const sessionId = `${userId}_${Date.now()}`;
        logger.info('SessionCleanupManager: Preparing new session', { userId, sessionId });

        // Step 1: Force close all circuit breakers
        circuitBreakerRegistry.forceCloseAll();
        logger.debug('All circuit breakers force closed for new session');

        // Step 2: Clear in-memory stats from learning services
        this.clearInMemoryStats();

        // Step 3: Run health checks
        const health = await serviceHealthManager.checkAllServices();

        // Step 4: If services are healthy, ensure circuit breakers stay closed
        // If unhealthy, log warning but allow session to start (graceful degradation)
        const readiness = {
            sessionId,
            userId,
            healthy: health.allHealthy,
            services: {
                memory: health.memory.healthy,
                openai: health.openai.healthy,
                claude: health.claude.healthy
            },
            errors: [],
            circuitBreakers: circuitBreakerRegistry.getStatus(),
            timestamp: new Date().toISOString()
        };

        // Collect errors for reporting
        if (!health.memory.healthy) {
            readiness.errors.push(`Memory service: ${health.memory.error || 'unhealthy'}`);
        }
        if (!health.openai.healthy) {
            readiness.errors.push(`OpenAI: ${health.openai.error || 'unhealthy'}`);
        }
        if (!health.claude.healthy) {
            readiness.errors.push(`Claude: ${health.claude.error || 'unhealthy'}`);
        }

        this.lastSessionId = sessionId;

        if (!health.allHealthy) {
            logger.warn('Session starting with degraded services', readiness);
        } else {
            logger.info('Session ready with all services healthy', { userId, sessionId });
        }

        return readiness;
    }

    /**
     * Clean up after session ends
     * @param {string} userId - User ID
     * @param {object} sessionStats - Final session statistics
     * @returns {object} Cleanup summary
     */
    async cleanupSession(userId, sessionStats = {}) {
        logger.info('SessionCleanupManager: Cleaning up session', { userId });

        // Get final circuit breaker state before cleanup
        const finalBreakerState = circuitBreakerRegistry.getStatus();

        // Record session in history
        this.sessionHistory.push({
            userId,
            sessionId: this.lastSessionId,
            endedAt: new Date().toISOString(),
            stats: {
                totalQuestions: sessionStats.total_questions || 0,
                correctAnswers: sessionStats.correct_answers || 0,
                benchmarksGenerated: sessionStats.benchmarks_generated || 0,
                benchmarksPassed: sessionStats.benchmarks_passed || 0,
                trainingTimeMs: sessionStats.training_time_ms || 0
            },
            circuitBreakerState: finalBreakerState
        });

        // Keep only last 10 sessions in history
        if (this.sessionHistory.length > 10) {
            this.sessionHistory = this.sessionHistory.slice(-10);
        }

        // Clear in-memory stats
        this.clearInMemoryStats();

        // Force close circuit breakers for clean slate
        circuitBreakerRegistry.forceCloseAll();

        const cleanup = {
            userId,
            sessionId: this.lastSessionId,
            circuitBreakersReset: finalBreakerState.open + finalBreakerState.halfOpen,
            statsCleared: true,
            timestamp: new Date().toISOString()
        };

        logger.info('Session cleanup completed', cleanup);

        return cleanup;
    }

    /**
     * Prepare for benchmark - ensure optimal conditions
     * @returns {object} Benchmark readiness status
     */
    async prepareForBenchmark() {
        logger.info('SessionCleanupManager: Preparing for benchmark');

        // Step 1: Check current circuit breaker status
        const breakerStatus = circuitBreakerRegistry.getStatus();
        const openBreakers = circuitBreakerRegistry.getOpenBreakers();

        // Step 2: If any breakers are open, check if services are now healthy
        if (openBreakers.length > 0) {
            logger.info('Open circuit breakers detected, checking service health', { openBreakers });

            // Invalidate health cache to get fresh checks
            serviceHealthManager.invalidateCache();

            // Reset breakers for healthy services
            await serviceHealthManager.resetHealthyCircuitBreakers();
        }

        // Step 3: Run comprehensive health check
        const health = await serviceHealthManager.checkAllServices();

        // Step 4: Get final circuit breaker status
        const finalBreakerStatus = circuitBreakerRegistry.getStatus();

        const readiness = {
            ready: health.allHealthy || (health.openai.healthy && (health.claude.healthy || health.memory.healthy)),
            services: {
                memory: health.memory.healthy,
                openai: health.openai.healthy,
                claude: health.claude.healthy
            },
            circuitBreakers: {
                total: finalBreakerStatus.total,
                open: finalBreakerStatus.open,
                closed: finalBreakerStatus.closed,
                openNames: circuitBreakerRegistry.getOpenBreakers()
            },
            recommendation: this._getBenchmarkRecommendation(health, finalBreakerStatus),
            timestamp: new Date().toISOString()
        };

        logger.info('Benchmark readiness assessment', readiness);

        return readiness;
    }

    /**
     * Get benchmark recommendation based on health and circuit breaker status
     * @private
     */
    _getBenchmarkRecommendation(health, breakerStatus) {
        if (health.allHealthy && breakerStatus.open === 0) {
            return 'GO - All systems operational';
        }

        const issues = [];

        if (!health.claude.healthy) {
            issues.push('Claude API unavailable - will fall back to OpenAI for benchmark generation');
        }

        if (!health.memory.healthy) {
            issues.push('Memory service unavailable - Oggy will run without learned context');
        }

        if (!health.openai.healthy) {
            issues.push('OpenAI API unavailable - benchmark evaluation will fail');
            return 'NO-GO - OpenAI required for benchmark evaluation';
        }

        if (breakerStatus.open > 0) {
            issues.push(`${breakerStatus.open} circuit breaker(s) still open`);
        }

        if (issues.length === 0) {
            return 'GO - Core services operational';
        }

        return `CAUTION - ${issues.join('; ')}`;
    }

    /**
     * Clear in-memory stats from learning services
     */
    clearInMemoryStats() {
        try {
            // Clear selfDrivenLearning stats if it has a resetStats method
            const selfDrivenLearning = require('./selfDrivenLearning');
            if (typeof selfDrivenLearning.resetStats === 'function') {
                selfDrivenLearning.resetStats();
                logger.debug('SelfDrivenLearning stats cleared');
            }
        } catch (error) {
            // Module might not be loaded yet, that's OK
            logger.debug('Could not clear selfDrivenLearning stats', { error: error.message });
        }

        // Note: ContinuousLearningLoop stats are reset in its start() method
    }

    /**
     * Get session history
     * @returns {array} Recent session history
     */
    getSessionHistory() {
        return this.sessionHistory;
    }

    /**
     * Get current session ID
     * @returns {string|null}
     */
    getCurrentSessionId() {
        return this.lastSessionId;
    }

    /**
     * Force reset everything - emergency cleanup
     * @returns {object} Reset results
     */
    async forceReset() {
        logger.warn('SessionCleanupManager: Force reset initiated');

        // Force close all circuit breakers
        circuitBreakerRegistry.forceCloseAll();

        // Clear in-memory stats
        this.clearInMemoryStats();

        // Invalidate health cache
        serviceHealthManager.invalidateCache();

        // Run fresh health checks
        const health = await serviceHealthManager.checkAllServices();

        const result = {
            circuitBreakersReset: true,
            statsCleared: true,
            healthCacheInvalidated: true,
            currentHealth: {
                memory: health.memory.healthy,
                openai: health.openai.healthy,
                claude: health.claude.healthy
            },
            timestamp: new Date().toISOString()
        };

        logger.info('Force reset completed', result);

        return result;
    }
}

// Singleton instance
const sessionCleanupManager = new SessionCleanupManager();

module.exports = sessionCleanupManager;
