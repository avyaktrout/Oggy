/**
 * Chat Routes - Dual-model conversational endpoint
 */

const express = require('express');
const router = express.Router();
const chatHandler = require('../../../shared/services/chatHandler');
const logger = require('../../../shared/utils/logger');

// POST /v0/chat
router.post('/', async (req, res) => {
    const { user_id, message, conversation_history, learn_from_chat } = req.body;

    if (!user_id || !message) {
        return res.status(400).json({ error: 'user_id and message are required' });
    }

    try {
        const result = await chatHandler.handleChat(user_id, message, conversation_history || [], {
            learnFromChat: !!learn_from_chat
        });
        res.json(result);
    } catch (error) {
        if (error.budgetExceeded) {
            return res.status(429).json({
                error: 'Daily token budget exceeded',
                message: 'Chat temporarily unavailable due to budget limits'
            });
        }
        logger.logError(error, { operation: 'chat', requestId: req.requestId });
        res.status(500).json({ error: 'Chat failed', message: error.message });
    }
});

module.exports = router;
