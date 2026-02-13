/**
 * Scenario Service — What-if sandbox for Harmony Map
 *
 * Allows users to adjust indicator values and see projected score changes.
 */

const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const harmonyEngine = require('./harmonyEngine');
const auditService = require('./auditService');

class ScenarioService {

    /**
     * Create a new scenario with adjusted indicator values
     */
    async createScenario(userId, { name, description, baseNodeId, adjustments }) {
        const result = await query(`
            INSERT INTO harmony_scenarios (user_id, name, description, base_node_id, adjustments, status)
            VALUES ($1, $2, $3, $4, $5, 'draft')
            RETURNING *
        `, [userId, name, description || null, baseNodeId, JSON.stringify(adjustments)]);

        await auditService.logAction(userId, 'create_scenario', 'scenario', result.rows[0].scenario_id, null, result.rows[0]);

        return result.rows[0];
    }

    /**
     * Recompute projected scores for a scenario
     */
    async recomputeProjections(scenarioId) {
        const scenarioResult = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        if (!scenarioResult.rows[0]) throw new Error('Scenario not found');

        const scenario = scenarioResult.rows[0];
        const nodeId = scenario.base_node_id;
        const adjustments = scenario.adjustments || {};

        logger.info('Recomputing scenario projections', {
            scenarioId,
            nodeId,
            adjustmentKeys: Object.keys(adjustments),
            adjustments,
        });

        // Get current indicator values for the base node (latest time window only, deduplicated)
        const valuesResult = await query(`
            SELECT DISTINCT ON (hi.key) hi.key, hi.dimension, hi.direction, iv.raw_value
            FROM harmony_indicator_values iv
            JOIN harmony_indicators hi ON iv.indicator_id = hi.indicator_id
            WHERE iv.node_id = $1
            ORDER BY hi.key, iv.time_window_start DESC
        `, [nodeId]);

        // Load bounds and weights
        const boundsResult = await query(`
            SELECT indicator_key, min_value, max_value
            FROM harmony_normalization_bounds WHERE version = 1 AND scope = 'global'
        `);
        const bounds = {};
        for (const row of boundsResult.rows) {
            bounds[row.indicator_key] = { min: parseFloat(row.min_value), max: parseFloat(row.max_value) };
        }

        const weightsResult = await query(`
            SELECT indicator_key, weight
            FROM harmony_weights WHERE version = 1 AND scope = 'global'
        `);
        const weights = {};
        for (const row of weightsResult.rows) {
            weights[row.indicator_key] = parseFloat(row.weight);
        }

        // Apply adjustments and normalize
        const dimensions = { balance: [], flow: [], compassion: [], discernment: [], awareness: [], expression: [] };

        for (const row of valuesResult.rows) {
            const hasAdjustment = adjustments[row.key] != null;
            const rawValue = hasAdjustment ? parseFloat(adjustments[row.key]) : parseFloat(row.raw_value);
            const bound = bounds[row.key];
            if (!bound) continue;

            const normalized = harmonyEngine.normalize(rawValue, bound.min, bound.max, row.direction);

            if (hasAdjustment) {
                logger.info('Applying scenario adjustment', {
                    key: row.key, dimension: row.dimension,
                    original: parseFloat(row.raw_value), adjusted: rawValue, normalized,
                });
            }

            if (dimensions[row.dimension]) {
                dimensions[row.dimension].push({ value: normalized, weight: weights[row.key] || 1.0 });
            }
        }

        // Compute projected scores
        const B = harmonyEngine.weightedMean(dimensions.balance);
        const F = harmonyEngine.weightedMean(dimensions.flow);
        const compassion = harmonyEngine.weightedMean(dimensions.compassion);
        const discernment = harmonyEngine.weightedMean(dimensions.discernment);
        const A = harmonyEngine.weightedMean(dimensions.awareness);
        const X = harmonyEngine.weightedMean(dimensions.expression);

        const C = (compassion != null && discernment != null) ? compassion * discernment : null;
        const eScaled = (B != null && F != null && C != null) ? Math.pow(B * F * C, 1 / 3) : null;
        const S = (A != null && X != null) ? Math.sqrt(A * X) : null;
        const H = (eScaled != null && S != null) ? Math.sqrt(eScaled * S) : null;

        const projectedScores = {
            balance: B, flow: F, compassion, discernment, care: C,
            e_scaled: eScaled, awareness: A, expression: X,
            intent_coherence: S, harmony: H,
        };

        logger.info('Scenario projection results', {
            scenarioId, projectedScores,
            dimensionCounts: Object.fromEntries(Object.entries(dimensions).map(([k, v]) => [k, v.length])),
        });

        await query(`
            UPDATE harmony_scenarios SET projected_scores = $1, updated_at = NOW()
            WHERE scenario_id = $2
        `, [JSON.stringify(projectedScores), scenarioId]);

        return { scenario_id: scenarioId, projected_scores: projectedScores };
    }

    /**
     * Compare a scenario's projected scores against the baseline.
     * Always recomputes projections to ensure freshness.
     */
    async compareScenario(scenarioId) {
        const scenarioResult = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        if (!scenarioResult.rows[0]) throw new Error('Scenario not found');

        const scenario = scenarioResult.rows[0];

        // Always recompute projections for freshness (baseline scores may have changed)
        await this.recomputeProjections(scenarioId);
        const updated = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        scenario.projected_scores = updated.rows[0].projected_scores;

        // Get baseline scores
        const baselineResult = await query(`
            SELECT * FROM harmony_scores
            WHERE node_id = $1
            ORDER BY time_window_start DESC LIMIT 1
        `, [scenario.base_node_id]);

        const baseline = baselineResult.rows[0];
        if (!baseline) return { error: 'No baseline scores computed yet' };

        const fields = ['balance', 'flow', 'compassion', 'discernment', 'care', 'e_scaled', 'harmony'];
        const comparison = {};
        for (const field of fields) {
            const baseVal = parseFloat(baseline[field]);
            const projVal = scenario.projected_scores[field];
            if (baseVal != null && projVal != null) {
                comparison[field] = {
                    baseline: baseVal,
                    projected: projVal,
                    delta: projVal - baseVal,
                    pct_change: baseVal !== 0 ? ((projVal - baseVal) / baseVal) * 100 : 0,
                };
            }
        }

        return {
            scenario_id: scenarioId,
            scenario_name: scenario.name,
            base_node_id: scenario.base_node_id,
            adjustments: scenario.adjustments,
            comparison,
        };
    }

    /**
     * List scenarios for a user
     */
    async listScenarios(userId) {
        const result = await query(`
            SELECT s.*, n.name AS node_name
            FROM harmony_scenarios s
            LEFT JOIN harmony_nodes n ON s.base_node_id = n.node_id
            WHERE s.user_id = $1
            ORDER BY s.updated_at DESC
        `, [userId]);
        return result.rows;
    }

    /**
     * Delete a scenario
     */
    async deleteScenario(scenarioId, userId) {
        const before = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        if (!before.rows[0]) throw new Error('Scenario not found');

        await query('DELETE FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        await auditService.logAction(userId, 'delete_scenario', 'scenario', scenarioId, before.rows[0], null);

        return { deleted: true };
    }

    /**
     * Approve a scenario (mark as approved with audit trail)
     */
    async approveScenario(scenarioId, userId) {
        const before = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);
        if (!before.rows[0]) throw new Error('Scenario not found');

        await query(`
            UPDATE harmony_scenarios SET status = 'approved', updated_at = NOW()
            WHERE scenario_id = $1
        `, [scenarioId]);

        const after = await query('SELECT * FROM harmony_scenarios WHERE scenario_id = $1', [scenarioId]);

        await auditService.logAction(userId, 'approve_scenario', 'scenario', scenarioId, before.rows[0], after.rows[0]);

        return after.rows[0];
    }
}

module.exports = new ScenarioService();
