/**
 * V3: Diet Agent Routes
 */
const express = require('express');
const router = express.Router();
const dietService = require('../services/dietService');
const logger = require('../utils/logger');

// Diet entries
router.post('/entries', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const entry = await dietService.addEntry(userId, req.body);
        res.json(entry);
    } catch (err) {
        logger.logError(err, { operation: 'v3-add-entry' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/entries', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const date = req.query.date;
        const entry_type = req.query.entry_type;
        const entries = await dietService.getEntries(userId, date, { entry_type });
        res.json({ entries });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-entries' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/nutrition', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const date = req.query.date;
        const summary = await dietService.getNutritionSummary(userId, date);
        res.json(summary);
    } catch (err) {
        logger.logError(err, { operation: 'v3-nutrition' });
        res.status(500).json({ error: err.message });
    }
});

// Diet rules
router.get('/rules', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const rules = await dietService.getRules(userId);
        res.json({ rules });
    } catch (err) {
        logger.logError(err, { operation: 'v3-get-rules' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/rules', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const rule = await dietService.addRule(userId, req.body);
        res.json(rule);
    } catch (err) {
        logger.logError(err, { operation: 'v3-add-rule' });
        res.status(500).json({ error: err.message });
    }
});

router.delete('/rules/:id', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        await dietService.deleteRule(userId, req.params.id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v3-delete-rule' });
        res.status(500).json({ error: err.message });
    }
});

// Diet chat
router.post('/chat', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { message, conversation_history, learn_from_chat } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required' });

        const result = await dietService.chat(userId, message, {
            conversation_history, learn_from_chat
        });
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'v3-chat' });
        res.status(500).json({ error: 'Chat failed', message: err.message });
    }
});

module.exports = router;
