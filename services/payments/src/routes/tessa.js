/**
 * Tessa Assessment Generator Routes
 * API for generating novel training scenarios
 */

const express = require('express');
const router = express.Router();
const tessaAssessmentGenerator = require('../services/tessaAssessmentGenerator');
const logger = require('../utils/logger');

/**
 * POST /v0/tessa/generate
 * Generate a single novel scenario
 */
router.post('/generate', async (req, res) => {
    try {
        const { category, difficulty, includeAmbiguity } = req.body;

        const scenario = await tessaAssessmentGenerator.generateNovelScenario({
            category,
            difficulty: difficulty || 'medium',
            includeAmbiguity: includeAmbiguity || false
        });

        if (!scenario) {
            return res.status(500).json({
                error: 'Failed to generate scenario'
            });
        }

        logger.info('Tessa generated scenario via API', {
            requestId: req.requestId,
            category: scenario.correctCategory
        });

        res.json({
            scenario,
            message: 'Novel scenario generated and added to domain knowledge'
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'tessa-generate',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to generate scenario',
            message: error.message
        });
    }
});

/**
 * POST /v0/tessa/generate-batch
 * Generate multiple novel scenarios
 */
router.post('/generate-batch', async (req, res) => {
    try {
        const { count, category, difficulty } = req.body;

        const batchCount = Math.min(count || 10, 50); // Max 50 per request

        logger.info('Tessa batch generation requested', {
            requestId: req.requestId,
            count: batchCount
        });

        const result = await tessaAssessmentGenerator.generateBatch(batchCount, {
            category,
            difficulty
        });

        res.json({
            ...result,
            message: `Generated ${result.success_count} scenarios, ${result.error_count} errors`
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'tessa-generate-batch',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to generate batch',
            message: error.message
        });
    }
});

/**
 * GET /v0/tessa/stats
 * Get statistics on generated scenarios
 */
router.get('/stats', async (req, res) => {
    try {
        const stats = await tessaAssessmentGenerator.getGenerationStats();

        res.json({
            stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'tessa-stats',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to get stats',
            message: error.message
        });
    }
});

module.exports = router;
