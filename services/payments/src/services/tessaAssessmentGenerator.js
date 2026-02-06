/**
 * Tessa Assessment Generator
 * Uses GPT to generate novel, diverse expense scenarios for Oggy's training
 * Expands domain knowledge beyond initial training data
 *
 * Week 8: Self-Expanding Knowledge Base
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const retryHandler = require('../utils/retry');
const { adaptiveDifficultyScaler, DIFFICULTY_TIERS } = require('./adaptiveDifficultyScaler');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-mini';

class TessaAssessmentGenerator {
    constructor() {
        // Use registry to get shared circuit breaker instance
        this.openaiCircuitBreaker = circuitBreakerRegistry.getOrCreate('tessa-openai', {
            failureThreshold: 3,
            timeout: 30000
        });

        // Categories to generate scenarios for
        this.categories = [
            'business_meal',
            'groceries',
            'transportation',
            'utilities',
            'entertainment',
            'health',
            'dining',
            'shopping'
        ];

        // Scale complexity definitions - mirrors sealedBenchmarkGenerator for consistency
        this.scaleComplexity = {
            1: {
                name: 'Foundation',
                description: 'Basic payment categorization with clear indicators',
                requirements: [
                    'Single clear category indicator',
                    'Common merchant names',
                    'Standard transaction amounts'
                ],
                prompt_additions: ''
            },
            2: {
                name: 'Intermediate',
                description: 'Multi-factor scenarios requiring context analysis',
                requirements: [
                    'Category depends on context clues',
                    'Amount-based category hints',
                    'Time-sensitive categorization'
                ],
                prompt_additions: `
SCALE 2 COMPLEXITY REQUIREMENTS:
- The category should not be immediately obvious from merchant name alone
- Include contextual details that are necessary to determine the correct category
- The scenario should require reading the full description to categorize correctly`
            },
            3: {
                name: 'Advanced',
                description: 'Complex real-world payment patterns',
                requirements: [
                    'Multi-category potential',
                    'Subscription services',
                    'Business vs personal blur'
                ],
                prompt_additions: `
SCALE 3 COMPLEXITY REQUIREMENTS:
- Include realistic complexity (subscriptions, memberships, bundled services)
- The scenario could initially suggest a different category but resolves correctly
- Require understanding of context to distinguish similar categories
- Include subtle business vs personal distinctions`
            },
            4: {
                name: 'Expert',
                description: 'Edge cases requiring deep contextual understanding',
                requirements: [
                    'Tax-relevant distinctions',
                    'Unusual merchant types',
                    'Compound transactions'
                ],
                prompt_additions: `
SCALE 4 COMPLEXITY REQUIREMENTS:
- Include edge case elements (unusual merchants, compound services)
- Professional/personal overlap requiring careful analysis
- The description should require expert-level understanding to categorize
- Include scenarios where naive categorization would be incorrect`
            },
            5: {
                name: 'Master',
                description: 'Nuanced scenarios requiring deep analysis',
                requirements: [
                    'Genuinely nuanced categories',
                    'Temporal context matters',
                    'User intent inference'
                ],
                prompt_additions: `
SCALE 5 COMPLEXITY REQUIREMENTS:
- Create genuinely nuanced scenarios where category depends on subtle clues
- The scenario should test deep understanding of category boundaries
- Include scenarios where multiple categories seem plausible but one is correct
- Require inference of user intent or transaction context`
            }
        };
    }

    /**
     * Generate a novel, realistic expense scenario using GPT
     * @param {object} options - Generation options
     * @returns {object} Assessment with merchant, amount, description, category
     */
    async generateNovelScenario(options = {}) {
        const {
            category = this._randomCategory(),
            difficultyTier = DIFFICULTY_TIERS.TIER_2_STANDARD,
            // Legacy support for old difficulty parameter
            difficulty = null,
            // Scale system support
            scale = null,
            level = null
        } = options;

        // Convert old difficulty to tier if needed
        const tier = difficulty ? this._legacyDifficultyToTier(difficulty) : difficultyTier;

        // Get scale context if provided
        const scaleContext = scale ? {
            scale,
            level: level || 3,
            scaleConfig: this.scaleComplexity[Math.min(scale, 5)] || this.scaleComplexity[5]
        } : null;

        try {
            // Build prompt with scale context if available
            let prompt;
            if (scaleContext && scaleContext.scale >= 2) {
                prompt = this._buildScaleAwarePrompt(category, tier, scaleContext);
            } else {
                prompt = adaptiveDifficultyScaler.buildTessaPrompt(category, tier);
            }

            const scenario = await this.openaiCircuitBreaker.execute(async () => {
                return await retryHandler.withRetry(
                    async () => await this._callOpenAI(prompt),
                    {
                        maxRetries: 2,
                        baseDelay: 1000,
                        operationName: 'tessa-generate-scenario'
                    }
                );
            });

            // Add tier and scale information to scenario
            scenario.difficulty_tier = tier.name;
            scenario.tier_level = tier.tier_level;
            if (scaleContext) {
                scenario.scale = scaleContext.scale;
                scenario.scale_level = scaleContext.level;
                scenario.scale_name = scaleContext.scaleConfig.name;
            }

            // Add to domain knowledge for future learning
            await this._addToDomainKnowledge(scenario, tier);

            logger.info('Tessa generated novel scenario', {
                category: scenario.category,
                merchant: scenario.merchant,
                difficulty_tier: tier.name,
                tier_level: tier.tier_level,
                scale: scaleContext?.scale,
                scale_name: scaleContext?.scaleConfig?.name,
                baseline_scale: adaptiveDifficultyScaler.baselineDifficultyScale,
                knowledge_id: scenario.knowledge_id
            });

            return {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                correctCategory: scenario.category,
                difficulty: tier.name,
                difficultyTier: tier,
                source: 'tessa_generated',
                knowledge_id: scenario.knowledge_id,
                scale: scaleContext?.scale,
                scale_name: scaleContext?.scaleConfig?.name
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'generateNovelScenario',
                category,
                tier: tier.name,
                scale: scaleContext?.scale
            });

            // Fallback: return null so self-learning can use existing domain knowledge
            return null;
        }
    }

    /**
     * Build a scale-aware prompt for higher complexity scenarios
     */
    _buildScaleAwarePrompt(category, tier, scaleContext) {
        const { scale, scaleConfig } = scaleContext;

        const categoryDefinitions = {
            'business_meal': 'Work-related dining: client meetings, team lunches, business dinners, networking events over food. MUST have explicit business/work context.',
            'groceries': 'Food shopping at supermarkets/grocery stores for home cooking and household food supplies.',
            'transportation': 'Travel and vehicle expenses: gas, rideshare, parking, car repairs, public transit.',
            'utilities': 'Home services: electricity, water, internet, phone bills, gas utilities.',
            'entertainment': 'Leisure activities: movies, concerts, streaming services, hobbies, sports events, gaming.',
            'health': 'Medical and wellness: gym memberships, pharmacy, doctor visits, health supplements.',
            'dining': 'Personal restaurant/cafe visits for pleasure (NOT work-related), casual meals with friends/family.',
            'shopping': 'Retail purchases: clothing, electronics, household items, online shopping.'
        };

        return `You are Tessa, an expert at generating realistic expense categorization scenarios for training AI systems.

## SCALE: S${scale} - ${scaleConfig.name}
${scaleConfig.description}

${scaleConfig.prompt_additions}

## TASK
Generate ONE realistic expense transaction for category: ${category}

## Difficulty Tier: ${tier.name} (Level ${tier.tier_level}/5)
${tier.description || ''}

## Category Definition
${category}: ${categoryDefinitions[category]}

## CRITICAL RULES
- For "dining": NEVER mention business, clients, meetings, colleagues, or work context
- For "business_meal": ALWAYS explicitly mention clients, business meeting, work event, or professional context
- The scenario must ultimately resolve to "${category}" when analyzed carefully
- At S${scale}, the scenario should have the complexity described above

## Requirements
1. Create a realistic merchant name
2. Generate a natural transaction description with appropriate complexity for S${scale}
3. Use a realistic USD amount
4. Include reasoning that explains the categorization

Return ONLY valid JSON:
{
  "merchant": "Merchant Name",
  "amount": 45.50,
  "description": "Transaction description with S${scale} complexity",
  "category": "${category}",
  "reasoning": "Why this is ${category} - include key distinguishing factors"
}`;
    }

    /**
     * Convert legacy difficulty string to new tier system
     */
    _legacyDifficultyToTier(difficulty) {
        const mapping = {
            'easy': DIFFICULTY_TIERS.TIER_1_WARMUP,
            'medium': DIFFICULTY_TIERS.TIER_2_STANDARD,
            'hard': DIFFICULTY_TIERS.TIER_3_CHALLENGE,
            'very_hard': DIFFICULTY_TIERS.TIER_4_EXPERT,
            'extreme': DIFFICULTY_TIERS.TIER_5_EXTREME
        };
        return mapping[difficulty] || DIFFICULTY_TIERS.TIER_2_STANDARD;
    }

    /**
     * Call OpenAI to generate scenario
     */
    async _callOpenAI(prompt) {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: OPENAI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'You are Tessa, an expert at generating realistic expense categorization scenarios for training AI systems. You create diverse, realistic examples that help AI learn nuanced categorization.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.9, // Higher creativity for diverse scenarios
                max_tokens: 600
            },
            {
                headers: {
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        const completion = response.data.choices[0].message.content.trim();

        // Parse JSON from response
        const jsonStr = completion.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        let parsed;
        try {
            parsed = JSON.parse(jsonStr);
        } catch (e) {
            // Try repair for truncated/malformed JSON
            parsed = this._repairAndParseJson(completion);
            if (!parsed) throw e;
        }

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: parsed.category,
            reasoning: parsed.reasoning,
            distinction_hint: parsed.distinction_hint
        };
    }

    /**
     * Repair malformed JSON from LLM output (unescaped quotes, truncation).
     */
    _repairAndParseJson(text) {
        const startIdx = text.indexOf('{');
        if (startIdx === -1) return null;

        const chars = [...text.substring(startIdx)];
        const result = [];
        let inString = false;
        let escaped = false;

        for (let i = 0; i < chars.length; i++) {
            if (escaped) { result.push(chars[i]); escaped = false; continue; }
            if (chars[i] === '\\') { result.push(chars[i]); escaped = true; continue; }
            if (chars[i] === '"') {
                if (!inString) {
                    inString = true;
                    result.push('"');
                } else {
                    let j = i + 1;
                    while (j < chars.length && ' \t\n\r'.includes(chars[j])) j++;
                    const next = j < chars.length ? chars[j] : '';
                    if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
                        inString = false;
                        result.push('"');
                    } else {
                        result.push('\\"');
                    }
                }
            } else {
                result.push(chars[i]);
            }
        }

        let fixed = result.join('');
        if (inString) fixed += '"';

        let braces = 0, inStr = false, esc = false;
        for (const ch of fixed) {
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (!inStr) { if (ch === '{') braces++; if (ch === '}') braces--; }
        }
        while (braces > 0) { fixed += '}'; braces--; }

        return JSON.parse(fixed);
    }

    /**
     * Add generated scenario to domain_knowledge
     * This expands Oggy's knowledge base automatically
     */
    async _addToDomainKnowledge(scenario, tier) {
        const knowledge_id = uuidv4();

        const tierInfo = tier ? `\n**Difficulty Tier:** ${tier.name} (Level ${tier.tier_level}/5)` : '';

        const content_text = `**AI-Generated Expense Scenario (Tessa):**
- Merchant: ${scenario.merchant}
- Category: ${scenario.category}
- Amount: $${scenario.amount}
- Description: ${scenario.description}${tierInfo}

**Reasoning:** ${scenario.reasoning}

${scenario.ambiguity_notes ? `**Challenge:** ${scenario.ambiguity_notes}\n` : ''}
This is a realistic example for training categorization AI.`;

        const content_structured = {
            merchant: scenario.merchant,
            category: scenario.category,
            amount: scenario.amount,
            description: scenario.description,
            reasoning: scenario.reasoning,
            difficulty_tier: scenario.difficulty_tier,
            tier_level: scenario.tier_level,
            ambiguity_notes: scenario.ambiguity_notes,
            source: 'tessa_generated'
        };

        const content_hash = require('crypto')
            .createHash('sha256')
            .update(JSON.stringify(content_structured))
            .digest('hex')
            .substring(0, 16);

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
            knowledge_id,
            'payments',
            'categorization',
            'ai_generated_scenarios',
            content_text,
            JSON.stringify(content_structured),
            'tessa_ai',
            `tessa_generated:${knowledge_id}`,
            'shareable',
            tier ? tier.tier_level : 3, // Use tier level as difficulty band (1-5)
            JSON.stringify(['categorization', 'ai_generated', scenario.category, 'tessa', tier ? tier.name : 'standard']),
            content_hash
        ]);

        scenario.knowledge_id = knowledge_id;
        return knowledge_id;
    }

    /**
     * Generate multiple scenarios at once
     */
    async generateBatch(count = 10, options = {}) {
        const scenarios = [];
        const errors = [];

        logger.info('Tessa generating batch of scenarios', { count });

        for (let i = 0; i < count; i++) {
            try {
                // Vary difficulty and category
                const category = options.category || this._randomCategory();
                const difficulty = options.difficulty || this._randomDifficulty();

                const scenario = await this.generateNovelScenario({
                    category,
                    difficulty,
                    includeAmbiguity: Math.random() > 0.7 // 30% ambiguous
                });

                if (scenario) {
                    scenarios.push(scenario);
                }

                // Small delay to avoid rate limits
                await this._sleep(500);
            } catch (error) {
                errors.push(error.message);
                logger.warn('Failed to generate scenario in batch', {
                    index: i,
                    error: error.message
                });
            }
        }

        logger.info('Tessa batch generation complete', {
            requested: count,
            generated: scenarios.length,
            errors: errors.length
        });

        return {
            scenarios,
            success_count: scenarios.length,
            error_count: errors.length
        };
    }

    /**
     * Get statistics on generated scenarios
     */
    async getGenerationStats() {
        const result = await query(`
            SELECT
                COUNT(*) as total,
                COUNT(DISTINCT content_structured->>'category') as unique_categories,
                content_structured->>'category' as category,
                COUNT(*) as count_per_category
            FROM domain_knowledge
            WHERE source_type = 'tessa_ai'
            GROUP BY content_structured->>'category'
        `);

        return {
            total_generated: result.rows.reduce((sum, row) => sum + parseInt(row.count_per_category), 0),
            by_category: result.rows.map(row => ({
                category: row.category,
                count: parseInt(row.count_per_category)
            }))
        };
    }

    _randomCategory() {
        return this.categories[Math.floor(Math.random() * this.categories.length)];
    }

    _randomDifficulty() {
        const rand = Math.random();
        if (rand < 0.3) return 'easy';
        if (rand < 0.7) return 'medium';
        if (rand < 0.9) return 'hard';
        return 'very_hard';
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Generate targeted practice items for specific weak categories
     * Used by benchmark-driven learning to focus on areas Oggy struggles with
     *
     * @param {Array} weakCategories - Array of {category, accuracy, severity}
     * @param {number} itemsPerCategory - Number of items per category (default 10)
     * @returns {Array} Practice items with category metadata
     */
    async generateForWeakCategories(weakCategories, itemsPerCategory = 10) {
        const items = [];

        logger.info('Generating items for weak categories', {
            weak_categories: weakCategories.map(w => w.category),
            items_per_category: itemsPerCategory
        });

        for (const weakness of weakCategories) {
            // Select difficulty tier based on severity
            const tier = this._severityToTier(weakness.severity);

            for (let i = 0; i < itemsPerCategory; i++) {
                try {
                    const scenario = await this.generateNovelScenario({
                        category: weakness.category,
                        difficultyTier: tier
                    });

                    if (scenario) {
                        items.push({
                            ...scenario,
                            weakness_context: {
                                original_accuracy: weakness.accuracy,
                                severity: weakness.severity,
                                target_improvement: Math.max(0.60 - weakness.accuracy, 0.10)
                            }
                        });
                    }

                    // Rate limit to avoid API issues
                    await this._sleep(300);

                } catch (error) {
                    logger.warn('Failed to generate targeted item', {
                        category: weakness.category,
                        index: i,
                        error: error.message
                    });
                }
            }
        }

        logger.info('Generated weak category items', {
            total: items.length,
            by_category: this._countByCategory(items)
        });

        return items;
    }

    /**
     * Map weakness severity to appropriate difficulty tier
     * Weaker categories get easier practice first (build foundation)
     */
    _severityToTier(severity) {
        switch (severity) {
            case 'critical':  // < 30% accuracy
                return DIFFICULTY_TIERS.TIER_1_WARMUP;
            case 'severe':    // < 45% accuracy
                return DIFFICULTY_TIERS.TIER_2_STANDARD;
            case 'moderate':  // < 60% accuracy
                return DIFFICULTY_TIERS.TIER_3_CHALLENGE;
            default:
                return DIFFICULTY_TIERS.TIER_2_STANDARD;
        }
    }

    /**
     * Count items by category
     */
    _countByCategory(items) {
        const counts = {};
        for (const item of items) {
            const cat = item.correctCategory;
            counts[cat] = (counts[cat] || 0) + 1;
        }
        return counts;
    }

    /**
     * Generate scenarios specifically targeting confusion patterns
     * These scenarios are designed to help Oggy distinguish between commonly confused categories
     *
     * @param {Array} confusionPatterns - Array of {actual, predicted, count, confusion_rate}
     * @param {number} itemsPerPattern - Number of items per confusion pattern (default 5)
     * @returns {Array} Practice items targeting specific confusion patterns
     */
    async generateForConfusionPatterns(confusionPatterns, itemsPerPattern = 5) {
        const items = [];

        logger.info('Generating confusion-targeted scenarios', {
            patterns: confusionPatterns.map(p => `${p.actual}→${p.predicted}`),
            items_per_pattern: itemsPerPattern
        });

        for (const pattern of confusionPatterns) {
            const { actual, predicted, confusion_rate } = pattern;

            for (let i = 0; i < itemsPerPattern; i++) {
                try {
                    const scenario = await this._generateConfusionScenario(actual, predicted, confusion_rate);

                    if (scenario) {
                        items.push({
                            ...scenario,
                            confusion_context: {
                                actual_category: actual,
                                confused_with: predicted,
                                confusion_rate: confusion_rate,
                                training_goal: `Learn to distinguish ${actual} from ${predicted}`
                            }
                        });
                    }

                    // Rate limit to avoid API issues
                    await this._sleep(300);

                } catch (error) {
                    logger.warn('Failed to generate confusion-targeted item', {
                        actual,
                        predicted,
                        index: i,
                        error: error.message
                    });
                }
            }
        }

        logger.info('Generated confusion-targeted items', {
            total: items.length,
            by_pattern: this._countByConfusionPattern(items)
        });

        return items;
    }

    /**
     * Generate a scenario that specifically addresses confusion between two categories
     * The scenario will be clearly in the 'actual' category but have elements that might
     * superficially seem like 'confused_with' category, forcing Oggy to learn the distinction
     */
    async _generateConfusionScenario(actualCategory, confusedWith, confusionRate) {
        const prompt = this._buildConfusionPrompt(actualCategory, confusedWith, confusionRate);

        const scenario = await this.openaiCircuitBreaker.execute(async () => {
            return await retryHandler.withRetry(
                async () => await this._callOpenAI(prompt),
                {
                    maxRetries: 2,
                    baseDelay: 1000,
                    operationName: 'tessa-confusion-scenario'
                }
            );
        });

        // Add to domain knowledge
        await this._addToDomainKnowledge(scenario, DIFFICULTY_TIERS.TIER_3_CHALLENGE);

        logger.debug('Generated confusion-targeted scenario', {
            actual: actualCategory,
            confused_with: confusedWith,
            merchant: scenario.merchant
        });

        return {
            merchant: scenario.merchant,
            amount: scenario.amount,
            description: scenario.description,
            correctCategory: scenario.category,
            difficulty: 'confusion_targeted',
            source: 'tessa_confusion_training',
            knowledge_id: scenario.knowledge_id,
            distinction_hint: scenario.distinction_hint
        };
    }

    /**
     * Build a prompt specifically for confusion-targeted scenarios
     */
    _buildConfusionPrompt(actualCategory, confusedWith, confusionRate) {
        const categoryDefinitions = {
            'business_meal': 'Work-related dining: client meetings, team lunches, business dinners, networking events over food',
            'groceries': 'Food shopping at supermarkets/grocery stores for home cooking and household food supplies',
            'transportation': 'Travel and vehicle expenses: gas, rideshare, parking, car repairs, public transit, flights',
            'utilities': 'Home services: electricity, water, internet, phone bills, gas utilities',
            'entertainment': 'Leisure activities: movies, concerts, streaming services, hobbies, sports events, gaming',
            'health': 'Medical and wellness: gym memberships, pharmacy, doctor visits, health supplements, therapy',
            'dining': 'Personal restaurant/cafe visits for pleasure (NOT work-related), casual meals out, coffee shops',
            'shopping': 'Retail purchases: clothing, electronics, household items, online shopping, general merchandise'
        };

        const severityNote = confusionRate >= 0.30
            ? 'This is a CRITICAL confusion pattern - make the distinction very clear.'
            : 'Help clarify the distinction between these commonly confused categories.';

        return `You are generating a TRAINING scenario to help an AI learn to distinguish between "${actualCategory}" and "${confusedWith}".

CRITICAL TASK: Create a scenario that is CLEARLY "${actualCategory}" but has elements that might superficially seem like "${confusedWith}".

Category definitions:
- ${actualCategory}: ${categoryDefinitions[actualCategory]}
- ${confusedWith}: ${categoryDefinitions[confusedWith]}

${severityNote}

Requirements:
1. The transaction MUST legitimately belong to "${actualCategory}"
2. Include realistic details that might cause confusion with "${confusedWith}"
3. But also include clear indicators that distinguish it as "${actualCategory}"
4. Create a realistic merchant name and transaction description
5. Include a "distinction_hint" explaining WHY this is ${actualCategory} and NOT ${confusedWith}

Example for dining vs business_meal confusion:
- A dinner at an upscale restaurant with friends (NOT business) is "dining"
- Key distinction: personal/social vs. work-related purpose

Return ONLY valid JSON:
{
  "merchant": "Realistic Merchant Name",
  "amount": 45.50,
  "description": "Transaction description with realistic details",
  "category": "${actualCategory}",
  "reasoning": "Why this is clearly ${actualCategory}",
  "distinction_hint": "Key factor that distinguishes this from ${confusedWith}: [specific distinguishing detail]"
}`;
    }

    /**
     * Count items by confusion pattern
     */
    _countByConfusionPattern(items) {
        const counts = {};
        for (const item of items) {
            if (item.confusion_context) {
                const key = `${item.confusion_context.actual_category}→${item.confusion_context.confused_with}`;
                counts[key] = (counts[key] || 0) + 1;
            }
        }
        return counts;
    }
}

// Singleton instance
const tessaAssessmentGenerator = new TessaAssessmentGenerator();

module.exports = tessaAssessmentGenerator;
