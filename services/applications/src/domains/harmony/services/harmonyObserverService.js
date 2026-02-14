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
            const deduped = this._deduplicateChanges(allChanges);

            // 4. Determine impact level
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
        let sql = 'SELECT * FROM harmony_observer_packs';
        const params = [];
        if (status) {
            params.push(status);
            sql += ' WHERE status = $1';
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
}

module.exports = new HarmonyObserverService();
