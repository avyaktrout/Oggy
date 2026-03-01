/**
 * Intent Service — Routing metadata across all 4 domains
 *
 * Intents are capabilities (e.g. "categorize_payment", "estimate_nutrition")
 * that enable per-intent analytics, intent-tagged packs, and targeted training.
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

// Stable ID format: domain.snake_case_name
const INTENT_NAME_REGEX = /^[a-z_]+\.[a-z0-9_]+$/;

// Confusion pair → intent mapping for payments domain
const PAYMENTS_CONFUSION_INTENTS = {
    'groceries→shopping': 'payments.disambiguate_groceries_vs_shopping',
    'shopping→groceries': 'payments.disambiguate_groceries_vs_shopping',
    'dining→business_meal': 'payments.disambiguate_dining_vs_business_meal',
    'business_meal→dining': 'payments.disambiguate_dining_vs_business_meal',
};

// Scenario type → intent mapping for general domain
const GENERAL_SCENARIO_INTENTS = {
    'context_retention': 'general.preference_fit',
    'preference_adherence': 'general.preference_fit',
    'general_helpfulness': 'general.explain_why_response',
    'research': 'general.research_synthesis',
    'planning': 'general.plan_generation',
    'comparison': 'general.comparison_recommendation',
    'study_plan': 'general.study_plan_generation',
    'clarification': 'general.ask_clarifying_questions',
    'proactive': 'general.proactive_suggestions',
};

// Scenario type → intent mapping for harmony domain
const HARMONY_SCENARIO_INTENTS = {
    'metric_computation': 'harmony.compute_metrics',
    'indicator_addition': 'harmony.add_indicator',
    'metric_explanation': 'harmony.explain_metric_change',
    'overlay_analysis': 'harmony.overlay_city_safety_crime_wellness',
    'intervention': 'harmony.suggest_interventions',
    'data_audit': 'harmony.audit_data_sources',
    'score_computation': 'harmony.compute_metrics',
    'classification': 'harmony.compute_metrics',
};

// Diet scenario → intent mapping
const DIET_SCENARIO_INTENTS = {
    'food_logging': 'diet.log_entry_from_text',
    'nutrition_estimation': 'diet.estimate_nutrition',
    'verification': 'diet.verify_with_user',
    'food_classification': 'diet.categorize_food_type',
    'clarification': 'diet.ask_clarifying_questions',
    'assumption_explanation': 'diet.explain_nutrition_assumptions',
};

class IntentService {

    // --- Catalog CRUD ---

    async listIntents(domain, userId = null) {
        const result = await query(
            `SELECT * FROM intent_catalog
             WHERE domain = $1
               AND retired_at IS NULL
               AND (is_builtin = true OR user_id = $2)
             ORDER BY intent_name`,
            [domain, userId]
        );
        return result.rows;
    }

    async getIntent(intentNameOrId) {
        // Try by UUID first, then by name
        let result = await query(
            'SELECT * FROM intent_catalog WHERE intent_id = $1 AND retired_at IS NULL',
            [intentNameOrId]
        ).catch(() => ({ rows: [] }));

        if (result.rows.length === 0) {
            result = await query(
                'SELECT * FROM intent_catalog WHERE intent_name = $1 AND is_builtin = true AND retired_at IS NULL',
                [intentNameOrId]
            );
        }
        return result.rows[0] || null;
    }

    async createIntent(userId, fields) {
        const { intent_name, domain, display_name, description, success_criteria, metric_type } = fields;

        if (!intent_name || !domain || !display_name) {
            throw new Error('intent_name, domain, and display_name are required');
        }
        if (!INTENT_NAME_REGEX.test(intent_name)) {
            throw new Error('intent_name must match domain.snake_case format (e.g. general.my_skill)');
        }
        // Validate domain prefix matches intent_name prefix
        const namePrefix = intent_name.split('.')[0];
        if (namePrefix !== domain) {
            throw new Error(`intent_name prefix "${namePrefix}" must match domain "${domain}"`);
        }

        const result = await query(
            `INSERT INTO intent_catalog
                (intent_name, domain, display_name, description, success_criteria, metric_type, is_builtin, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, false, $7)
             RETURNING *`,
            [intent_name, domain, display_name, description || null, success_criteria || null, metric_type || 'accuracy', userId]
        );
        return result.rows[0];
    }

    async cloneIntent(intentId, userId, overrides = {}) {
        const source = await this.getIntent(intentId);
        if (!source) throw new Error('Source intent not found');

        // Generate a safe clone name: domain.baseName_clone_shortUserId
        const baseName = source.intent_name.split('.').slice(1).join('_');
        const shortUserId = userId.replace(/[^a-z0-9]/g, '').substring(0, 8);
        const cloneName = overrides.intent_name || `${source.domain}.${baseName}_clone_${shortUserId}`;

        const result = await query(
            `INSERT INTO intent_catalog
                (intent_name, domain, display_name, description, success_criteria, metric_type, is_builtin, cloned_from, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8)
             RETURNING *`,
            [
                cloneName,
                source.domain,
                overrides.display_name || source.display_name,
                overrides.description || source.description,
                overrides.success_criteria || source.success_criteria,
                overrides.metric_type || source.metric_type,
                source.intent_id,
                userId
            ]
        );
        return result.rows[0];
    }

    async updateIntent(intentId, userId, updates) {
        const intent = await this.getIntent(intentId);
        if (!intent) throw new Error('Intent not found');
        if (intent.is_builtin) throw new Error('Cannot modify built-in intents');
        if (intent.user_id !== userId) throw new Error('Not your intent');

        const result = await query(
            `UPDATE intent_catalog SET
                display_name = COALESCE($1, display_name),
                description = COALESCE($2, description),
                success_criteria = COALESCE($3, success_criteria)
             WHERE intent_id = $4 AND user_id = $5
             RETURNING *`,
            [updates.display_name, updates.description, updates.success_criteria, intentId, userId]
        );
        return result.rows[0];
    }

    async retireIntent(intentId, userId) {
        const intent = await this.getIntent(intentId);
        if (!intent) throw new Error('Intent not found');
        if (intent.is_builtin) throw new Error('Cannot retire built-in intents');
        if (intent.user_id !== userId) throw new Error('Not your intent');

        await query(
            'UPDATE intent_catalog SET retired_at = now() WHERE intent_id = $1',
            [intentId]
        );
        return { retired: true };
    }

    // --- Intent resolution ---

    /**
     * Resolves a scenario to 1-3 intents with source tracking.
     * Returns { intents: string[], source: 'explicit'|'inferred', reason: string }
     */
    resolveIntentsForScenario(scenario, domain) {
        // Prefer explicit intent_id on the scenario (best)
        if (scenario.intent_id) {
            return {
                intents: [scenario.intent_id],
                source: 'explicit',
                reason: 'scenario.intent_id set'
            };
        }

        const intents = [];
        let reason = '';

        if (domain === 'payments') {
            intents.push('payments.categorize_payment');
            reason = 'category-based: always categorize_payment';

            if (scenario.correct_category && scenario.predicted_category) {
                const key = `${scenario.correct_category}→${scenario.predicted_category}`;
                const reverseKey = `${scenario.predicted_category}→${scenario.correct_category}`;
                const confusionIntent = PAYMENTS_CONFUSION_INTENTS[key] || PAYMENTS_CONFUSION_INTENTS[reverseKey];
                if (confusionIntent && !intents.includes(confusionIntent)) {
                    intents.push(confusionIntent);
                    reason += ` + confusion pair ${scenario.correct_category}→${scenario.predicted_category}`;
                }
            }

            if (scenario.description && /mixed|combo|bundle/i.test(scenario.description)) {
                intents.push('payments.handle_mixed_cart_dominance');
                reason += ' + mixed cart detected';
            }

        } else if (domain === 'general') {
            const scenarioType = scenario.scenario_type || scenario.type;
            const mapped = GENERAL_SCENARIO_INTENTS[scenarioType];
            if (mapped) {
                intents.push(mapped);
                reason = `scenario_type=${scenarioType} → ${mapped}`;
            } else {
                intents.push('general.explain_why_response');
                reason = `scenario_type=${scenarioType} unmapped, fallback to explain_why_response`;
            }

        } else if (domain === 'harmony') {
            const scenarioType = scenario.scenario_type || scenario.type;
            const mapped = HARMONY_SCENARIO_INTENTS[scenarioType];
            if (mapped) {
                intents.push(mapped);
                reason = `scenario_type=${scenarioType} → ${mapped}`;
            } else {
                intents.push('harmony.compute_metrics');
                reason = `scenario_type=${scenarioType} unmapped, fallback to compute_metrics`;
            }

        } else if (domain === 'diet') {
            const scenarioType = scenario.scenario_type || scenario.type;
            const mapped = DIET_SCENARIO_INTENTS[scenarioType];
            if (mapped) {
                intents.push(mapped);
                reason = `scenario_type=${scenarioType} → ${mapped}`;
            } else {
                intents.push('diet.log_entry_from_text');
                reason = `scenario_type=${scenarioType} unmapped, fallback to log_entry_from_text`;
            }
        }

        return {
            intents: intents.slice(0, 3),
            source: 'inferred',
            reason
        };
    }

    // --- Intent tags validation ---

    async validateIntentTags(tags, domain) {
        if (!Array.isArray(tags) || tags.length === 0) return { valid: true, tags: [] };
        if (tags.length > 3) return { valid: false, error: 'Maximum 3 intent tags allowed' };

        // Enforce stable ID format
        const badFormat = tags.filter(t => !INTENT_NAME_REGEX.test(t));
        if (badFormat.length > 0) {
            return { valid: false, error: `Invalid intent name format (expected domain.name): ${badFormat.join(', ')}` };
        }

        const result = await query(
            `SELECT intent_name FROM intent_catalog
             WHERE intent_name = ANY($1) AND domain = $2 AND retired_at IS NULL`,
            [tags, domain]
        );

        const found = result.rows.map(r => r.intent_name);
        const missing = tags.filter(t => !found.includes(t));

        if (missing.length > 0) {
            return { valid: false, error: `Unknown intents: ${missing.join(', ')}` };
        }
        return { valid: true, tags };
    }

    // --- Performance recording ---

    async recordIntentPerformance(resultId, userId, scenarioResults, domain) {
        // Accumulate correct/total per intent, track source
        const intentAccum = {};

        for (const scenario of scenarioResults) {
            const resolution = this.resolveIntentsForScenario(scenario, domain);
            const isCorrect = scenario.correct || scenario.oggy?.correct || false;

            for (const intentName of resolution.intents) {
                if (!intentAccum[intentName]) {
                    intentAccum[intentName] = { correct: 0, total: 0, source: resolution.source };
                }
                intentAccum[intentName].total++;
                if (isCorrect) intentAccum[intentName].correct++;
            }

            // Log inferred resolutions for debuggability
            if (resolution.source === 'inferred') {
                logger.debug('Intent inferred for scenario', {
                    scenario_id: scenario.scenario_id,
                    intents: resolution.intents,
                    reason: resolution.reason,
                    domain
                });
            }
        }

        // Look up intent_ids and INSERT into intent_performance
        const entries = Object.entries(intentAccum);
        let recorded = 0;

        for (const [intentName, counts] of entries) {
            try {
                const intentResult = await query(
                    'SELECT intent_id FROM intent_catalog WHERE intent_name = $1 AND is_builtin = true',
                    [intentName]
                );
                if (intentResult.rows.length === 0) {
                    logger.warn('Intent not found in catalog, skipping', { intent: intentName, domain });
                    continue;
                }

                const intentId = intentResult.rows[0].intent_id;
                const accuracy = counts.total > 0 ? counts.correct / counts.total : 0;

                await query(
                    `INSERT INTO intent_performance
                        (intent_id, user_id, benchmark_result_id, domain, correct, total, accuracy, intent_source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [intentId, userId, resultId, domain, counts.correct, counts.total, accuracy.toFixed(4), counts.source]
                );
                recorded++;
            } catch (err) {
                logger.warn('Intent performance recording failed', {
                    intent: intentName, error: err.message
                });
            }
        }

        logger.info('Intent performance recorded', {
            result_id: resultId, domain, intents: recorded, user_id: userId,
            sources: Object.fromEntries(entries.map(([k, v]) => [k, v.source]))
        });
        return { recorded, intents: Object.keys(intentAccum) };
    }

    // --- Time-series analytics ---

    async getIntentTimeSeries(userId, domain, intentName = null, limit = 20) {
        let sql, params;

        if (intentName) {
            sql = `SELECT ip.*, ic.intent_name, ic.display_name, ic.metric_type
                   FROM intent_performance ip
                   JOIN intent_catalog ic ON ic.intent_id = ip.intent_id
                   WHERE ip.user_id = $1 AND ip.domain = $2 AND ic.intent_name = $3
                   ORDER BY ip.tested_at DESC
                   LIMIT $4`;
            params = [userId, domain, intentName, limit];
        } else {
            sql = `SELECT ip.*, ic.intent_name, ic.display_name, ic.metric_type
                   FROM intent_performance ip
                   JOIN intent_catalog ic ON ic.intent_id = ip.intent_id
                   WHERE ip.user_id = $1 AND ip.domain = $2
                   ORDER BY ip.tested_at DESC
                   LIMIT $3`;
            params = [userId, domain, limit];
        }

        const result = await query(sql, params);
        return result.rows;
    }

    // --- Latest per-intent summary ---

    async getIntentSummary(userId, domain) {
        // Get latest performance for each intent in a domain
        const sql = `
            SELECT DISTINCT ON (ic.intent_name)
                ic.intent_name, ic.display_name, ic.metric_type,
                ip.correct, ip.total, ip.accuracy, ip.score_avg, ip.tested_at
            FROM intent_catalog ic
            LEFT JOIN intent_performance ip
                ON ip.intent_id = ic.intent_id AND ip.user_id = $1
            WHERE ic.domain = $2 AND ic.is_builtin = true AND ic.retired_at IS NULL
            ORDER BY ic.intent_name, ip.tested_at DESC NULLS LAST`;

        const result = await query(sql, [userId, domain]);

        return result.rows.map(row => ({
            intent_name: row.intent_name,
            display_name: row.display_name,
            metric_type: row.metric_type,
            correct: row.correct,
            total: row.total,
            accuracy: row.accuracy ? parseFloat(row.accuracy) : null,
            score_avg: row.score_avg ? parseFloat(row.score_avg) : null,
            tested_at: row.tested_at,
            pass: row.accuracy !== null ? parseFloat(row.accuracy) >= 0.80 : null,
            status: row.accuracy === null ? 'untested' : (parseFloat(row.accuracy) >= 0.80 ? 'pass' : 'fail')
        }));
    }

    // --- Derive intent_tags from observer pack rules ---

    deriveIntentTagsFromRules(rules, categories) {
        const tags = new Set();

        for (const rule of (rules || [])) {
            const key = `${rule.actual}→${rule.predicted}`;
            const reverseKey = `${rule.predicted}→${rule.actual}`;
            const intent = PAYMENTS_CONFUSION_INTENTS[key] || PAYMENTS_CONFUSION_INTENTS[reverseKey];
            if (intent) tags.add(intent);
        }

        // Always add categorize_payment if there are any rules
        if (rules && rules.length > 0) {
            tags.add('payments.categorize_payment');
        }

        return Array.from(tags).slice(0, 3);
    }

    // --- Derive intent_tags from general observer pack rules ---

    deriveIntentTagsFromGeneralRules(rules) {
        const tags = new Set();

        for (const rule of (rules || [])) {
            const scenarioType = rule.weakness_type;
            const mapped = GENERAL_SCENARIO_INTENTS[scenarioType];
            if (mapped) tags.add(mapped);
        }

        // Default if no specific mappings found but rules exist
        if (rules && rules.length > 0 && tags.size === 0) {
            tags.add('general.explain_why_response');
        }

        return Array.from(tags).slice(0, 3);
    }

    // --- Derive intent_tags from diet observer pack rules ---

    deriveIntentTagsFromDietRules(rules) {
        const DIET_GENERATOR_INTENTS = {
            'branded_foods_db': 'diet.estimate_nutrition',
            'ai_whole_food': 'diet.log_entry_from_text',
            'ai_complex_meal': 'diet.estimate_nutrition'
        };

        const tags = new Set();

        for (const rule of (rules || [])) {
            const genType = rule.generator_type || rule.weakness_type;
            const mapped = DIET_GENERATOR_INTENTS[genType];
            if (mapped) tags.add(mapped);
        }

        // Default if no specific mappings found but rules exist
        if (rules && rules.length > 0 && tags.size === 0) {
            tags.add('diet.estimate_nutrition');
        }

        return Array.from(tags).slice(0, 3);
    }

    // --- Verification gating ---

    /**
     * Check if a pack's target intents have passing local evals.
     * Returns { verified: bool, details: [{intent, pass, accuracy}] }
     */
    async getPackVerificationStatus(intentTags, userId, domain) {
        if (!intentTags || intentTags.length === 0) {
            return { verified: true, details: [], reason: 'no intent tags' };
        }

        const summary = await this.getIntentSummary(userId, domain);
        const details = intentTags.map(tag => {
            const intent = summary.find(i => i.intent_name === tag);
            return {
                intent: tag,
                pass: intent?.pass || false,
                accuracy: intent?.accuracy || null,
                status: intent?.status || 'untested'
            };
        });

        const allPassing = details.every(d => d.pass);
        const anyUntested = details.some(d => d.status === 'untested');

        return {
            verified: allPassing,
            details,
            reason: allPassing ? 'all intents passing' :
                    anyUntested ? 'some intents untested' : 'some intents failing'
        };
    }

    // --- Map target intents to focus categories ---

    async resolveIntentsToFocusCategories(intentNames) {
        // Extract category pairs from intent names
        const focusCategories = new Set();

        for (const name of intentNames) {
            // Find confusion pair categories from the intent mapping
            for (const [key, intent] of Object.entries(PAYMENTS_CONFUSION_INTENTS)) {
                if (intent === name) {
                    const [actual] = key.split('→');
                    focusCategories.add(actual);
                }
            }

            // If it's categorize_payment, no specific category focus
            // If it's a specific intent, we might need category info
        }

        return Array.from(focusCategories);
    }

    // --- Intent weakness → memory cards ---

    async createMemoryCardsForWeakIntents(resultId, userId, domain) {
        try {
            const weakIntents = await query(
                `SELECT ip.accuracy, ic.intent_name, ic.display_name, ic.success_criteria
                 FROM intent_performance ip
                 JOIN intent_catalog ic ON ic.intent_id = ip.intent_id
                 WHERE ip.benchmark_result_id = $1 AND ip.user_id = $2 AND ip.domain = $3
                   AND ip.accuracy < 0.70`,
                [resultId, userId, domain]
            );

            let cardsCreated = 0;

            for (const row of weakIntents.rows) {
                try {
                    // Dedup: skip if a weakness card for this intent exists within 7 days
                    const existing = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                        owner_type: 'user', owner_id: userId,
                        tag_filter: [domain, 'intent_weakness', row.intent_name],
                        limit: 1
                    }, { timeout: 3000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } });

                    const recentCard = (existing.data?.cards || []).find(c => {
                        const created = new Date(c.created_at);
                        return (Date.now() - created.getTime()) < 7 * 24 * 60 * 60 * 1000;
                    });
                    if (recentCard) continue;

                    const accuracyPct = (parseFloat(row.accuracy) * 100).toFixed(0);
                    const text = `Weakness: ${row.display_name} — ${accuracyPct}% accuracy. ${row.success_criteria || 'Needs improvement'}. Focus on improving this.`;

                    await axios.post(`${MEMORY_SERVICE_URL}/store`, {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: 'intent_weakness',
                        content: {
                            type: 'INTENT_WEAKNESS',
                            text,
                            intent_name: row.intent_name,
                            display_name: row.display_name,
                            accuracy: parseFloat(row.accuracy),
                            benchmark_result_id: resultId,
                            source: 'benchmark_intent_analysis'
                        },
                        tags: [domain, 'intent_weakness', row.intent_name, 'training'],
                        utility_weight: 0.75,
                        reliability: 0.9
                    }, { timeout: 5000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } });

                    cardsCreated++;
                } catch (err) {
                    logger.warn('Failed to create intent weakness memory card', {
                        intent: row.intent_name, error: err.message
                    });
                }
            }

            if (cardsCreated > 0) {
                logger.info('Created intent weakness memory cards', {
                    result_id: resultId, domain, cards_created: cardsCreated,
                    weak_intents: weakIntents.rows.length
                });
            }

            return { cards_created: cardsCreated };
        } catch (err) {
            logger.warn('createMemoryCardsForWeakIntents failed', {
                result_id: resultId, error: err.message
            });
            return { cards_created: 0 };
        }
    }

    // --- Project-Intent binding ---

    async getProjectIntents(projectId) {
        const result = await query(
            `SELECT pi.id, pi.project_id, pi.intent_id, pi.added_at,
                    ic.intent_name, ic.domain, ic.display_name, ic.description
             FROM project_intents pi
             JOIN intent_catalog ic ON ic.intent_id = pi.intent_id
             WHERE pi.project_id = $1
             ORDER BY ic.domain, ic.intent_name`,
            [projectId]
        );
        return result.rows;
    }

    async bindIntentsToProject(projectId, intentIds, userId) {
        let bound = 0;
        for (const intentId of intentIds) {
            try {
                await query(
                    `INSERT INTO project_intents (project_id, intent_id, user_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (project_id, intent_id) DO NOTHING`,
                    [projectId, intentId, userId]
                );
                bound++;
            } catch (err) {
                logger.warn('Failed to bind intent to project', {
                    project_id: projectId, intent_id: intentId, error: err.message
                });
            }
        }
        return { bound };
    }

    async unbindIntentFromProject(projectId, intentId) {
        const result = await query(
            'DELETE FROM project_intents WHERE project_id = $1 AND intent_id = $2',
            [projectId, intentId]
        );
        return { removed: result.rowCount > 0 };
    }

    async getProjectIntentNames(projectId) {
        const result = await query(
            `SELECT ic.intent_name
             FROM project_intents pi
             JOIN intent_catalog ic ON ic.intent_id = pi.intent_id
             WHERE pi.project_id = $1`,
            [projectId]
        );
        return result.rows.map(r => r.intent_name);
    }
}

module.exports = new IntentService();
