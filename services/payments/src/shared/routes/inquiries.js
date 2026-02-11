/**
 * Inquiry Routes - Self-driven inquiry system
 */

const express = require('express');
const router = express.Router();
const inquiryGenerator = require('../services/inquiryGenerator');
const { suggestionGate } = require('../services/suggestionGate');
const logger = require('../utils/logger');

// GET /v0/inquiries/pending - Get pending inquiries (triggers lazy generation)
router.get('/pending', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        let inquiries = await inquiryGenerator.getPendingInquiries(user_id);

        // Lazy generation if no pending inquiries
        if (inquiries.length === 0) {
            const generated = await inquiryGenerator.generateIfNeeded(user_id);
            if (generated.length > 0) {
                inquiries = generated;
            }
        }

        res.json({ inquiries, count: inquiries.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-pending-inquiries', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get inquiries' });
    }
});

// POST /v0/inquiries/:inquiry_id/answer
router.post('/:inquiry_id/answer', async (req, res) => {
    const { inquiry_id } = req.params;
    const { user_id, answer, additional_context } = req.body;

    if (!user_id || !answer) {
        return res.status(400).json({ error: 'user_id and answer are required' });
    }

    try {
        await inquiryGenerator.answerInquiry(inquiry_id, user_id, answer, additional_context);
        res.json({ success: true, message: 'Answer recorded and applied to memory' });
    } catch (error) {
        logger.logError(error, { operation: 'answer-inquiry', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to record answer' });
    }
});

// POST /v0/inquiries/:inquiry_id/dismiss
router.post('/:inquiry_id/dismiss', async (req, res) => {
    const { inquiry_id } = req.params;
    const { user_id } = req.body;

    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        await inquiryGenerator.dismissInquiry(inquiry_id, user_id);
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'dismiss-inquiry', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to dismiss inquiry' });
    }
});

// GET /v0/inquiries/preferences
router.get('/preferences', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const prefs = await inquiryGenerator.getPreferences(user_id);
        res.json(prefs);
    } catch (error) {
        logger.logError(error, { operation: 'get-inquiry-preferences', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get preferences' });
    }
});

// PUT /v0/inquiries/preferences
router.put('/preferences', async (req, res) => {
    const { user_id, max_questions_per_day, enabled } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        await inquiryGenerator.updatePreferences(user_id, { max_questions_per_day, enabled });
        const updated = await inquiryGenerator.getPreferences(user_id);
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'update-inquiry-preferences', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update preferences' });
    }
});

// POST /v0/inquiries/generate - Manual trigger
router.post('/generate', async (req, res) => {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const generated = await inquiryGenerator.generateIfNeeded(user_id);
        res.json({ generated: generated.length, inquiries: generated });
    } catch (error) {
        logger.logError(error, { operation: 'generate-inquiries', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to generate inquiries' });
    }
});

// GET /v0/inquiries/suggestion-settings
router.get('/suggestion-settings', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const settings = await suggestionGate.getSettings(user_id);
        res.json(settings);
    } catch (error) {
        logger.logError(error, { operation: 'get-suggestion-settings', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get suggestion settings' });
    }
});

// PUT /v0/inquiries/suggestion-settings
router.put('/suggestion-settings', async (req, res) => {
    const { user_id, receive_suggestions, suggestion_interval_seconds } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const updated = await suggestionGate.updateSettings(user_id, {
            receive_suggestions,
            suggestion_interval_seconds
        });
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'update-suggestion-settings', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update suggestion settings' });
    }
});

module.exports = router;
