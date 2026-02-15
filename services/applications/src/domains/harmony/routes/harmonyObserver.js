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

router.post('/export-map', async (req, res) => {
    const userId = req.userId || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    try {
        const snapshot = await harmonyObserverService.exportMap(userId);
        res.json(snapshot);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-export-map' });
        res.status(500).json({ error: 'Failed to export map' });
    }
});

router.post('/upload-map', async (req, res) => {
    const userId = req.userId || req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });
    const snapshot = req.body.snapshot;
    if (!snapshot || !snapshot.nodes) return res.status(400).json({ error: 'snapshot with nodes is required' });
    try {
        const result = await harmonyObserverService.createDiffPack(userId, snapshot);
        res.json(result);
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-upload-map' });
        res.status(500).json({ error: 'Failed to process uploaded map' });
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

// Cleanup: remove duplicate cities, indicators, and model_updates from existing packs
router.post('/cleanup-duplicates', async (req, res) => {
    try {
        const { query: dbQuery } = require('../../../shared/utils/db');
        const cities = await dbQuery("SELECT LOWER(name) AS name FROM harmony_nodes WHERE scope = 'city'");
        const cityNames = new Set(cities.rows.map(r => r.name));
        const indicators = await dbQuery("SELECT key FROM harmony_indicators");
        const indicatorKeys = new Set(indicators.rows.map(r => r.key));
        const packs = await dbQuery('SELECT pack_id, changes FROM harmony_observer_packs');
        let citiesRemoved = 0, indicatorsRemoved = 0, modelUpdatesRemoved = 0;
        for (const pack of packs.rows) {
            const changes = pack.changes || [];
            const filtered = changes.filter(c => {
                if (c.type === 'new_city') {
                    const name = (c.payload?.name || c.payload?.city_name || '').toLowerCase();
                    if (cityNames.has(name)) { citiesRemoved++; return false; }
                }
                if (c.type === 'new_indicator') {
                    const key = c.payload?.key;
                    if (key && indicatorKeys.has(key)) { indicatorsRemoved++; return false; }
                }
                if (c.type === 'model_update') {
                    modelUpdatesRemoved++; return false;
                }
                return true;
            });
            if (filtered.length !== changes.length) {
                const impact = filtered.length > 10 ? 'high' : filtered.length > 3 ? 'medium' : 'low';
                await dbQuery('UPDATE harmony_observer_packs SET changes = $1, impact_level = $2 WHERE pack_id = $3',
                    [JSON.stringify(filtered), impact, pack.pack_id]);
            }
        }
        res.json({ success: true, packs_cleaned: packs.rows.length, duplicate_cities_removed: citiesRemoved, duplicate_indicators_removed: indicatorsRemoved, duplicate_model_updates_removed: modelUpdatesRemoved });
    } catch (error) {
        logger.logError(error, { operation: 'harmony-observer-cleanup' });
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

module.exports = router;
