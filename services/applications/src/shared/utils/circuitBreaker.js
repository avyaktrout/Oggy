/**
 * Circuit Breaker
 * Prevents cascading failures by stopping requests to failing services
 *
 * Features:
 * - Auto-registers with CircuitBreakerRegistry for central management
 * - Three states: CLOSED (normal), OPEN (failing), HALF_OPEN (testing)
 * - Configurable failure threshold and timeout
 */

const logger = require('./logger');

class CircuitBreaker {
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000; // 1 minute
        this.name = options.name || 'circuit';

        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();

        // Custom function to determine if an error should count as a circuit breaker failure
        // By default, 4xx errors are NOT counted as failures (they're client errors, not service failures)
        this.isFailure = options.isFailure || CircuitBreaker.defaultIsFailure;

        // Auto-register with registry (unless explicitly skipped to avoid circular dependency)
        if (!options._skipRegistry) {
            const registry = require('./circuitBreakerRegistry');
            registry.register(this.name, this);
        }
    }

    /**
     * Default failure detection: 4xx errors are NOT service failures
     * Only 5xx errors and network errors count as failures
     */
    static defaultIsFailure(error) {
        // JSON parse errors are NOT service failures (bad model output, service is fine)
        if (error.jsonParseError || error.retryable) {
            return false;
        }

        // Network errors are failures
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
            return true;
        }

        // If it's an HTTP response error, check status code
        if (error.response && error.response.status) {
            // 4xx errors are client errors, NOT service failures - don't count
            if (error.response.status >= 400 && error.response.status < 500) {
                return false;
            }
            // 5xx errors are service failures - count them
            if (error.response.status >= 500) {
                return true;
            }
        }

        // Other errors (no response, unknown) count as failures
        return true;
    }

    async execute(fn) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                const error = new Error(`Circuit breaker ${this.name} is OPEN`);
                error.circuitBreakerOpen = true;
                throw error;
            }

            // Try to transition to HALF_OPEN
            this.state = 'HALF_OPEN';
            logger.info(`Circuit breaker ${this.name} transitioning to HALF_OPEN`);
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (error) {
            // Only count as failure if isFailure returns true
            // 4xx errors are client errors and don't indicate service problems
            if (this.isFailure(error)) {
                this._onFailure();
            } else {
                logger.debug(`Circuit breaker ${this.name} ignoring non-failure error (4xx client error)`, {
                    status: error.response?.status,
                    message: error.message
                });
            }
            throw error;
        }
    }

    _onSuccess() {
        this.failureCount = 0;

        if (this.state === 'HALF_OPEN') {
            this.successCount++;

            if (this.successCount >= this.successThreshold) {
                this.state = 'CLOSED';
                this.successCount = 0;
                logger.info(`Circuit breaker ${this.name} CLOSED after successful requests`);
            }
        }
    }

    _onFailure() {
        this.failureCount++;
        this.successCount = 0;

        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;

            logger.error(`Circuit breaker ${this.name} OPEN after ${this.failureCount} failures`, {
                nextAttemptIn: `${this.timeout}ms`
            });
        }
    }

    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            nextAttempt: this.nextAttempt
        };
    }

    /**
     * Get full state including configuration
     * @returns {object} Complete state and config
     */
    getFullState() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            nextAttempt: this.nextAttempt,
            nextAttemptIn: this.state === 'OPEN'
                ? Math.max(0, this.nextAttempt - Date.now())
                : null,
            config: {
                failureThreshold: this.failureThreshold,
                successThreshold: this.successThreshold,
                timeout: this.timeout
            }
        };
    }

    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
        logger.info(`Circuit breaker ${this.name} manually reset to CLOSED`);
    }

    /**
     * Force close without logging (for session cleanup)
     */
    forceClose() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
    }
}

module.exports = CircuitBreaker;
