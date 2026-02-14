/**
 * Harmony Observer Routes — Federated learning for Harmony Map
 */

const express = require('express');
const router = express.Router();
const harmonyObserverService = require('../services/harmonyObserverService');
const logger = require('../../../shared/utils/logger');

router.get('/config', async (req, res) => {
    const userId = req.userId || req.query.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    try {
        const config = await harmonyObserverService.getConfig(userId);
        res.json(config);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-config' });
        res.status(500).json({ error: 'Failed to get observer config' });
    }
});

router.put('/config', async (req, res) => {
    const userId = req.userId || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    try {
        const updated = await harmonyObserverService.updateConfig(userId, req.body);
        res.json(updated);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-update-config' });
        res.status(500).json({ error: 'Failed to update observer config' });
    }
});

router.get('/packs', async (req, res) => {
    try {
        const packs = await harmonyObserverService.listPacks(req.query.status || null);
        res.json({ packs, count: packs.length });
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-packs' });
        res.status(500).json({ error: 'Failed to list packs' });
    }
});

router.get('/packs/:id', async (req, res) => {
    try {
        const pack = await harmonyObserverService.getPack(req.params.id);
        if (!pack) return res.status(404).json({ error: 'Pack not found' });
        res.json(pack);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-get-pack' });
        res.status(500).json({ error: 'Failed to get pack' });
    }
});

router.post('/import-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    const userId = req.userId || user_id;
    if (!pack_id || !userId) return res.status(400).json({ error: 'pack_id and user_id are required' });
    try {
        const result = await harmonyObserverService.applyPack(pack_id, userId);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-import-pack' });
        res.status(500).json({ error: error.message || 'Failed to import pack' });
    }
});

router.post('/rollback-pack', async (req, res) => {
    const { pack_id, user_id } = req.body;
    const userId = req.userId || user_id;
    if (!pack_id || !userId) return res.status(400).json({ error: 'pack_id and user_id are required' });
    try {
        const result = await harmonyObserverService.rollbackPack(pack_id, userId);
        res.json({ success: true, ...result });
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-rollback-pack' });
        res.status(500).json({ error: error.message || 'Failed to rollback pack' });
    }
});

router.get('/job-status', async (req, res) => {
    try {
        const status = await harmonyObserverService.getJobStatus();
        res.json(status);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-job-status' });
        res.status(500).json({ error: 'Failed to get job status' });
    }
});

router.post('/run-job', async (req, res) => {
    try {
        const { start_schedule, stop_schedule } = req.body;
        if (start_schedule) {
            harmonyObserverService.startSchedule(6);
            return res.json({ success: true, message: 'Auto-run enabled (every 6h)' });
        }
        if (stop_schedule) {
            harmonyObserverService.stopSchedule();
            return res.json({ success: true, message: 'Auto-run disabled' });
        }
        const result = await harmonyObserverService.runObserverJob();
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-run-job' });
        res.status(500).json({ error: 'Observer job failed' });
    }
});

router.get('/job-log', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const jobs = await harmonyObserverService.getJobLog(limit);
        res.json({ jobs, count: jobs.length });
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-job-log' });
        res.status(500).json({ error: 'Failed to get job log' });
    }
});

module.exports = router;
