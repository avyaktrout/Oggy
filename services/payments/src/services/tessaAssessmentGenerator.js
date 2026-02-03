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
const CircuitBreaker = require('../utils/circuitBreaker');
const retryHandler = require('../utils/retry');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-mini';

class TessaAssessmentGenerator {
    constructor() {
        this.openaiCircuitBreaker = new CircuitBreaker({
            name: 'tessa-openai',
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
    }

    /**
     * Generate a novel, realistic expense scenario using GPT
     * @param {object} options - Generation options
     * @returns {object} Assessment with merchant, amount, description, category
     */
    async generateNovelScenario(options = {}) {
        const {
            category = this._randomCategory(),
            difficulty = 'medium',
            includeAmbiguity = false
        } = options;

        try {
            const prompt = this._buildPrompt(category, difficulty, includeAmbiguity);

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

            // Add to domain knowledge for future learning
            await this._addToDomainKnowledge(scenario);

            logger.info('Tessa generated novel scenario', {
                category: scenario.category,
                merchant: scenario.merchant,
                difficulty,
                knowledge_id: scenario.knowledge_id
            });

            return {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                correctCategory: scenario.category,
                difficulty,
                source: 'tessa_generated',
                knowledge_id: scenario.knowledge_id
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'generateNovelScenario',
                category
            });

            // Fallback: return null so self-learning can use existing domain knowledge
            return null;
        }
    }

    /**
     * Build GPT prompt for generating realistic expense scenarios
     */
    _buildPrompt(category, difficulty, includeAmbiguity) {
        const difficultyInstructions = {
            'easy': 'very obvious, typical example',
            'medium': 'realistic, common scenario',
            'hard': 'edge case, ambiguous, or requires careful reasoning',
            'very_hard': 'highly ambiguous, could be multiple categories, requires expert judgment'
        };

        const ambiguityNote = includeAmbiguity
            ? '\n- Make this somewhat ambiguous - it could reasonably be categorized in multiple ways, but one is most correct.'
            : '';

        return `You are Tessa, an AI that generates realistic expense categorization training scenarios.

Generate a realistic expense transaction that should be categorized as "${category}".

Requirements:
- Make it a ${difficultyInstructions[difficulty]} for the category "${category}"
- Use a real-world merchant name (can be fictional but realistic)
- Include a descriptive transaction description
- Use a realistic amount in USD${ambiguityNote}
- The expense MUST clearly belong to category "${category}" when considered carefully

Categories:
- business_meal: Client dinners, team lunches, work-related meals
- groceries: Supermarkets, food shopping for home
- transportation: Gas, Uber, parking, car expenses
- utilities: Electric, water, internet, phone bills
- entertainment: Movies, streaming, concerts, hobbies
- health: Gym, pharmacy, doctor, medical
- dining: Restaurants, cafes (personal, not business)
- shopping: Retail, online shopping, household items

Return ONLY a JSON object with this exact structure:
{
  "merchant": "Merchant Name",
  "amount": 45.50,
  "description": "Detailed description of the transaction",
  "category": "${category}",
  "reasoning": "Why this belongs in ${category} category"
}`;
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
                max_tokens: 300
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
        const parsed = JSON.parse(jsonStr);

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: parsed.category,
            reasoning: parsed.reasoning
        };
    }

    /**
     * Add generated scenario to domain_knowledge
     * This expands Oggy's knowledge base automatically
     */
    async _addToDomainKnowledge(scenario) {
        const knowledge_id = uuidv4();

        const content_text = `**AI-Generated Expense Scenario (Tessa):**
- Merchant: ${scenario.merchant}
- Category: ${scenario.category}
- Amount: $${scenario.amount}
- Description: ${scenario.description}

**Reasoning:** ${scenario.reasoning}

This is a realistic example for training categorization AI.`;

        const content_structured = {
            merchant: scenario.merchant,
            category: scenario.category,
            amount: scenario.amount,
            description: scenario.description,
            reasoning: scenario.reasoning,
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
            3, // Difficulty band for AI-generated
            JSON.stringify(['categorization', 'ai_generated', scenario.category, 'tessa']),
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
}

// Singleton instance
const tessaAssessmentGenerator = new TessaAssessmentGenerator();

module.exports = tessaAssessmentGenerator;
