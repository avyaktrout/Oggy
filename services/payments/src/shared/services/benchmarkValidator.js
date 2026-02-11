/**
 * Benchmark Validator
 * Validates that benchmark scenario descriptions match their labels
 * Prevents mislabeled test data from corrupting evaluation results
 *
 * Week 8+: Quality assurance for benchmark data
 */

const axios = require('axios');
const logger = require('../utils/logger');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

class BenchmarkValidator {
    constructor() {
        // Category definitions for validation
        this.categoryDefinitions = {
            'dining': 'Personal restaurant/cafe visits, casual meals out, social meals with friends/family, dates, coffee shops - NO work/business/client/meeting context',
            'business_meal': 'Work-related meals: client dinners, business lunches, team meals, networking events, conference meals - MUST have explicit business/work/client/meeting/team/project context',
            'groceries': 'Food items for home consumption from supermarkets/grocery stores - produce, dairy, bread, meat, household food items',
            'shopping': 'Non-food retail purchases: clothing, electronics, home goods, general merchandise - NOT primarily food items',
            'entertainment': 'Leisure activities: movies, concerts, streaming services, gaming, sports events - NOT food service establishments',
            'transportation': 'Travel costs: gas, parking, tolls, rideshare, public transit, car-related expenses',
            'utilities': 'Monthly home bills: electric, gas, water, internet, phone services',
            'health': 'Medical/wellness: pharmacy, doctor visits, gym, fitness, wellness treatments',
            'personal_care': 'Beauty/grooming services: salon, spa, haircut, cosmetic services',
            'other': 'Anything that does not fit the above categories'
        };

        // Known confusion pairs that need extra scrutiny
        this.confusionPairs = [
            ['dining', 'business_meal'],
            ['groceries', 'shopping'],
            ['entertainment', 'dining'],
            ['health', 'personal_care']
        ];
    }

    /**
     * Validate a single scenario
     * @param {object} scenario - The scenario to validate
     * @returns {object} Validation result with suggested_label if mismatch detected
     */
    async validateScenario(scenario) {
        const { merchant, description, correct_category } = scenario;

        try {
            const prompt = this._buildValidationPrompt(merchant, description, correct_category);
            const result = await this._callOpenAI(prompt);

            return {
                scenario_id: scenario.scenario_id,
                merchant,
                description,
                labeled_category: correct_category,
                validated_category: result.suggested_category,
                is_valid: result.suggested_category === correct_category,
                confidence: result.confidence,
                reasoning: result.reasoning,
                flags: result.flags || []
            };
        } catch (error) {
            logger.warn('Scenario validation failed', {
                scenario_id: scenario.scenario_id,
                error: error.message
            });
            return {
                scenario_id: scenario.scenario_id,
                is_valid: null,
                error: error.message
            };
        }
    }

    /**
     * Validate all scenarios in a benchmark
     * @param {array} scenarios - Array of scenarios to validate
     * @returns {object} Validation report with issues found
     */
    async validateBenchmark(scenarios) {
        logger.info('Validating benchmark scenarios', { count: scenarios.length });

        const results = [];
        const issues = [];

        for (const scenario of scenarios) {
            const result = await this.validateScenario(scenario);
            results.push(result);

            if (result.is_valid === false) {
                issues.push({
                    scenario_id: scenario.scenario_id,
                    merchant: scenario.merchant,
                    description: scenario.description,
                    labeled_as: scenario.correct_category,
                    should_be: result.validated_category,
                    confidence: result.confidence,
                    reasoning: result.reasoning
                });
            }
        }

        const report = {
            total_scenarios: scenarios.length,
            valid_count: results.filter(r => r.is_valid === true).length,
            invalid_count: issues.length,
            error_count: results.filter(r => r.is_valid === null).length,
            issues,
            validation_rate: ((results.filter(r => r.is_valid === true).length / scenarios.length) * 100).toFixed(1) + '%'
        };

        logger.info('Benchmark validation complete', {
            total: report.total_scenarios,
            valid: report.valid_count,
            invalid: report.invalid_count
        });

        return report;
    }

    /**
     * Validate and fix scenarios before saving to benchmark
     * This should be called during benchmark generation
     * @param {array} scenarios - Generated scenarios
     * @returns {array} Validated and corrected scenarios
     */
    async validateAndFixScenarios(scenarios) {
        const validated = [];

        for (const scenario of scenarios) {
            const result = await this.validateScenario(scenario);

            if (result.is_valid === false && result.confidence > 0.7) {
                // High confidence mismatch - fix the label
                logger.warn('Auto-correcting mislabeled scenario', {
                    merchant: scenario.merchant,
                    original_label: scenario.correct_category,
                    corrected_label: result.validated_category,
                    reason: result.reasoning
                });

                validated.push({
                    ...scenario,
                    correct_category: result.validated_category,
                    original_label: scenario.correct_category,
                    auto_corrected: true
                });
            } else {
                validated.push(scenario);
            }
        }

        return validated;
    }

    /**
     * Apply reasoning-based auto-fix without LLM calls.
     * Returns { scenarios, fixedCount }.
     */
    applyReasoningAutoFix(scenarios) {
        let fixedCount = 0;
        const updated = scenarios.map(scenario => {
            const reasoningInference = this._inferCategoryFromReasoning(scenario.reasoning || '');
            if (reasoningInference && reasoningInference.category &&
                reasoningInference.category !== scenario.correct_category) {
                fixedCount++;
                return {
                    ...scenario,
                    correct_category: reasoningInference.category,
                    original_label: scenario.correct_category,
                    auto_corrected: true,
                    auto_corrected_reason: 'reasoning_inference'
                };
            }
            return scenario;
        });

        if (fixedCount > 0) {
            logger.warn('Reasoning-based auto-fix applied', { fixed_count: fixedCount });
        }

        return { scenarios: updated, fixedCount };
    }

    /**
     * Quick validation using keyword checks (no LLM call)
     * Use this for fast pre-screening before full validation
     */
    quickValidate(scenario) {
        const { description, correct_category } = scenario;
        const descLower = description.toLowerCase();

        const flags = [];

        // Check dining vs business_meal (require 2+ keywords to reduce false positives)
        if (correct_category === 'dining') {
            const businessKeywords = ['client', 'meeting', 'team', 'conference', 'work', 'project', 'business', 'networking', 'professional'];
            const foundBusinessWords = businessKeywords.filter(kw => descLower.includes(kw));
            if (foundBusinessWords.length >= 2) {
                flags.push({
                    type: 'potential_mislabel',
                    message: `Dining scenario contains business keywords: ${foundBusinessWords.join(', ')}`,
                    suggested_category: 'business_meal'
                });
            }
        }

        if (correct_category === 'business_meal') {
            const personalKeywords = ['friend', 'family', 'date', 'anniversary', 'birthday', 'personal', 'catching up'];
            const foundPersonalWords = personalKeywords.filter(kw => descLower.includes(kw));
            if (foundPersonalWords.length >= 2) {
                flags.push({
                    type: 'potential_mislabel',
                    message: `Business meal scenario contains personal keywords: ${foundPersonalWords.join(', ')}`,
                    suggested_category: 'dining'
                });
            }
        }

        // Check groceries vs shopping (require 2+ keywords)
        if (correct_category === 'groceries') {
            const shoppingKeywords = ['clothing', 'electronics', 'home goods', 'personal care', 'accessories'];
            const foundShoppingWords = shoppingKeywords.filter(kw => descLower.includes(kw));
            if (foundShoppingWords.length >= 2) {
                flags.push({
                    type: 'potential_mislabel',
                    message: `Groceries scenario mentions non-food items: ${foundShoppingWords.join(', ')}`,
                    suggested_category: 'shopping'
                });
            }
        }

        if (correct_category === 'shopping') {
            const groceryKeywords = ['grocery', 'groceries', 'food', 'produce', 'vegetables', 'fruits', 'dairy', 'bread'];
            const foundGroceryWords = groceryKeywords.filter(kw => descLower.includes(kw));
            if (foundGroceryWords.length >= 2 && !descLower.includes('non-food')) {
                flags.push({
                    type: 'potential_mislabel',
                    message: `Shopping scenario mentions food/grocery items: ${foundGroceryWords.join(', ')}`,
                    suggested_category: 'groceries'
                });
            }
        }

        return {
            scenario_id: scenario.scenario_id,
            has_flags: flags.length > 0,
            flags
        };
    }

    /**
     * Infer correct category from scenario reasoning when it explicitly states the label.
     * Returns { category, confidence, reason } or null if no strong signal found.
     */
    _inferCategoryFromReasoning(reasoning) {
        if (!reasoning) return null;

        const text = reasoning.toLowerCase();
        const categories = Object.keys(this.categoryDefinitions);

        const patterns = [
            { regex: /categorized as ([a-z_\s-]+)/i, reason: 'categorized_as' },
            { regex: /should be (categorized as )?([a-z_\s-]+)/i, reason: 'should_be' },
            { regex: /is best categorized as ([a-z_\s-]+)/i, reason: 'best_categorized' },
            { regex: /primary purpose.*?([a-z_\s-]+)/i, reason: 'primary_purpose' },
            { regex: /takes precedence.*?([a-z_\s-]+)/i, reason: 'takes_precedence' },
            { regex: /this is a ([a-z_\s-]+) expense/i, reason: 'is_expense' },
            { regex: /the correct category.*?([a-z_\s-]+)/i, reason: 'correct_category' },
            { regex: /classified as ([a-z_\s-]+)/i, reason: 'classified_as' },
            { regex: /categorized as a ([a-z_\s-]+)/i, reason: 'categorized_as_a' }
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern.regex);
            if (!match) continue;
            const rawCandidate = (match[2] || match[1] || '').toLowerCase().trim();
            if (!rawCandidate) continue;

            const normalized = rawCandidate
                .replace(/category|expense|transaction|type|this|a|an|the/gi, '')
                .replace(/[^a-z\s-]/g, '')
                .trim()
                .replace(/\s+/g, '_')
                .replace(/-+/g, '_');

            if (!categories.includes(normalized)) continue;

            const idx = match.index || 0;
            const windowStart = Math.max(0, idx - 5);
            const window = text.slice(windowStart, idx);
            if (window.includes('not ')) {
                continue;
            }

            return {
                category: normalized,
                confidence: 0.95,
                reason: pattern.reason
            };
        }

        // No strong pattern match found - do NOT use loose fallbacks
        // (e.g., "first category mention" or keyword-based inference)
        // as they incorrectly flip labels more often than they fix them
        return null;
    }

    /**
     * Build validation prompt
     */
    _buildValidationPrompt(merchant, description, labeledCategory) {
        return `You are a financial expense categorization validator. Your job is to verify if a scenario's label matches its description.

# Scenario to Validate
Merchant: ${merchant}
Description: ${description}
Labeled Category: ${labeledCategory}

# Category Definitions (STRICT)
${Object.entries(this.categoryDefinitions).map(([cat, def]) => `- **${cat}**: ${def}`).join('\n')}

# Critical Rules
1. **dining vs business_meal**:
   - If description mentions "client", "meeting", "team", "project", "conference", "work", "business", "networking" → MUST be business_meal
   - If description mentions "friends", "family", "date", "anniversary", "personal" with NO work context → MUST be dining

2. **groceries vs shopping**:
   - If PRIMARY purchase is food for home → groceries
   - If PRIMARY purchase is non-food items (clothing, electronics, home goods) → shopping

# Task
Determine what category this expense SHOULD be based on the description, regardless of what it's labeled as.

Respond in JSON (no markdown):
{
  "suggested_category": "<correct_category>",
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>",
  "flags": ["<any_warning_flags>"]
}`;
    }

    /**
     * Call OpenAI for validation
     */
    async _callOpenAI(prompt) {
        if (!OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY not configured');
        }

        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: 'You are a strict expense categorization validator.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,  // Low temperature for consistent validation
                max_tokens: 200
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const completion = response.data.choices[0].message.content.trim();
        const jsonStr = completion.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(jsonStr);
    }
}

// Singleton instance
const benchmarkValidator = new BenchmarkValidator();

module.exports = benchmarkValidator;
