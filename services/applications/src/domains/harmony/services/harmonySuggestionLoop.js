/**
 * Harmony Suggestion Loop — Interval-based suggestion generation
 *
 * Generates 10 suggestions per cycle at a user-configured interval (5-30 min).
 * Uses harmonySuggestionService.generateOnDemand() for the actual LLM call.
 */

const logger = require('../../../shared/utils/logger');
const suggestionService = require('./harmonySuggestionService');

const instances = new Map();

class HarmonySuggestionLoop {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.intervalMinutes = 10;
        this.userId = null;
        this.stats = { total_generated: 0, cycles: 0, last_run: null, errors: 0 };
    }

    async start(userId, { intervalMinutes = 10 } = {}) {
        if (this.isRunning) return { status: 'already_running', interval_minutes: this.intervalMinutes };

        const validIntervals = [5, 10, 15, 20, 25, 30];
        if (!validIntervals.includes(intervalMinutes)) {
            return { status: 'error', message: `Invalid interval. Must be one of: ${validIntervals.join(', ')}` };
        }

        this.isRunning = true;
        this.userId = userId;
        this.intervalMinutes = intervalMinutes;
        this.stats = { total_generated: 0, cycles: 0, last_run: null, errors: 0 };

        const intervalMs = intervalMinutes * 60 * 1000;

        logger.info('Harmony suggestion loop starting', { userId, intervalMinutes });

        // Run first cycle immediately
        this._runCycle().catch(err => {
            logger.error('Harmony suggestion loop first cycle failed', { error: err.message });
        });

        // Set up recurring interval
        this.interval = setInterval(() => {
            this._runCycle().catch(err => {
                logger.error('Harmony suggestion loop cycle failed', { error: err.message });
            });
        }, intervalMs);

        return { status: 'started', interval_minutes: intervalMinutes };
    }

    stop() {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.isRunning = false;
        logger.info('Harmony suggestion loop stopped', { userId: this.userId, stats: this.stats });
        return { status: 'stopped', stats: { ...this.stats } };
    }

    getStatus() {
        return {
            is_running: this.isRunning,
            interval_minutes: this.intervalMinutes,
            total_generated: this.stats.total_generated,
            cycles: this.stats.cycles,
            last_run: this.stats.last_run,
            errors: this.stats.errors,
        };
    }

    async _runCycle() {
        try {
            const result = await suggestionService.generateOnDemand(this.userId, 10, 'all');
            const count = Array.isArray(result) ? result.length : 0;
            this.stats.total_generated += count;
            this.stats.cycles++;
            this.stats.last_run = new Date().toISOString();
            logger.info('Harmony suggestion loop cycle complete', { userId: this.userId, generated: count, cycle: this.stats.cycles });
        } catch (err) {
            this.stats.errors++;
            logger.error('Harmony suggestion loop cycle error', { userId: this.userId, error: err.message });
        }
    }
}

function getInstance(userId) {
    if (!instances.has(userId)) {
        const inst = new HarmonySuggestionLoop();
        inst.userId = userId;
        instances.set(userId, inst);
    }
    return instances.get(userId);
}

module.exports = { getInstance };
