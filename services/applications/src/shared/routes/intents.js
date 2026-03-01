/**
 * Intent Routes — CRUD + analytics for the intent framework
 */

const express = require('express');
const router = express.Router();
const intentService = require('../services/intentService');
const logger = require('../utils/logger');

// GET /v0/intents?domain=payments
router.get('/', async (req, res) => {
    const { domain } = req.query;
    if (!domain) return res.status(400).json({ error: 'domain is required' });

    try {
        const userId = req.headers['x-user-id'] || req.query.user_id || null;
        const intents = await intentService.listIntents(domain, userId);
        res.json({ intents });
    } catch (error) {
        logger.logError(error, { operation: 'list-intents', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to list intents' });
    }
});

// GET /v0/intents/performance?domain=X&intent=Y&limit=20
router.get('/performance', async (req, res) => {
    const { domain, intent, limit } = req.query;
    const userId = req.headers['x-user-id'] || req.query.user_id;
    if (!userId || !domain) return res.status(400).json({ error: 'domain and user_id are required' });

    try {
        const data = await intentService.getIntentTimeSeries(
            userId, domain, intent || null, parseInt(limit) || 20
        );
        res.json({ performance: data });
    } catch (error) {
        logger.logError(error, { operation: 'intent-performance', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get intent performance' });
    }
});

// GET /v0/intents/summary?domain=X
router.get('/summary', async (req, res) => {
    const { domain } = req.query;
    const userId = req.headers['x-user-id'] || req.query.user_id;
    if (!userId || !domain) return res.status(400).json({ error: 'domain and user_id are required' });

    try {
        const summary = await intentService.getIntentSummary(userId, domain);
        res.json({ summary });
    } catch (error) {
        logger.logError(error, { operation: 'intent-summary', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get intent summary' });
    }
});

// GET /v0/intents/:id
router.get('/:id', async (req, res) => {
    try {
        const intent = await intentService.getIntent(req.params.id);
        if (!intent) return res.status(404).json({ error: 'Intent not found' });
        res.json(intent);
    } catch (error) {
        logger.logError(error, { operation: 'get-intent', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get intent' });
    }
});

// POST /v0/intents - Create a custom intent
router.post('/', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    const { intent_name, domain, display_name, description, success_criteria, metric_type } = req.body;
    if (!intent_name || !domain || !display_name) {
        return res.status(400).json({ error: 'intent_name, domain, and display_name are required' });
    }

    try {
        const created = await intentService.createIntent(userId, {
            intent_name, domain, display_name, description, success_criteria, metric_type
        });
        res.status(201).json(created);
    } catch (error) {
        if (error.code === '23505') { // unique_violation
            return res.status(409).json({ error: 'Intent name already exists' });
        }
        logger.logError(error, { operation: 'create-intent', requestId: req.requestId });
        res.status(400).json({ error: error.message || 'Failed to create intent' });
    }
});

// POST /v0/intents/clone
router.post('/clone', async (req, res) => {
    const { intent_id, display_name, description, success_criteria } = req.body;
    const userId = req.headers['x-user-id'] || req.body.user_id;
    if (!intent_id || !userId) return res.status(400).json({ error: 'intent_id and user_id are required' });

    try {
        const cloned = await intentService.cloneIntent(intent_id, userId, {
            display_name, description, success_criteria
        });
        res.status(201).json(cloned);
    } catch (error) {
        logger.logError(error, { operation: 'clone-intent', requestId: req.requestId });
        res.status(500).json({ error: error.message || 'Failed to clone intent' });
    }
});

// PUT /v0/intents/:id
router.put('/:id', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    try {
        const updated = await intentService.updateIntent(req.params.id, userId, req.body);
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'update-intent', requestId: req.requestId });
        res.status(400).json({ error: error.message || 'Failed to update intent' });
    }
});

// DELETE /v0/intents/:id
router.delete('/:id', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    try {
        const result = await intentService.retireIntent(req.params.id, userId);
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'retire-intent', requestId: req.requestId });
        res.status(400).json({ error: error.message || 'Failed to retire intent' });
    }
});

// --- Project-Intent binding ---

// GET /v0/intents/projects/:projectId - List intents bound to a project
router.get('/projects/:projectId', async (req, res) => {
    try {
        const intents = await intentService.getProjectIntents(req.params.projectId);
        res.json({ intents, count: intents.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-project-intents', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get project intents' });
    }
});

// POST /v0/intents/projects/:projectId - Bind intents to a project
router.post('/projects/:projectId', async (req, res) => {
    const userId = req.headers['x-user-id'] || req.body.user_id;
    const { intent_ids } = req.body;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    if (!Array.isArray(intent_ids) || intent_ids.length === 0) {
        return res.status(400).json({ error: 'intent_ids array is required' });
    }

    try {
        const result = await intentService.bindIntentsToProject(req.params.projectId, intent_ids, userId);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'bind-project-intents', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to bind intents to project' });
    }
});

// DELETE /v0/intents/projects/:projectId/:intentId - Unbind an intent from a project
router.delete('/projects/:projectId/:intentId', async (req, res) => {
    try {
        const result = await intentService.unbindIntentFromProject(req.params.projectId, req.params.intentId);
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'unbind-project-intent', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to unbind intent from project' });
    }
});

module.exports = router;
