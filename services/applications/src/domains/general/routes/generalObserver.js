/**
 * General Observer Routes — Federated learning for conversation quality
 */

const express = require('express');
const router = express.Router();
const generalObserverService = require('../services/generalObserverService');
const intentService = require('../../../shared/services/intentService');
const logger = require('../../../shared/utils/logger');

router.get('/config', async (req, res) => {
    const userId = req.userId || req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    try {
        const config = await generalObserverService.getConfig(userId);
        res.json(config);
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-config' });
        res.status(500).json({ error: 'Failed to get observer config' });
    }
});

router.put('/config', async (req, res) => {
    const userId = req.userId || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    try {
        const updated = await generalObserverService.updateConfig(userId, req.body);
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-update-config' });
        res.status(500).json({ error: 'Failed to update observer config' });
    }
});

router.get('/packs', async (req, res) => {
    const userId = req.userId || req.query.user_id;
    try {
        const packs = await generalObserverService.listPacks(req.query.status || null, req.query.intent || null);

        // Attach verified_for_intents badge
        for (const pack of packs) {
            if (pack.intent_tags && pack.intent_tags.length > 0 && userId) {
                try {
                    const verification = await intentService.getPackVerificationStatus(pack.intent_tags, userId, 'general');
                    pack.verified_for_intents = verification.verified;
                } catch (_) {
                    pack.verified_for_intents = false;
                }
            } else {
                pack.verified_for_intents = false;
            }
        }

        res.json({ packs, count: packs.length });
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-packs' });
        res.status(500).json({ error: 'Failed to list packs' });
    }
});

router.get('/packs/:id', async (req, res) => {
    try {
        const pack = await generalObserverService.getPack(req.params.id);
        if (!pack) return res.status(404).json({ error: 'Pack not found' });
        res.json(pack);
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-get-pack' });
        res.status(500).json({ error: 'Failed to get pack' });
    }
});

router.post('/import-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    const userId = req.userId || user_id;
    if (!pack_id || !userId) return res.status(400).json({ error: 'pack_id and user_id are required' });
    try {
        const result = await generalObserverService.importPack(pack_id, userId);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-import-pack' });
        res.status(500).json({ error: error.message || 'Failed to import pack' });
    }
});

router.post('/rollback-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    const userId = req.userId || user_id;
    if (!pack_id || !userId) return res.status(400).json({ error: 'pack_id and user_id are required' });
    try {
        const result = await generalObserverService.rollbackPack(pack_id, userId);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-rollback-pack' });
        res.status(500).json({ error: error.message || 'Failed to rollback pack' });
    }
});

router.get('/job-status', async (req, res) => {
    try {
        const status = await generalObserverService.getJobStatus();
        res.json(status);
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-job-status' });
        res.status(500).json({ error: 'Failed to get job status' });
    }
});

router.post('/run-job', async (req, res) => {
    try {
        const { start_schedule, stop_schedule } = req.body;
        if (start_schedule) {
            generalObserverService.startSchedule(6);
            return res.json({ success: true, message: 'Auto-run enabled (every 6h)' });
        }
        if (stop_schedule) {
            generalObserverService.stopSchedule();
            return res.json({ success: true, message: 'Auto-run disabled' });
        }
        const result = await generalObserverService.runObserverJob();
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-run-job' });
        res.status(500).json({ error: 'Observer job failed' });
    }
});

router.get('/job-log', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const jobs = await generalObserverService.getJobLog(limit);
        res.json({ jobs, count: jobs.length });
    } catch (error) {
        logger.logError(error, { operation: 'general-observer-job-log' });
        res.status(500).json({ error: 'Failed to get job log' });
    }
});

module.exports = router;
