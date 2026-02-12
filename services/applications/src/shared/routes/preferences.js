/**
 * Preference Routes - User preference management and feedback
 * Behavior Design Doc Sections 4, 7
 */

const express = require('express');
const router = express.Router();
const PreferenceManager = require('../services/preferenceManager');
const ResponseAuditor = require('../services/responseAuditor');
const logger = require('../utils/logger');

const prefManager = new PreferenceManager(null);
const auditor = new ResponseAuditor();

// Set Redis client when available
let redisSet = false;
function setRedisClient(client) {
    if (!redisSet && client) {
        prefManager.redis = client;
        redisSet = true;
    }
}

/**
 * POST /v0/preferences/feedback - Record user feedback on a response
 * Body: { user_id, intent, target, value, strength?, request_id?, session_id? }
 */
router.post('/feedback', async (req, res) => {
    const { user_id, intent, target, value, strength, request_id, session_id } = req.body;

    if (!user_id || !intent || !target || !value) {
        return res.status(400).json({
            error: 'user_id, intent, target, and value are required'
        });
    }

    try {
        const event = await prefManager.recordEvent(user_id, {
            intent, target, value,
            strength: strength || 0.5,
            requestId: request_id || req.requestId,
            sessionId: session_id,
            evidencePointer: { request_id: request_id || req.requestId }
        });

        res.json({ success: true, event_id: event.event_id });
    } catch (error) {
        logger.logError(error, { operation: 'record-feedback', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to record feedback' });
    }
});

/**
 * GET /v0/preferences/profile?user_id=oggy - Get current preference profile
 */
router.get('/profile', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const profile = await prefManager.getProfile(user_id);
        res.json(profile);
    } catch (error) {
        logger.logError(error, { operation: 'get-profile', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get preference profile' });
    }
});

/**
 * GET /v0/preferences/events?user_id=oggy - Get preference event history
 */
router.get('/events', async (req, res) => {
    const { user_id, limit } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const events = await prefManager.getEvents(user_id, parseInt(limit) || 50);
        res.json({ events, count: events.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-pref-events', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get preference events' });
    }
});

/**
 * POST /v0/preferences/reset - Reset non-pinned preferences (Section 7)
 * Body: { user_id }
 */
router.post('/reset', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const result = await prefManager.resetPreferences(user_id);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'reset-preferences', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to reset preferences' });
    }
});

/**
 * GET /v0/preferences/audits?user_id=oggy - Get response audit history
 */
router.get('/audits', async (req, res) => {
    const { user_id, limit } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const audits = await auditor.getAudits(user_id, parseInt(limit) || 20);
        res.json({ audits, count: audits.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-audits', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get response audits' });
    }
});

/**
 * GET /v0/preferences/audit-stats?user_id=oggy - Get audit statistics
 */
router.get('/audit-stats', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const stats = await auditor.getAuditStats(user_id);
        res.json(stats);
    } catch (error) {
        logger.logError(error, { operation: 'get-audit-stats', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get audit stats' });
    }
});

/**
 * GET /v0/preferences/audit/:requestId - Get audit detail for a specific response
 * Used by the "Why?" link in chat UI
 */
router.get('/audit/:requestId', async (req, res) => {
    const userId = req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    try {
        const audit = await auditor.getAuditByRequest(req.params.requestId);
        if (!audit) return res.status(404).json({ error: 'Audit not found' });
        if (audit.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });

        const candidates = audit.candidates || [];
        const winner = candidates[audit.winner_index] || {};
        const axes = audit.scoring_axes?.weights || {};

        res.json({
            request_id: audit.request_id,
            candidate_count: audit.candidate_count,
            winner_reason: audit.winner_reason,
            winner_score: winner.scores?.total || null,
            humor_gate_active: audit.humor_gate_active,
            memory_cards_used: (audit.memory_card_ids || []).length,
            scoring: Object.entries(axes).map(([axis, weight]) => ({
                axis,
                weight,
                score: winner.scores?.[axis] || null
            })),
            created_at: audit.created_at
        });
    } catch (error) {
        logger.logError(error, { operation: 'get-audit-detail', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get audit detail' });
    }
});

module.exports = router;
module.exports.setRedisClient = setRedisClient;
