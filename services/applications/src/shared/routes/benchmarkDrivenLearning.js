/**
 * Benchmark-Driven Learning Routes
 * API for running learning cycles with benchmark feedback loops
 */

const express = require('express');
const router = express.Router();
const BenchmarkDrivenLearning = require('../../domains/payments/services/benchmarkDrivenLearning');
const logger = require('../utils/logger');

/**
 * POST /v0/benchmark-learning/cycles
 * Run benchmark-driven learning cycles
 */
router.post('/cycles', async (req, res) => {
    try {
        const {
            benchmark_identifier,
            user_id,
            cycles = 3,
            training_duration_seconds = 90,
            training_interval_ms = 10000,
            practice_count_per_session = 5
        } = req.body;

        if (!benchmark_identifier) {
            return res.status(400).json({
                error: 'benchmark_identifier is required'
            });
        }

        if (!user_id) {
            return res.status(400).json({
                error: 'user_id is required'
            });
        }

        logger.info('Starting benchmark-driven learning cycles', {
            requestId: req.requestId,
            benchmark_identifier,
            user_id,
            cycles,
            training_duration_seconds
        });

        const learningService = new BenchmarkDrivenLearning();
        const results = await learningService.runLearningCycles({
            benchmark_identifier,
            user_id,
            cycles,
            training_duration_seconds,
            training_interval_ms,
            practice_count_per_session
        });

        res.json(results);
    } catch (error) {
        logger.logError(error, {
            operation: 'benchmark-driven-learning-cycles',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to run learning cycles',
            message: error.message
        });
    }
});

module.exports = router;
