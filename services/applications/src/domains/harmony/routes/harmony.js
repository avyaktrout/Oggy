/**
 * Harmony Map Routes — API for the Harmony Map domain
 */
const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const harmonyEngine = require('../services/harmonyEngine');
const scenarioService = require('../services/scenarioService');
const auditService = require('../services/auditService');

// ──────────────────────────────────────────────────
// Nodes
// ──────────────────────────────────────────────────

// List available scopes
router.get('/scopes', async (req, res) => {
    try {
        const result = await query(`
            SELECT scope, COUNT(*) AS count
            FROM harmony_nodes
            GROUP BY scope
            ORDER BY CASE scope
                WHEN 'world' THEN 1 WHEN 'continent' THEN 2 WHEN 'country' THEN 3
                WHEN 'state' THEN 4 WHEN 'city' THEN 5 WHEN 'neighborhood' THEN 6
                WHEN 'person' THEN 7 ELSE 8 END
        `);
        res.json({ scopes: result.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-scopes' });
        res.status(500).json({ error: err.message });
    }
});

// List nodes for a scope/region
router.get('/nodes', async (req, res) => {
    try {
        const { scope, parent_id } = req.query;
        let sql = `
            SELECT n.node_id, n.scope, n.name, n.geometry, n.population, n.metadata,
                   s.harmony, s.e_scaled, s.balance, s.flow, s.care
            FROM harmony_nodes n
            LEFT JOIN harmony_scores s ON n.node_id = s.node_id
        `;
        const params = [];
        const conditions = [];

        if (scope) {
            params.push(scope);
            conditions.push(`n.scope = $${params.length}`);
        }
        if (parent_id) {
            params.push(parent_id);
            conditions.push(`n.parent_node_id = $${params.length}`);
        }

        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY n.name';

        const result = await query(sql, params);
        res.json({ nodes: result.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-nodes' });
        res.status(500).json({ error: err.message });
    }
});

// Get single node with full scores
router.get('/node/:id', async (req, res) => {
    try {
        const nodeResult = await query(`
            SELECT n.*, s.balance, s.flow, s.compassion, s.discernment, s.care,
                   s.e_raw, s.e_scaled, s.awareness, s.expression, s.intent_coherence, s.harmony,
                   s.computation_hash, s.time_window_start, s.time_window_end
            FROM harmony_nodes n
            LEFT JOIN harmony_scores s ON n.node_id = s.node_id
            WHERE n.node_id = $1
            ORDER BY s.time_window_start DESC
            LIMIT 1
        `, [req.params.id]);

        if (!nodeResult.rows[0]) {
            return res.status(404).json({ error: 'Node not found' });
        }

        // Get alerts for this node
        const alertsResult = await query(`
            SELECT * FROM harmony_alerts
            WHERE node_id = $1 AND acknowledged = FALSE
            ORDER BY created_at DESC LIMIT 10
        `, [req.params.id]);

        res.json({ node: nodeResult.rows[0], alerts: alertsResult.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-node-detail' });
        res.status(500).json({ error: err.message });
    }
});

// Get explainability data for a node
router.get('/node/:id/explain', async (req, res) => {
    try {
        const timeWindowStart = req.query.time_window_start || '2024-01-01';
        const data = await harmonyEngine.getExplainability(req.params.id, timeWindowStart);
        res.json(data);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-explain' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Computation
// ──────────────────────────────────────────────────

// Compute/recompute scores for a node
router.post('/compute/:id', async (req, res) => {
    try {
        const { time_window_start, time_window_end } = req.body;
        const result = await harmonyEngine.computeScores(
            req.params.id,
            time_window_start || '2024-01-01',
            time_window_end || '2024-12-31'
        );

        if (!result) {
            return res.status(404).json({ error: 'No indicator data found for this node' });
        }

        // Generate alerts after computation
        const alerts = await harmonyEngine.generateAlerts(req.params.id);

        // Audit log
        await auditService.logAction(
            req.userId || 'system', 'compute', 'node', req.params.id,
            null, result, result.computation_hash
        );

        res.json({ ...result, alerts });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-compute' });
        res.status(500).json({ error: err.message });
    }
});

// Compute all nodes of a scope
router.post('/compute-all', async (req, res) => {
    try {
        const { scope, time_window_start, time_window_end } = req.body;
        const results = await harmonyEngine.computeAllNodes(
            scope || 'city',
            time_window_start || '2024-01-01',
            time_window_end || '2024-12-31'
        );
        res.json({ computed: results.length, results });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-compute-all' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Scenarios
// ──────────────────────────────────────────────────

// Create a scenario
router.post('/scenario', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const scenario = await scenarioService.createScenario(userId, req.body);
        // Auto-compute projections
        const projections = await scenarioService.recomputeProjections(scenario.scenario_id);
        res.json({ scenario, projections });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-create-scenario' });
        res.status(500).json({ error: err.message });
    }
});

// List user's scenarios
router.get('/scenarios', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id;
        const scenarios = await scenarioService.listScenarios(userId);
        res.json({ scenarios });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-list-scenarios' });
        res.status(500).json({ error: err.message });
    }
});

// Compare scenario vs baseline
router.get('/scenario/:id/compare', async (req, res) => {
    try {
        const comparison = await scenarioService.compareScenario(req.params.id);
        res.json(comparison);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-compare-scenario' });
        res.status(500).json({ error: err.message });
    }
});

// Delete a scenario
router.delete('/scenario/:id', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const result = await scenarioService.deleteScenario(req.params.id, userId);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-delete-scenario' });
        res.status(500).json({ error: err.message });
    }
});

// Approve a scenario
router.post('/scenario/:id/approve', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const scenario = await scenarioService.approveScenario(req.params.id, userId);
        res.json({ scenario });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-approve-scenario' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Datasets (Data Catalog)
// ──────────────────────────────────────────────────

router.get('/datasets', async (req, res) => {
    try {
        const result = await query('SELECT * FROM harmony_datasets ORDER BY name');
        res.json({ datasets: result.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-datasets' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Audit
// ──────────────────────────────────────────────────

router.get('/audit/:hash', async (req, res) => {
    try {
        const records = await auditService.getByHash(req.params.hash);
        res.json({ audit_records: records });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-audit' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/audit/verify/:hash', async (req, res) => {
    try {
        const result = await auditService.verifyHash(req.params.hash);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-audit-verify' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Alerts
// ──────────────────────────────────────────────────

router.get('/alerts', async (req, res) => {
    try {
        const { node_id, acknowledged } = req.query;
        let sql = 'SELECT a.*, n.name AS node_name FROM harmony_alerts a JOIN harmony_nodes n ON a.node_id = n.node_id';
        const params = [];
        const conditions = [];

        if (node_id) {
            params.push(node_id);
            conditions.push(`a.node_id = $${params.length}`);
        }
        if (acknowledged !== undefined) {
            params.push(acknowledged === 'true');
            conditions.push(`a.acknowledged = $${params.length}`);
        }

        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY a.created_at DESC LIMIT 50';

        const result = await query(sql, params);
        res.json({ alerts: result.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-alerts' });
        res.status(500).json({ error: err.message });
    }
});

// Acknowledge an alert
router.post('/alerts/:id/acknowledge', async (req, res) => {
    try {
        await query('UPDATE harmony_alerts SET acknowledged = TRUE WHERE alert_id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-acknowledge-alert' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
