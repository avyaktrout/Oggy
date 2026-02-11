/**
 * Service Health Manager
 * Centralized health checking and circuit breaker management
 *
 * Features:
 * - Health checks for memory service, OpenAI, Claude
 * - Reset circuit breakers when services recover
 * - Pre-operation health validation (e.g., before benchmarks)
 * - Session lifecycle hooks
 */

const axios = require('axios');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const logger = require('../utils/logger');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

class ServiceHealthManager {
    constructor() {
        this.healthStatus = {
            memory: { healthy: false, lastCheck: null, error: null },
            openai: { healthy: false, lastCheck: null, error: null },
            claude: { healthy: false, lastCheck: null, error: null }
        };

        // Cache health check results for 30 seconds
        this.healthCacheTTL = 30000;
    }

    /**
     * Check health of all services
     * @returns {object} Health status of all services
     */
    async checkAllServices() {
        const [memory, openai, claude] = await Promise.all([
            this.checkMemoryService(),
            this.checkOpenAI(),
            this.checkClaude()
        ]);

        return {
            memory,
            openai,
            claude,
            allHealthy: memory.healthy && openai.healthy && claude.healthy,
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Check memory service health
     * @returns {object} Health status
     */
    async checkMemoryService() {
        const now = Date.now();

        // Return cached result if still valid
        if (this.healthStatus.memory.lastCheck &&
            (now - this.healthStatus.memory.lastCheck) < this.healthCacheTTL) {
            return this.healthStatus.memory;
        }

        try {
            const response = await axios.get(`${MEMORY_SERVICE_URL}/health`, {
                timeout: 3000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });

            this.healthStatus.memory = {
                healthy: response.data.ok === true,
                lastCheck: now,
                error: null,
                responseTime: response.headers['x-response-time'] || null
            };
        } catch (error) {
            this.healthStatus.memory = {
                healthy: false,
                lastCheck: now,
                error: error.message
            };
        }

        return this.healthStatus.memory;
    }

    /**
     * Check OpenAI API health (lightweight check)
     * @returns {object} Health status
     */
    async checkOpenAI() {
        const now = Date.now();

        // Return cached result if still valid
        if (this.healthStatus.openai.lastCheck &&
            (now - this.healthStatus.openai.lastCheck) < this.healthCacheTTL) {
            return this.healthStatus.openai;
        }

        // Check if API key is configured
        if (!OPENAI_API_KEY) {
            this.healthStatus.openai = {
                healthy: false,
                lastCheck: now,
                error: 'OPENAI_API_KEY not configured'
            };
            return this.healthStatus.openai;
        }

        try {
            // Lightweight models list call to verify API key works
            const response = await axios.get('https://api.openai.com/v1/models', {
                timeout: 5000,
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`
                }
            });

            this.healthStatus.openai = {
                healthy: response.status === 200,
                lastCheck: now,
                error: null
            };
        } catch (error) {
            this.healthStatus.openai = {
                healthy: false,
                lastCheck: now,
                error: error.response?.status === 401
                    ? 'Invalid API key'
                    : error.message
            };
        }

        return this.healthStatus.openai;
    }

    /**
     * Check Claude/Anthropic API health
     * @returns {object} Health status
     */
    async checkClaude() {
        const now = Date.now();

        // Return cached result if still valid
        if (this.healthStatus.claude.lastCheck &&
            (now - this.healthStatus.claude.lastCheck) < this.healthCacheTTL) {
            return this.healthStatus.claude;
        }

        // Check if API key is configured
        if (!ANTHROPIC_API_KEY) {
            this.healthStatus.claude = {
                healthy: false,
                lastCheck: now,
                error: 'ANTHROPIC_API_KEY not configured'
            };
            return this.healthStatus.claude;
        }

        try {
            // Minimal API call to verify key works
            // Using a cheap count_tokens-like approach
            const response = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                    model: 'claude-3-haiku-20240307',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'ping' }]
                },
                {
                    timeout: 5000,
                    headers: {
                        'x-api-key': ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01',
                        'content-type': 'application/json'
                    }
                }
            );

            this.healthStatus.claude = {
                healthy: response.status === 200,
                lastCheck: now,
                error: null
            };
        } catch (error) {
            this.healthStatus.claude = {
                healthy: false,
                lastCheck: now,
                error: error.response?.status === 401
                    ? 'Invalid API key'
                    : error.message
            };
        }

        return this.healthStatus.claude;
    }

    /**
     * Reset circuit breakers for services that are now healthy
     * @returns {object} Results of reset operations
     */
    async resetHealthyCircuitBreakers() {
        const health = await this.checkAllServices();
        const results = {
            checked: [],
            reset: [],
            stillUnhealthy: []
        };

        // Memory service circuit breakers
        if (health.memory.healthy) {
            const memoryBreakers = ['memory-service', 'memory-service-events'];
            for (const name of memoryBreakers) {
                if (circuitBreakerRegistry.has(name)) {
                    const breaker = circuitBreakerRegistry.get(name);
                    if (breaker.state === 'OPEN') {
                        circuitBreakerRegistry.reset(name);
                        results.reset.push(name);
                    }
                    results.checked.push(name);
                }
            }
        } else {
            results.stillUnhealthy.push('memory');
        }

        // OpenAI circuit breakers
        if (health.openai.healthy) {
            const openaiBreakers = ['openai-api', 'tessa-openai', 'sealed-benchmark-openai'];
            for (const name of openaiBreakers) {
                if (circuitBreakerRegistry.has(name)) {
                    const breaker = circuitBreakerRegistry.get(name);
                    if (breaker.state === 'OPEN') {
                        circuitBreakerRegistry.reset(name);
                        results.reset.push(name);
                    }
                    results.checked.push(name);
                }
            }
        } else {
            results.stillUnhealthy.push('openai');
        }

        // Claude circuit breakers
        if (health.claude.healthy) {
            const claudeBreakers = ['sealed-benchmark-claude'];
            for (const name of claudeBreakers) {
                if (circuitBreakerRegistry.has(name)) {
                    const breaker = circuitBreakerRegistry.get(name);
                    if (breaker.state === 'OPEN') {
                        circuitBreakerRegistry.reset(name);
                        results.reset.push(name);
                    }
                    results.checked.push(name);
                }
            }
        } else {
            results.stillUnhealthy.push('claude');
        }

        if (results.reset.length > 0) {
            logger.info('Reset healthy circuit breakers', results);
        }

        return results;
    }

    /**
     * Ensure system is ready for benchmark generation
     * @returns {object} Readiness status
     */
    async ensureReadyForBenchmark() {
        const health = await this.checkAllServices();

        // Force reset circuit breakers for healthy services
        const resetResults = await this.resetHealthyCircuitBreakers();

        // Get current circuit breaker status
        const breakerStatus = circuitBreakerRegistry.getStatus();
        const openBreakers = circuitBreakerRegistry.getOpenBreakers();

        const ready = {
            memoryService: health.memory.healthy,
            openai: health.openai.healthy,
            claude: health.claude.healthy,
            allHealthy: health.allHealthy,
            circuitBreakersReset: resetResults.reset,
            openCircuitBreakers: openBreakers,
            recommendation: this._getBenchmarkRecommendation(health, openBreakers)
        };

        logger.info('Benchmark readiness check', ready);

        return ready;
    }

    /**
     * Get recommendation for benchmark execution
     * @private
     */
    _getBenchmarkRecommendation(health, openBreakers) {
        if (health.allHealthy && openBreakers.length === 0) {
            return 'GO - All services healthy, all circuit breakers closed';
        }

        if (!health.claude.healthy) {
            return 'CAUTION - Claude unhealthy, OOD benchmark generation may fail';
        }

        if (!health.memory.healthy) {
            return 'CAUTION - Memory service unhealthy, Oggy will run without memory context';
        }

        if (openBreakers.length > 0) {
            return `CAUTION - ${openBreakers.length} circuit breaker(s) still open: ${openBreakers.join(', ')}`;
        }

        return 'GO - Core services healthy';
    }

    /**
     * Session start hook - reset circuit breakers and check health
     * @param {string} userId - User ID starting the session
     * @returns {object} Session readiness status
     */
    async onSessionStart(userId) {
        logger.info('ServiceHealthManager: Session starting', { userId });

        // Force close all circuit breakers for clean session start
        circuitBreakerRegistry.forceCloseAll();

        // Run health checks
        const health = await this.checkAllServices();

        const status = {
            userId,
            healthy: health.allHealthy,
            services: {
                memory: health.memory.healthy,
                openai: health.openai.healthy,
                claude: health.claude.healthy
            },
            circuitBreakers: circuitBreakerRegistry.getStatus(),
            timestamp: new Date().toISOString()
        };

        if (!health.allHealthy) {
            logger.warn('Session starting with degraded services', status);
        } else {
            logger.info('Session starting with all services healthy', { userId });
        }

        return status;
    }

    /**
     * Session stop hook - log final state
     * @param {string} userId - User ID stopping the session
     * @returns {object} Final session state
     */
    async onSessionStop(userId) {
        const breakerStatus = circuitBreakerRegistry.getStatus();

        const status = {
            userId,
            circuitBreakers: breakerStatus,
            openBreakers: circuitBreakerRegistry.getOpenBreakers(),
            timestamp: new Date().toISOString()
        };

        logger.info('ServiceHealthManager: Session stopped', status);

        return status;
    }

    /**
     * Get comprehensive service status
     * @returns {object} Full status including health and circuit breakers
     */
    getServiceStatus() {
        return {
            health: this.healthStatus,
            circuitBreakers: circuitBreakerRegistry.getStatus(),
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Get circuit breaker status only
     * @returns {object} Circuit breaker status
     */
    getCircuitBreakerStatus() {
        return circuitBreakerRegistry.getStatus();
    }

    /**
     * Invalidate health cache (force fresh checks)
     */
    invalidateCache() {
        this.healthStatus.memory.lastCheck = null;
        this.healthStatus.openai.lastCheck = null;
        this.healthStatus.claude.lastCheck = null;
    }
}

// Singleton instance
const serviceHealthManager = new ServiceHealthManager();

module.exports = serviceHealthManager;
