/**
 * Circuit Breaker Registry
 * Central registry for all circuit breakers - provides global management and observability
 *
 * Features:
 * - Singleton pattern for global access
 * - Register/retrieve circuit breakers by name
 * - Bulk operations (resetAll, getStatus)
 * - Prevents duplicate circuit breakers with same name
 */

const logger = require('./logger');

class CircuitBreakerRegistry {
    constructor() {
        this.breakers = new Map();
    }

    /**
     * Register a circuit breaker
     * @param {string} name - Unique name for the circuit breaker
     * @param {CircuitBreaker} breaker - The circuit breaker instance
     */
    register(name, breaker) {
        if (this.breakers.has(name)) {
            logger.debug(`Circuit breaker '${name}' already registered, returning existing instance`);
            return this.breakers.get(name);
        }

        this.breakers.set(name, breaker);
        logger.info(`Circuit breaker '${name}' registered`, {
            failureThreshold: breaker.failureThreshold,
            timeout: breaker.timeout
        });

        return breaker;
    }

    /**
     * Get or create a circuit breaker
     * If one exists with the same name, returns the existing instance
     * @param {string} name - Circuit breaker name
     * @param {object} options - Options for new circuit breaker
     * @returns {CircuitBreaker} The circuit breaker instance
     */
    getOrCreate(name, options = {}) {
        if (this.breakers.has(name)) {
            return this.breakers.get(name);
        }

        // Lazy require to avoid circular dependency
        const CircuitBreaker = require('./circuitBreaker');
        const breaker = new CircuitBreaker({ ...options, name, _skipRegistry: true });
        this.breakers.set(name, breaker);

        logger.info(`Circuit breaker '${name}' created via registry`, {
            failureThreshold: breaker.failureThreshold,
            timeout: breaker.timeout
        });

        return breaker;
    }

    /**
     * Get a circuit breaker by name
     * @param {string} name - Circuit breaker name
     * @returns {CircuitBreaker|undefined}
     */
    get(name) {
        return this.breakers.get(name);
    }

    /**
     * Check if a circuit breaker exists
     * @param {string} name - Circuit breaker name
     * @returns {boolean}
     */
    has(name) {
        return this.breakers.has(name);
    }

    /**
     * Get all registered circuit breakers
     * @returns {Map<string, CircuitBreaker>}
     */
    getAll() {
        return new Map(this.breakers);
    }

    /**
     * Get names of all registered circuit breakers
     * @returns {string[]}
     */
    getNames() {
        return Array.from(this.breakers.keys());
    }

    /**
     * Reset all circuit breakers to CLOSED state
     * @returns {object} Results of reset operation
     */
    resetAll() {
        const results = {
            total: this.breakers.size,
            reset: 0,
            errors: []
        };

        for (const [name, breaker] of this.breakers) {
            try {
                const previousState = breaker.state;
                breaker.reset();
                results.reset++;

                if (previousState !== 'CLOSED') {
                    logger.info(`Circuit breaker '${name}' reset from ${previousState} to CLOSED`);
                }
            } catch (error) {
                results.errors.push({ name, error: error.message });
                logger.error(`Failed to reset circuit breaker '${name}'`, { error: error.message });
            }
        }

        logger.info('Circuit breaker registry resetAll completed', results);
        return results;
    }

    /**
     * Reset a specific circuit breaker by name
     * @param {string} name - Circuit breaker name
     * @returns {boolean} True if reset successful
     */
    reset(name) {
        const breaker = this.breakers.get(name);
        if (!breaker) {
            logger.warn(`Cannot reset circuit breaker '${name}' - not found in registry`);
            return false;
        }

        const previousState = breaker.state;
        breaker.reset();

        logger.info(`Circuit breaker '${name}' reset`, {
            previousState,
            newState: 'CLOSED'
        });

        return true;
    }

    /**
     * Force close a circuit breaker without logging (for session cleanup)
     * @param {string} name - Circuit breaker name
     * @returns {boolean}
     */
    forceClose(name) {
        const breaker = this.breakers.get(name);
        if (!breaker) {
            return false;
        }

        breaker.state = 'CLOSED';
        breaker.failureCount = 0;
        breaker.successCount = 0;
        breaker.nextAttempt = Date.now();
        return true;
    }

    /**
     * Force close all circuit breakers (for session cleanup)
     */
    forceCloseAll() {
        for (const name of this.breakers.keys()) {
            this.forceClose(name);
        }
        logger.debug('All circuit breakers force closed for session cleanup');
    }

    /**
     * Get status of all circuit breakers
     * @returns {object} Status object with all breaker states
     */
    getStatus() {
        const status = {
            total: this.breakers.size,
            open: 0,
            closed: 0,
            halfOpen: 0,
            breakers: {}
        };

        for (const [name, breaker] of this.breakers) {
            const state = breaker.getState();
            status.breakers[name] = {
                state: state.state,
                failureCount: state.failureCount,
                successCount: state.successCount,
                nextAttempt: state.nextAttempt,
                nextAttemptIn: state.state === 'OPEN'
                    ? Math.max(0, state.nextAttempt - Date.now())
                    : null,
                config: {
                    failureThreshold: breaker.failureThreshold,
                    successThreshold: breaker.successThreshold,
                    timeout: breaker.timeout
                }
            };

            // Count by state
            if (state.state === 'OPEN') status.open++;
            else if (state.state === 'CLOSED') status.closed++;
            else if (state.state === 'HALF_OPEN') status.halfOpen++;
        }

        return status;
    }

    /**
     * Get list of circuit breakers that are currently OPEN
     * @returns {string[]} Names of open circuit breakers
     */
    getOpenBreakers() {
        const open = [];
        for (const [name, breaker] of this.breakers) {
            if (breaker.state === 'OPEN') {
                open.push(name);
            }
        }
        return open;
    }

    /**
     * Check if any circuit breaker is OPEN
     * @returns {boolean}
     */
    hasOpenBreakers() {
        for (const breaker of this.breakers.values()) {
            if (breaker.state === 'OPEN') {
                return true;
            }
        }
        return false;
    }

    /**
     * Get circuit breakers by service type
     * @param {string} serviceType - 'memory', 'openai', 'claude'
     * @returns {Map<string, CircuitBreaker>}
     */
    getByServiceType(serviceType) {
        const filtered = new Map();
        for (const [name, breaker] of this.breakers) {
            if (name.toLowerCase().includes(serviceType.toLowerCase())) {
                filtered.set(name, breaker);
            }
        }
        return filtered;
    }

    /**
     * Reset all circuit breakers for a specific service type
     * @param {string} serviceType - 'memory', 'openai', 'claude'
     * @returns {number} Number of breakers reset
     */
    resetByServiceType(serviceType) {
        let count = 0;
        for (const [name, breaker] of this.breakers) {
            if (name.toLowerCase().includes(serviceType.toLowerCase())) {
                breaker.reset();
                count++;
            }
        }

        if (count > 0) {
            logger.info(`Reset ${count} circuit breaker(s) for service type '${serviceType}'`);
        }

        return count;
    }

    /**
     * Clear the registry (for testing)
     */
    clear() {
        this.breakers.clear();
        logger.debug('Circuit breaker registry cleared');
    }
}

// Singleton instance
const circuitBreakerRegistry = new CircuitBreakerRegistry();

module.exports = circuitBreakerRegistry;
