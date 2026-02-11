/**
 * Parallel execution utilities with concurrency control
 * Worker-pool pattern: N workers pull from a shared queue.
 * More efficient than batch-and-wait since idle slots are immediately filled.
 */

const logger = require('./logger');

/**
 * Execute async tasks with concurrency control
 * @param {Array<Function>} tasks - Array of async functions to execute
 * @param {number} concurrency - Max concurrent tasks (default 5)
 * @param {object} options
 * @param {number} options.interTaskDelayMs - Delay between starting tasks (default 0)
 * @param {boolean} options.stopOnError - Stop all tasks on first error (default false)
 * @param {string} options.operationName - Name for logging
 * @returns {Promise<{results: Array, errors: Array, duration_ms: number}>}
 */
async function parallelWithConcurrency(tasks, concurrency = 5, options = {}) {
    const { interTaskDelayMs = 0, stopOnError = false, operationName = 'parallel' } = options;
    const startTime = Date.now();
    const results = new Array(tasks.length);
    const errors = [];
    let nextIndex = 0;
    let stopped = false;

    async function runWorker() {
        while (!stopped) {
            const index = nextIndex++;
            if (index >= tasks.length) return;

            try {
                const value = await tasks[index]();
                results[index] = { success: true, value, index };
            } catch (error) {
                results[index] = { success: false, error: error.message, index };
                errors.push({ index, error: error.message });
                if (stopOnError) stopped = true;
            }

            if (interTaskDelayMs > 0 && nextIndex < tasks.length) {
                await new Promise(resolve => setTimeout(resolve, interTaskDelayMs));
            }
        }
    }

    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, () => runWorker());
    await Promise.all(workers);

    const duration_ms = Date.now() - startTime;
    logger.debug(`${operationName} completed`, {
        total: tasks.length,
        succeeded: results.filter(r => r && r.success).length,
        failed: errors.length,
        concurrency: workerCount,
        duration_ms
    });

    return { results, errors, duration_ms };
}

/**
 * Map items through an async function with concurrency control
 * @param {Array} items - Items to process
 * @param {Function} mapperFn - Async function (item, index) => result
 * @param {number} concurrency - Max concurrent tasks
 * @param {object} options - Same as parallelWithConcurrency
 * @returns {Promise<{results: Array, errors: Array, duration_ms: number}>}
 */
async function parallelMap(items, mapperFn, concurrency = 5, options = {}) {
    const tasks = items.map((item, index) => () => mapperFn(item, index));
    return parallelWithConcurrency(tasks, concurrency, options);
}

module.exports = { parallelWithConcurrency, parallelMap };
