/**
 * Inquiry Routes - Self-driven inquiry system
 */

const express = require('express');
const router = express.Router();
const inquiryGenerator = require('../services/inquiryGenerator');
const { suggestionGate } = require('../services/suggestionGate');
const intentService = require('../services/intentService');
const { query: dbQuery } = require('../utils/db');
const logger = require('../utils/logger');

// GET /v0/inquiries/pending - Get pending inquiries (triggers lazy generation)
router.get('/pending', async (req, res) => {
    const { user_id, domain } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        let inquiries = await inquiryGenerator.getPendingInquiries(user_id);

        // Filter by domain if specified (payments pages show payments inquiries only, etc.)
        if (domain && inquiries.length > 0) {
            inquiries = inquiries.filter(inq => {
                const inqDomain = inq.context?.domain;
                // Clarifications (no domain) are shown on payments pages (legacy behavior)
                if (!inqDomain) return domain === 'payments';
                return inqDomain === domain;
            });
        }

        // Lazy generation if no pending inquiries for this domain
        if (inquiries.length === 0) {
            const generated = await inquiryGenerator.generateIfNeeded(user_id, domain || null);
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

// GET /v0/inquiries/saved-tips - Get saved advice tips for a domain
router.get('/saved-tips', async (req, res) => {
    const { user_id, domain } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        let sql = `SELECT inquiry_id, question_text, topic, context, answered_at
                    FROM oggy_inquiries
                    WHERE user_id = $1 AND question_type = 'ai_advice'
                      AND status = 'answered' AND user_answer = 'saved'`;
        const params = [user_id];

        if (domain) {
            sql += ` AND context->>'domain' = $2`;
            params.push(domain);
        }
        sql += ` ORDER BY answered_at DESC LIMIT 50`;

        const result = await dbQuery(sql, params);
        res.json({ tips: result.rows, count: result.rows.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-saved-tips', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get saved tips' });
    }
});

// DELETE /v0/inquiries/saved-tips/:inquiry_id - Unsave a tip
router.delete('/saved-tips/:inquiry_id', async (req, res) => {
    const { inquiry_id } = req.params;
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        await dbQuery(
            `UPDATE oggy_inquiries SET status = 'dismissed', user_answer = NULL
             WHERE inquiry_id = $1 AND user_id = $2 AND question_type = 'ai_advice'`,
            [inquiry_id, user_id]
        );
        res.json({ success: true });
    } catch (error) {
        logger.logError(error, { operation: 'delete-saved-tip', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to remove saved tip' });
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

// GET /v0/inquiries/focus-intents - Get user's focus intents (grouped by domain)
router.get('/focus-intents', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    try {
        const prefs = await inquiryGenerator.getPreferences(userId);
        const focusIntents = prefs.focus_intents || [];

        // Group by domain
        const byDomain = {};
        for (const intentName of focusIntents) {
            const domain = intentName.split('.')[0];
            if (!byDomain[domain]) byDomain[domain] = [];
            byDomain[domain].push(intentName);
        }

        res.json({ focus_intents: focusIntents, by_domain: byDomain });
    } catch (error) {
        logger.logError(error, { operation: 'get-focus-intents', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get focus intents' });
    }
});

// PUT /v0/inquiries/focus-intents - Set user's focus intents
router.put('/focus-intents', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.body.user_id;
    const { focus_intents } = req.body;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    if (!Array.isArray(focus_intents)) return res.status(400).json({ error: 'focus_intents must be an array' });

    try {
        // Validate all intent names exist in catalog
        if (focus_intents.length > 0) {
            // Group by domain for validation
            const byDomain = {};
            for (const iName of focus_intents) {
                const domain = iName.split('.')[0];
                if (!byDomain[domain]) byDomain[domain] = [];
                byDomain[domain].push(iName);
            }

            for (const [domain, names] of Object.entries(byDomain)) {
                const validation = await intentService.validateIntentTags(names, domain);
                if (!validation.valid) {
                    return res.status(400).json({ error: validation.error });
                }
            }
        }

        // Ensure preferences row exists
        await inquiryGenerator.getPreferences(userId);

        // Update focus_intents
        await dbQuery(
            `UPDATE oggy_inquiry_preferences SET focus_intents = $1, updated_at = now() WHERE user_id = $2`,
            [focus_intents, userId]
        );

        const updated = await inquiryGenerator.getPreferences(userId);
        res.json({ success: true, focus_intents: updated.focus_intents || [] });
    } catch (error) {
        logger.logError(error, { operation: 'set-focus-intents', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to set focus intents' });
    }
});

module.exports = router;
