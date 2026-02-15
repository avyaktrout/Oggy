/**
 * Harmony Engine — Core computation for Equilibrium Canon metrics
 *
 * Formulas:
 *   B = weighted_mean(Balance indicators)
 *   F = weighted_mean(Flow indicators)
 *   Compassion = weighted_mean(Compassion indicators)
 *   Discernment = weighted_mean(Discernment indicators)
 *   C = Compassion * Discernment
 *   E_raw = (B * F) * C
 *   E_scaled = (B * F * C)^(1/3)
 *   A = weighted_mean(Awareness indicators)
 *   X = weighted_mean(Expression indicators)
 *   S = sqrt(A * X)
 *   H = sqrt(E * S)
 */

const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const crypto = require('crypto');

class HarmonyEngine {

    /**
     * Normalize a raw value to 0-1 using min-max bounds
     */
    normalize(rawValue, minVal, maxVal, direction) {
        if (maxVal === minVal) return 0.5;
        let normalized = (rawValue - minVal) / (maxVal - minVal);
        normalized = Math.max(0, Math.min(1, normalized));
        // Invert for lower_is_better (low raw = high score)
        if (direction === 'lower_is_better') {
            normalized = 1 - normalized;
        }
        return normalized;
    }

    /**
     * Weighted mean of an array of {value, weight} pairs
     */
    weightedMean(items) {
        if (!items.length) return null;
        let totalWeight = 0;
        let weightedSum = 0;
        for (const { value, weight } of items) {
            if (value == null) continue;
            weightedSum += value * weight;
            totalWeight += weight;
        }
        return totalWeight > 0 ? weightedSum / totalWeight : null;
    }

    /**
     * Compute all scores for a node in a given time window
     */
    async computeScores(nodeId, timeWindowStart = '2024-01-01', timeWindowEnd = '2024-12-31') {
        // 1. Load raw indicator values for this node + time window
        const valuesResult = await query(`
            SELECT iv.raw_value, hi.key, hi.dimension, hi.direction
            FROM harmony_indicator_values iv
            JOIN harmony_indicators hi ON iv.indicator_id = hi.indicator_id
            WHERE iv.node_id = $1
              AND iv.time_window_start = $2
        `, [nodeId, timeWindowStart]);

        if (valuesResult.rows.length === 0) {
            logger.warn('No indicator values found for node', { nodeId, timeWindowStart });
            return null;
        }

        // 2. Load normalization bounds
        const boundsResult = await query(`
            SELECT indicator_key, min_value, max_value
            FROM harmony_normalization_bounds
            WHERE version = 1 AND scope = 'global'
        `);
        const bounds = {};
        for (const row of boundsResult.rows) {
            bounds[row.indicator_key] = { min: parseFloat(row.min_value), max: parseFloat(row.max_value) };
        }

        // 3. Load weights
        const weightsResult = await query(`
            SELECT indicator_key, weight
            FROM harmony_weights
            WHERE version = 1 AND scope = 'global'
        `);
        const weights = {};
        for (const row of weightsResult.rows) {
            weights[row.indicator_key] = parseFloat(row.weight);
        }

        // 4. Normalize all values and group by dimension
        const dimensions = { balance: [], flow: [], compassion: [], discernment: [], awareness: [], expression: [] };
        const normalizedValues = {};

        for (const row of valuesResult.rows) {
            const bound = bounds[row.key];
            if (!bound) continue;

            const normalized = this.normalize(
                parseFloat(row.raw_value),
                bound.min,
                bound.max,
                row.direction
            );
            normalizedValues[row.key] = normalized;

            // Update normalized_value in DB
            await query(`
                UPDATE harmony_indicator_values SET normalized_value = $1
                WHERE node_id = $2 AND indicator_id = (SELECT indicator_id FROM harmony_indicators WHERE key = $3)
                  AND time_window_start = $4
            `, [normalized, nodeId, row.key, timeWindowStart]);

            if (dimensions[row.dimension]) {
                dimensions[row.dimension].push({
                    value: normalized,
                    weight: weights[row.key] || 1.0,
                });
            }
        }

        // 5. Compute dimension scores
        const B = this.weightedMean(dimensions.balance);
        const F = this.weightedMean(dimensions.flow);
        const compassion = this.weightedMean(dimensions.compassion);
        const discernment = this.weightedMean(dimensions.discernment);
        const A = this.weightedMean(dimensions.awareness);
        const X = this.weightedMean(dimensions.expression);

        // 6. Compute top-level scores
        const C = (compassion != null && discernment != null) ? compassion * discernment : null;
        const eRaw = (B != null && F != null && C != null) ? (B * F) * C : null;
        const eScaled = (B != null && F != null && C != null) ? Math.pow(B * F * C, 1 / 3) : null;
        const S = (A != null && X != null) ? Math.sqrt(A * X) : null;
        const H = (eScaled != null && S != null) ? Math.sqrt(eScaled * S) : null;

        // 7. Compute audit hash
        const hashInput = JSON.stringify({ nodeId, timeWindowStart, normalizedValues, weights });
        const computationHash = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);

        // 8. Store scores
        await query(`
            INSERT INTO harmony_scores (node_id, time_window_start, time_window_end,
                balance, flow, compassion, discernment, care,
                e_raw, e_scaled, awareness, expression, intent_coherence, harmony,
                computation_hash, weight_version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1)
            ON CONFLICT (node_id, time_window_start)
            DO UPDATE SET
                balance = $4, flow = $5, compassion = $6, discernment = $7, care = $8,
                e_raw = $9, e_scaled = $10, awareness = $11, expression = $12,
                intent_coherence = $13, harmony = $14, computation_hash = $15
        `, [nodeId, timeWindowStart, timeWindowEnd,
            B, F, compassion, discernment, C,
            eRaw, eScaled, A, X, S, H, computationHash]);

        return {
            node_id: nodeId,
            time_window: { start: timeWindowStart, end: timeWindowEnd },
            dimensions: { balance: B, flow: F, compassion, discernment, care: C },
            scores: { e_raw: eRaw, e_scaled: eScaled, awareness: A, expression: X, intent_coherence: S, harmony: H },
            computation_hash: computationHash,
        };
    }

    /**
     * Compute scores for all nodes of a given scope
     */
    async computeAllNodes(scope = 'city', timeWindowStart = '2024-01-01', timeWindowEnd = '2024-12-31') {
        const nodesResult = await query('SELECT node_id FROM harmony_nodes WHERE scope = $1', [scope]);
        const results = [];
        for (const row of nodesResult.rows) {
            const result = await this.computeScores(row.node_id, timeWindowStart, timeWindowEnd);
            if (result) results.push(result);
        }
        return results;
    }

    /**
     * Get explainability data for a node's scores
     */
    async getExplainability(nodeId, timeWindowStart = '2024-01-01') {
        // Get indicator values with their normalized scores
        const result = await query(`
            SELECT hi.key, hi.name, hi.dimension, hi.direction, hi.unit,
                   hi.created_at AS indicator_created_at,
                   iv.raw_value, iv.normalized_value,
                   hnb.min_value AS bound_min, hnb.max_value AS bound_max,
                   hw.weight
            FROM harmony_indicator_values iv
            JOIN harmony_indicators hi ON iv.indicator_id = hi.indicator_id
            LEFT JOIN harmony_normalization_bounds hnb ON hnb.indicator_key = hi.key AND hnb.version = 1
            LEFT JOIN harmony_weights hw ON hw.indicator_key = hi.key AND hw.version = 1 AND hw.scope = 'global'
            WHERE iv.node_id = $1 AND iv.time_window_start = $2
            ORDER BY hi.dimension, hi.key
        `, [nodeId, timeWindowStart]);

        // Get computed scores
        const scoresResult = await query(`
            SELECT * FROM harmony_scores
            WHERE node_id = $1 AND time_window_start = $2
        `, [nodeId, timeWindowStart]);

        return {
            indicators: result.rows.map(r => ({
                key: r.key,
                name: r.name,
                dimension: r.dimension,
                direction: r.direction,
                unit: r.unit,
                raw_value: parseFloat(r.raw_value),
                normalized_value: r.normalized_value != null ? parseFloat(r.normalized_value) : null,
                bounds: { min: parseFloat(r.bound_min), max: parseFloat(r.bound_max) },
                weight: parseFloat(r.weight || 1),
                created_at: r.indicator_created_at,
            })),
            scores: scoresResult.rows[0] || null,
        };
    }

    /**
     * Compute drift between two time windows
     */
    async computeDrift(nodeId, timeWindow1Start, timeWindow2Start) {
        const [s1, s2] = await Promise.all([
            query('SELECT * FROM harmony_scores WHERE node_id = $1 AND time_window_start = $2', [nodeId, timeWindow1Start]),
            query('SELECT * FROM harmony_scores WHERE node_id = $1 AND time_window_start = $2', [nodeId, timeWindow2Start]),
        ]);

        if (!s1.rows[0] || !s2.rows[0]) return null;

        const fields = ['balance', 'flow', 'compassion', 'discernment', 'care', 'e_scaled', 'harmony'];
        const drift = {};
        for (const field of fields) {
            const v1 = parseFloat(s1.rows[0][field]);
            const v2 = parseFloat(s2.rows[0][field]);
            if (v1 != null && v2 != null && v1 !== 0) {
                drift[field] = { from: v1, to: v2, delta: v2 - v1, pct_change: ((v2 - v1) / v1) * 100 };
            }
        }
        return drift;
    }

    /**
     * Generate alerts for a node based on thresholds
     */
    async generateAlerts(nodeId) {
        const scoresResult = await query(`
            SELECT * FROM harmony_scores
            WHERE node_id = $1
            ORDER BY time_window_start DESC LIMIT 1
        `, [nodeId]);

        if (!scoresResult.rows[0]) return [];

        const scores = scoresResult.rows[0];
        const alerts = [];

        // Threshold alerts
        const thresholds = [
            { field: 'harmony', threshold: 0.3, message: 'Harmony score critically low' },
            { field: 'balance', threshold: 0.25, message: 'Balance dimension critically low' },
            { field: 'flow', threshold: 0.25, message: 'Flow dimension critically low' },
            { field: 'care', threshold: 0.15, message: 'Care score critically low' },
        ];

        for (const { field, threshold, message } of thresholds) {
            const val = parseFloat(scores[field]);
            if (val != null && val < threshold) {
                alerts.push({
                    node_id: nodeId,
                    alert_type: 'threshold',
                    severity: val < threshold * 0.5 ? 'critical' : 'warning',
                    message,
                    details: { field, value: val, threshold },
                });
            }
        }

        // Store alerts
        for (const alert of alerts) {
            await query(`
                INSERT INTO harmony_alerts (node_id, alert_type, severity, message, details)
                VALUES ($1, $2, $3, $4, $5)
            `, [alert.node_id, alert.alert_type, alert.severity, alert.message, JSON.stringify(alert.details)]);
        }

        return alerts;
    }

    /**
     * Get top drivers (highest weighted normalized score) and drags (lowest)
     */
    async getTopDriversAndDrags(nodeId, timeWindowStart = '2024-01-01', count = 3) {
        const data = await this.getExplainability(nodeId, timeWindowStart);
        if (!data.indicators || data.indicators.length === 0) return { drivers: [], drags: [] };

        const scored = data.indicators
            .filter(ind => ind.normalized_value != null)
            .map(ind => ({
                ...ind,
                weighted_score: ind.normalized_value * ind.weight,
            }))
            .sort((a, b) => b.weighted_score - a.weighted_score);

        return {
            drivers: scored.slice(0, count),
            drags: scored.slice(-count).reverse(),
        };
    }

    /**
     * Get data freshness and coverage for a node
     */
    async getFreshnessAndCoverage(nodeId) {
        const totalResult = await query('SELECT COUNT(*) AS total FROM harmony_indicators');
        const totalIndicators = parseInt(totalResult.rows[0].total);

        const presentResult = await query(`
            SELECT COUNT(*) AS present,
                   MIN(iv.created_at) AS oldest,
                   MAX(iv.created_at) AS newest
            FROM harmony_indicator_values iv
            WHERE iv.node_id = $1
        `, [nodeId]);

        const present = parseInt(presentResult.rows[0].present);
        const oldest = presentResult.rows[0].oldest;
        const newest = presentResult.rows[0].newest;
        const coveragePct = totalIndicators > 0 ? (present / totalIndicators) * 100 : 0;

        const daysSinceUpdate = newest
            ? Math.floor((Date.now() - new Date(newest).getTime()) / 86400000)
            : null;

        let grade = 'D';
        if (coveragePct >= 90 && daysSinceUpdate != null && daysSinceUpdate < 30) grade = 'A';
        else if (coveragePct >= 70 && daysSinceUpdate != null && daysSinceUpdate < 90) grade = 'B';
        else if (coveragePct >= 50 && daysSinceUpdate != null && daysSinceUpdate < 180) grade = 'C';

        return {
            total_indicators: totalIndicators,
            present_indicators: present,
            coverage_pct: Math.round(coveragePct),
            oldest_timestamp: oldest,
            newest_timestamp: newest,
            days_since_update: daysSinceUpdate,
            grade,
        };
    }

    /**
     * Snapshot current scores for all nodes in a scope (for daily analytics)
     */
    async snapshotAllNodes(scope = 'city') {
        const today = new Date().toISOString().split('T')[0];
        const nodesResult = await query('SELECT node_id FROM harmony_nodes WHERE scope = $1', [scope]);

        let snapshotCount = 0;
        for (const { node_id } of nodesResult.rows) {
            const scoresResult = await query(`
                SELECT * FROM harmony_scores WHERE node_id = $1
                ORDER BY time_window_start DESC LIMIT 1
            `, [node_id]);

            if (!scoresResult.rows[0]) continue;
            const s = scoresResult.rows[0];

            await query(`
                INSERT INTO harmony_daily_snapshots
                (node_id, snapshot_date, harmony, e_raw, e_scaled, balance, flow,
                 compassion, discernment, care, awareness, expression, intent_coherence)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (node_id, snapshot_date) DO UPDATE SET
                    harmony = $3, e_raw = $4, e_scaled = $5, balance = $6, flow = $7,
                    compassion = $8, discernment = $9, care = $10, awareness = $11,
                    expression = $12, intent_coherence = $13
            `, [node_id, today, s.harmony, s.e_raw, s.e_scaled, s.balance, s.flow,
                s.compassion, s.discernment, s.care, s.awareness, s.expression, s.intent_coherence]);
            snapshotCount++;
        }
        return { date: today, snapshots: snapshotCount };
    }
}

module.exports = new HarmonyEngine();
