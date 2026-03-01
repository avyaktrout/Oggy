/**
 * General Observer Service — Federated learning for conversation quality
 *
 * Aggregates benchmark weakness patterns from opted-in users,
 * creates versioned improvement packs, and distributes them as memory cards.
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const intentService = require('../../../shared/services/intentService');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://oggy-memory-service:3000';

// Deterministic improvement guidance — no LLM needed
const IMPROVEMENT_GUIDANCE = {
    context_retention: {
        guidance: 'When user references previous messages, explicitly acknowledge and quote prior context before answering. Check memory cards for conversation history before responding.',
        criteria_focus: 'context_awareness'
    },
    preference_adherence: {
        guidance: 'Check memory for user preference cards. Follow stated preferences for tone, format, length, and style. If unsure about a preference, briefly confirm before responding.',
        criteria_focus: 'preference_alignment'
    },
    general_helpfulness: {
        guidance: 'Provide comprehensive, actionable answers with specific examples and step-by-step guidance. Anticipate follow-up questions and address them proactively.',
        criteria_focus: 'helpfulness'
    },
    domain_knowledge_recall: {
        guidance: 'Retrieve and cite specific learned facts from memory when answering domain-specific questions. Reference domain knowledge explicitly in responses.',
        criteria_focus: 'domain_accuracy'
    },
    domain_knowledge_application: {
        guidance: 'Apply domain knowledge practically rather than reciting facts. Connect expertise to the user\'s specific situation and provide tailored recommendations.',
        criteria_focus: 'domain_accuracy'
    }
};

class GeneralObserverService {
    constructor() {
        this._scheduleInterval = null;
    }

    // ── Config ───────────────────────────────────────

    async getConfig(userId) {
        const result = await query('SELECT * FROM general_observer_config WHERE user_id = $1', [userId]);
        if (result.rows.length === 0) {
            await query('INSERT INTO general_observer_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
            return { user_id: userId, share_learning: false, receive_general_packs: false };
        }
        return result.rows[0];
    }

    async updateConfig(userId, updates) {
        await this.getConfig(userId);
        const share = updates.share_learning;
        // Accept receive_merchant_packs as UI alias for receive_general_packs
        const receive = updates.receive_general_packs ?? updates.receive_merchant_packs ?? updates.receive_observer_suggestions;
        await query(`
            UPDATE general_observer_config SET
                share_learning = COALESCE($2, share_learning),
                receive_general_packs = COALESCE($3, receive_general_packs),
                updated_at = now()
            WHERE user_id = $1
        `, [userId, share, receive]);
        return this.getConfig(userId);
    }

    // ── Export weaknesses (anonymized) ───────────────

    async exportWeaknesses(userId) {
        // Get latest general-domain benchmark result
        const latestResult = await query(`
            SELECT result_id, detailed_results
            FROM sealed_benchmark_results
            WHERE user_id = $1
              AND training_state->>'domain' = 'general'
              AND oggy_accuracy != 'NaN'
            ORDER BY tested_at DESC LIMIT 1
        `, [userId]);

        if (!latestResult.rows[0]) return { weaknesses: [], criteria_weaknesses: [] };

        const details = latestResult.rows[0].detailed_results;
        const scenarios = details?.scenarios || [];

        // Aggregate per-scenario-type performance
        const byType = {};
        const criteriaAgg = {};

        for (const s of scenarios) {
            const oggy = s.oggy || {};
            const type = s.scenario_type || 'unknown';

            if (!byType[type]) byType[type] = { correct: 0, total: 0, scores: [] };
            byType[type].total++;
            if (oggy.correct) byType[type].correct++;
            if (oggy.avg_score) byType[type].scores.push(oggy.avg_score);

            // Aggregate criteria scores
            const scores = oggy.scores || {};
            for (const [key, val] of Object.entries(scores)) {
                if (typeof val !== 'number') continue;
                if (!criteriaAgg[key]) criteriaAgg[key] = [];
                criteriaAgg[key].push(val);
            }
        }

        // Build weakness list (types below 70% accuracy)
        const weaknesses = [];
        for (const [type, data] of Object.entries(byType)) {
            const accuracy = data.total > 0 ? data.correct / data.total : 0;
            const avgScore = data.scores.length > 0
                ? data.scores.reduce((a, b) => a + b, 0) / data.scores.length : 0;
            if (accuracy < 0.70) {
                weaknesses.push({
                    scenario_type: type,
                    accuracy: parseFloat(accuracy.toFixed(4)),
                    avg_score: parseFloat(avgScore.toFixed(2)),
                    total: data.total,
                    severity: accuracy < 0.30 ? 'critical' : accuracy < 0.50 ? 'severe' : 'moderate'
                });
            }
        }

        // Build criteria weaknesses (avg below 3.5 out of 5)
        const criteria_weaknesses = [];
        for (const [key, values] of Object.entries(criteriaAgg)) {
            if (values.length === 0) continue;
            const avg = values.reduce((a, b) => a + b, 0) / values.length;
            if (avg < 3.5) {
                criteria_weaknesses.push({
                    criterion: key,
                    avg_score: parseFloat(avg.toFixed(2)),
                    sample_count: values.length,
                    severity: avg < 2.0 ? 'critical' : avg < 3.0 ? 'severe' : 'moderate'
                });
            }
        }

        return { weaknesses, criteria_weaknesses };
    }

    // ── Observer job ─────────────────────────────────

    async runObserverJob() {
        const jobId = uuidv4();
        await query(`
            INSERT INTO general_observer_job_log (job_id, status)
            VALUES ($1, 'running')
        `, [jobId]);

        try {
            // 1. Get opted-in users
            const tenants = await query(
                'SELECT user_id FROM general_observer_config WHERE share_learning = TRUE'
            );

            if (tenants.rows.length < 1) {
                await this._completeJob(jobId, { tenants_analyzed: 0, reason: 'no sharing tenants' }, 0);
                return { success: true, packs_generated: 0, reason: 'No sharing tenants' };
            }

            // 2. Aggregate weaknesses across tenants
            const allWeaknesses = new Map(); // scenario_type → { count, totalAccuracy, totalScore, maxSeverity }
            const allCriteriaWeaknesses = new Map(); // criterion → { count, totalScore }
            let tenantsWithData = 0;

            for (const { user_id } of tenants.rows) {
                const exported = await this.exportWeaknesses(user_id);
                if (exported.weaknesses.length > 0 || exported.criteria_weaknesses.length > 0) {
                    tenantsWithData++;
                }

                for (const w of exported.weaknesses) {
                    const existing = allWeaknesses.get(w.scenario_type) || { count: 0, totalAccuracy: 0, totalScore: 0, maxSeverity: 'moderate' };
                    existing.count++;
                    existing.totalAccuracy += w.accuracy;
                    existing.totalScore += w.avg_score;
                    if (w.severity === 'critical' || (w.severity === 'severe' && existing.maxSeverity !== 'critical')) {
                        existing.maxSeverity = w.severity;
                    }
                    allWeaknesses.set(w.scenario_type, existing);
                }

                for (const cw of exported.criteria_weaknesses) {
                    const existing = allCriteriaWeaknesses.get(cw.criterion) || { count: 0, totalScore: 0 };
                    existing.count++;
                    existing.totalScore += cw.avg_score;
                    allCriteriaWeaknesses.set(cw.criterion, existing);
                }
            }

            if (allWeaknesses.size === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, weaknesses: 0, reason: 'no weaknesses found' }, 0);
                return { success: true, packs_generated: 0, reason: 'No weaknesses found across tenants' };
            }

            // 3. Build pack rules from significant weakness patterns
            const packRules = [];
            for (const [type, agg] of allWeaknesses.entries()) {
                const avgAccuracy = agg.totalAccuracy / agg.count;
                const avgScore = agg.totalScore / agg.count;

                // Include if significant: seen by any tenant OR accuracy is very low
                if (agg.count >= 1 || avgAccuracy < 0.50) {
                    const guidance = IMPROVEMENT_GUIDANCE[type];
                    if (!guidance) continue; // Skip unknown types

                    // Build criteria detail from aggregated criteria weaknesses
                    const criteriaDetail = {};
                    for (const [criterion, cAgg] of allCriteriaWeaknesses.entries()) {
                        criteriaDetail[criterion] = parseFloat((cAgg.totalScore / cAgg.count).toFixed(2));
                    }

                    packRules.push({
                        weakness_type: type,
                        pattern: guidance.criteria_focus,
                        avg_accuracy: parseFloat(avgAccuracy.toFixed(4)),
                        avg_score: parseFloat(avgScore.toFixed(2)),
                        tenant_count: agg.count,
                        improvement_guidance: guidance.guidance,
                        criteria_detail: criteriaDetail,
                        severity: agg.maxSeverity
                    });
                }
            }

            if (packRules.length === 0) {
                await this._completeJob(jobId, { tenants_analyzed: tenants.rows.length, weaknesses: allWeaknesses.size, rules: 0 }, 0);
                return { success: true, packs_generated: 0, reason: 'No significant weakness patterns' };
            }

            // 4. Derive intent tags
            const intentTags = intentService.deriveIntentTagsFromGeneralRules(packRules);
            const weaknessTypes = packRules.map(r => r.weakness_type);

            // 5. Determine risk level
            const maxSeverity = packRules.reduce((max, r) => {
                if (r.severity === 'critical') return 'critical';
                if (r.severity === 'severe' && max !== 'critical') return 'severe';
                return max;
            }, 'moderate');
            const riskLevel = maxSeverity === 'critical' ? 'high' : maxSeverity === 'severe' ? 'medium' : 'low';

            // 6. Get next version
            const versionResult = await query('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM general_observer_packs');
            const version = versionResult.rows[0].next;

            // 7. Calculate expected lift (conservative)
            const avgWeaknessAccuracy = packRules.reduce((sum, r) => sum + r.avg_accuracy, 0) / packRules.length;
            const expectedLift = Math.min(Math.round((0.70 - avgWeaknessAccuracy) * 100 * 0.5), 15); // conservative

            // 8. Create pack
            const packId = uuidv4();
            await query(`
                INSERT INTO general_observer_packs (pack_id, version, name, rules, evidence, risk_level, expected_lift, weakness_types, intent_tags)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [
                packId,
                version,
                `Conversation Pack v${version}`,
                JSON.stringify(packRules),
                JSON.stringify({
                    tenants_analyzed: tenants.rows.length,
                    tenants_with_data: tenantsWithData,
                    total_weakness_types: allWeaknesses.size,
                    criteria_weaknesses: allCriteriaWeaknesses.size,
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

            logger.info('General observer pack created', { packId, version, rules: packRules.length, intentTags });
            return { success: true, packs_generated: 1, pack_id: packId, rules: packRules.length };
        } catch (err) {
            await query(`
                UPDATE general_observer_job_log SET status = 'failed', completed_at = NOW(),
                    stats = $2 WHERE job_id = $1
            `, [jobId, JSON.stringify({ error: err.message })]);
            throw err;
        }
    }

    async _completeJob(jobId, stats, packsGenerated) {
        await query(`
            UPDATE general_observer_job_log SET status = 'completed', completed_at = NOW(),
                stats = $2, packs_generated = $3
            WHERE job_id = $1
        `, [jobId, JSON.stringify(stats), packsGenerated]);
    }

    // ── Pack management ─────────────────────────────

    async listPacks(status, intentFilter) {
        let sql = 'SELECT * FROM general_observer_packs';
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
        const result = await query('SELECT * FROM general_observer_packs WHERE pack_id = $1', [packId]);
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
                        avg_accuracy: rule.avg_accuracy,
                        avg_score: rule.avg_score,
                        criteria_detail: rule.criteria_detail,
                        source: 'general_observer_pack',
                        pack_id: packId,
                        pack_version: pack.version
                    },
                    tags: ['general', 'conversation', 'observer', rule.weakness_type],
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
                logger.warn('General observer: failed to apply rule', { error: err.message, weakness_type: rule.weakness_type });
            }
        }

        // Record application
        await query(
            `INSERT INTO general_observer_pack_applications (pack_id, user_id, action, rules_applied, memory_cards_created)
             VALUES ($1, $2, 'apply', $3, $4)`,
            [packId, userId, rulesApplied, cardIds]
        );

        // Mark pack as applied
        await query(
            "UPDATE general_observer_packs SET status = 'applied', applied_at = now() WHERE pack_id = $1",
            [packId]
        );

        logger.info('General observer pack applied', { pack_id: packId, user_id: userId, rules_applied: rulesApplied, cards_created: cardIds.length });
        return { rules_applied: rulesApplied, cards_created: cardIds.length };
    }

    async rollbackPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');

        const appResult = await query(
            `SELECT * FROM general_observer_pack_applications
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
                    logger.warn('General observer: failed to rollback card', { card_id: cardId, error: err.message });
                }
            }
        }

        await query(
            `INSERT INTO general_observer_pack_applications (pack_id, user_id, action, rules_applied)
             VALUES ($1, $2, 'rollback', $3)`,
            [packId, userId, cardsRolledBack]
        );

        await query(
            "UPDATE general_observer_packs SET status = 'rolled_back', rolled_back_at = now() WHERE pack_id = $1",
            [packId]
        );

        logger.info('General observer pack rolled back', { pack_id: packId, user_id: userId, cards_rolled_back: cardsRolledBack });
        return { cards_rolled_back: cardsRolledBack };
    }

    // ── Job status ──────────────────────────────────

    async getJobStatus() {
        const tenants = await query('SELECT COUNT(*) AS count FROM general_observer_config WHERE share_learning = TRUE');
        const sharingTenants = parseInt(tenants.rows[0].count);

        const lastJob = await query('SELECT * FROM general_observer_job_log ORDER BY started_at DESC LIMIT 1');
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
        const result = await query('SELECT * FROM general_observer_job_log ORDER BY started_at DESC LIMIT $1', [limit]);
        return result.rows;
    }

    startSchedule(intervalHours = 6) {
        this.stopSchedule();
        this._scheduleInterval = setInterval(async () => {
            try {
                const status = await this.getJobStatus();
                if (status.ready) await this.runObserverJob();
            } catch (err) {
                logger.error('Scheduled general observer job failed', { error: err.message });
            }
        }, intervalHours * 3600000);
        logger.info('General observer auto-run enabled', { intervalHours });
    }

    stopSchedule() {
        if (this._scheduleInterval) {
            clearInterval(this._scheduleInterval);
            this._scheduleInterval = null;
        }
    }
}

module.exports = new GeneralObserverService();
