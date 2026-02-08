/**
 * Self-Driven Learning Routes
 * API endpoints to control Oggy's autonomous learning
 */

const express = require('express');
const router = express.Router();
const selfDrivenLearning = require('../services/selfDrivenLearning');
const logger = require('../utils/logger');

/**
 * POST /v0/learning/start
 * Start autonomous learning for a user
 */
router.post('/start', async (req, res) => {
    try {
        const { user_id, interval, practice_count, enabled } = req.body;

        if (!user_id) {
            return res.status(400).json({
                error: 'user_id is required'
            });
        }

        const sdl = selfDrivenLearning.getInstance(user_id);
        sdl.start(user_id, {
            interval: interval || 300000, // 5 minutes default
            practiceCount: practice_count || 5,
            enabled: enabled !== false
        });

        logger.info('Self-driven learning started via API', {
            user_id,
            requestId: req.requestId
        });

        res.json({
            message: 'Self-driven learning started',
            user_id,
            config: {
                interval: interval || 300000,
                practice_count: practice_count || 5
            },
            stats: sdl.getStats()
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'start-self-learning',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to start self-driven learning',
            message: error.message
        });
    }
});

/**
 * POST /v0/learning/stop
 * Stop autonomous learning
 */
router.post('/stop', async (req, res) => {
    try {
        const { user_id } = req.body;
        const sdl = selfDrivenLearning.getInstance(user_id);
        const stats = sdl.getStats();
        sdl.stop();

        logger.info('Self-driven learning stopped via API', {
            requestId: req.requestId,
            final_stats: stats
        });

        res.json({
            message: 'Self-driven learning stopped',
            stats
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'stop-self-learning',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to stop self-driven learning',
            message: error.message
        });
    }
});

/**
 * GET /v0/learning/stats
 * Get current learning statistics
 */
router.get('/stats', (req, res) => {
    try {
        const { user_id } = req.query;
        const stats = selfDrivenLearning.getInstance(user_id).getStats();

        res.json({
            stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'get-learning-stats',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to get learning stats',
            message: error.message
        });
    }
});

/**
 * POST /v0/learning/practice
 * Manually trigger a single practice session
 */
router.post('/practice', async (req, res) => {
    try {
        const startTime = Date.now();
        const { user_id } = req.body;
        const sdl = selfDrivenLearning.getInstance(user_id);

        await sdl.runLearningSession();

        const duration = Date.now() - startTime;
        const stats = sdl.getStats();

        logger.info('Manual practice session completed', {
            requestId: req.requestId,
            duration_ms: duration
        });

        res.json({
            message: 'Practice session completed',
            duration_ms: duration,
            stats
        });
    } catch (error) {
        logger.logError(error, {
            operation: 'manual-practice',
            requestId: req.requestId
        });
        res.status(500).json({
            error: 'Failed to run practice session',
            message: error.message
        });
    }
});

module.exports = router;
