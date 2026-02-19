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

const REDIS_KEY = 'harmony:new_indicators';

class HarmonySuggestionService {
    constructor() {
        this.redis = null;
    }

    setRedisClient(client) {
        this.redis = client;
    }

    /**
     * Specificity guard — rejects indicators that are too broad or vague.
     * Returns { valid: true } or { valid: false, reason: '...' }
     */
    _validateIndicatorSpecificity(key, name, description) {
        // Reject if name is too long (specific metrics have concise names)
        if (name && name.length > 80) {
            return { valid: false, reason: `Indicator name too long (${name.length} chars). Must be a concise metric name under 80 chars.` };
        }

        // Reject if name contains vague/broad phrases
        const vaguePatterns = [
            /\bvarious\b/i, /\bmultiple\b/i, /\bseveral\b/i, /\bnumerous\b/i,
            /\bintegrate\s+data\b/i, /\bintegrate\s+.{10,}\s+data\b/i,
            /\binform\s+.*indicators?\b/i, /\brelated\s+to\b/i,
            /\band\s+\w+\s+and\b/i,  // "X and Y and Z" pattern
            /\bsocioeconomic\s+status.*transportation/i,
            /\btransportation.*socioeconomic/i,
        ];
        const combined = `${name || ''} ${description || ''}`;
        for (const pattern of vaguePatterns) {
            if (pattern.test(combined)) {
                return { valid: false, reason: `Indicator appears too broad/vague: matches pattern "${pattern}". Indicators must be specific, single-metric measurements.` };
            }
        }

        // Reject if name/description mentions 3+ different dimension keywords (multi-topic)
        const dimensionKeywords = {
            balance: /\b(safety|crime|housing|income|inequality|homeless|economic stability)\b/i,
            flow: /\b(commute|transit|transportation|labor|employment|infrastructure|mobility)\b/i,
            compassion: /\b(health|food security|insecurity|eviction|mental health|uninsured)\b/i,
            discernment: /\b(education|school|college|graduation|library|voter|civic engagement)\b/i,
            awareness: /\b(environment|community|transparency|wellbeing|quality of life)\b/i,
            expression: /\b(arts|culture|creative|freedom|cultural participation)\b/i,
        };
        const matchedDimensions = Object.entries(dimensionKeywords)
            .filter(([, regex]) => regex.test(combined))
            .map(([dim]) => dim);
        if (matchedDimensions.length >= 3) {
            return { valid: false, reason: `Indicator spans ${matchedDimensions.length} dimensions (${matchedDimensions.join(', ')}). Must be a single-metric indicator for one dimension.` };
        }

        // Reject if key is a vague action phrase (e.g. "integrate_american_community_survey_data")
        if (key && key.length > 60) {
            return { valid: false, reason: `Indicator key too long (${key.length} chars). Keys should be concise snake_case metric names.` };
        }
        if (key && /^(integrate|add|incorporate|include|use)_/.test(key)) {
            return { valid: false, reason: `Indicator key "${key}" starts with an action verb. Keys should be metric names, not action descriptions.` };
        }

        return { valid: true };
    }

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

        // Only clear NEW badges when the suggestion type can add indicators
        // (new_indicator always adds; model_update may fall through to _applyNewIndicator)
        if (this.redis && (suggestion.suggestion_type === 'new_indicator' || suggestion.suggestion_type === 'model_update')) {
            try { await this.redis.del(REDIS_KEY); } catch (_) {}
        }

        const payload = suggestion.payload;
        let affectedNodeId = suggestion.node_id;

        // Capture scores BEFORE applying the change (for impact tracking)
        const scoresBefore = {};
        try {
            const nodesRes = await query("SELECT node_id, name FROM harmony_nodes WHERE scope = 'city'");
            for (const n of nodesRes.rows) {
                const sr = await query('SELECT harmony, balance, flow, care, awareness, expression, intent_coherence, compassion, discernment FROM harmony_scores WHERE node_id = $1 ORDER BY time_window_start DESC LIMIT 1', [n.node_id]);
                if (sr.rows[0]) scoresBefore[n.node_id] = { ...sr.rows[0], name: n.name };
            }
        } catch (_) {}

        let recomputeAll = false;

        switch (suggestion.suggestion_type) {
            case 'new_indicator':
                await this._applyNewIndicator(payload, userId, suggestion.node_id);
                // If scoped to a specific node, only recompute that node
                if (suggestion.node_id) {
                    affectedNodeId = suggestion.node_id;
                } else {
                    recomputeAll = true;
                }
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
                // Try to apply model_update as a real change if payload has structured data
                await this._applyModelUpdate(payload, userId, suggestion.node_id);
                recomputeAll = true;
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

        // Capture scores AFTER recompute and store impact in suggestion payload
        try {
            const nodesRes = await query("SELECT node_id, name FROM harmony_nodes WHERE scope = 'city'");
            const impact = {};
            for (const n of nodesRes.rows) {
                const sr = await query('SELECT harmony, balance, flow, care, awareness, expression, intent_coherence, compassion, discernment FROM harmony_scores WHERE node_id = $1 ORDER BY time_window_start DESC LIMIT 1', [n.node_id]);
                if (!sr.rows[0] || !scoresBefore[n.node_id]) continue;
                const before = scoresBefore[n.node_id];
                const after = sr.rows[0];
                const dims = ['harmony', 'balance', 'flow', 'care', 'awareness', 'expression', 'intent_coherence', 'compassion', 'discernment'];
                const deltas = {};
                let hasDelta = false;
                for (const dim of dims) {
                    const bv = parseFloat(before[dim]) || 0;
                    const av = parseFloat(after[dim]) || 0;
                    const delta = av - bv;
                    if (Math.abs(delta) >= 0.0001) {
                        deltas[dim] = { before: bv, after: av, delta };
                        hasDelta = true;
                    }
                }
                if (hasDelta) {
                    impact[n.node_id] = { name: n.name, deltas };
                }
            }
            if (Object.keys(impact).length > 0) {
                const updatedPayload = { ...payload, _impact: impact };
                await query('UPDATE harmony_suggestions SET payload = $1 WHERE suggestion_id = $2',
                    [JSON.stringify(updatedPayload), suggestionId]);
            }
        } catch (err) {
            logger.debug('Post-apply impact capture failed', { error: err.message });
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

    async _applyNewIndicator(payload, userId, nodeId) {
        let { key, name, dimension, direction, unit, description, bounds, weight } = payload;
        if (!key || !name || !dimension) throw new Error('new_indicator requires key, name, dimension');

        // Specificity guard — reject broad/vague indicators
        const specificity = this._validateIndicatorSpecificity(key, name, description);
        if (!specificity.valid) {
            logger.warn('Indicator rejected by specificity guard', { key, name, reason: specificity.reason });
            throw new Error(`Indicator too broad: ${specificity.reason}`);
        }

        // Auto-clean city-specific indicator names → strip city prefix to make general
        const cityNames = await query("SELECT LOWER(name) AS name FROM harmony_nodes WHERE scope = 'city'");
        for (const { name: city } of cityNames.rows) {
            const cityUnderscore = city.replace(/\s+/g, '_');
            if (key.toLowerCase().startsWith(cityUnderscore + '_')) {
                const oldKey = key;
                key = key.substring(cityUnderscore.length + 1);
                logger.info('Auto-cleaned city prefix from indicator key', { oldKey, newKey: key, city });
            }
            if (name.toLowerCase().startsWith(city + ' ')) {
                const oldName = name;
                name = name.substring(city.length + 1);
                logger.info('Auto-cleaned city prefix from indicator name', { oldName, newName: name, city });
            }
        }

        // Reject indicators that still reference a specific city after prefix stripping
        const combinedLower = `${key} ${name}`.toLowerCase();
        for (const { name: city } of cityNames.rows) {
            if (combinedLower.includes(city)) {
                logger.warn('Indicator rejected: city-specific after cleanup', { key, name, city });
                throw new Error(`Indicator "${name}" is city-specific (references "${city}"). Indicators must be general metrics.`);
            }
        }

        // Insert indicator (global definition)
        await query(`
            INSERT INTO harmony_indicators (key, name, dimension, direction, unit, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (key) DO NOTHING
        `, [key, name, dimension, direction || 'higher_is_better', unit || '', description || '']);

        // Insert bounds
        const minVal = (bounds && bounds.min != null) ? bounds.min : 0;
        const maxVal = (bounds && bounds.max != null) ? bounds.max : 100;
        await query(`
            INSERT INTO harmony_normalization_bounds (indicator_key, version, min_value, max_value, scope)
            VALUES ($1, 1, $2, $3, 'global')
            ON CONFLICT (indicator_key, version, scope) DO NOTHING
        `, [key, minVal, maxVal]);

        // Insert weight
        await query(`
            INSERT INTO harmony_weights (version, indicator_key, weight, scope, created_by)
            VALUES (1, $1, $2, 'global', $3)
            ON CONFLICT (version, indicator_key, scope) DO NOTHING
        `, [key, weight || 1.0, userId]);

        // Populate indicator values for the target node(s)
        const indResult = await query('SELECT indicator_id FROM harmony_indicators WHERE key = $1', [key]);
        if (indResult.rows[0]) {
            const indicatorId = indResult.rows[0].indicator_id;
            const dir = direction || 'higher_is_better';

            // Determine which nodes to populate
            let targetNodes;
            if (nodeId) {
                targetNodes = await query('SELECT node_id FROM harmony_nodes WHERE node_id = $1', [nodeId]);
            } else {
                targetNodes = await query("SELECT node_id FROM harmony_nodes WHERE scope = 'city'");
            }

            for (const node of targetNodes.rows) {
                // Get the node's existing score for this dimension to reverse-normalize
                const scoreResult = await query('SELECT * FROM harmony_scores WHERE node_id = $1 ORDER BY time_window_start DESC LIMIT 1', [node.node_id]);
                const dimScore = scoreResult.rows[0] ? (scoreResult.rows[0][dimension] || 0.5) : 0.5;

                // Reverse normalization with jitter
                let rawValue;
                if (dir === 'lower_is_better') {
                    rawValue = maxVal - dimScore * (maxVal - minVal);
                } else {
                    rawValue = minVal + dimScore * (maxVal - minVal);
                }
                const jitter = 1 + (Math.random() - 0.5) * 0.10;
                rawValue = Math.max(minVal, Math.min(maxVal, rawValue * jitter));
                rawValue = Math.round(rawValue * 100) / 100;

                await query(`
                    INSERT INTO harmony_indicator_values (node_id, indicator_id, time_window_start, time_window_end, raw_value, source_dataset)
                    VALUES ($1, $2, '2024-01-01', '2024-12-31', $3, 'suggestion_indicator')
                    ON CONFLICT (node_id, indicator_id, time_window_start) DO NOTHING
                `, [node.node_id, indicatorId, rawValue]);
            }

            logger.info('New indicator added via suggestion with data populated', { key, dimension, nodeId, nodesPopulated: targetNodes.rows.length });
        } else {
            logger.info('New indicator added via suggestion', { key, dimension });
        }

        // If suggestion includes dataset info, add to data catalog
        if (payload.dataset_name) {
            try {
                await query(`
                    INSERT INTO harmony_datasets (name, source_url, license, refresh_cadence, fields)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT DO NOTHING
                `, [payload.dataset_name, payload.dataset_url || '', payload.dataset_license || 'Public Domain',
                    payload.refresh_cadence || 'yearly', JSON.stringify([{ field: key, type: unit || 'index' }])]);
            } catch (dsErr) {
                logger.debug('Dataset insert skipped', { error: dsErr.message });
            }
        }

        // Mark indicator as new in Redis
        if (this.redis) {
            try { await this.redis.sAdd(REDIS_KEY, key); } catch (_) {}
        }
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

    async _applyModelUpdate(payload, userId, nodeId) {
        // Model updates often describe adding a new metric or data source.
        // Try to extract structured indicator data and apply it.
        const desc = (payload.change_description || payload.rationale || '').toLowerCase();
        const title = (payload.title || '').toLowerCase();

        // If the payload has indicator-like fields, treat as new_indicator
        if (payload.key || payload.indicator_key || payload.dimension) {
            const indicatorPayload = {
                key: payload.key || payload.indicator_key || desc.replace(/[^a-z0-9]+/g, '_').substring(0, 50),
                name: payload.name || payload.change_description || 'Model Update Indicator',
                dimension: payload.dimension || 'awareness',
                direction: payload.direction || 'higher_is_better',
                unit: payload.unit || 'index',
                description: payload.description || payload.change_description || '',
                bounds: payload.bounds || { min: 0, max: 100 },
                weight: payload.weight || 1.0,
            };
            try {
                await this._applyNewIndicator(indicatorPayload, userId, nodeId);
                return;
            } catch (err) {
                logger.warn('Model update failed to apply as indicator', { error: err.message });
            }
        }

        // If the description mentions adding a metric/index, try to auto-generate an indicator
        if (desc.includes('index') || desc.includes('metric') || desc.includes('indicator') ||
            title.includes('index') || title.includes('metric') || title.includes('add')) {
            // Extract a general key from the description — strip city names
            const cityNames = await query("SELECT LOWER(name) AS name FROM harmony_nodes WHERE scope = 'city'");
            let cleanName = payload.change_description || payload.title || 'Unknown Metric';
            for (const { name: city } of cityNames.rows) {
                cleanName = cleanName.replace(new RegExp(city, 'gi'), '').trim();
            }
            cleanName = cleanName.replace(/^(add|incorporate|include|the)\s+/i, '').trim();
            if (!cleanName) cleanName = 'Quality of Life Index';

            // Specificity guard — don't auto-convert broad model_updates to indicators
            const cleanKey = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const specificity = this._validateIndicatorSpecificity(cleanKey, cleanName, payload.rationale || '');
            if (!specificity.valid) {
                logger.info('Model update skipped auto-indicator conversion (too broad)', { cleanName, reason: specificity.reason });
                return; // Accept as informational only
            }

            // Determine dimension from context
            let dimension = 'awareness';
            const dimKeywords = {
                balance: ['safety', 'crime', 'housing', 'income', 'inequality', 'homeless'],
                flow: ['commute', 'transit', 'employment', 'labor', 'job', 'economic'],
                compassion: ['health', 'food', 'insecurity', 'eviction', 'mental', 'uninsured'],
                discernment: ['education', 'school', 'college', 'graduation', 'library', 'voter'],
                awareness: ['civic', 'community', 'transparency', 'engagement', 'wellbeing', 'quality of life'],
                expression: ['arts', 'culture', 'creative', 'protest', 'freedom'],
            };
            const combined = (cleanName + ' ' + (payload.rationale || '')).toLowerCase();
            for (const [dim, keywords] of Object.entries(dimKeywords)) {
                if (keywords.some(kw => combined.includes(kw))) {
                    dimension = dim;
                    break;
                }
            }

            const indicatorPayload = {
                key: cleanKey,
                name: cleanName,
                dimension,
                direction: 'higher_is_better',
                unit: 'index',
                description: payload.rationale || payload.change_description || '',
                bounds: { min: 0, max: 100 },
                weight: 1.0,
            };

            try {
                await this._applyNewIndicator(indicatorPayload, userId, nodeId);
                logger.info('Model update applied as new indicator', { key: cleanKey, name: cleanName, dimension });
                return;
            } catch (err) {
                logger.warn('Model update auto-indicator failed', { error: err.message, cleanName });
            }
        }

        // Fallback: store enriched context about what the data means
        const ctx = ((payload.change_description || '') + ' ' + (payload.rationale || '')).toLowerCase();
        const dimMap = {
            balance: ['safety', 'crime', 'housing', 'income', 'inequality', 'homeless', 'poverty'],
            flow: ['commute', 'transit', 'employment', 'labor', 'job', 'economic', 'transport'],
            compassion: ['health', 'food', 'insecurity', 'eviction', 'mental', 'uninsured', 'socioeconomic', 'medical'],
            discernment: ['education', 'school', 'college', 'graduation', 'library', 'voter', 'literacy'],
            awareness: ['civic', 'community', 'transparency', 'engagement', 'wellbeing', 'environment'],
            expression: ['arts', 'culture', 'creative', 'protest', 'freedom', 'media'],
        };
        const affectedDims = [];
        for (const [dim, keywords] of Object.entries(dimMap)) {
            if (keywords.some(kw => ctx.includes(kw))) affectedDims.push(dim);
        }
        payload._context = {
            dimensions: affectedDims.length > 0 ? affectedDims : ['general'],
            effect: 'contextual_data',
            description: payload.change_description || payload.rationale || 'Data integration'
        };
        logger.info('Model update accepted (contextual)', { description: payload.change_description || 'N/A', dimensions: affectedDims });
    }

    async _applyNewCity(payload, userId) {
        // Accept both 'name' and 'city_name' fields
        const cityName = payload.name || payload.city_name;
        const { lat, lng, population, country, state } = payload;
        if (!cityName || lat == null || lng == null) throw new Error('new_city requires name, lat, lng');

        const existing = await query('SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = $2', [cityName, 'city']);
        if (existing.rows.length > 0) {
            logger.info('City already exists, skipping add', { cityName });
            return existing.rows[0].node_id;
        }

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
            `${n.name} [${n.node_id}]: H=${((n.harmony||0)*100).toFixed(1)}% E=${((n.e_scaled||0)*100).toFixed(1)}% B=${((n.balance||0)*100).toFixed(1)}% F=${((n.flow||0)*100).toFixed(1)}% C=${((n.care||0)*100).toFixed(1)}%`
        ).join('\n');
        // Build city name→UUID lookup for post-processing
        const cityNameToId = {};
        for (const n of nodes.rows) {
            cityNameToId[n.name.toLowerCase()] = n.node_id;
        }
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
  - new_indicator: {"key":"snake_case_key","name":"Display Name","dimension":"balance|flow|compassion|discernment|awareness|expression","direction":"higher_is_better|lower_is_better","unit":"per 100k|%|index","description":"What this measures","bounds":{"min":0,"max":100},"weight":1.0,"source_rationale":"Why this metric matters","target_city":"City Name or null if applies globally"}
  - new_data_point: {"indicator_key":"existing_key","node_id":"city_uuid","raw_value":123.4,"source_dataset":"Source name","time_window_start":"2024-01-01"}
  - weight_adjustment: {"indicator_key":"existing_key","current_weight":1.0,"proposed_weight":1.5,"rationale":"Why adjust"}
  - model_update: {"change_description":"What to change","rationale":"Why"}
  - new_city: {"name":"City Name","lat":37.8044,"lng":-122.2712,"population":433031,"country":"US","state":"California","rationale":"Why this city should be tracked"}

IMPORTANT RULES:
- For new_indicator: ONLY suggest GENERAL metrics that apply to ALL cities (e.g., "Air Quality Index", "Median Household Income"). NEVER suggest city-specific indicators (e.g., "Detroit Creative Corridor Index", "Portland Transit Ridership"). The indicator must be a universally measurable metric.
- EACH indicator must measure EXACTLY ONE specific thing. Never combine multiple topics into one indicator. BAD: "Community Survey covering transportation, education, and health". GOOD: "Average Commute Time (minutes)", "High School Graduation Rate (%)", "Uninsured Rate (%)".
- Indicator names must be concise (under 60 chars) and be the name of a measurable metric, NOT a description of an action. BAD: "Integrate American Community Survey data into metrics". GOOD: "Labor Force Participation Rate (%)".
- Each indicator belongs to exactly ONE dimension. If a data source covers multiple dimensions, create SEPARATE indicators for each.
- For city-specific suggestions, include "target_city" with the exact city name from the list above.
- Use the UUID shown in brackets [uuid] for node_id fields.
- Only suggest publicly available, credible data sources.
- For new_city: NEVER suggest a city that already exists in the list above. Only suggest cities NOT already on the map.
- For new_indicator: NEVER suggest an indicator with a key that already exists in the indicator list above. Only suggest NEW metrics not already tracked.
- For model_update: NEVER suggest adding a metric or index that already exists as an indicator above. Only suggest genuinely new methodology changes.
- For weight_adjustment: ONLY adjust weights for indicators that exist in the list above.
Respond ONLY with the JSON array, no other text.`;

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

        // Store each suggestion, resolving target_city → node_id
        const stored = [];
        for (const s of suggestions.slice(0, count)) {
            try {
                // Skip suggestions for things that already exist
                if (s.suggestion_type === 'new_city') {
                    const cityName = s.payload?.name || s.payload?.city_name;
                    if (cityName) {
                        const exists = await query("SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = 'city'", [cityName]);
                        if (exists.rows.length > 0) {
                            logger.info('Skipping new_city suggestion for existing city', { cityName });
                            continue;
                        }
                    }
                }
                if (s.suggestion_type === 'new_indicator') {
                    const key = s.payload?.key;
                    if (key) {
                        const exists = await query("SELECT indicator_id FROM harmony_indicators WHERE key = $1", [key]);
                        if (exists.rows.length > 0) {
                            logger.info('Skipping new_indicator suggestion for existing indicator', { key });
                            continue;
                        }
                    }
                }
                if (s.suggestion_type === 'model_update') {
                    const key = s.payload?.key || s.payload?.indicator_key;
                    if (key) {
                        const exists = await query("SELECT indicator_id FROM harmony_indicators WHERE key = $1", [key]);
                        if (exists.rows.length > 0) {
                            logger.info('Skipping model_update suggestion for existing indicator', { key });
                            continue;
                        }
                    }
                }
                // Resolve target_city to node_id if present
                let resolvedNodeId = s.payload?.node_id || null;
                if (!resolvedNodeId && s.payload?.target_city) {
                    resolvedNodeId = cityNameToId[s.payload.target_city.toLowerCase()] || null;
                }
                const saved = await this.createSuggestion(userId, {
                    node_id: resolvedNodeId,
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

    // ──────────────────────────────────────────────────
    // Data Catalog — check for new datasets/metrics
    // ──────────────────────────────────────────────────

    async generateDataCatalogSuggestions(userId, count = 5) {
        const [datasets, indicators] = await Promise.all([
            query('SELECT name, source_url, license, fields FROM harmony_datasets ORDER BY name'),
            query('SELECT key, name, dimension, direction, unit FROM harmony_indicators ORDER BY dimension, key'),
        ]);

        const datasetList = datasets.rows.map(d => {
            const fields = (d.fields || []).map(f => f.field).join(', ');
            return `${d.name} (${d.source_url || 'no url'}) — fields: ${fields || 'none'}`;
        }).join('\n');

        const indicatorList = indicators.rows.map(i =>
            `${i.key} (${i.dimension}, ${i.direction}, ${i.unit})`
        ).join('\n');

        const systemPrompt = `You are Oggy, an expert at finding publicly available datasets to improve city well-being measurement.

Current datasets in the catalog (${datasets.rows.length} total):
${datasetList || '(none)'}

Current indicators (${indicators.rows.length} total):
${indicatorList || '(none)'}

The Equilibrium Canon framework dimensions: balance, flow, compassion, discernment, awareness, expression.

Suggest exactly ${count} NEW publicly-available data sources that could add metrics to the Harmony Map.
Each suggestion must be a data source NOT already in the catalog, with specific measurable metrics.

For each suggestion, respond with a JSON array. Each item must have:
- "title": short title for the suggestion
- "description": 1-2 sentence explanation of what this data source adds
- "payload": {
    "key": "snake_case_metric_key",
    "name": "Display Name of Metric",
    "dimension": "balance|flow|compassion|discernment|awareness|expression",
    "direction": "higher_is_better|lower_is_better",
    "unit": "per 100k|%|index|score 0-1|minutes|rate",
    "description": "What this metric measures",
    "bounds": {"min": 0, "max": 100},
    "weight": 1.0,
    "dataset_name": "Name of the Data Source",
    "dataset_url": "https://example.gov/data",
    "dataset_license": "Public Domain|CC BY 4.0|Open Data",
    "refresh_cadence": "yearly|monthly|quarterly"
  }

RULES:
- NEVER suggest a dataset or metric that already exists in the lists above
- Each metric must be GENERAL (applicable to ALL US cities), not city-specific
- Metric names must be concise (under 60 chars) and measure ONE specific thing
- Only suggest real, publicly accessible government or institutional data sources
- Include the actual URL where the data can be found

Respond ONLY with the JSON array, no other text.`;

        await costGovernor.checkBudget(6000);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const r = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Suggest ${count} new data sources for the Harmony Map data catalog.` }
            ],
            temperature: 0.7,
            max_tokens: 2500,
            timeout: 45000
        });
        costGovernor.recordUsage(r.tokens_used || 1500);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'dataCatalogSuggestions', r.tokens_used, r.latency_ms, true, null);

        const suggestions = this._parseJsonSuggestions(r.text);

        // Store each suggestion
        const stored = [];
        for (const s of suggestions.slice(0, count)) {
            try {
                const key = s.payload?.key;
                if (key) {
                    const exists = await query("SELECT indicator_id FROM harmony_indicators WHERE key = $1", [key]);
                    if (exists.rows.length > 0) continue;
                }
                const saved = await this.createSuggestion(userId, {
                    node_id: null,
                    suggestion_type: 'new_indicator',
                    title: s.title,
                    description: s.description,
                    payload: s.payload || {},
                    source: 'data_catalog',
                });
                stored.push(saved);
            } catch (err) {
                logger.warn('Failed to store catalog suggestion', { title: s.title, error: err.message });
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
