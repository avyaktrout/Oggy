/**
 * Diet Observer Service — Federated learning for nutrition estimation
 *
 * Aggregates benchmark weakness patterns (by food type) from opted-in users,
 * creates versioned improvement packs, and distributes them as memory cards.
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const intentService = require('../../../shared/services/intentService');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://oggy-memory-service:3000';

// Deterministic improvement guidance by food generator type — no LLM needed
const DIET_IMPROVEMENT_GUIDANCE = {
    branded_foods_db: {
        guidance: 'Check memory for branded food nutrition data before estimating. Reference exact serving sizes and nutrition labels. When a user mentions a specific brand, look up stored corrections first.',
        nutrient_focus: 'calories_and_protein'
    },
    ai_whole_food: {
        guidance: 'For common whole foods, use standard USDA reference portions. A medium banana is ~105 cal, a chicken breast (6oz) is ~280 cal. Cross-reference memory cards for previous corrections on similar foods.',
        nutrient_focus: 'calories_and_protein'
    },
    ai_complex_meal: {
        guidance: 'Break complex meals into individual components before estimating total nutrition. Sum each ingredient separately. Account for cooking oils, sauces, and hidden calories in preparation methods.',
        nutrient_focus: 'calories_and_protein'
    }
};

class DietObserverService {
    constructor() {
        this._scheduleInterval = null;
    }

    // ── Config ───────────────────────────────────────

    async getConfig(userId) {
        const result = await query('SELECT * FROM diet_observer_config WHERE user_id = $1', [userId]);
        if (result.rows.length === 0) {
            await query('INSERT INTO diet_observer_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
            return { user_id: userId, share_learning: false, receive_diet_packs: false };
        }
        return result.rows[0];
    }

    async updateConfig(userId, updates) {
        await this.getConfig(userId);
        const share = updates.share_learning;
        // Accept receive_merchant_packs as UI alias for receive_diet_packs
        const receive = updates.receive_diet_packs ?? updates.receive_merchant_packs ?? updates.receive_observer_suggestions;
        await query(`
            UPDATE diet_observer_config SET
                share_learning = COALESCE($2, share_learning),
                receive_diet_packs = COALESCE($3, receive_diet_packs),
                updated_at = now()
            WHERE user_id = $1
        `, [userId, share, receive]);
        return this.getConfig(userId);
    }

    // ── Export weaknesses (anonymized) ───────────────

    async exportWeaknesses(userId) {
        // Get latest diet-domain benchmark result
        const latestResult = await query(`
            SELECT r.result_id, r.benchmark_id, r.detailed_results
            FROM sealed_benchmark_results r
            WHERE r.user_id = $1
              AND r.training_state->>'domain' = 'diet'
              AND r.oggy_accuracy != 'NaN'
            ORDER BY r.tested_at DESC LIMIT 1
        `, [userId]);

        if (!latestResult.rows[0]) return { weaknesses: [] };

        const { benchmark_id, detailed_results } = latestResult.rows[0];
        const oggyResults = detailed_results?.oggy || [];

        if (oggyResults.length === 0) return { weaknesses: [] };

        // Get scenario details (generator field = food type) from the benchmark
        const scenarioIds = oggyResults.map(r => r.scenario_id).filter(Boolean);
        if (scenarioIds.length === 0) return { weaknesses: [] };

        const scenariosResult = await query(
            `SELECT scenario_id, generator FROM sealed_benchmark_scenarios
             WHERE scenario_id = ANY($1)`,
            [scenarioIds]
        );

        const scenarioGenerators = {};
        for (const row of scenariosResult.rows) {
            scenarioGenerators[row.scenario_id] = row.generator || 'unknown';
        }

        // Aggregate per-generator performance
        const byGenerator = {};
        for (const r of oggyResults) {
            const gen = scenarioGenerators[r.scenario_id] || 'unknown';
            if (!byGenerator[gen]) byGenerator[gen] = { correct: 0, total: 0, calErrors: [], proErrors: [] };
            byGenerator[gen].total++;
            if (r.correct) byGenerator[gen].correct++;
            if (r.errors) {
                byGenerator[gen].calErrors.push(r.errors.cal_pct || 0);
                byGenerator[gen].proErrors.push(r.errors.pro_pct || 0);
            }
        }

        // Build weakness list (generators below 70% accuracy)
        const weaknesses = [];
        for (const [gen, data] of Object.entries(byGenerator)) {
            const accuracy = data.total > 0 ? data.correct / data.total : 0;
            const avgCalError = data.calErrors.length > 0
                ? data.calErrors.reduce((a, b) => a + b, 0) / data.calErrors.length : 0;
            const avgProError = data.proErrors.length > 0
                ? data.proErrors.reduce((a, b) => a + b, 0) / data.proErrors.length : 0;

            if (accuracy < 0.70) {
                weaknesses.push({
                    generator_type: gen,
                    accuracy: parseFloat(accuracy.toFixed(4)),
                    avg_cal_error: Math.round(avgCalError),
                    avg_pro_error: Math.round(avgProError),
                    total: data.total,
                    severity: accuracy < 0.30 ? 'critical' : accuracy < 0.50 ? 'severe' : 'moderate'
                });
            }
        }

        return { weaknesses };
    }

    // ── Observer job ─────────────────────────────────

    async runObserverJob() {
        const jobId = uuidv4();
        await query(`
            INSERT INTO diet_observer_job_log (job_id, status)
            VALUES ($1, 'running')
        `, [jobId]);

        try {
            // 1. Get opted-in users
            const tenants = await query(
                'SELECT user_id FROM diet_observer_config WHERE share_learning = TRUE'
            );

            if (tenants.rows.length < 1) {
                await this._completeJob(jobId, { tenants_analyzed: 0, reason: 'no sharing tenants' }, 0);
                return { success: true, packs_generated: 0, reason: 'No sharing tenants' };
            }

            // 2. Aggregate weaknesses across tenants
            const allWeaknesses = new Map(); // generator_type → { count, totalAccuracy, totalCalError, totalProError, maxSeverity }
            let tenantsWithData = 0;

            for (const { user_id } of tenants.rows) {
                const exported = await this.exportWeaknesses(user_id);
                if (exported.weaknesses.length > 0) tenantsWithData++;

                for (const w of exported.weaknesses) {
                    const existing = allWeaknesses.get(w.generator_type) || {
                        count: 0, totalAccuracy: 0, totalCalError: 0, totalProError: 0, maxSeverity: 'moderate'
                    };
                    existing.count++;
                    existing.totalAccuracy += w.accuracy;
                    existing.totalCalError += w.avg_cal_error;
                    existing.totalProError += w.avg_pro_error;
                    if (w.severity === 'critical' || (w.severity === 'severe' && existing.maxSeverity !== 'critical')) {
                        existing.maxSeverity = w.severity;
                    }
                    allWeaknesses.set(w.generator_type, existing);
                }
            }

            if (allWeaknesses.size === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, weaknesses: 0, reason: 'no weaknesses found' }, 0);
                return { success: true, packs_generated: 0, reason: 'No weaknesses found across tenants' };
            }

            // 3. Build pack rules from significant weakness patterns
            const packRules = [];
            for (const [gen, agg] of allWeaknesses.entries()) {
                const avgAccuracy = agg.totalAccuracy / agg.count;
                const avgCalError = Math.round(agg.totalCalError / agg.count);
                const avgProError = Math.round(agg.totalProError / agg.count);

                if (agg.count >= 1 || avgAccuracy < 0.50) {
                    const guidance = DIET_IMPROVEMENT_GUIDANCE[gen];
                    if (!guidance) continue;

                    packRules.push({
                        weakness_type: gen,
                        generator_type: gen,
                        pattern: guidance.nutrient_focus,
                        avg_accuracy: parseFloat(avgAccuracy.toFixed(4)),
                        avg_cal_error: avgCalError,
                        avg_pro_error: avgProError,
                        tenant_count: agg.count,
                        improvement_guidance: guidance.guidance,
                        severity: agg.maxSeverity
                    });
                }
            }

            if (packRules.length === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, weaknesses: allWeaknesses.size, rules: 0 }, 0);
                return { success: true, packs_generated: 0, reason: 'No significant weakness patterns' };
            }

            // 4. Derive intent tags
            const intentTags = intentService.deriveIntentTagsFromDietRules(packRules);
            const weaknessTypes = packRules.map(r => r.weakness_type);

            // 5. Determine risk level
            const maxSeverity = packRules.reduce((max, r) => {
                if (r.severity === 'critical') return 'critical';
                if (r.severity === 'severe' && max !== 'critical') return 'severe';
                return max;
            }, 'moderate');
            const riskLevel = maxSeverity === 'critical' ? 'high' : maxSeverity === 'severe' ? 'medium' : 'low';

            // 6. Get next version
            const versionResult = await query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM diet_observer_packs');
            const version = versionResult.rows[0].next;

            // 7. Calculate expected lift (conservative)
            const avgWeaknessAccuracy = packRules.reduce((sum, r) => sum + r.avg_accuracy, 0) / packRules.length;
            const expectedLift = Math.min(Math.round((0.70 - avgWeaknessAccuracy) * 100 * 0.5), 15);

            // 8. Create pack
            const packId = uuidv4();
            await query(`
                INSERT INTO diet_observer_packs (pack_id, version, name, rules, evidence, risk_level, expected_lift, weakness_types, intent_tags)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                packId,
                version,
                `Nutrition Pack v${version}`,
                JSON.stringify(packRules),
                JSON.stringify({
                    tenants_analyzed: tenants.rows.length,
                    tenants_with_data: tenantsWithData,
                    total_weakness_types: allWeaknesses.size,
                    generated_at: new Date().toISOString()
                }),
                riskLevel,
                Math.max(expectedLift, 1),
                weaknessTypes,
                intentTags
            ]);

            await this._completeJob(jobId, {
                tenants_analyzed: tenants.rows.length,
                weaknesses: allWeaknesses.size,
                rules: packRules.length,
                intent_tags: intentTags
            }, 1);

            logger.info('Diet observer pack created', { packId, version, rules: packRules.length, intentTags });
            return { success: true, packs_generated: 1, pack_id: packId, rules: packRules.length };
        } catch (err) {
            await query(`
                UPDATE diet_observer_job_log SET status = 'failed', completed_at = NOW(),
                    stats = $2 WHERE job_id = $1
            `, [jobId, JSON.stringify({ error: err.message })]);
            throw err;
        }
    }

    async _completeJob(jobId, stats, packsGenerated) {
        await query(`
            UPDATE diet_observer_job_log SET status = 'completed', completed_at = NOW(),
                stats = $2, packs_generated = $3
            WHERE job_id = $1
        `, [jobId, JSON.stringify(stats), packsGenerated]);
    }

    // ── Pack management ─────────────────────────────

    async listPacks(status, intentFilter) {
        let sql = 'SELECT * FROM diet_observer_packs';
        const params = [];
        const conditions = [];

        if (status) {
            params.push(status);
            conditions.push(`status = $${params.length}`);
        }
        if (intentFilter) {
            params.push([intentFilter]);
            conditions.push(`intent_tags && $${params.length}`);
        }

        if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY created_at DESC LIMIT 20';

        const result = await query(sql, params);
        return result.rows;
    }

    async getPack(packId) {
        const result = await query('SELECT * FROM diet_observer_packs WHERE pack_id = $1', [packId]);
        return result.rows[0] || null;
    }

    async importPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');
        if (pack.status !== 'available' && pack.status !== 'rolled_back') {
            throw new Error(`Pack status is ${pack.status}, not available`);
        }

        const rules = pack.rules || [];
        const cardIds = [];
        let rulesApplied = 0;

        for (const rule of rules) {
            try {
                const cardResponse = await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                    owner_type: 'user',
                    owner_id: userId,
                    tier: 2,
                    kind: 'observer_rule',
                    content: {
                        type: 'PATTERN',
                        text: `OBSERVER RULE (${rule.weakness_type}): ${rule.improvement_guidance}`,
                        weakness_type: rule.weakness_type,
                        generator_type: rule.generator_type,
                        avg_accuracy: rule.avg_accuracy,
                        avg_cal_error: rule.avg_cal_error,
                        avg_pro_error: rule.avg_pro_error,
                        source: 'diet_observer_pack',
                        pack_id: packId,
                        pack_version: pack.version
                    },
                    tags: ['diet', 'nutrition', 'observer', rule.weakness_type],
                    utility_weight: 0.7,
                    reliability: 0.8
                }, {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                });

                if (cardResponse.data?.card_id) {
                    cardIds.push(cardResponse.data.card_id);
                }
                rulesApplied++;
            } catch (err) {
                logger.warn('Diet observer: failed to apply rule', { error: err.message, weakness_type: rule.weakness_type });
            }
        }

        // Record application
        await query(
            `INSERT INTO diet_observer_pack_applications (pack_id, user_id, action, rules_applied, memory_cards_created)
             VALUES ($1, $2, 'apply', $3, $4)`,
            [packId, userId, rulesApplied, cardIds]
        );

        // Mark pack as applied
        await query(
            "UPDATE diet_observer_packs SET status = 'applied', applied_at = now() WHERE pack_id = $1",
            [packId]
        );

        logger.info('Diet observer pack applied', { pack_id: packId, user_id: userId, rules_applied: rulesApplied, cards_created: cardIds.length });
        return { rules_applied: rulesApplied, cards_created: cardIds.length };
    }

    async rollbackPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');

        const appResult = await query(
            `SELECT * FROM diet_observer_pack_applications
             WHERE pack_id = $1 AND user_id = $2 AND action = 'apply'
             ORDER BY created_at DESC LIMIT 1`,
            [packId, userId]
        );

        let cardsRolledBack = 0;
        if (appResult.rows.length > 0) {
            const cardIds = appResult.rows[0].memory_cards_created || [];
            for (const cardId of cardIds) {
                try {
                    await axios.patch(`${MEMORY_SERVICE_URL}/cards/${cardId}`, {
                        utility_weight_delta: -1.0
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    });
                    cardsRolledBack++;
                } catch (err) {
                    logger.warn('Diet observer: failed to rollback card', { card_id: cardId, error: err.message });
                }
            }
        }

        await query(
            `INSERT INTO diet_observer_pack_applications (pack_id, user_id, action, rules_applied)
             VALUES ($1, $2, 'rollback', $3)`,
            [packId, userId, cardsRolledBack]
        );

        await query(
            "UPDATE diet_observer_packs SET status = 'rolled_back', rolled_back_at = now() WHERE pack_id = $1",
            [packId]
        );

        logger.info('Diet observer pack rolled back', { pack_id: packId, user_id: userId, cards_rolled_back: cardsRolledBack });
        return { cards_rolled_back: cardsRolledBack };
    }

    // ── Job status ──────────────────────────────────

    async getJobStatus() {
        const tenants = await query('SELECT COUNT(*) AS count FROM diet_observer_config WHERE share_learning = TRUE');
        const sharingTenants = parseInt(tenants.rows[0].count);

        const lastJob = await query('SELECT * FROM diet_observer_job_log ORDER BY started_at DESC LIMIT 1');
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
        const result = await query('SELECT * FROM diet_observer_job_log ORDER BY started_at DESC LIMIT $1', [limit]);
        return result.rows;
    }

    startSchedule(intervalHours = 6) {
        this.stopSchedule();
        this._scheduleInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus();
                if (status.ready) await this.runObserverJob();
            } catch (err) {
                logger.error('Scheduled diet observer job failed', { error: err.message });
            }
        }, intervalHours * 3600000);
        logger.info('Diet observer auto-run enabled', { intervalHours });
    }

    stopSchedule() {
        if (this._scheduleInterval) {
            clearInterval(this._scheduleInterval);
            this._scheduleInterval = null;
        }
    }
}

module.exports = new DietObserverService();
