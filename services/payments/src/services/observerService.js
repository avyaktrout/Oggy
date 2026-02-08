/**
 * Observer Service - Federated Learning across tenants
 * Observer Oggy Spec v0.1
 *
 * Aggregates weaknesses from opted-in tenants, deduplicates,
 * creates versioned rule packs, and allows import/rollback.
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const weaknessAnalyzer = require('./weaknessAnalyzer');
const categoryRulesManager = require('./categoryRulesManager');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

class ObserverService {
    constructor() {
        this._scheduleInterval = null;
    }

    // --- Tenant config ---

    async getConfig(userId) {
        const result = await query(
            'SELECT * FROM observer_tenant_config WHERE user_id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            await query(
                'INSERT INTO observer_tenant_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
                [userId]
            );
            return {
                user_id: userId,
                share_learning: false,
                receive_observer_suggestions: false,
                receive_merchant_packs: false
            };
        }
        return result.rows[0];
    }

    async updateConfig(userId, updates) {
        const { share_learning, receive_observer_suggestions, receive_merchant_packs } = updates;
        // Ensure row exists first
        await this.getConfig(userId);
        // Then update only provided fields
        await query(
            `UPDATE observer_tenant_config SET
                share_learning = COALESCE($2, share_learning),
                receive_observer_suggestions = COALESCE($3, receive_observer_suggestions),
                receive_merchant_packs = COALESCE($4, receive_merchant_packs),
                updated_at = now()
             WHERE user_id = $1`,
            [userId, share_learning, receive_observer_suggestions, receive_merchant_packs]
        );
        return this.getConfig(userId);
    }

    // --- Export (PII-stripped) ---

    async exportWeaknesses(userId) {
        try {
            // Find the latest sealed benchmark result for this user
            const latestResult = await query(
                `SELECT result_id FROM sealed_benchmark_results
                 WHERE user_id = $1 AND oggy_accuracy != 'NaN'
                 ORDER BY tested_at DESC LIMIT 1`,
                [userId]
            );
            const resultId = latestResult.rows.length > 0 ? latestResult.rows[0].result_id : null;

            const analysis = await weaknessAnalyzer.analyzeWeaknesses({
                user_id: userId,
                result_id: resultId
            });
            if (!analysis || !analysis.weaknesses) return { weaknesses: [], confusion_patterns: [] };

            // Strip PII: only return category-level data, no merchant names or amounts
            return {
                weaknesses: (analysis.weaknesses || []).map(w => ({
                    category: w.category,
                    accuracy: w.accuracy,
                    severity: w.severity,
                    gap: w.gap
                })),
                confusion_patterns: (analysis.confusion_patterns || []).map(p => ({
                    actual: p.actual,
                    predicted: p.predicted,
                    confusion_rate: p.confusion_rate,
                    severity: p.severity
                }))
            };
        } catch (err) {
            logger.warn('Observer: export weaknesses failed', { error: err.message, user_id: userId });
            return { weaknesses: [], confusion_patterns: [] };
        }
    }

    async exportRules(userId) {
        try {
            const rules = await categoryRulesManager.getActiveRules(userId);
            // Strip raw text, only keep structured rule data
            return rules.map(r => ({
                category_a: r.category_a,
                category_b: r.category_b,
                distinction: r.distinction,
                confusion_rate: r.confusion_rate,
                rule_type: r.rule_type
            }));
        } catch (err) {
            logger.warn('Observer: export rules failed', { error: err.message, user_id: userId });
            return [];
        }
    }

    // --- Observer job ---

    async runObserverJob() {
        const jobId = uuidv4();
        const startedAt = new Date();

        await query(
            'INSERT INTO observer_job_log (job_id, started_at) VALUES ($1, $2)',
            [jobId, startedAt]
        );

        logger.info('Observer job started', { job_id: jobId });

        try {
            // 1. Collect opted-in tenants
            const tenants = await query(
                'SELECT user_id FROM observer_tenant_config WHERE share_learning = true'
            );

            if (tenants.rows.length === 0) {
                await this._completeJob(jobId, 'completed', { tenants: 0, message: 'No opted-in tenants' }, 0);
                return { job_id: jobId, packs_generated: 0, message: 'No opted-in tenants' };
            }

            // 2. Aggregate weaknesses from all tenants
            const allWeaknesses = [];
            const allConfusions = [];

            for (const tenant of tenants.rows) {
                const exported = await this.exportWeaknesses(tenant.user_id);
                allWeaknesses.push(...exported.weaknesses);
                allConfusions.push(...exported.confusion_patterns);
            }

            // 3. Normalize and deduplicate
            const categoryWeakness = {};
            for (const w of allWeaknesses) {
                if (!categoryWeakness[w.category]) {
                    categoryWeakness[w.category] = { count: 0, totalAccuracy: 0, maxSeverity: 'mild' };
                }
                categoryWeakness[w.category].count++;
                categoryWeakness[w.category].totalAccuracy += w.accuracy;
                const severityRank = { critical: 4, severe: 3, moderate: 2, mild: 1 };
                if ((severityRank[w.severity] || 0) > (severityRank[categoryWeakness[w.category].maxSeverity] || 0)) {
                    categoryWeakness[w.category].maxSeverity = w.severity;
                }
            }

            const confusionPairs = {};
            for (const c of allConfusions) {
                const key = `${c.actual}→${c.predicted}`;
                if (!confusionPairs[key]) {
                    confusionPairs[key] = { actual: c.actual, predicted: c.predicted, count: 0, totalRate: 0 };
                }
                confusionPairs[key].count++;
                confusionPairs[key].totalRate += c.confusion_rate;
            }

            // 4. Build rules for pack (only patterns seen by 2+ tenants or high confusion)
            const packRules = [];
            // Collect existing rules from all tenants for dedup
            const allExistingRules = [];
            for (const tenant of tenants.rows) {
                const tenantRules = await this.exportRules(tenant.user_id);
                allExistingRules.push(...tenantRules);
            }
            const existingRules = allExistingRules;

            for (const [key, conf] of Object.entries(confusionPairs)) {
                const avgRate = conf.totalRate / conf.count;
                const isSignificant = conf.count >= 2 || avgRate > 0.3;

                if (isSignificant) {
                    // Check if an existing rule already covers this
                    const existing = existingRules.find(
                        r => r.category_a === conf.actual && r.category_b === conf.predicted
                    );

                    packRules.push({
                        actual: conf.actual,
                        predicted: conf.predicted,
                        avg_confusion_rate: parseFloat(avgRate.toFixed(3)),
                        tenant_count: conf.count,
                        distinction: existing?.distinction || `${conf.actual} vs ${conf.predicted}: needs distinction rule`,
                        source: existing ? 'existing_rule' : 'observed_pattern'
                    });
                }
            }

            if (packRules.length === 0) {
                await this._completeJob(jobId, 'completed', {
                    tenants: tenants.rows.length,
                    weaknesses: allWeaknesses.length,
                    confusions: allConfusions.length,
                    message: 'No significant patterns to create a pack'
                }, 0);
                return { job_id: jobId, packs_generated: 0, message: 'No significant patterns found' };
            }

            // 5. Determine risk level
            const maxRate = Math.max(...packRules.map(r => r.avg_confusion_rate));
            const riskLevel = maxRate > 0.5 ? 'high' : maxRate > 0.2 ? 'medium' : 'low';

            // 6. Get version number
            const versionResult = await query(
                'SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM observer_packs'
            );
            const version = versionResult.rows[0].next_version;

            // 7. Create pack
            const categories = [...new Set(packRules.flatMap(r => [r.actual, r.predicted]))];
            const expectedLift = Math.min(packRules.length * 2, 15); // Conservative estimate

            const packId = uuidv4();
            await query(
                `INSERT INTO observer_packs (pack_id, version, name, rules, evidence, risk_level, expected_lift, categories_covered)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    packId,
                    version,
                    `Observer Pack v${version}`,
                    JSON.stringify(packRules),
                    JSON.stringify({
                        tenants_analyzed: tenants.rows.length,
                        total_weaknesses: allWeaknesses.length,
                        total_confusions: allConfusions.length,
                        generated_at: new Date().toISOString()
                    }),
                    riskLevel,
                    expectedLift,
                    categories
                ]
            );

            await this._completeJob(jobId, 'completed', {
                tenants: tenants.rows.length,
                weaknesses: allWeaknesses.length,
                confusions: allConfusions.length,
                pack_rules: packRules.length,
                risk_level: riskLevel
            }, 1);

            logger.info('Observer pack created', {
                job_id: jobId, pack_id: packId,
                version, rules: packRules.length,
                risk_level: riskLevel
            });

            return { job_id: jobId, packs_generated: 1, pack_id: packId };

        } catch (err) {
            await this._completeJob(jobId, 'failed', { error: err.message }, 0);
            logger.error('Observer job failed', { job_id: jobId, error: err.message });
            throw err;
        }
    }

    async _completeJob(jobId, status, stats, packsGenerated) {
        await query(
            `UPDATE observer_job_log SET completed_at = now(), status = $1, stats = $2, packs_generated = $3
             WHERE job_id = $4`,
            [status, JSON.stringify(stats), packsGenerated, jobId]
        );
    }

    // --- Pack management ---

    async listPacks(status = null) {
        let sql = 'SELECT * FROM observer_packs ORDER BY created_at DESC LIMIT 20';
        let params = [];
        if (status) {
            sql = 'SELECT * FROM observer_packs WHERE status = $1 ORDER BY created_at DESC LIMIT 20';
            params = [status];
        }
        const result = await query(sql, params);
        return result.rows;
    }

    async getPack(packId) {
        const result = await query('SELECT * FROM observer_packs WHERE pack_id = $1', [packId]);
        return result.rows[0] || null;
    }

    async importPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');
        if (pack.status !== 'available') throw new Error(`Pack status is ${pack.status}, not available`);

        const rules = pack.rules || [];
        const cardIds = [];
        let rulesApplied = 0;

        for (const rule of rules) {
            try {
                // Create distinction rule via categoryRulesManager
                const ruleId = await categoryRulesManager.createDistinctionRule(
                    { actual: rule.actual, predicted: rule.predicted, confusion_rate: rule.avg_confusion_rate },
                    rule.distinction,
                    userId
                );

                // Create memory card for the rule
                const cardResponse = await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                    owner_type: 'user',
                    owner_id: userId,
                    tier: 2,
                    kind: 'observer_rule',
                    content: {
                        type: 'PATTERN',
                        text: `OBSERVER RULE: ${rule.distinction}`,
                        actual: rule.actual,
                        predicted: rule.predicted,
                        confusion_rate: rule.avg_confusion_rate,
                        source: 'observer_pack',
                        pack_id: packId,
                        pack_version: pack.version
                    },
                    tags: ['payments', 'categorization', 'observer', rule.actual, rule.predicted],
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
                logger.warn('Observer: failed to apply rule', { error: err.message, rule });
            }
        }

        // Record application
        await query(
            `INSERT INTO observer_pack_applications (pack_id, user_id, action, rules_applied, memory_cards_created)
             VALUES ($1, $2, 'apply', $3, $4)`,
            [packId, userId, rulesApplied, cardIds]
        );

        // Mark pack as applied
        await query(
            'UPDATE observer_packs SET status = $1, applied_at = now() WHERE pack_id = $2',
            ['applied', packId]
        );

        logger.info('Observer pack applied', {
            pack_id: packId, user_id: userId,
            rules_applied: rulesApplied, cards_created: cardIds.length
        });

        return { rules_applied: rulesApplied, cards_created: cardIds.length };
    }

    async rollbackPack(packId, userId) {
        const pack = await this.getPack(packId);
        if (!pack) throw new Error('Pack not found');

        // Find the application record to get memory card IDs
        const appResult = await query(
            `SELECT * FROM observer_pack_applications
             WHERE pack_id = $1 AND user_id = $2 AND action = 'apply'
             ORDER BY created_at DESC LIMIT 1`,
            [packId, userId]
        );

        let cardsRolledBack = 0;
        if (appResult.rows.length > 0) {
            const cardIds = appResult.rows[0].memory_cards_created || [];
            for (const cardId of cardIds) {
                try {
                    // Zero out the card's utility weight
                    await axios.patch(`${MEMORY_SERVICE_URL}/cards/${cardId}`, {
                        utility_weight_delta: -1.0
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    });
                    cardsRolledBack++;
                } catch (err) {
                    logger.warn('Observer: failed to rollback card', { card_id: cardId, error: err.message });
                }
            }
        }

        // Record rollback
        await query(
            `INSERT INTO observer_pack_applications (pack_id, user_id, action, rules_applied)
             VALUES ($1, $2, 'rollback', $3)`,
            [packId, userId, cardsRolledBack]
        );

        // Update pack status
        await query(
            'UPDATE observer_packs SET status = $1, rolled_back_at = now() WHERE pack_id = $2',
            ['rolled_back', packId]
        );

        logger.info('Observer pack rolled back', {
            pack_id: packId, user_id: userId, cards_rolled_back: cardsRolledBack
        });

        return { cards_rolled_back: cardsRolledBack };
    }

    // --- Job log ---

    async getJobLog(limit = 10) {
        const result = await query(
            'SELECT * FROM observer_job_log ORDER BY started_at DESC LIMIT $1',
            [limit]
        );
        return result.rows;
    }

    // --- Job status (readiness check) ---

    async getJobStatus() {
        // Count tenants sharing data
        const tenants = await query(
            'SELECT COUNT(*) as count FROM observer_tenant_config WHERE share_learning = true'
        );
        const sharingTenants = parseInt(tenants.rows[0].count);

        // Get last job info
        const lastJob = await query(
            'SELECT job_id, started_at, completed_at, status, packs_generated FROM observer_job_log ORDER BY started_at DESC LIMIT 1'
        );

        const last = lastJob.rows[0] || null;
        const lastRunAt = last ? last.completed_at || last.started_at : null;
        const isRunning = last && last.status === 'running';

        // Job is ready if: 2+ sharing tenants, not currently running, and >1hr since last run (or never run)
        const cooldownMs = 3600000; // 1 hour
        const cooldownPassed = !lastRunAt || (Date.now() - new Date(lastRunAt).getTime()) > cooldownMs;
        const ready = sharingTenants >= 2 && !isRunning && cooldownPassed;

        let reason = null;
        if (isRunning) reason = 'Job is currently running';
        else if (sharingTenants < 2) reason = `Need 2+ tenants sharing data (currently ${sharingTenants})`;
        else if (!cooldownPassed) reason = 'Cooldown period — last job ran less than 1 hour ago';

        return {
            ready,
            reason,
            sharing_tenants: sharingTenants,
            is_running: isRunning,
            last_run: lastRunAt,
            last_packs_generated: last ? last.packs_generated : 0,
            auto_run_active: !!this._scheduleInterval
        };
    }

    // --- Scheduled runs ---

    startSchedule(intervalHours = 6) {
        const ms = intervalHours * 3600000;
        logger.info('Observer schedule started', { interval_hours: intervalHours });
        this._scheduleInterval = setInterval(async () => {
            try {
                await this.runObserverJob();
            } catch (err) {
                logger.error('Scheduled observer job failed', { error: err.message });
            }
        }, ms);
    }

    stopSchedule() {
        if (this._scheduleInterval) {
            clearInterval(this._scheduleInterval);
            this._scheduleInterval = null;
            logger.info('Observer schedule stopped');
        }
    }
}

module.exports = new ObserverService();
