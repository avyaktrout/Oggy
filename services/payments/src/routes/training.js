/**
 * Training Routes
 * API endpoints for benchmark-driven targeted training
 *
 * Week 8: Benchmark-Driven Learning
 */

const express = require('express');
const router = express.Router();
const benchmarkDrivenLearning = require('../services/benchmarkDrivenLearning');
const logger = require('../utils/logger');

/**
 * POST /v0/training/benchmark-driven
 * Trigger benchmark-driven targeted learning
 *
 * Body:
 * - result_id: UUID of sealed benchmark result to analyze
 * - user_id: User to train for
 * - duration_minutes: Training duration (default 5)
 * - items_per_category: Items per weak category (default 10)
 * - auto_retest: Whether to re-run benchmark after training (default true)
 */
router.post('/benchmark-driven', async (req, res) => {
    try {
        const {
            result_id,
            user_id,
            duration_minutes = 5,
            items_per_category = 10,
            auto_retest = true
        } = req.body;

        // Validation
        if (!result_id) {
            return res.status(400).json({
                error: 'result_id is required',
                message: 'Provide the UUID of a sealed benchmark result to analyze'
            });
        }

        if (!user_id) {
            return res.status(400).json({
                error: 'user_id is required',
                message: 'Provide the user ID to train for'
            });
        }

        logger.info('Benchmark-driven training requested', {
            result_id,
            user_id,
            duration_minutes,
            items_per_category
        });

        const result = await benchmarkDrivenLearning.runBenchmarkDrivenTraining({
            result_id,
            user_id,
            duration_minutes,
            items_per_category,
            auto_retest
        });

        res.json(result);

    } catch (error) {
        logger.logError(error, {
            operation: 'POST /training/benchmark-driven'
        });

        if (error.message.includes('already in progress')) {
            return res.status(409).json({
                error: 'Training in progress',
                message: error.message
            });
        }

        if (error.message.includes('not found')) {
            return res.status(404).json({
                error: 'Not found',
                message: error.message
            });
        }

        res.status(500).json({
            error: 'Training failed',
            message: error.message
        });
    }
});

/**
 * GET /v0/training/benchmark-driven/status
 * Get current training status
 */
router.get('/benchmark-driven/status', (req, res) => {
    const status = benchmarkDrivenLearning.getStatus();
    res.json(status);
});

/**
 * POST /v0/training/benchmark-driven/stop
 * Stop current training session early
 */
router.post('/benchmark-driven/stop', async (req, res) => {
    try {
        const result = await benchmarkDrivenLearning.stopTraining();
        res.json(result);

    } catch (error) {
        logger.logError(error, {
            operation: 'POST /training/benchmark-driven/stop'
        });

        res.status(500).json({
            error: 'Failed to stop training',
            message: error.message
        });
    }
});

module.exports = router;
