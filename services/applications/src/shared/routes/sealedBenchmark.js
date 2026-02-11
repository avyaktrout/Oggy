/**
 * Sealed Benchmark Routes
 * API for creating and testing against fixed, out-of-distribution benchmarks
 */

const express = require('express');
const router = express.Router();
const sealedBenchmarkGenerator = require('../../domains/payments/services/sealedBenchmarkGenerator');
const sealedBenchmarkEvaluator = require('../../domains/payments/services/sealedBenchmarkEvaluator');
const logger = require('../utils/logger');

/**
 * POST /v0/sealed-benchmark/create
 * Create a new sealed benchmark set
 */
router.post('/create', async (req, res) => {
    try {
        const {
            count = 100,
            name,
            description,
            difficulty_mix = 'balanced',
            use_ood = true
        } = req.body;

        // Validate count
        if (count < 10 || count > 500) {
            return res.status(400).json({
                error: 'Count must be between 10 and 500'
            });
        }

        logger.info('Creating sealed benchmark', {
            requestId: req.requestId,
            count,
            name,
            use_ood
        });

        const result = await sealedBenchmarkGenerator.createSealedBenchmark({
            count,
            name,
            description,
            difficulty_mix,
            use_ood
        });

        res.json(result);
    } catch (error) {
        logger.logError(error, {
            operation: 'create-sealed-benchmark',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to create sealed benchmark',
            message: error.message
        });
    }
});

/**
 * GET /v0/sealed-benchmark/list
 * List all available sealed benchmarks
 */
router.get('/list', async (req, res) => {
    try {
        const benchmarks = await sealedBenchmarkGenerator.listSealedBenchmarks();

        res.json({
            benchmarks,
            count: benchmarks.length
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'list-sealed-benchmarks',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to list sealed benchmarks',
            message: error.message
        });
    }
});

/**
 * GET /v0/sealed-benchmark/:identifier
 * Get a sealed benchmark by ID or name
 */
router.get('/:identifier', async (req, res) => {
    try {
        const { identifier } = req.params;

        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(identifier);

        res.json(benchmark);
    } catch (error) {
        if (error.message.includes('not found')) {
            return res.status(404).json({
                error: 'Sealed benchmark not found',
                message: error.message
            });
        }

        logger.logError(error, {
            operation: 'get-sealed-benchmark',
            requestId: req.requestId,
            identifier: req.params.identifier
        });
        res.status(500).json({
            error: 'Failed to get sealed benchmark',
            message: error.message
        });
    }
});

/**
 * POST /v0/sealed-benchmark/test
 * Test Oggy vs Base on a sealed benchmark
 */
router.post('/test', async (req, res) => {
    try {
        const {
            benchmark_id,
            benchmark_name,
            user_id
        } = req.body;

        if (!benchmark_id && !benchmark_name) {
            return res.status(400).json({
                error: 'Must provide either benchmark_id or benchmark_name'
            });
        }

        if (!user_id) {
            return res.status(400).json({
                error: 'user_id is required'
            });
        }

        logger.info('Testing on sealed benchmark', {
            requestId: req.requestId,
            benchmark_id,
            benchmark_name,
            user_id
        });

        const result = await sealedBenchmarkEvaluator.testOnSealedBenchmark({
            benchmark_identifier: benchmark_id || benchmark_name,
            user_id
        });

        res.json(result);
    } catch (error) {
        logger.logError(error, {
            operation: 'test-sealed-benchmark',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to test on sealed benchmark',
            message: error.message
        });
    }
});

/**
 * GET /v0/sealed-benchmark/results/:benchmark_identifier
 * Get historical results for a sealed benchmark
 */
router.get('/results/:benchmark_identifier', async (req, res) => {
    try {
        const { benchmark_identifier } = req.params;

        const results = await sealedBenchmarkEvaluator.getHistoricalResults(benchmark_identifier);

        res.json({
            benchmark_identifier,
            results,
            count: results.length
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'get-sealed-benchmark-results',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to get results',
            message: error.message
        });
    }
});

/**
 * POST /v0/sealed-benchmark/compare-over-time
 * Compare performance on sealed benchmark over multiple test runs
 */
router.post('/compare-over-time', async (req, res) => {
    try {
        const {
            benchmark_identifier,
            user_id
        } = req.body;

        if (!benchmark_identifier || !user_id) {
            return res.status(400).json({
                error: 'benchmark_identifier and user_id are required'
            });
        }

        const comparison = await sealedBenchmarkEvaluator.compareOverTime({
            benchmark_identifier,
            user_id
        });

        res.json(comparison);
    } catch (error) {
        logger.logError(error, {
            operation: 'compare-over-time',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to compare over time',
            message: error.message
        });
    }
});

module.exports = router;
