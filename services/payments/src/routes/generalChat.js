/**
 * V2: General Conversation Routes
 */
const express = require('express');
const router = express.Router();
const generalChatService = require('../services/generalChatService');
const logger = require('../utils/logger');

// Chat
router.post('/chat', async (req, res) => {
    try {
        const userId = req.body.user_id || req.query.user_id;
        const { message, project_id, conversation_history, learn_from_chat } = req.body;

        if (!message) return res.status(400).json({ error: 'message is required' });

        const result = await generalChatService.chat(userId, message, {
            project_id, conversation_history, learn_from_chat
        });
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'v2-chat' });
        res.status(500).json({ error: 'Chat failed', message: err.message });
    }
});

// Projects
router.get('/projects', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const projects = await generalChatService.getProjects(userId);
        res.json({ projects });
    } catch (err) {
        logger.logError(err, { operation: 'v2-list-projects' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/projects', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { name, description } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });
        const project = await generalChatService.createProject(userId, name, description);
        res.json(project);
    } catch (err) {
        logger.logError(err, { operation: 'v2-create-project' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:id', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const project = await generalChatService.getProject(userId, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (err) {
        logger.logError(err, { operation: 'v2-get-project' });
        res.status(500).json({ error: err.message });
    }
});

router.put('/projects/:id', async (req, res) => {
    try {
        const userId = req.body.user_id;
        await generalChatService.updateProject(userId, req.params.id, req.body);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v2-update-project' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:id/messages', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const limit = parseInt(req.query.limit) || 50;
        const messages = await generalChatService.getProjectMessages(userId, req.params.id, limit);
        res.json({ messages });
    } catch (err) {
        logger.logError(err, { operation: 'v2-project-messages' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
