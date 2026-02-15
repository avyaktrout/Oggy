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
const harmonySuggestionService = require('../services/harmonySuggestionService');
const suggestionLoop = require('../services/harmonySuggestionLoop');
const harmonySdl = require('../services/harmonySelfDrivenLearning');

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

// ──────────────────────────────────────────────────
// Drivers & Freshness
// ──────────────────────────────────────────────────

// Top drivers and drags for a node
router.get('/node/:id/drivers', async (req, res) => {
    try {
        const timeWindowStart = req.query.time_window_start || '2024-01-01';
        const count = parseInt(req.query.count) || 3;
        const data = await harmonyEngine.getTopDriversAndDrags(req.params.id, timeWindowStart, count);
        res.json(data);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-drivers' });
        res.status(500).json({ error: err.message });
    }
});

// Data freshness and coverage for a node
router.get('/node/:id/freshness', async (req, res) => {
    try {
        const data = await harmonyEngine.getFreshnessAndCoverage(req.params.id);
        res.json(data);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-freshness' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Analytics (Daily Snapshots)
// ──────────────────────────────────────────────────

// Get snapshot history for charts
router.get('/analytics/snapshots', async (req, res) => {
    try {
        const { node_id, days } = req.query;
        const dayCount = parseInt(days) || 90;

        let sql = `
            SELECT s.*, n.name AS node_name
            FROM harmony_daily_snapshots s
            JOIN harmony_nodes n ON s.node_id = n.node_id
            WHERE s.snapshot_date >= CURRENT_DATE - INTERVAL '1 day' * $1
        `;
        const params = [dayCount];

        if (node_id) {
            params.push(node_id);
            sql += ` AND s.node_id = $${params.length}`;
        }

        sql += ' ORDER BY s.node_id, s.snapshot_date ASC';

        const result = await query(sql, params);
        res.json({ snapshots: result.rows });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-analytics-snapshots' });
        res.status(500).json({ error: err.message });
    }
});

// Manual snapshot trigger
router.post('/analytics/snapshot-now', async (req, res) => {
    try {
        const scope = req.body.scope || 'city';
        const result = await harmonyEngine.snapshotAllNodes(scope);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-snapshot-now' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Chat
// ──────────────────────────────────────────────────

const providerResolver = require('../../../shared/providers/providerResolver');
const { costGovernor } = require('../../../shared/middleware/costGovernor');

router.post('/chat', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const { message, conversation_history = [] } = req.body;
        if (!message) return res.status(400).json({ error: 'message is required' });

        // Build context from latest city scores
        const citiesResult = await query(`
            SELECT n.name, s.harmony, s.e_scaled, s.balance, s.flow, s.care,
                   s.awareness, s.expression, s.intent_coherence
            FROM harmony_nodes n
            JOIN harmony_scores s ON n.node_id = s.node_id
            WHERE n.scope = 'city'
            ORDER BY n.name
        `);

        const cityContext = citiesResult.rows.map(c =>
            `${c.name}: H=${((c.harmony||0)*100).toFixed(1)}% E=${((c.e_scaled||0)*100).toFixed(1)}% B=${((c.balance||0)*100).toFixed(1)}% F=${((c.flow||0)*100).toFixed(1)}% C=${((c.care||0)*100).toFixed(1)}% S=${((c.intent_coherence||0)*100).toFixed(1)}%`
        ).join('\n');

        const systemPrompt = `You are Oggy, a Harmony Map assistant that helps users understand city well-being metrics.

You use the Equilibrium Canon framework:
- H (Harmony) = sqrt(E * S) — overall city well-being
- E (Equilibrium) = (B * F * C)^(1/3) — structural balance
- B (Balance) = weighted mean of safety/economic indicators
- F (Flow) = weighted mean of mobility/access indicators
- C (Care) = Compassion * Discernment
- S (Intent Coherence) = sqrt(A * X)
- A (Awareness) = weighted mean of education/civic indicators
- X (Expression) = weighted mean of cultural/freedom indicators

Current city scores:
${cityContext}

Help users understand what drives city scores, suggest improvements, and explain the mathematical relationships. You can also suggest new data sources or metrics to improve the model. Be concise and data-driven.`;

        await costGovernor.checkBudget(6000);

        const oggyMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const baseMessages = [
            { role: 'system', content: `You are a city well-being analysis assistant. Help users understand urban metrics and suggest improvements. Be concise.\n\nCurrent city scores:\n${cityContext}` },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        // Run Oggy and Base in parallel
        const [oggyResult, baseResult] = await Promise.all([
            (async () => {
                const resolved = await providerResolver.getAdapter(userId, 'oggy');
                const r = await resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: oggyMessages,
                    temperature: 0.7,
                    max_tokens: 1000
                });
                costGovernor.recordUsage(r.tokens_used || 800);
                providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'harmonyChat', r.tokens_used, r.latency_ms, true, null);
                return { text: r.text };
            })(),
            (async () => {
                try {
                    const resolved = await providerResolver.getAdapter(userId, 'base');
                    const r = await resolved.adapter.chatCompletion({
                        model: resolved.model,
                        messages: baseMessages,
                        temperature: 0.7,
                        max_tokens: 1000
                    });
                    costGovernor.recordUsage(r.tokens_used || 800);
                    providerResolver.logRequest(userId, resolved.provider, resolved.model, 'base', 'harmonyChat', r.tokens_used, r.latency_ms, true, null);
                    return { text: r.text };
                } catch (err) {
                    logger.debug('Base harmony chat failed', { error: err.message });
                    return { text: 'Sorry, I encountered an error. Please try again.' };
                }
            })()
        ]);

        res.json({
            oggy_response: oggyResult.text,
            base_response: baseResult.text,
            domain: 'harmony',
        });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-chat' });
        res.status(500).json({ error: 'Chat failed', message: err.message });
    }
});

// ──────────────────────────────────────────────────
// What-If Chat (node-specific, with suggestions)
// ──────────────────────────────────────────────────

router.post('/whatif-chat', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const { message, node_id, conversation_history = [] } = req.body;
        if (!message || !node_id) return res.status(400).json({ error: 'message and node_id required' });

        // Build rich context for the selected node
        const [nodeData, explainData, driversData, snapshotsData, allCities] = await Promise.all([
            query(`
                SELECT n.*, s.balance, s.flow, s.compassion, s.discernment, s.care,
                       s.e_raw, s.e_scaled, s.awareness, s.expression, s.intent_coherence, s.harmony
                FROM harmony_nodes n LEFT JOIN harmony_scores s ON n.node_id = s.node_id
                WHERE n.node_id = $1 LIMIT 1
            `, [node_id]),
            harmonyEngine.getExplainability(node_id),
            harmonyEngine.getTopDriversAndDrags(node_id),
            query(`
                SELECT snapshot_date, harmony, e_scaled, balance, flow, care, intent_coherence
                FROM harmony_daily_snapshots WHERE node_id = $1
                ORDER BY snapshot_date DESC LIMIT 30
            `, [node_id]),
            query(`
                SELECT n.name, s.harmony, s.e_scaled, s.balance, s.flow, s.care, s.intent_coherence
                FROM harmony_nodes n JOIN harmony_scores s ON n.node_id = s.node_id
                WHERE n.scope = 'city' ORDER BY n.name
            `),
        ]);

        const node = nodeData.rows[0];
        if (!node) return res.status(404).json({ error: 'Node not found' });

        const indicatorContext = (explainData.indicators || []).map(i =>
            `  ${i.key}: raw=${i.raw_value} norm=${i.normalized_value != null ? (i.normalized_value*100).toFixed(1)+'%' : '?'} (${i.dimension}, ${i.direction}, w=${i.weight})`
        ).join('\n');

        const driverContext = (driversData.drivers || []).map(d => `  + ${d.name}: ${(d.normalized_value*100).toFixed(0)}%`).join('\n');
        const dragContext = (driversData.drags || []).map(d => `  - ${d.name}: ${(d.normalized_value*100).toFixed(0)}%`).join('\n');

        const progressionContext = snapshotsData.rows.map(s =>
            `  ${s.snapshot_date}: H=${((s.harmony||0)*100).toFixed(1)}% E=${((s.e_scaled||0)*100).toFixed(1)}%`
        ).join('\n');

        const allCityContext = allCities.rows.map(c =>
            `${c.name}: H=${((c.harmony||0)*100).toFixed(1)}% B=${((c.balance||0)*100).toFixed(1)}% F=${((c.flow||0)*100).toFixed(1)}% C=${((c.care||0)*100).toFixed(1)}% S=${((c.intent_coherence||0)*100).toFixed(1)}%`
        ).join('\n');

        const systemPrompt = `You are Oggy, a Harmony Map "What If?" scenario analyst. You analyze targeted what-if scenarios about cities and regions observable on the Harmony Map.

SELECTED CITY: ${node.name} (pop: ${node.population ? Number(node.population).toLocaleString() : 'unknown'})
Current scores: H=${((node.harmony||0)*100).toFixed(1)}% E=${((node.e_scaled||0)*100).toFixed(1)}% B=${((node.balance||0)*100).toFixed(1)}% F=${((node.flow||0)*100).toFixed(1)}% C=${((node.care||0)*100).toFixed(1)}% S=${((node.intent_coherence||0)*100).toFixed(1)}%

INDICATORS:
${indicatorContext}

TOP DRIVERS:
${driverContext}

TOP DRAGS:
${dragContext}

RECENT PROGRESSION (last 30 snapshots):
${progressionContext || '  No historical data yet'}

ALL CITIES FOR COMPARISON:
${allCityContext}

EQUILIBRIUM CANON:
H = sqrt(E * S), E = (B*F*C)^(1/3), S = sqrt(A*X), C = Compassion*Discernment
Dimensions: balance, flow, compassion, discernment, awareness, expression

YOUR ROLE:
1. Answer "what if" scenarios with quantitative reasoning. Estimate how score changes would propagate through the formula chain.
2. Use publicly available data, historical trends, and cross-city comparisons.
3. When you notice gaps in the model, proactively suggest new metrics or data points.
4. If you have a concrete suggestion, append it as a JSON block at the end of your response like:
   ===SUGGESTIONS===
   [{"suggestion_type":"new_indicator","title":"...","description":"...","payload":{...}}]

Be concise, data-driven, and actionable.`;

        await costGovernor.checkBudget(8000);

        const oggyMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const baseMessages = [
            { role: 'system', content: `You are a city analysis assistant. Answer what-if scenario questions about ${node.name}. Current H=${((node.harmony||0)*100).toFixed(1)}%. Be concise.\n\nAll cities:\n${allCityContext}` },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const [oggyResult, baseResult] = await Promise.all([
            (async () => {
                const resolved = await providerResolver.getAdapter(userId, 'oggy');
                const r = await resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: oggyMessages,
                    temperature: 0.7,
                    max_tokens: 1500
                });
                costGovernor.recordUsage(r.tokens_used || 1000);
                providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'harmonyWhatIf', r.tokens_used, r.latency_ms, true, null);
                return { text: r.text };
            })(),
            (async () => {
                try {
                    const resolved = await providerResolver.getAdapter(userId, 'base');
                    const r = await resolved.adapter.chatCompletion({
                        model: resolved.model,
                        messages: baseMessages,
                        temperature: 0.7,
                        max_tokens: 1000
                    });
                    costGovernor.recordUsage(r.tokens_used || 800);
                    providerResolver.logRequest(userId, resolved.provider, resolved.model, 'base', 'harmonyWhatIf', r.tokens_used, r.latency_ms, true, null);
                    return { text: r.text };
                } catch (err) {
                    return { text: 'Base model unavailable.' };
                }
            })()
        ]);

        // Extract embedded suggestions from Oggy's response
        let oggyText = oggyResult.text;
        let suggestions = [];
        const sugMarker = '===SUGGESTIONS===';
        const sugIdx = oggyText.indexOf(sugMarker);
        if (sugIdx !== -1) {
            const sugJson = oggyText.substring(sugIdx + sugMarker.length).trim();
            oggyText = oggyText.substring(0, sugIdx).trim();
            try {
                const parsed = JSON.parse(sugJson.match(/\[[\s\S]*\]/)?.[0] || '[]');
                for (const s of parsed) {
                    const saved = await harmonySuggestionService.createSuggestion(userId, {
                        node_id: node_id,
                        suggestion_type: s.suggestion_type,
                        title: s.title,
                        description: s.description,
                        payload: s.payload || {},
                        source: 'chat',
                    });
                    suggestions.push(saved);
                }
            } catch (parseErr) {
                logger.debug('Failed to parse whatif suggestions', { error: parseErr.message });
            }
        }

        res.json({
            oggy_response: oggyText,
            base_response: baseResult.text,
            suggestions,
            domain: 'harmony',
        });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-whatif-chat' });
        res.status(500).json({ error: 'What-if chat failed', message: err.message });
    }
});

// ──────────────────────────────────────────────────
// Suggestions
// ──────────────────────────────────────────────────

router.get('/suggestions', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id;
        const suggestions = await harmonySuggestionService.listSuggestions(userId, {
            status: req.query.status,
            node_id: req.query.node_id,
        });
        res.json({ suggestions, count: suggestions.length });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-list-suggestions' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/suggestions/:id/accept', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const result = await harmonySuggestionService.acceptSuggestion(req.params.id, userId);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-accept-suggestion' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/suggestions/:id/reject', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const result = await harmonySuggestionService.rejectSuggestion(req.params.id, userId);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-reject-suggestion' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/generate-suggestions', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const { count = 10, focus = 'all' } = req.body;
        const suggestions = await harmonySuggestionService.generateOnDemand(userId, count, focus);
        res.json({ suggestions, count: suggestions.length });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-generate-suggestions' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Suggestion auto-generation loop
// ──────────────────────────────────────────────────

router.post('/suggestions/auto/start', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const { interval_minutes = 10 } = req.body;
        const loop = suggestionLoop.getInstance(userId);
        const result = await loop.start(userId, { intervalMinutes: interval_minutes });
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-suggestion-loop-start' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/suggestions/auto/stop', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const loop = suggestionLoop.getInstance(userId);
        const result = loop.stop();
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-suggestion-loop-stop' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/suggestions/auto/status', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id;
        const loop = suggestionLoop.getInstance(userId);
        res.json(loop.getStatus());
    } catch (err) {
        logger.logError(err, { operation: 'harmony-suggestion-loop-status' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// Maintenance: Clean up broad/vague indicators
// ──────────────────────────────────────────────────

router.post('/maintenance/cleanup-broad-indicators', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const dryRun = req.body.dry_run !== false; // default dry_run=true

        // Find indicators that fail the specificity guard
        const allIndicators = await query('SELECT indicator_id, key, name, description FROM harmony_indicators');
        const broad = [];

        for (const ind of allIndicators.rows) {
            const check = harmonySuggestionService._validateIndicatorSpecificity(ind.key, ind.name, ind.description);
            if (!check.valid) {
                broad.push({ ...ind, reason: check.reason });
            }
        }

        if (dryRun) {
            return res.json({ dry_run: true, broad_indicators: broad, count: broad.length });
        }

        // Actually remove broad indicators and their associated data
        const removed = [];
        for (const ind of broad) {
            // Remove indicator values
            await query('DELETE FROM harmony_indicator_values WHERE indicator_id = $1', [ind.indicator_id]);
            // Remove weights
            await query('DELETE FROM harmony_weights WHERE indicator_key = $1', [ind.key]);
            // Remove normalization bounds
            await query('DELETE FROM harmony_normalization_bounds WHERE indicator_key = $1', [ind.key]);
            // Remove the indicator itself
            await query('DELETE FROM harmony_indicators WHERE indicator_id = $1', [ind.indicator_id]);
            removed.push({ key: ind.key, name: ind.name, reason: ind.reason });
            logger.info('Removed broad indicator', { key: ind.key, name: ind.name, reason: ind.reason });
        }

        // Recompute scores for all city nodes after cleanup
        if (removed.length > 0) {
            const allNodes = await query("SELECT node_id FROM harmony_nodes WHERE scope = 'city'");
            for (const n of allNodes.rows) {
                try {
                    await harmonyEngine.computeScores(n.node_id);
                } catch (err) {
                    logger.warn('Score recompute after cleanup failed', { nodeId: n.node_id, error: err.message });
                }
            }
        }

        await auditService.logAction(userId, 'cleanup_broad_indicators', 'maintenance', null, null, { removed_count: removed.length, removed });

        res.json({ dry_run: false, removed, count: removed.length });
    } catch (err) {
        logger.logError(err, { operation: 'harmony-cleanup-broad-indicators' });
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────────
// SDL-driven suggestion generation
// ──────────────────────────────────────────────────

router.post('/suggestions/sdl/start', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const sdl = harmonySdl.getInstance(userId, 'suggestions');
        const result = await sdl.start(userId, {
            mode: 'suggestions',
            intervalMinutes: req.body.interval_minutes || 1,
            attemptsPerSession: req.body.attempts || 5
        });
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-sdl-suggestion-start' });
        res.status(500).json({ error: err.message });
    }
});

router.post('/suggestions/sdl/stop', async (req, res) => {
    try {
        const userId = req.userId || req.body.user_id;
        const sdl = harmonySdl.getInstance(userId, 'suggestions');
        const result = sdl.stop();
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'harmony-sdl-suggestion-stop' });
        res.status(500).json({ error: err.message });
    }
});

router.get('/suggestions/sdl/status', async (req, res) => {
    try {
        const userId = req.userId || req.query.user_id;
        const sdl = harmonySdl.getInstance(userId, 'suggestions');
        res.json(sdl.getStats());
    } catch (err) {
        logger.logError(err, { operation: 'harmony-sdl-suggestion-status' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
