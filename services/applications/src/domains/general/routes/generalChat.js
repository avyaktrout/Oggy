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

// Project suggestions (must be before :id route)
router.get('/projects/suggestions', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const suggestions = await generalChatService.getProjectSuggestions(userId);
        res.json({ suggestions });
    } catch (err) {
        logger.logError(err, { operation: 'v2-project-suggestions' });
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

// Notes
router.post('/projects/:id/notes', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { content, source_message_id, source_role } = req.body;
        if (!content) return res.status(400).json({ error: 'content is required' });
        const note = await generalChatService.createNote(userId, req.params.id, content, source_message_id || null, source_role || null);
        res.json(note);
    } catch (err) {
        logger.logError(err, { operation: 'v2-create-note' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:id/notes', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const notes = await generalChatService.getNotes(userId, req.params.id);
        res.json({ notes });
    } catch (err) {
        logger.logError(err, { operation: 'v2-get-notes' });
        res.status(500).json({ error: err.message });
    }
});

router.delete('/notes/:noteId', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        const deleted = await generalChatService.deleteNote(userId, req.params.noteId);
        if (!deleted) return res.status(404).json({ error: 'Note not found' });
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'v2-delete-note' });
        res.status(500).json({ error: err.message });
    }
});

// Learning Settings
router.get('/projects/:id/learning-settings', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const project = await generalChatService.getProject(userId, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const metadata = project.metadata || {};
        const learning = metadata.learning || { behavior_learning: true, domain_learning: false };
        res.json({ learning });
    } catch (err) {
        logger.logError(err, { operation: 'v2-get-learning-settings' });
        res.status(500).json({ error: err.message });
    }
});

router.put('/projects/:id/learning-settings', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { behavior_learning, domain_learning } = req.body;

        const project = await generalChatService.getProject(userId, req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const metadata = project.metadata || {};
        metadata.learning = {
            behavior_learning: behavior_learning !== undefined ? behavior_learning : (metadata.learning?.behavior_learning ?? true),
            domain_learning: domain_learning !== undefined ? domain_learning : (metadata.learning?.domain_learning ?? false)
        };

        await generalChatService.updateProjectMetadata(userId, req.params.id, metadata);
        res.json({ success: true, learning: metadata.learning });
    } catch (err) {
        logger.logError(err, { operation: 'v2-put-learning-settings' });
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

        // Behavior learning stats
        let blStats = { signals_extracted: 0 };
        try {
            const blResult = await dbQuery(
                `SELECT COUNT(*) as total FROM v2_preference_events WHERE user_id = $1 AND source = 'behavior_auto'`,
                [userId]
            );
            blStats.signals_extracted = parseInt(blResult.rows[0].total);
        } catch (e) { /* ignore */ }

        // Domain learning stats
        let dlStats = { enabled_tags: 0, active_packs: 0, total_cards: 0, tags: [], study_plans_saved: 0, total_packs_generated: 0 };
        try {
            const tagResult = await dbQuery(
                `SELECT COUNT(*) as cnt FROM dl_domain_tags WHERE user_id = $1 AND status = 'enabled'`,
                [userId]
            );
            dlStats.enabled_tags = parseInt(tagResult.rows[0].cnt);
            const packResult = await dbQuery(
                `SELECT COUNT(*) as cnt FROM dl_knowledge_packs WHERE user_id = $1 AND status = 'applied'`,
                [userId]
            );
            dlStats.active_packs = parseInt(packResult.rows[0].cnt);
            const cardResult = await dbQuery(
                `SELECT COUNT(*) as cnt FROM dl_knowledge_cards kc
                 JOIN dl_knowledge_packs kp ON kp.pack_id = kc.pack_id
                 WHERE kp.user_id = $1 AND kp.status = 'applied'`,
                [userId]
            );
            dlStats.total_cards = parseInt(cardResult.rows[0].cnt);

            // Tag details with pack/card counts
            const tagListResult = await dbQuery(
                `SELECT t.tag, t.display_name, t.status,
                        COUNT(DISTINCT kp.pack_id) FILTER (WHERE kp.status = 'applied') as pack_count,
                        COALESCE(SUM(kp.card_count) FILTER (WHERE kp.status = 'applied'), 0) as card_count
                 FROM dl_domain_tags t
                 LEFT JOIN dl_knowledge_packs kp ON kp.tag_id = t.tag_id AND kp.user_id = t.user_id
                 WHERE t.user_id = $1 AND t.status = 'enabled'
                 GROUP BY t.tag_id, t.tag, t.display_name, t.status
                 ORDER BY t.created_at DESC`,
                [userId]
            );
            dlStats.tags = tagListResult.rows;

            // Study plans saved
            const spResult = await dbQuery(
                `SELECT COUNT(*) as cnt FROM dl_audit_events WHERE user_id = $1 AND action = 'study_plan_saved'`,
                [userId]
            );
            dlStats.study_plans_saved = parseInt(spResult.rows[0].cnt);

            // Total packs generated
            const allPacksResult = await dbQuery(
                `SELECT COUNT(*) as cnt FROM dl_knowledge_packs WHERE user_id = $1`,
                [userId]
            );
            dlStats.total_packs_generated = parseInt(allPacksResult.rows[0].cnt);
        } catch (e) { /* tables may not exist */ }

        res.json({
            total_conversations: parseInt(msgResult.rows[0].total),
            daily_activity: activityResult.rows,
            learning_events: learningCount,
            training,
            behavior_learning: blStats,
            domain_learning: dlStats
        });
    } catch (err) {
        logger.logError(err, { operation: 'v2-analytics' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
