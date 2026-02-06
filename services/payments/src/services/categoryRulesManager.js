/**
 * Category Rules Manager
 * Manages learned distinction rules between categories
 * These rules are ALWAYS injected into categorization prompts
 * regardless of semantic memory retrieval
 *
 * Week 8+: Closing the learning feedback loop
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

class CategoryRulesManager {
    constructor() {
        // Cache rules in memory for fast access
        this.rulesCache = new Map();
        this.cacheExpiry = 5 * 60 * 1000; // 5 minute cache
        this.lastCacheUpdate = 0;
    }

    /**
     * Get all active category distinction rules
     * These should ALWAYS be injected into categorization prompts
     */
    async getActiveRules() {
        // Check cache
        if (Date.now() - this.lastCacheUpdate < this.cacheExpiry && this.rulesCache.size > 0) {
            return Array.from(this.rulesCache.values());
        }

        try {
            const result = await query(`
                SELECT knowledge_id, content_structured, content_text, created_at
                FROM domain_knowledge
                WHERE domain = 'payments'
                  AND topic = 'categorization'
                  AND subtopic = 'category_distinction_rules'
                  AND visibility = 'shareable'
                ORDER BY created_at DESC
                LIMIT 20
            `);

            // Update cache
            this.rulesCache.clear();
            for (const row of result.rows) {
                const rule = {
                    rule_id: row.knowledge_id,
                    ...row.content_structured,
                    created_at: row.created_at
                };
                this.rulesCache.set(row.knowledge_id, rule);
            }
            this.lastCacheUpdate = Date.now();

            logger.debug('Loaded category distinction rules', {
                count: result.rows.length
            });

            return Array.from(this.rulesCache.values());
        } catch (error) {
            logger.warn('Failed to load category rules', { error: error.message });
            return [];
        }
    }

    /**
     * Get rules relevant to specific categories
     * @param {array} categories - Categories involved in the transaction
     */
    async getRulesForCategories(categories) {
        const allRules = await this.getActiveRules();

        // Filter rules that mention any of the categories
        return allRules.filter(rule => {
            const ruleCategories = [
                rule.category_a,
                rule.category_b,
                ...(rule.applies_to || [])
            ].filter(Boolean);

            return categories.some(cat => ruleCategories.includes(cat));
        });
    }

    /**
     * Create a new category distinction rule from confusion training
     * @param {object} confusionPattern - The confusion pattern that was learned
     * @param {string} distinctionHint - The key distinction learned
     */
    async createDistinctionRule(confusionPattern, distinctionHint) {
        const { actual, predicted, confusion_rate } = confusionPattern;

        // Check if similar rule already exists
        const existingRule = await this._findExistingRule(actual, predicted);
        if (existingRule) {
            // Update existing rule with new hint
            return await this._updateRule(existingRule.knowledge_id, distinctionHint, confusion_rate);
        }

        const rule_id = uuidv4();

        const content_structured = {
            category_a: actual,
            category_b: predicted,
            applies_to: [actual, predicted],
            distinction: distinctionHint,
            confusion_rate: confusion_rate,
            rule_type: 'confusion_learned',
            examples_seen: 1,
            last_updated: new Date().toISOString()
        };

        const content_text = `**Category Distinction Rule:**
When distinguishing "${actual}" from "${predicted}":
${distinctionHint}

This rule was learned from confusion pattern training where ${actual} was being misclassified as ${predicted} (${(confusion_rate * 100).toFixed(0)}% confusion rate).`;

        const content_hash = crypto
            .createHash('sha256')
            .update(`rule:${actual}:${predicted}`)
            .digest('hex')
            .substring(0, 16);

        try {
            await query(`
                INSERT INTO domain_knowledge (
                    knowledge_id,
                    domain,
                    topic,
                    subtopic,
                    content_text,
                    content_structured,
                    source_type,
                    source_ref,
                    visibility,
                    difficulty_band,
                    tags,
                    content_hash
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                rule_id,
                'payments',
                'categorization',
                'category_distinction_rules',
                content_text,
                JSON.stringify(content_structured),
                'tessa_ai',  // Using tessa_ai as source since rules come from Tessa-generated training
                `confusion:${actual}:${predicted}`,
                'shareable',
                3,
                JSON.stringify(['category_rule', 'distinction', actual, predicted, 'learned']),
                content_hash
            ]);

            // Invalidate cache
            this.lastCacheUpdate = 0;

            logger.info('Created category distinction rule', {
                rule_id,
                category_a: actual,
                category_b: predicted,
                distinction: distinctionHint.substring(0, 100)
            });

            return rule_id;
        } catch (error) {
            if (error.code === '23505') { // Unique violation
                logger.debug('Distinction rule already exists', { actual, predicted });
                return null;
            }
            throw error;
        }
    }

    /**
     * Create a per-scenario reasoning-based rule to target specific mistakes
     * @param {object} mistake - mistake context (actual/predicted/scenario_id)
     * @param {string} reasoningHint - short reasoning snippet
     */
    async createScenarioReasonRule(mistake, reasoningHint) {
        const { actual, predicted, scenario_id } = mistake;

        if (!actual || !predicted || !reasoningHint) return null;

        const rule_id = uuidv4();
        const content_structured = {
            category_a: actual,
            category_b: predicted,
            applies_to: [actual, predicted],
            distinction: reasoningHint,
            rule_type: 'scenario_reasoning',
            scenario_id,
            examples_seen: 1,
            last_updated: new Date().toISOString()
        };

        const content_text = `**Scenario Reasoning Rule:**
When distinguishing "${actual}" from "${predicted}":
${reasoningHint}

Source: benchmark scenario ${scenario_id || 'unknown'}.`;

        const content_hash = crypto
            .createHash('sha256')
            .update(`scenario_rule:${actual}:${predicted}:${reasoningHint}`)
            .digest('hex')
            .substring(0, 16);

        try {
            await query(`
                INSERT INTO domain_knowledge (
                    knowledge_id,
                    domain,
                    topic,
                    subtopic,
                    content_text,
                    content_structured,
                    source_type,
                    source_ref,
                    visibility,
                    difficulty_band,
                    tags,
                    content_hash
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                rule_id,
                'payments',
                'categorization',
                'category_distinction_rules',
                content_text,
                JSON.stringify(content_structured),
                'app_event',
                `benchmark_scenario:${scenario_id || 'unknown'}`,
                'shareable',
                3,
                JSON.stringify(['category_rule', 'scenario_reasoning', actual, predicted]),
                content_hash
            ]);

            // Invalidate cache
            this.lastCacheUpdate = 0;

            logger.info('Created scenario reasoning rule', {
                rule_id,
                category_a: actual,
                category_b: predicted,
                scenario_id
            });

            return rule_id;
        } catch (error) {
            if (error.code === '23505') {
                logger.debug('Scenario reasoning rule already exists', { actual, predicted, scenario_id });
                return null;
            }
            throw error;
        }
    }

    /**
     * Find existing rule for a category pair
     */
    async _findExistingRule(categoryA, categoryB) {
        const result = await query(`
            SELECT knowledge_id, content_structured
            FROM domain_knowledge
            WHERE domain = 'payments'
              AND topic = 'categorization'
              AND subtopic = 'category_distinction_rules'
              AND (
                  (content_structured->>'category_a' = $1 AND content_structured->>'category_b' = $2)
                  OR (content_structured->>'category_a' = $2 AND content_structured->>'category_b' = $1)
              )
            LIMIT 1
        `, [categoryA, categoryB]);

        return result.rows[0] || null;
    }

    /**
     * Update an existing rule with additional distinction
     */
    async _updateRule(knowledgeId, newHint, confusionRate) {
        const result = await query(`
            SELECT content_structured, content_text
            FROM domain_knowledge
            WHERE knowledge_id = $1
        `, [knowledgeId]);

        if (result.rows.length === 0) return null;

        const existing = result.rows[0].content_structured;

        // Combine distinctions
        const existingDistinction = existing.distinction || '';
        const combinedDistinction = existingDistinction.includes(newHint)
            ? existingDistinction
            : `${existingDistinction}\n- ${newHint}`;

        const updatedStructured = {
            ...existing,
            distinction: combinedDistinction,
            confusion_rate: confusionRate,
            examples_seen: (existing.examples_seen || 1) + 1,
            last_updated: new Date().toISOString()
        };

        const updatedText = `**Category Distinction Rule:**
When distinguishing "${existing.category_a}" from "${existing.category_b}":
${combinedDistinction}

Examples seen: ${updatedStructured.examples_seen}
Last confusion rate: ${(confusionRate * 100).toFixed(0)}%`;

        await query(`
            UPDATE domain_knowledge
            SET content_structured = $1,
                content_text = $2,
                updated_at = NOW()
            WHERE knowledge_id = $3
        `, [JSON.stringify(updatedStructured), updatedText, knowledgeId]);

        // Invalidate cache
        this.lastCacheUpdate = 0;

        logger.info('Updated category distinction rule', {
            knowledge_id: knowledgeId,
            examples_seen: updatedStructured.examples_seen
        });

        return knowledgeId;
    }

    /**
     * Format rules for injection into categorization prompt
     */
    formatRulesForPrompt(rules) {
        if (!rules || rules.length === 0) {
            return '';
        }

        const formatted = rules.map((rule, idx) => {
            return `${idx + 1}. **${rule.category_a} vs ${rule.category_b}**: ${rule.distinction}`;
        }).join('\n');

        return `# LEARNED CATEGORY DISTINCTIONS (ALWAYS APPLY)
${formatted}

IMPORTANT: Apply these learned distinctions when the expense could be either category.`;
    }

    /**
     * Clear the rules cache (for testing)
     */
    clearCache() {
        this.rulesCache.clear();
        this.lastCacheUpdate = 0;
    }
}

// Singleton instance
const categoryRulesManager = new CategoryRulesManager();

module.exports = categoryRulesManager;
