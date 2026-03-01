/**
 * Continuous Learning Routes
 * API for long-running self-driven learning with auto-benchmark generation
 */

const express = require('express');
const router = express.Router();
const { getInstance } = require('../services/continuousLearningLoop');
const benchmarkValidator = require('../services/benchmarkValidator');
const { getReporter } = require('../services/trainingReporter');
const intentService = require('../services/intentService');
const { query } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * POST /v0/continuous-learning/start
 * Start the continuous learning loop
 */
router.post('/start', async (req, res) => {
    try {
        // Always use authenticated user from session (not from body)
        const user_id = req.userId;
        if (!user_id) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const {
            duration_minutes = 5,
            questions_per_benchmark = 20,
            accuracy_threshold = 0.80,
            benchmark_scenario_count = 40,
            upgrade_threshold = 0.90,
            training_interval_ms = 10000,
            practice_count = 3,
            starting_difficulty = null,
            starting_scale = null,
            report_email = null,
            report_interval = 'end_only',
            domain = 'payments',
            target_intents = null,
            intent_focus = null,
            project_id = null
        } = req.body;

        // Auto-populate target_intents from project if not explicitly provided
        let resolvedIntents = target_intents;
        if (!resolvedIntents && project_id) {
            try {
                const projectIntentNames = await intentService.getProjectIntentNames(project_id);
                if (projectIntentNames.length > 0) {
                    resolvedIntents = projectIntentNames;
                    logger.info('Auto-populated target_intents from project', {
                        project_id, intents: resolvedIntents
                    });
                }
            } catch (err) {
                logger.warn('Failed to auto-populate intents from project', { error: err.message });
            }
        }

        const loop = getInstance(user_id);

        // Configure per-user email reporter
        if (report_email) {
            const reporter = getReporter(user_id);
            reporter.configure(report_email, report_interval, duration_minutes, user_id);
            reporter.setStatsProvider(() => loop.getStats());
        }

        logger.info('Starting continuous learning via API', {
            requestId: req.requestId,
            user_id,
            domain,
            duration_minutes,
            starting_scale,
            starting_difficulty,
            benchmark_scenario_count,
            upgrade_threshold,
            report_email: report_email ? '***' : null,
            report_interval
        });

        // Start the loop (this will run in the background)
        const resultPromise = loop.start(user_id, {
            duration_minutes,
            questions_per_benchmark,
            accuracy_threshold,
            benchmark_scenario_count,
            upgrade_threshold,
            training_interval_ms,
            practice_count,
            starting_difficulty,
            starting_scale,
            domain,
            target_intents: resolvedIntents,
            intent_focus: intent_focus
        });

        // Return immediately with status
        res.json({
            message: duration_minutes ? `Continuous learning started for ${duration_minutes} minutes` : 'Continuous learning started (indefinite)',
            status: 'running',
            config: {
                duration_minutes,
                questions_per_benchmark,
                accuracy_threshold,
                benchmark_scenario_count,
                upgrade_threshold,
                starting_scale,
                starting_difficulty
            }
        });

        // Wait for completion and log results
        resultPromise.then(results => {
            logger.info('Continuous learning completed', results);
        }).catch(error => {
            logger.error('Continuous learning failed', { error: error.message });
            // Send error report email via per-user reporter
            try {
                const reporter = getReporter(user_id);
                reporter.onError(loop.getStats(), error);
            } catch (reportErr) {
                logger.warn('Error report failed', { error: reportErr.message });
            }
        });

    } catch (error) {
        logger.logError(error, {
            operation: 'continuous-learning-start',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to start continuous learning',
            message: error.message
        });
    }
});

/**
 * POST /v0/continuous-learning/start-and-wait
 * Start continuous learning and wait for completion
 */
router.post('/start-and-wait', async (req, res) => {
    try {
        const user_id = req.userId;
        if (!user_id) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const {
            duration_minutes = 5,
            questions_per_benchmark = 20,
            accuracy_threshold = 0.80,
            benchmark_scenario_count = 40,
            upgrade_threshold = 0.90,
            training_interval_ms = 10000,
            practice_count = 3,
            starting_difficulty = null,
            starting_scale = null
        } = req.body;

        logger.info('Starting continuous learning (blocking) via API', {
            requestId: req.requestId,
            user_id,
            duration_minutes,
            starting_scale,
            starting_difficulty,
            benchmark_scenario_count,
            upgrade_threshold
        });

        const results = await getInstance(user_id).start(user_id, {
            duration_minutes,
            questions_per_benchmark,
            accuracy_threshold,
            benchmark_scenario_count,
            upgrade_threshold,
            training_interval_ms,
            practice_count,
            starting_difficulty,
            starting_scale
        });

        res.json(results);

    } catch (error) {
        logger.logError(error, {
            operation: 'continuous-learning-start-wait',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to run continuous learning',
            message: error.message
        });
    }
});

/**
 * POST /v0/continuous-learning/stop
 * Stop the continuous learning loop
 */
router.post('/stop', async (req, res) => {
    try {
        const user_id = req.userId;
        if (!user_id) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const loop = getInstance(user_id);
        loop.stop();
        const stats = loop.getStats();

        res.json({
            message: 'Continuous learning stopped',
            stats
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'continuous-learning-stop',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to stop continuous learning',
            message: error.message
        });
    }
});

/**
 * GET /v0/continuous-learning/status
 * Get current status of continuous learning
 */
router.get('/status', async (req, res) => {
    try {
        const user_id = req.userId;
        if (!user_id) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const stats = getInstance(user_id).getStats();
        res.json(stats);
    } catch (error) {
        logger.logError(error, {
            operation: 'continuous-learning-status',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to get status',
            message: error.message
        });
    }
});

/**
 * POST /v0/continuous-learning/validate-benchmark
 * Validate a benchmark's scenarios for labeling issues
 */
router.post('/validate-benchmark', async (req, res) => {
    try {
        const { benchmark_name } = req.body;

        if (!benchmark_name) {
            return res.status(400).json({ error: 'benchmark_name is required' });
        }

        // Get benchmark scenarios
        const result = await query(`
            SELECT s.scenario_id, s.merchant, s.description, s.correct_category
            FROM sealed_benchmark_scenarios s
            JOIN sealed_benchmarks b ON s.benchmark_id = b.benchmark_id
            WHERE b.benchmark_name = $1
            ORDER BY s.order_index
        `, [benchmark_name]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Benchmark not found' });
        }

        logger.info('Validating benchmark', {
            benchmark_name,
            scenario_count: result.rows.length
        });

        const validationReport = await benchmarkValidator.validateBenchmark(result.rows);

        res.json(validationReport);

    } catch (error) {
        logger.logError(error, {
            operation: 'validate-benchmark',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to validate benchmark',
            message: error.message
        });
    }
});

/**
 * POST /v0/continuous-learning/quick-validate
 * Quick validation of scenarios without LLM calls
 */
router.post('/quick-validate', async (req, res) => {
    try {
        const { benchmark_name } = req.body;

        if (!benchmark_name) {
            return res.status(400).json({ error: 'benchmark_name is required' });
        }

        // Get benchmark scenarios
        const result = await query(`
            SELECT s.scenario_id, s.merchant, s.description, s.correct_category
            FROM sealed_benchmark_scenarios s
            JOIN sealed_benchmarks b ON s.benchmark_id = b.benchmark_id
            WHERE b.benchmark_name = $1
            ORDER BY s.order_index
        `, [benchmark_name]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Benchmark not found' });
        }

        const issues = [];
        for (const scenario of result.rows) {
            const check = benchmarkValidator.quickValidate(scenario);
            if (check.has_flags) {
                issues.push({
                    scenario_id: scenario.scenario_id,
                    merchant: scenario.merchant,
                    description: scenario.description,
                    labeled_as: scenario.correct_category,
                    flags: check.flags
                });
            }
        }

        res.json({
            benchmark_name,
            total_scenarios: result.rows.length,
            issues_found: issues.length,
            issues
        });

    } catch (error) {
        logger.logError(error, {
            operation: 'quick-validate',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to quick validate',
            message: error.message
        });
    }
});

module.exports = router;
