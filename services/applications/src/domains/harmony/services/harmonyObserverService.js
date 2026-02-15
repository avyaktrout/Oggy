/**
 * Harmony Observer Service — Federated learning for Harmony Map
 *
 * Aggregates accepted suggestions from opted-in users,
 * creates versioned change packs, and distributes them.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const harmonyEngine = require('./harmonyEngine');

class HarmonyObserverService {
    constructor() {
        this._scheduleInterval = null;
    }

    // ── Config ───────────────────────────────────────

    async getConfig(userId) {
        const result = await query('SELECT * FROM harmony_observer_config WHERE user_id = $1', [userId]);
        if (result.rows.length === 0) {
            await query('INSERT INTO harmony_observer_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
            return { user_id: userId, share_changes: false, receive_harmony_packs: false };
        }
        return result.rows[0];
    }

    async updateConfig(userId, updates) {
        await this.getConfig(userId);
        const { share_changes, receive_harmony_packs } = updates;
        await query(`
            UPDATE harmony_observer_config SET
                share_changes = COALESCE($2, share_changes),
                receive_harmony_packs = COALESCE($3, receive_harmony_packs),
                updated_at = now()
            WHERE user_id = $1
        `, [userId, share_changes, receive_harmony_packs]);
        return this.getConfig(userId);
    }

    // ── Export changes (anonymized) ──────────────────

    async exportChanges(userId) {
        // Get recently accepted suggestions from this user (last 30 days)
        const result = await query(`
            SELECT suggestion_type, title, description, payload
            FROM harmony_suggestions
            WHERE user_id = $1 AND status = 'accepted' AND resolved_at > NOW() - INTERVAL '30 days'
            ORDER BY resolved_at DESC LIMIT 50
        `, [userId]);

        return {
            changes: result.rows.map(r => ({
                type: r.suggestion_type,
                title: r.title,
                description: r.description,
                payload: r.payload,
            })),
            count: result.rows.length,
        };
    }

    // ── Observer job ─────────────────────────────────

    async runObserverJob() {
        const jobId = uuidv4();
        await query(`
            INSERT INTO harmony_observer_job_log (job_id, status)
            VALUES ($1, 'running')
        `, [jobId]);

        try {
            // 1. Get opted-in users
            const tenants = await query(
                'SELECT user_id FROM harmony_observer_config WHERE share_changes = TRUE'
            );

            if (tenants.rows.length < 1) {
                await this._completeJob(jobId, { tenants_analyzed: 0, reason: 'no sharing tenants' }, 0);
                return { success: true, packs_generated: 0, reason: 'No sharing tenants' };
            }

            // 2. Aggregate changes from all opted-in users
            const allChanges = [];
            for (const { user_id } of tenants.rows) {
                const exported = await this.exportChanges(user_id);
                for (const change of exported.changes) {
                    allChanges.push({ ...change, source_user: 'anonymous' });
                }
            }

            if (allChanges.length === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, changes: 0 }, 0);
                return { success: true, packs_generated: 0, reason: 'No changes to aggregate' };
            }

            // 3. Deduplicate by type+key
            const dedupedRaw = this._deduplicateChanges(allChanges);

            // 3b. Filter out suggestions for things that already exist (cities, indicators, weight adjustments for unknown indicators)
            const existingCities = await query("SELECT LOWER(name) AS name FROM harmony_nodes WHERE scope = 'city'");
            const existingCityNames = new Set(existingCities.rows.map(r => r.name));
            const existingIndicators = await query("SELECT key FROM harmony_indicators");
            const existingIndicatorKeys = new Set(existingIndicators.rows.map(r => r.key));
            const deduped = dedupedRaw.filter(c => {
                if (c.type === 'new_city') {
                    const cityName = (c.payload?.name || c.payload?.city_name || '').toLowerCase();
                    if (existingCityNames.has(cityName)) {
                        logger.info('Observer job: filtering out existing city from pack', { city: cityName });
                        return false;
                    }
                }
                if (c.type === 'new_indicator') {
                    const key = c.payload?.key;
                    if (key && existingIndicatorKeys.has(key)) {
                        logger.info('Observer job: filtering out existing indicator from pack', { key });
                        return false;
                    }
                }
                if (c.type === 'model_update') {
                    // model_updates are informational only — not actionable in packs
                    logger.info('Observer job: filtering out model_update from pack (not actionable)', { title: c.title });
                    return false;
                }
                if (c.type === 'weight_adjustment') {
                    const key = c.payload?.indicator_key;
                    if (key && !existingIndicatorKeys.has(key)) {
                        logger.info('Observer job: filtering out weight_adjustment for non-existent indicator', { key });
                        return false;
                    }
                }
                return true;
            });

            // 4. Skip pack creation if no actionable changes remain
            if (deduped.length === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, changes: 0, reason: 'all changes filtered as duplicates' }, 0);
                return { success: true, packs_generated: 0, reason: 'No new actionable changes' };
            }

            // 5. Determine impact level
            const dimensions = new Set();
            const nodeIds = new Set();
            for (const change of deduped) {
                if (change.payload?.dimension) dimensions.add(change.payload.dimension);
                if (change.payload?.node_id) nodeIds.add(change.payload.node_id);
            }
            const impactLevel = deduped.length > 10 ? 'high' : deduped.length > 3 ? 'medium' : 'low';

            // 5. Get next version
            const versionResult = await query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM harmony_observer_packs');
            const version = versionResult.rows[0].next;

            // 6. Create pack
            const packId = uuidv4();
            await query(`
                INSERT INTO harmony_observer_packs (pack_id, version, name, changes, evidence, impact_level, nodes_affected, dimensions_affected)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                packId,
                version,
                `Harmony Pack v${version}`,
                JSON.stringify(deduped),
                JSON.stringify({ tenants_analyzed: tenants.rows.length, total_changes: allChanges.length, deduped_changes: deduped.length }),
                impactLevel,
                Array.from(nodeIds),
                Array.from(dimensions),
            ]);

            await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, changes: deduped.length }, 1);

            return { success: true, packs_generated: 1, pack_id: packId, changes: deduped.length };
        } catch (err) {
            await query(`
                UPDATE harmony_observer_job_log SET status = 'failed', completed_at = NOW(),
                    stats = $2 WHERE job_id = $1
            `, [jobId, JSON.stringify({ error: err.message })]);
            throw err;
        }
    }

    _deduplicateChanges(changes) {
        const seen = new Map();
        for (const change of changes) {
            const key = `${change.type}:${change.payload?.key || change.payload?.indicator_key || change.title}`;
            if (!seen.has(key)) {
                seen.set(key, change);
            }
        }
        return Array.from(seen.values());
    }

    async _completeJob(jobId, stats, packsGenerated) {
        await query(`
            UPDATE harmony_observer_job_log SET status = 'completed', completed_at = NOW(),
                stats = $2, packs_generated = $3
            WHERE job_id = $1
        `, [jobId, JSON.stringify(stats), packsGenerated]);
    }

    // ── Pack management ─────────────────────────────

    async listPacks(status) {
        let sql = 'SELECT * FROM harmony_observer_packs WHERE jsonb_array_length(COALESCE(changes, \'[]\'::jsonb)) > 0';
        const params = [];
        if (status) {
            params.push(status);
            sql += ' AND status = $1';
        }
        sql += ' ORDER BY created_at DESC LIMIT 20';
        const result = await query(sql, params);
        return result.rows;
    }

    async getPack(packId) {
        const result = await query('SELECT * FROM harmony_observer_packs WHERE pack_id = $1', [packId]);
        return result.rows[0] || null;
    }

    async applyPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');

        const changes = pack.changes || [];
        const rollbackSnapshot = [];
        let applied = 0;

        for (const change of changes) {
            try {
                const beforeState = await this._captureBeforeState(change);
                rollbackSnapshot.push({ change, beforeState });

                switch (change.type) {
                    case 'new_indicator':
                        await this._applyNewIndicator(change.payload);
                        applied++;
                        break;
                    case 'new_data_point':
                        await this._applyNewDataPoint(change.payload);
                        applied++;
                        break;
                    case 'weight_adjustment':
                        await this._applyWeightAdjustment(change.payload);
                        applied++;
                        break;
                    default:
                        applied++;
                        break;
                }
            } catch (err) {
                logger.warn('Failed to apply pack change', { type: change.type, error: err.message });
            }
        }

        // Record application
        await query(`
            INSERT INTO harmony_observer_pack_applications (pack_id, user_id, action, changes_applied, rollback_snapshot)
            VALUES ($1, $2, 'apply', $3, $4)
        `, [packId, userId, applied, JSON.stringify(rollbackSnapshot)]);

        // Update pack status
        await query("UPDATE harmony_observer_packs SET status = 'applied', applied_at = NOW() WHERE pack_id = $1", [packId]);

        // Recompute affected nodes
        const affectedNodes = new Set(changes.map(c => c.payload?.node_id).filter(Boolean));
        for (const nodeId of affectedNodes) {
            try { await harmonyEngine.computeScores(nodeId); } catch (_) {}
        }

        return { changes_applied: applied };
    }

    async rollbackPack(packId, userId) {
        const appResult = await query(`
            SELECT * FROM harmony_observer_pack_applications
            WHERE pack_id = $1 AND user_id = $2 AND action = 'apply'
            ORDER BY created_at DESC LIMIT 1
        `, [packId, userId]);

        if (!appResult.rows[0]) throw new Error('No application record found');

        const snapshot = appResult.rows[0].rollback_snapshot || [];
        let rolledBack = 0;

        for (const { change, beforeState } of snapshot) {
            try {
                await this._rollbackChange(change, beforeState);
                rolledBack++;
            } catch (err) {
                logger.warn('Failed to rollback change', { type: change.type, error: err.message });
            }
        }

        await query(`
            INSERT INTO harmony_observer_pack_applications (pack_id, user_id, action, changes_applied)
            VALUES ($1, $2, 'rollback', $3)
        `, [packId, userId, rolledBack]);

        await query("UPDATE harmony_observer_packs SET status = 'rolled_back', rolled_back_at = NOW() WHERE pack_id = $1", [packId]);

        return { changes_rolled_back: rolledBack };
    }

    async _captureBeforeState(change) {
        switch (change.type) {
            case 'new_indicator': {
                const r = await query('SELECT * FROM harmony_indicators WHERE key = $1', [change.payload?.key]);
                return { existed: r.rows.length > 0, indicator: r.rows[0] || null };
            }
            case 'weight_adjustment': {
                const r = await query(
                    "SELECT weight FROM harmony_weights WHERE indicator_key = $1 AND version = 1 AND scope = 'global'",
                    [change.payload?.indicator_key]
                );
                return { previous_weight: r.rows[0]?.weight };
            }
            default:
                return {};
        }
    }

    async _rollbackChange(change, beforeState) {
        switch (change.type) {
            case 'new_indicator':
                if (!beforeState.existed) {
                    await query('DELETE FROM harmony_indicators WHERE key = $1', [change.payload?.key]);
                    await query("DELETE FROM harmony_normalization_bounds WHERE indicator_key = $1 AND version = 1", [change.payload?.key]);
                    await query("DELETE FROM harmony_weights WHERE indicator_key = $1 AND version = 1", [change.payload?.key]);
                }
                break;
            case 'weight_adjustment':
                if (beforeState.previous_weight != null) {
                    await query(
                        "UPDATE harmony_weights SET weight = $1 WHERE indicator_key = $2 AND version = 1 AND scope = 'global'",
                        [beforeState.previous_weight, change.payload?.indicator_key]
                    );
                }
                break;
            case 'new_data_point':
                await query(`
                    DELETE FROM harmony_indicator_values
                    WHERE node_id = $1 AND indicator_id = (SELECT indicator_id FROM harmony_indicators WHERE key = $2)
                      AND source_dataset = 'observer_pack'
                `, [change.payload?.node_id, change.payload?.indicator_key]);
                break;
        }
    }

    async _applyNewIndicator(payload) {
        if (!payload?.key) return;
        await query(`
            INSERT INTO harmony_indicators (key, name, dimension, direction, unit, description)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING
        `, [payload.key, payload.name, payload.dimension, payload.direction || 'higher_is_better', payload.unit || '', payload.description || '']);

        if (payload.bounds) {
            await query(`
                INSERT INTO harmony_normalization_bounds (indicator_key, version, min_value, max_value, scope)
                VALUES ($1, 1, $2, $3, 'global') ON CONFLICT (indicator_key, version, scope) DO NOTHING
            `, [payload.key, payload.bounds.min, payload.bounds.max]);
        }
        await query(`
            INSERT INTO harmony_weights (version, indicator_key, weight, scope, created_by)
            VALUES (1, $1, $2, 'global', 'observer') ON CONFLICT (version, indicator_key, scope) DO NOTHING
        `, [payload.key, payload.weight || 1.0]);
    }

    async _applyNewDataPoint(payload) {
        if (!payload?.indicator_key || !payload?.node_id) return;
        const indResult = await query('SELECT indicator_id FROM harmony_indicators WHERE key = $1', [payload.indicator_key]);
        if (!indResult.rows[0]) return;

        await query(`
            INSERT INTO harmony_indicator_values (node_id, indicator_id, time_window_start, time_window_end, raw_value, source_dataset)
            VALUES ($1, $2, $3, $4, $5, 'observer_pack')
            ON CONFLICT (node_id, indicator_id, time_window_start) DO UPDATE SET raw_value = $5
        `, [payload.node_id, indResult.rows[0].indicator_id, payload.time_window_start || '2024-01-01', payload.time_window_end || '2024-12-31', payload.raw_value]);
    }

    async _applyWeightAdjustment(payload) {
        if (!payload?.indicator_key) return;
        await query(
            "UPDATE harmony_weights SET weight = $1 WHERE indicator_key = $2 AND version = 1 AND scope = 'global'",
            [payload.proposed_weight, payload.indicator_key]
        );
    }

    // ── Job status ──────────────────────────────────

    async getJobStatus() {
        const tenants = await query('SELECT COUNT(*) AS count FROM harmony_observer_config WHERE share_changes = TRUE');
        const sharingTenants = parseInt(tenants.rows[0].count);

        const lastJob = await query(
            "SELECT * FROM harmony_observer_job_log ORDER BY started_at DESC LIMIT 1"
        );
        const isRunning = lastJob.rows[0]?.status === 'running';
        const lastRun = lastJob.rows[0]?.completed_at;
        const cooldownPassed = !lastRun || (Date.now() - new Date(lastRun).getTime()) > 3600000;

        return {
            ready: sharingTenants >= 1 && !isRunning && cooldownPassed,
            reason: isRunning ? 'Job is currently running' :
                    sharingTenants < 1 ? 'Need 1+ tenant sharing data' :
                    !cooldownPassed ? 'Cooldown period (1 hour)' : null,
            sharing_tenants: sharingTenants,
            is_running: isRunning,
            last_run: lastRun,
            last_packs_generated: lastJob.rows[0]?.packs_generated || 0,
            auto_run_active: !!this._scheduleInterval,
        };
    }

    async getJobLog(limit = 10) {
        const result = await query('SELECT * FROM harmony_observer_job_log ORDER BY started_at DESC LIMIT $1', [limit]);
        return result.rows;
    }

    startSchedule(intervalHours = 6) {
        this.stopSchedule();
        this._scheduleInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus();
                if (status.ready) await this.runObserverJob();
            } catch (err) {
                logger.error('Scheduled harmony observer job failed', { error: err.message });
            }
        }, intervalHours * 3600000);
        logger.info('Harmony observer auto-run enabled', { intervalHours });
    }

    stopSchedule() {
        if (this._scheduleInterval) {
            clearInterval(this._scheduleInterval);
            this._scheduleInterval = null;
        }
    }

    // ── Map Export / Upload / Diff ───────────────────

    async exportMap(userId) {
        const [nodesResult, indicatorsResult, boundsResult, weightsResult, valuesResult, scoresResult] = await Promise.all([
            query("SELECT node_id, scope, name, geometry, population, metadata FROM harmony_nodes WHERE scope = 'city' ORDER BY name"),
            query('SELECT key, name, dimension, direction, unit, description FROM harmony_indicators ORDER BY key'),
            query("SELECT indicator_key, min_value, max_value FROM harmony_normalization_bounds WHERE version = 1 AND scope = 'global'"),
            query("SELECT indicator_key, weight FROM harmony_weights WHERE version = 1 AND scope = 'global'"),
            query(`
                SELECT n.name AS node_name, hi.key AS indicator_key, hiv.raw_value, hiv.time_window_start, hiv.time_window_end, hiv.source_dataset
                FROM harmony_indicator_values hiv
                JOIN harmony_nodes n ON n.node_id = hiv.node_id
                JOIN harmony_indicators hi ON hi.indicator_id = hiv.indicator_id
                WHERE n.scope = 'city'
                ORDER BY n.name, hi.key
            `),
            query(`
                SELECT n.name AS node_name, hs.harmony, hs.e_scaled, hs.balance, hs.flow,
                       hs.compassion, hs.discernment, hs.care, hs.awareness, hs.expression,
                       hs.intent_coherence, hs.time_window_start
                FROM harmony_scores hs
                JOIN harmony_nodes n ON n.node_id = hs.node_id
                WHERE n.scope = 'city'
                ORDER BY n.name
            `),
        ]);

        // Build bounds/weights lookup
        const boundsMap = {};
        for (const b of boundsResult.rows) boundsMap[b.indicator_key] = { min: parseFloat(b.min_value), max: parseFloat(b.max_value) };
        const weightsMap = {};
        for (const w of weightsResult.rows) weightsMap[w.indicator_key] = parseFloat(w.weight);

        return {
            exported_at: new Date().toISOString(),
            exported_by: userId,
            nodes: nodesResult.rows.map(n => ({
                name: n.name, scope: n.scope,
                geometry: n.geometry, population: n.population,
                metadata: n.metadata,
            })),
            indicators: indicatorsResult.rows.map(i => ({
                ...i,
                bounds: boundsMap[i.key] || null,
                weight: weightsMap[i.key] || 1.0,
            })),
            indicator_values: valuesResult.rows,
            scores: scoresResult.rows,
        };
    }

    async createDiffPack(userId, externalSnapshot) {
        // Load user's current map state
        const myMap = await this.exportMap(userId);
        const changes = [];

        // 1. Find missing cities
        const myCityNames = new Set(myMap.nodes.map(n => n.name.toLowerCase()));
        // Also load all existing cities globally to avoid duplicates
        const allCitiesResult = await query("SELECT LOWER(name) AS name FROM harmony_nodes WHERE scope = 'city'");
        const allCityNames = new Set(allCitiesResult.rows.map(r => r.name));
        for (const extNode of (externalSnapshot.nodes || [])) {
            if (!myCityNames.has(extNode.name.toLowerCase()) && !allCityNames.has(extNode.name.toLowerCase())) {
                const coords = extNode.geometry?.coordinates || [0, 0];
                // Look for scores in the external snapshot to get initial dimension values
                const extScores = (externalSnapshot.scores || []).find(s => s.node_name?.toLowerCase() === extNode.name.toLowerCase());
                changes.push({
                    type: 'new_city',
                    title: `Add city: ${extNode.name}`,
                    description: `City "${extNode.name}" exists in the uploaded map but not in yours.`,
                    reason: 'Missing city from uploaded map',
                    payload: {
                        name: extNode.name,
                        lat: coords[1], lng: coords[0],
                        population: extNode.population,
                        country: extNode.metadata?.country || '',
                        state: extNode.metadata?.state || '',
                        initial_scores: extScores ? {
                            balance: Math.round((extScores.balance || 0.5) * 100),
                            flow: Math.round((extScores.flow || 0.5) * 100),
                            compassion: Math.round((extScores.compassion || 0.5) * 100),
                            discernment: Math.round((extScores.discernment || 0.5) * 100),
                            awareness: Math.round((extScores.awareness || 0.5) * 100),
                            expression: Math.round((extScores.expression || 0.5) * 100),
                        } : {},
                    },
                });
            }
        }

        // 2. Find missing indicators
        const myIndicatorKeys = new Set(myMap.indicators.map(i => i.key));
        for (const extInd of (externalSnapshot.indicators || [])) {
            if (!myIndicatorKeys.has(extInd.key)) {
                changes.push({
                    type: 'new_indicator',
                    title: `Add indicator: ${extInd.name}`,
                    description: `Indicator "${extInd.name}" (${extInd.dimension}) exists in the uploaded map but not in yours.`,
                    reason: `Missing ${extInd.dimension} indicator from uploaded map`,
                    payload: {
                        key: extInd.key,
                        name: extInd.name,
                        dimension: extInd.dimension,
                        direction: extInd.direction,
                        unit: extInd.unit,
                        description: extInd.description,
                        bounds: extInd.bounds || { min: 0, max: 100 },
                        weight: extInd.weight || 1.0,
                    },
                });
            }
        }

        // 3. Find missing indicator values (only for cities both maps have)
        const myValuesSet = new Set(myMap.indicator_values.map(v =>
            `${v.node_name.toLowerCase()}:${v.indicator_key}`
        ));
        for (const extVal of (externalSnapshot.indicator_values || [])) {
            const key = `${(extVal.node_name || '').toLowerCase()}:${extVal.indicator_key}`;
            if (!myValuesSet.has(key) && myCityNames.has((extVal.node_name || '').toLowerCase()) && myIndicatorKeys.has(extVal.indicator_key)) {
                // Need to resolve node_name to node_id in user's map
                const nodeResult = await query(
                    "SELECT node_id FROM harmony_nodes WHERE LOWER(name) = LOWER($1) AND scope = 'city'",
                    [extVal.node_name]
                );
                if (nodeResult.rows[0]) {
                    changes.push({
                        type: 'new_data_point',
                        title: `Add ${extVal.indicator_key} data for ${extVal.node_name}`,
                        description: `Data point for "${extVal.indicator_key}" in ${extVal.node_name} exists in the uploaded map.`,
                        reason: `Missing data point from uploaded map`,
                        payload: {
                            indicator_key: extVal.indicator_key,
                            node_id: nodeResult.rows[0].node_id,
                            raw_value: extVal.raw_value,
                            time_window_start: extVal.time_window_start || '2024-01-01',
                            time_window_end: extVal.time_window_end || '2024-12-31',
                            source_dataset: 'map_upload',
                        },
                    });
                }
            }
        }

        if (changes.length === 0) {
            return { diff_summary: { missing_cities: 0, missing_indicators: 0, missing_data_points: 0 }, pack_id: null, changes: [] };
        }

        // Create a pack from the diff
        const packId = uuidv4();
        const versionResult = await query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM harmony_observer_packs');
        const version = versionResult.rows[0].next;

        const missingCities = changes.filter(c => c.type === 'new_city').length;
        const missingIndicators = changes.filter(c => c.type === 'new_indicator').length;
        const missingDataPoints = changes.filter(c => c.type === 'new_data_point').length;
        const impactLevel = changes.length > 10 ? 'high' : changes.length > 3 ? 'medium' : 'low';

        await query(`
            INSERT INTO harmony_observer_packs (pack_id, version, name, changes, evidence, impact_level, status)
            VALUES ($1, $2, $3, $4, $5, $6, 'available')
        `, [
            packId, version,
            `Map Upload Diff v${version}`,
            JSON.stringify(changes),
            JSON.stringify({
                source: 'map_upload',
                uploaded_by: externalSnapshot.exported_by || 'unknown',
                missing_cities: missingCities,
                missing_indicators: missingIndicators,
                missing_data_points: missingDataPoints,
            }),
            impactLevel,
        ]);

        logger.info('Created diff pack from map upload', { packId, changes: changes.length, missingCities, missingIndicators, missingDataPoints });

        return {
            diff_summary: { missing_cities: missingCities, missing_indicators: missingIndicators, missing_data_points: missingDataPoints },
            pack_id: packId,
            changes: changes.map(c => ({ type: c.type, title: c.title, description: c.description, reason: c.reason })),
        };
    }
}

module.exports = new HarmonyObserverService();
