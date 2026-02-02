/**
 * Retry Handler
 * Provides exponential backoff retry logic for resilient operations
 */

const logger = require('./logger');

class RetryHandler {
    /**
     * Execute a function with retry logic
     * @param {Function} fn - Async function to execute
     * @param {Object} options - Retry options
     * @returns {Promise} - Result of the function
     */
    async withRetry(fn, options = {}) {
        const {
            maxRetries = 3,
            baseDelay = 1000,
            maxDelay = 10000,
            exponential = true,
            operationName = 'operation',
            shouldRetry = null // Custom function to determine if error should be retried
        } = options;

        let lastError;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const result = await fn();

                if (attempt > 0) {
                    logger.info(`${operationName} succeeded after ${attempt} retries`);
                }

                return result;

            } catch (error) {
                lastError = error;

                // Check if we should retry this error
                if (shouldRetry && !shouldRetry(error)) {
                    logger.warn(`${operationName} failed with non-retryable error`, {
                        error: error.message,
                        attempt
                    });
                    throw error;
                }

                if (attempt < maxRetries) {
                    const delay = exponential
                        ? Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
                        : baseDelay;

                    logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
                        error: error.message,
                        attempt: attempt + 1,
                        maxRetries
                    });

                    await this._sleep(delay);
                } else {
                    logger.error(`${operationName} failed after ${maxRetries} retries`, {
                        error: error.message,
                        stack: error.stack
                    });
                }
            }
        }

        throw lastError;
    }

    /**
     * Sleep for specified milliseconds
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Predefined retry policies
     */
    static retryableHttpErrors(error) {
        // Retry on network errors and 5xx errors
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            return true;
        }
        if (error.response && error.response.status >= 500) {
            return true;
        }
        // Don't retry on 4xx errors (client errors)
        if (error.response && error.response.status >= 400 && error.response.status < 500) {
            return false;
        }
        return true;
    }

    static retryableOpenAIErrors(error) {
        // Retry on rate limits and server errors
        if (error.response) {
            const status = error.response.status;
            // 429 = rate limit, 5xx = server errors
            return status === 429 || status >= 500;
        }
        // Retry on network errors
        return error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
    }
}

module.exports = new RetryHandler();
