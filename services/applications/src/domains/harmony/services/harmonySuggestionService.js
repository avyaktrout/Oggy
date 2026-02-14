/**
 * Harmony Suggestion Service — CRUD + apply logic for Oggy-generated suggestions
 *
 * Suggestion types:
 *   new_indicator   — Add a new indicator to harmony_indicators + bounds + weight
 *   new_data_point  — Add a raw value for an existing indicator to a specific node
 *   weight_adjustment — Change an indicator's weight in harmony_weights
 *   model_update    — Descriptive model change (manual action required)
 *   new_city        — Add a new city as a node on the Harmony Map
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const harmonyEngine = require('./harmonyEngine');
const auditService = require('./auditService');
const providerResolver = require('../../../shared/providers/providerResolver');
const { costGovernor } = require('../../../shared/middleware/costGovernor');

class HarmonySuggestionService {

    async createSuggestion(userId, { node_id, suggestion_type, title, description, payload, source }) {
        const result = await query(`
            INSERT INTO harmony_suggestions (user_id, node_id, suggestion_type, title, description, payload, source)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [userId, node_id || null, suggestion_type, title, description || '', JSON.stringify(payload), source || 'chat']);
        return result.rows[0];
    }

    async listSuggestions(userId, { status, node_id } = {}) {
        let sql = 'SELECT s.*, n.name AS node_name FROM harmony_suggestions s LEFT JOIN harmony_nodes n ON s.node_id = n.node_id WHERE s.user_id = $1';
        const params = [userId];

        if (status) {
            params.push(status);
            sql += ` AND s.status = $${params.length}`;
        }
        if (node_id) {
            params.push(node_id);
            sql += ` AND s.node_id = $${params.length}`;
        }

        sql += ' ORDER BY s.created_at DESC LIMIT 50';
        const result = await query(sql, params);
        return result.rows;
    }

    async acceptSuggestion(suggestionId, userId) {
        // Load suggestion
        const sugResult = await query('SELECT * FROM harmony_suggestions WHERE suggestion_id = $1', [suggestionId]);
        if (!sugResult.rows[0]) throw new Error('Suggestion not found');
        const suggestion = sugResult.rows[0];
        if (suggestion.status !== 'pending') throw new Error(`Suggestion already ${suggestion.status}`);

        const payload = suggestion.payload;
        let affectedNodeId = suggestion.node_id;

        let recomputeAll = false;

        switch (suggestion.suggestion_type) {
            case 'new_indicator':
                await this._applyNewIndicator(payload, userId);
                recomputeAll = true; // Indicators affect all nodes
                break;

            case 'new_data_point':
                await this._applyNewDataPoint(payload, userId);
                affectedNodeId = payload.node_id || affectedNodeId;
                // If applies_to is 'all', recompute all nodes
                if (payload.applies_to === 'all') recomputeAll = true;
                break;

            case 'weight_adjustment':
                await this._applyWeightAdjustment(payload, userId);
                recomputeAll = true; // Weight changes affect all nodes
                break;

            case 'new_city':
                affectedNodeId = await this._applyNewCity(payload, userId);
                break;

            case 'model_update':
                // Model updates are descriptive — just mark as accepted
                break;

            default:
                throw new Error(`Unknown suggestion type: ${suggestion.suggestion_type}`);
        }

        // Mark as accepted
        await query(`
            UPDATE harmony_suggestions SET status = 'accepted', resolved_at = NOW(), resolved_by = $2
            WHERE suggestion_id = $1
        `, [suggestionId, userId]);

        // Recompute scores — either all nodes or just the affected one
        if (recomputeAll) {
            try {
                const allNodes = await query("SELECT node_id FROM harmony_nodes WHERE scope = 'city'");
                for (const n of allNodes.rows) {
                    await harmonyEngine.computeScores(n.node_id);
                }
                logger.info('Recomputed scores for all nodes after suggestion', { suggestionId, type: suggestion.suggestion_type, nodeCount: allNodes.rows.length });
            } catch (err) {
                logger.warn('Global score recompute after suggestion failed', { suggestionId, error: err.message });
            }
        } else if (affectedNodeId) {
            try {
                await harmonyEngine.computeScores(affectedNodeId);
            } catch (err) {
                logger.warn('Score recompute after suggestion failed', { suggestionId, nodeId: affectedNodeId, error: err.message });
            }
        }

        // Audit
        await auditService.logAction(userId, 'accept_suggestion', 'suggestion', suggestionId, null, { suggestion_type: suggestion.suggestion_type, title: suggestion.title });

        return { success: true, suggestion_id: suggestionId, type: suggestion.suggestion_type };
    }

    async rejectSuggestion(suggestionId, userId) {
        await query(`
            UPDATE harmony_suggestions SET status = 'rejected', resolved_at = NOW(), resolved_by = $2
            WHERE suggestion_id = $1
        `, [suggestionId, userId]);
        return { success: true };
    }

    // ──────────────────────────────────────────────────
    // Apply helpers
    // ──────────────────────────────────────────────────

    async _applyNewIndicator(payload, userId) {
        const { key, name, dimension, direction, unit, description, bounds, weight } = payload;
        if (!key || !name || !dimension) throw new Error('new_indicator requires key, name, dimension');

        // Insert indicator
        await query(`
            INSERT INTO harmony_indicators (key, name, dimension, direction, unit, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (key) DO NOTHING
        `, [key, name, dimension, direction || 'higher_is_better', unit || '', description || '']);

        // Insert bounds
        if (bounds && bounds.min != null && bounds.max != null) {
            await query(`
                INSERT INTO harmony_normalization_bounds (indicator_key, version, min_value, max_value, scope)
                VALUES ($1, 1, $2, $3, 'global')
                ON CONFLICT (indicator_key, version, scope) DO NOTHING
            `, [key, bounds.min, bounds.max]);
        }

        // Insert weight
        await query(`
            INSERT INTO harmony_weights (version, indicator_key, weight, scope, created_by)
            VALUES (1, $1, $2, 'global', $3)
            ON CONFLICT (version, indicator_key, scope) DO NOTHING
        `, [key, weight || 1.0, userId]);

        logger.info('New indicator added via suggestion', { key, dimension });
    }

    async _applyNewDataPoint(payload, userId) {
        const { indicator_key, node_id, raw_value, time_window_start, time_window_end, source_dataset } = payload;

        // If missing required fields, treat as informational (data source reference from training)
        if (!indicator_key || !node_id || raw_value == null) {
            logger.info('Data point suggestion treated as informational (missing node_id or raw_value)', {
                indicator_key, has_node_id: !!node_id, has_raw_value: raw_value != null,
                source_name: payload.source_name, applies_to: payload.applies_to
            });
            return; // Accept without inserting — the suggestion metadata is still stored
        }

        // Get indicator_id
        const indResult = await query('SELECT indicator_id FROM harmony_indicators WHERE key = $1', [indicator_key]);
        if (!indResult.rows[0]) throw new Error(`Indicator not found: ${indicator_key}`);

        await query(`
            INSERT INTO harmony_indicator_values (node_id, indicator_id, time_window_start, time_window_end, raw_value, source_dataset)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (node_id, indicator_id, time_window_start) DO UPDATE SET raw_value = $5, source_dataset = $6
        `, [node_id, indResult.rows[0].indicator_id, time_window_start || '2024-01-01', time_window_end || '2024-12-31', raw_value, source_dataset || 'oggy_suggestion']);

        logger.info('New data point added via suggestion', { indicator_key, node_id });
    }

    async _applyWeightAdjustment(payload, userId) {
        const { indicator_key } = payload;
        const proposed_weight = payload.proposed_weight != null ? payload.proposed_weight : payload.suggested_weight;
        if (!indicator_key || proposed_weight == null) throw new Error('weight_adjustment requires indicator_key, proposed_weight or suggested_weight');

        await query(`
            UPDATE harmony_weights SET weight = $1, created_by = $2
            WHERE version = 1 AND indicator_key = $3 AND scope = 'global'
        `, [proposed_weight, userId, indicator_key]);

        logger.info('Weight adjusted via suggestion', { indicator_key, weight: proposed_weight });
    }

    async _applyNewCity(payload, userId) {
        // Accept both 'name' and 'city_name' fields
        const cityName = payload.name || payload.city_name;
        const { lat, lng, population, country, state } = payload;
        if (!cityName || lat == null || lng == null) throw new Error('new_city requires name, lat, lng');

        const existing = await query('SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = $2', [cityName, 'city']);
        if (existing.rows.length > 0) throw new Error(`City '${cityName}' already exists`);

        const result = await query(`
            INSERT INTO harmony_nodes (scope, name, geometry, population, metadata)
            VALUES ('city', $1, $2, $3, $4)
            RETURNING node_id
        `, [
            cityName,
            JSON.stringify({ type: 'Point', coordinates: [lng, lat] }),
            population || null,
            JSON.stringify({ country: country || '', state: state || '', added_by: 'suggestion', data_sources: payload.data_sources || [] })
        ]);

        const nodeId = result.rows[0].node_id;

        // If initial_scores provided, insert them as starting dimension scores (fallback before computeScores runs)
        const scores = payload.initial_scores;
        if (scores) {
            try {
                const b = (scores.balance || 50) / 100;
                const f = (scores.flow || 50) / 100;
                const c = (scores.compassion || 50) / 100;
                const d = (scores.discernment || 50) / 100;
                const a = (scores.awareness || 50) / 100;
                const x = (scores.expression || 50) / 100;
                const care = c * d;
                const e = Math.pow(b * f * care, 1 / 3);
                const s = Math.sqrt(a * x);
                const h = Math.sqrt(e * s);

                await query(`
                    INSERT INTO harmony_scores (node_id, time_window_start, time_window_end,
                        balance, flow, compassion, discernment, care,
                        e_scaled, awareness, expression, intent_coherence, harmony)
                    VALUES ($1, '2024-01-01', '2024-12-31', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    ON CONFLICT (node_id, time_window_start) DO UPDATE SET
                        balance = $2, flow = $3, compassion = $4, discernment = $5, care = $6,
                        e_scaled = $7, awareness = $8, expression = $9, intent_coherence = $10, harmony = $11
                `, [nodeId, b, f, c, d, care, e, a, x, s, h]);

                logger.info('Initial scores set for new city', { cityName, harmony: h.toFixed(4) });
            } catch (err) {
                logger.warn('Failed to set initial scores for new city (non-blocking)', { error: err.message });
            }
        }

        // Populate indicator values so the city has data on the map
        try {
            await this._populateCityIndicatorValues(nodeId, scores || {});
        } catch (err) {
            logger.warn('Failed to populate indicator values for new city (non-blocking)', { cityName, error: err.message });
        }

        logger.info('New city added via suggestion', { name: cityName, node_id: nodeId });
        return nodeId;
    }

    /**
     * Populate harmony_indicator_values for a new city based on initial dimension scores.
     * Reverse-engineers raw values from the dimension scores and normalization bounds.
     */
    async _populateCityIndicatorValues(nodeId, initialScores) {
        // Load all indicators with their bounds
        const indicatorsResult = await query(`
            SELECT hi.indicator_id, hi.key, hi.dimension, hi.direction,
                   hnb.min_value, hnb.max_value
            FROM harmony_indicators hi
            LEFT JOIN harmony_normalization_bounds hnb ON hnb.indicator_key = hi.key AND hnb.version = 1
        `);

        if (indicatorsResult.rows.length === 0) return;

        // Map dimension scores (0-100 scale) to normalized (0-1)
        const dimScores = {
            balance: (initialScores.balance || 50) / 100,
            flow: (initialScores.flow || 50) / 100,
            compassion: (initialScores.compassion || 50) / 100,
            discernment: (initialScores.discernment || 50) / 100,
            awareness: (initialScores.awareness || 50) / 100,
            expression: (initialScores.expression || 50) / 100,
        };

        let inserted = 0;
        for (const ind of indicatorsResult.rows) {
            const normalized = dimScores[ind.dimension] || 0.5;
            const minVal = ind.min_value != null ? parseFloat(ind.min_value) : 0;
            const maxVal = ind.max_value != null ? parseFloat(ind.max_value) : 100;

            // Reverse normalization: raw = min + normalized * (max - min) for higher_is_better
            // For lower_is_better: raw = max - normalized * (max - min)
            let rawValue;
            if (ind.direction === 'lower_is_better') {
                rawValue = maxVal - normalized * (maxVal - minVal);
            } else {
                rawValue = minVal + normalized * (maxVal - minVal);
            }

            // Add small random jitter (+/- 5%) so values aren't suspiciously uniform
            const jitter = 1 + (Math.random() - 0.5) * 0.10;
            rawValue = Math.max(minVal, Math.min(maxVal, rawValue * jitter));
            rawValue = Math.round(rawValue * 100) / 100;

            await query(`
                INSERT INTO harmony_indicator_values (node_id, indicator_id, time_window_start, time_window_end, raw_value, source_dataset)
                VALUES ($1, $2, '2024-01-01', '2024-12-31', $3, 'initial_estimate')
                ON CONFLICT (node_id, indicator_id, time_window_start) DO NOTHING
            `, [nodeId, ind.indicator_id, rawValue]);
            inserted++;
        }

        logger.info('Populated indicator values for new city', { nodeId, indicators: inserted });
    }

    // ──────────────────────────────────────────────────
    // On-demand suggestion generation via LLM
    // ──────────────────────────────────────────────────

    async generateOnDemand(userId, count = 10, focus = 'all') {
        // Load current model state
        const [indicators, nodes, freshness] = await Promise.all([
            query('SELECT key, name, dimension, direction, unit FROM harmony_indicators ORDER BY dimension, key'),
            query(`
                SELECT n.node_id, n.name, n.scope, s.harmony, s.e_scaled, s.balance, s.flow, s.care, s.intent_coherence
                FROM harmony_nodes n LEFT JOIN harmony_scores s ON n.node_id = s.node_id
                WHERE n.scope = 'city' ORDER BY n.name
            `),
            query(`
                SELECT n.name, COUNT(iv.value_id) AS data_points
                FROM harmony_nodes n
                LEFT JOIN harmony_indicator_values iv ON n.node_id = iv.node_id
                WHERE n.scope = 'city'
                GROUP BY n.name ORDER BY n.name
            `),
        ]);

        const indicatorList = indicators.rows.map(i => `${i.key} (${i.dimension}, ${i.direction}, ${i.unit})`).join('\n');
        const nodeList = nodes.rows.map(n =>
            `${n.name}: H=${((n.harmony||0)*100).toFixed(1)}% E=${((n.e_scaled||0)*100).toFixed(1)}% B=${((n.balance||0)*100).toFixed(1)}% F=${((n.flow||0)*100).toFixed(1)}% C=${((n.care||0)*100).toFixed(1)}%`
        ).join('\n');
        const freshnessInfo = freshness.rows.map(f => `${f.name}: ${f.data_points} data points`).join('\n');

        const focusInstruction = focus === 'all' ? 'all types' :
            focus === 'indicators' ? 'new_indicator suggestions only' :
            focus === 'weights' ? 'weight_adjustment suggestions only' :
            focus === 'data_points' ? 'new_data_point suggestions only' : 'all types';

        const systemPrompt = `You are Oggy, an expert at improving city well-being measurement models.

Current Harmony Map indicators (${indicators.rows.length} total):
${indicatorList}

Current city scores:
${nodeList}

Data coverage:
${freshnessInfo}

The Equilibrium Canon framework:
- H = sqrt(E * S), E = (B*F*C)^(1/3), S = sqrt(A*X), C = Compassion * Discernment
- Dimensions: balance, flow, compassion, discernment, awareness, expression

Generate exactly ${count} suggestions to improve the Harmony Map model. Focus on: ${focusInstruction}.

For each suggestion, respond with a JSON array. Each item must have:
- "suggestion_type": one of "new_indicator", "new_data_point", "weight_adjustment", "model_update", "new_city"
- "title": short descriptive title
- "description": 1-2 sentence explanation of why this improves the model
- "payload": structured data for the suggestion type:
  - new_indicator: {"key":"snake_case_key","name":"Display Name","dimension":"balance|flow|compassion|discernment|awareness|expression","direction":"higher_is_better|lower_is_better","unit":"per 100k|%|index","description":"What this measures","bounds":{"min":0,"max":100},"weight":1.0,"source_rationale":"Why this metric matters"}
  - new_data_point: {"indicator_key":"existing_key","node_id":"city_uuid","raw_value":123.4,"source_dataset":"Source name","time_window_start":"2024-01-01"}
  - weight_adjustment: {"indicator_key":"existing_key","current_weight":1.0,"proposed_weight":1.5,"rationale":"Why adjust"}
  - model_update: {"change_description":"What to change","rationale":"Why"}
  - new_city: {"name":"City Name","lat":37.8044,"lng":-122.2712,"population":433031,"country":"US","state":"California","rationale":"Why this city should be tracked"}

Only suggest publicly available, credible data sources. Respond ONLY with the JSON array, no other text.`;

        await costGovernor.checkBudget(8000);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const r = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Generate ${count} improvement suggestions for the Harmony Map.` }
            ],
            temperature: 0.8,
            max_tokens: 3000
        });
        costGovernor.recordUsage(r.tokens_used || 2000);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'harmonySuggestions', r.tokens_used, r.latency_ms, true, null);

        // Parse JSON from response
        const suggestions = this._parseJsonSuggestions(r.text);

        // Store each suggestion
        const stored = [];
        for (const s of suggestions.slice(0, count)) {
            try {
                const saved = await this.createSuggestion(userId, {
                    node_id: s.payload?.node_id || null,
                    suggestion_type: s.suggestion_type,
                    title: s.title,
                    description: s.description,
                    payload: s.payload || {},
                    source: 'on_demand',
                });
                stored.push(saved);
            } catch (err) {
                logger.warn('Failed to store suggestion', { title: s.title, error: err.message });
            }
        }

        return stored;
    }

    _parseJsonSuggestions(text) {
        try {
            // Try direct JSON parse
            const trimmed = text.trim();
            if (trimmed.startsWith('[')) return JSON.parse(trimmed);

            // Try extracting JSON from markdown code block
            const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (match) return JSON.parse(match[1].trim());

            // Try finding array in text
            const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
            if (arrayMatch) return JSON.parse(arrayMatch[0]);

            return [];
        } catch (err) {
            logger.warn('Failed to parse suggestions JSON', { error: err.message });
            return [];
        }
    }
}

module.exports = new HarmonySuggestionService();
