/**
 * Memory Pruning Routes
 * API for intelligent memory management
 */

const express = require('express');
const router = express.Router();
const memoryPruner = require('../services/memoryPruner');
const logger = require('../utils/logger');

/**
 * POST /v0/memory-pruning/analyze
 * Analyze memory utility without pruning
 */
router.post('/analyze', async (req, res) => {
    try {
        const { user_id } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const analysis = await memoryPruner.analyzeMemoryUtility(user_id);

        res.json(analysis);
    } catch (error) {
        logger.logError(error, {
            operation: 'analyze-memory-utility',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to analyze memory',
            message: error.message
        });
    }
});

/**
 * POST /v0/memory-pruning/prune
 * Execute memory pruning
 */
router.post('/prune', async (req, res) => {
    try {
        const {
            user_id,
            dry_run = false,
            min_utility_score = 0.30,
            max_prune_percentage = 0.30
        } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        logger.info('Memory pruning requested', {
            requestId: req.requestId,
            user_id,
            dry_run
        });

        const result = await memoryPruner.pruneMemory(user_id, {
            dry_run,
            min_utility_score,
            max_prune_percentage
        });

        res.json(result);
    } catch (error) {
        logger.logError(error, {
            operation: 'prune-memory',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to prune memory',
            message: error.message
        });
    }
});

/**
 * POST /v0/memory-pruning/enable-auto
 * Enable automatic pruning during training
 */
router.post('/enable-auto', async (req, res) => {
    try {
        const {
            user_id,
            prune_interval_sessions = 50,
            min_utility_threshold = 0.25
        } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'user_id is required' });
        }

        const result = await memoryPruner.enableAutoPruning(user_id, {
            prune_interval_sessions,
            min_utility_threshold
        });

        res.json(result);
    } catch (error) {
        logger.logError(error, {
            operation: 'enable-auto-pruning',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to enable auto-pruning',
            message: error.message
        });
    }
});

module.exports = router;
