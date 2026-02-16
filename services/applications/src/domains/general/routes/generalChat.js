/**
 * V2: General Conversation Routes
 */
const express = require('express');
const router = express.Router();
const generalChatService = require('../services/generalChatService');
const logger = require('../../../shared/utils/logger');

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

router.delete('/projects/:id', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        const deleted = await generalChatService.deleteProject(userId, req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Project not found' });
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v2-delete-project' });
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

// Analytics
router.get('/analytics', async (req, res) => {
    try {
        const userId = req.query.user_id;
        if (!userId) return res.status(400).json({ error: 'user_id required' });

        const { query: dbQuery } = require('../../../shared/utils/db');

        // Total conversations (messages where role = user content in project messages)
        const msgResult = await dbQuery(
            `SELECT COUNT(*) as total FROM v2_project_messages WHERE user_id = $1 AND role = 'user'`,
            [userId]
        );

        // Daily activity for last 14 days
        const activityResult = await dbQuery(
            `SELECT DATE(created_at) as day, COUNT(*) as count
             FROM v2_project_messages
             WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '14 days'
             GROUP BY DATE(created_at) ORDER BY day`,
            [userId]
        );

        // Learning events (memory cards with general tag)
        let learningCount = 0;
        try {
            const memResult = await dbQuery(
                `SELECT COUNT(*) as total FROM memory_cards WHERE owner_id = $1 AND tags @> ARRAY['general']`,
                [userId]
            );
            learningCount = parseInt(memResult.rows[0].total);
        } catch (e) { /* memory_cards table may not exist locally */ }

        // Training status from latest benchmark + its evaluation
        let training = null;
        try {
            const trainResult = await dbQuery(
                `SELECT b.benchmark_name, b.metadata, b.created_at,
                        r.oggy_accuracy, r.base_accuracy
                 FROM sealed_benchmarks b
                 LEFT JOIN sealed_benchmark_results r ON r.benchmark_id = b.benchmark_id
                 WHERE b.metadata->>'domain' = 'general'
                 ORDER BY b.created_at DESC LIMIT 1`
            );
            if (trainResult.rows.length > 0) {
                const b = trainResult.rows[0];
                const m = b.metadata || {};
                const scale = m.scale || 1;
                const level = m.level || 1;
                training = {
                    level: `S${scale} L${level}`,
                    accuracy: b.oggy_accuracy ? `${Math.round(b.oggy_accuracy * 100)}%` : null,
                    date: b.created_at
                };
            }
        } catch (e) { /* benchmarks may not exist */ }

        res.json({
            total_conversations: parseInt(msgResult.rows[0].total),
            daily_activity: activityResult.rows,
            learning_events: learningCount,
            training
        });
    } catch (err) {
        logger.logError(err, { operation: 'v2-analytics' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
