/**
 * Circuit Breaker
 * Prevents cascading failures by stopping requests to failing services
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
            this._onFailure();
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

    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.nextAttempt = Date.now();
        logger.info(`Circuit breaker ${this.name} manually reset to CLOSED`);
    }
}

module.exports = CircuitBreaker;
