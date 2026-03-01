/**
 * Observer Routes - Federated Learning endpoints
 * Observer Oggy Spec v0.1
 */

const express = require('express');
const router = express.Router();
const observerService = require('../services/observerService');
const intentService = require('../services/intentService');
const logger = require('../utils/logger');

// GET /v0/observer/config
router.get('/config', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const config = await observerService.getConfig(user_id);
        res.json(config);
    } catch (error) {
        logger.logError(error, { operation: 'get-observer-config', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get observer config' });
    }
});

// PUT /v0/observer/config
router.put('/config', async (req, res) => {
    const { user_id, share_learning, receive_observer_suggestions, receive_merchant_packs } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const updated = await observerService.updateConfig(user_id, {
            share_learning, receive_observer_suggestions, receive_merchant_packs
        });
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'update-observer-config', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to update observer config' });
    }
});

// GET /v0/observer/export-weaknesses
router.get('/export-weaknesses', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const data = await observerService.exportWeaknesses(user_id);
        res.json(data);
    } catch (error) {
        logger.logError(error, { operation: 'export-weaknesses', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to export weaknesses' });
    }
});

// GET /v0/observer/export-rules
router.get('/export-rules', async (req, res) => {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });

    try {
        const rules = await observerService.exportRules(user_id);
        res.json({ rules, count: rules.length });
    } catch (error) {
        logger.logError(error, { operation: 'export-rules', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to export rules' });
    }
});

// GET /v0/observer/packs
router.get('/packs', async (req, res) => {
    try {
        const { status, intent } = req.query;
        const userId = req.headers['x-user-id'] || req.query.user_id;
        const packs = await observerService.listPacks(status || null, intent || null);

        // Attach verified_for_intents flag to each pack
        if (userId) {
            await Promise.all(packs.map(async (pack) => {
                if (pack.intent_tags && pack.intent_tags.length > 0) {
                    try {
                        const domain = pack.intent_tags[0].split('.')[0] || 'payments';
                        const verification = await intentService.getPackVerificationStatus(pack.intent_tags, userId, domain);
                        pack.verified_for_intents = verification.verified;
                    } catch (e) {
                        pack.verified_for_intents = false;
                    }
                }
            }));
        }

        res.json({ packs, count: packs.length });
    } catch (error) {
        logger.logError(error, { operation: 'list-packs', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to list packs' });
    }
});

// GET /v0/observer/packs/:id
router.get('/packs/:id', async (req, res) => {
    try {
        const pack = await observerService.getPack(req.params.id);
        if (!pack) return res.status(404).json({ error: 'Pack not found' });
        res.json(pack);
    } catch (error) {
        logger.logError(error, { operation: 'get-pack', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get pack' });
    }
});

// POST /v0/observer/import-pack
router.post('/import-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    if (!pack_id || !user_id) return res.status(400).json({ error: 'pack_id and user_id are required' });

    try {
        const result = await observerService.importPack(pack_id, user_id);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'import-pack', requestId: req.requestId });
        res.status(500).json({ error: error.message || 'Failed to import pack' });
    }
});

// POST /v0/observer/rollback-pack
router.post('/rollback-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    if (!pack_id || !user_id) return res.status(400).json({ error: 'pack_id and user_id are required' });

    try {
        const result = await observerService.rollbackPack(pack_id, user_id);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'rollback-pack', requestId: req.requestId });
        res.status(500).json({ error: error.message || 'Failed to rollback pack' });
    }
});

// GET /v0/observer/job-status (check if job can run)
router.get('/job-status', async (req, res) => {
    try {
        const status = await observerService.getJobStatus();
        res.json(status);
    } catch (error) {
        logger.logError(error, { operation: 'observer-job-status', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get job status' });
    }
});

// POST /v0/observer/run-job (manual trigger or schedule toggle)
router.post('/run-job', async (req, res) => {
    try {
        const { start_schedule, stop_schedule } = req.body;

        if (start_schedule) {
            observerService.startSchedule(6);
            return res.json({ success: true, message: 'Auto-run enabled (every 6h)' });
        }
        if (stop_schedule) {
            observerService.stopSchedule();
            return res.json({ success: true, message: 'Auto-run disabled' });
        }

        const result = await observerService.runObserverJob();
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'run-observer-job', requestId: req.requestId });
        res.status(500).json({ error: 'Observer job failed' });
    }
});

// GET /v0/observer/job-log
router.get('/job-log', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const jobs = await observerService.getJobLog(limit);
        res.json({ jobs, count: jobs.length });
    } catch (error) {
        logger.logError(error, { operation: 'get-job-log', requestId: req.requestId });
        res.status(500).json({ error: 'Failed to get job log' });
    }
});

module.exports = router;
