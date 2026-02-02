/**
 * Cost Governor
 * Tracks and limits daily token usage to prevent runaway costs
 */

const logger = require('../utils/logger');

class CostGovernor {
    constructor() {
        // Daily budget in tokens (default 2M tokens/day)
        this.dailyBudget = parseInt(process.env.DAILY_TOKEN_BUDGET || '2000000', 10);
        this.warningThreshold = 0.8; // Warn at 80%
        this.usageCache = new Map(); // In-memory cache for current day
    }

    /**
     * Check if we have budget remaining
     * @param {number} estimatedTokens - Estimated tokens for the request
     * @returns {Promise<boolean>}
     */
    async checkBudget(estimatedTokens = 1000) {
        const today = this._getToday();
        const currentUsage = this.usageCache.get(today) || 0;
        const projectedUsage = currentUsage + estimatedTokens;

        // Check if we'd exceed budget
        if (projectedUsage > this.dailyBudget) {
            const percentUsed = (currentUsage / this.dailyBudget * 100).toFixed(1);

            logger.error('Daily token budget exceeded', {
                currentUsage,
                dailyBudget: this.dailyBudget,
                percentUsed,
                requestedTokens: estimatedTokens
            });

            const error = new Error('Daily token budget exceeded');
            error.budgetExceeded = true;
            error.currentUsage = currentUsage;
            error.dailyBudget = this.dailyBudget;
            throw error;
        }

        // Warn at 80% threshold
        const percentUsed = projectedUsage / this.dailyBudget;
        if (percentUsed >= this.warningThreshold && currentUsage / this.dailyBudget < this.warningThreshold) {
            logger.warn('Daily token budget warning', {
                percentUsed: (percentUsed * 100).toFixed(1),
                currentUsage,
                dailyBudget: this.dailyBudget
            });
        }

        return true;
    }

    /**
     * Record actual token usage
     * @param {number} actualTokens - Actual tokens used
     */
    recordUsage(actualTokens) {
        const today = this._getToday();
        const currentUsage = this.usageCache.get(today) || 0;
        const newUsage = currentUsage + actualTokens;

        this.usageCache.set(today, newUsage);

        // Clean up old days from cache
        this._cleanupCache();

        logger.logMetric('token_usage_daily', newUsage, 'tokens');

        return {
            dailyUsage: newUsage,
            dailyBudget: this.dailyBudget,
            percentUsed: (newUsage / this.dailyBudget * 100).toFixed(2),
            remaining: this.dailyBudget - newUsage
        };
    }

    /**
     * Get current usage stats
     */
    getUsageStats() {
        const today = this._getToday();
        const currentUsage = this.usageCache.get(today) || 0;

        return {
            date: today,
            currentUsage,
            dailyBudget: this.dailyBudget,
            percentUsed: (currentUsage / this.dailyBudget * 100).toFixed(2),
            remaining: this.dailyBudget - currentUsage,
            warningThreshold: this.warningThreshold * 100
        };
    }

    /**
     * Get budget status (alias for getUsageStats)
     */
    getBudgetStatus() {
        return this.getUsageStats();
    }

    /**
     * Reset budget (for testing or manual override)
     */
    reset() {
        const today = this._getToday();
        this.usageCache.delete(today);
        logger.info('Token budget reset for today');
    }

    _getToday() {
        return new Date().toISOString().split('T')[0];
    }

    _cleanupCache() {
        const today = this._getToday();
        for (const [date] of this.usageCache) {
            if (date !== today) {
                this.usageCache.delete(date);
            }
        }
    }
}

// Singleton instance
const costGovernor = new CostGovernor();

/**
 * Express middleware to check budget before expensive operations
 */
function checkBudgetMiddleware(estimatedTokens = 1000) {
    return async (req, res, next) => {
        try {
            await costGovernor.checkBudget(estimatedTokens);
            next();
        } catch (error) {
            if (error.budgetExceeded) {
                return res.status(429).json({
                    error: 'BUDGET_EXCEEDED',
                    message: 'Daily token budget exceeded. Please try again tomorrow.',
                    details: {
                        currentUsage: error.currentUsage,
                        dailyBudget: error.dailyBudget
                    }
                });
            }
            next(error);
        }
    };
}

module.exports = {
    costGovernor,
    checkBudgetMiddleware
};
