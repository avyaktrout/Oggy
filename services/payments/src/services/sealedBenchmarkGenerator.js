/**
 * Sealed Benchmark Generator
 * Creates fixed, out-of-distribution test sets using Claude (not GPT)
 * Prevents overfitting to Tessa's GPT-4o-mini generation patterns
 *
 * Week 8: Scientific Evaluation with OOD Testing
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const CircuitBreaker = require('../utils/circuitBreaker');
const retryHandler = require('../utils/retry');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = 'claude-3-haiku-20240307'; // Claude 3 Haiku - fast and affordable
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = 'gpt-4o-mini';

/**
 * Out-of-Distribution Sealed Benchmark Generator
 * Uses Claude instead of GPT to create truly independent test sets
 */
class SealedBenchmarkGenerator {
    constructor() {
        this.claudeCircuitBreaker = new CircuitBreaker({
            name: 'sealed-benchmark-claude',
            failureThreshold: 3,
            timeout: 30000
        });

        this.openaiCircuitBreaker = new CircuitBreaker({
            name: 'sealed-benchmark-openai',
            failureThreshold: 3,
            timeout: 30000
        });

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
     * Create a sealed benchmark set
     * @param {object} options - Benchmark creation options
     * @returns {object} Created benchmark with ID and scenarios
     */
    async createSealedBenchmark(options = {}) {
        const {
            count = 100,              // Number of assessments
            name = null,              // Optional name for the benchmark
            description = null,       // Optional description
            difficulty_mix = 'balanced', // balanced, easy, hard, mixed
            use_ood = true            // Use out-of-distribution (Claude) generation
        } = options;

        const benchmark_id = uuidv4();
        const benchmark_name = name || `sealed_benchmark_${Date.now()}`;

        logger.info('Creating sealed benchmark', {
            benchmark_id,
            benchmark_name,
            count,
            use_ood
        });

        // Generate scenarios
        const scenarios = [];
        const errors = [];

        for (let i = 0; i < count; i++) {
            try {
                const category = this._randomCategory();
                const difficulty = this._selectDifficulty(difficulty_mix, i, count);

                const scenario = use_ood
                    ? await this._generateOODScenario(category, difficulty)
                    : await this._generateInDistributionScenario(category, difficulty);

                if (scenario) {
                    scenarios.push({
                        scenario_id: uuidv4(),
                        ...scenario,
                        order_index: i
                    });
                }

                // Small delay to avoid rate limits
                await this._sleep(200);
            } catch (error) {
                errors.push({
                    index: i,
                    error: error.message
                });
                logger.warn('Failed to generate sealed benchmark scenario', {
                    index: i,
                    error: error.message
                });
            }
        }

        // Store sealed benchmark in database
        await this._storeSealedBenchmark({
            benchmark_id,
            benchmark_name,
            description,
            scenarios,
            count,
            use_ood,
            difficulty_mix,
            errors
        });

        logger.info('Sealed benchmark created', {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length
        });

        return {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length,
            use_ood,
            message: `Sealed benchmark created with ${scenarios.length} scenarios`
        };
    }

    /**
     * Generate out-of-distribution scenario using Claude
     * This is different from Tessa's GPT-4o-mini generation patterns
     */
    async _generateOODScenario(category, difficulty) {
        const prompt = this._buildClaudePrompt(category, difficulty);

        return await this.claudeCircuitBreaker.execute(async () => {
            return await retryHandler.withRetry(
                async () => await this._callClaude(prompt),
                {
                    maxRetries: 2,
                    baseDelay: 1000,
                    operationName: 'sealed-benchmark-ood-generation'
                }
            );
        });
    }

    /**
     * Generate in-distribution scenario (for control benchmarks)
     * Uses similar style to Tessa but not stored for training
     */
    async _generateInDistributionScenario(category, difficulty) {
        // Use similar GPT prompt style as Tessa but mark as sealed
        // This is for control/comparison benchmarks
        const prompt = this._buildGPTLikePrompt(category, difficulty);

        return await this.openaiCircuitBreaker.execute(async () => {
            return await retryHandler.withRetry(
                async () => await this._callOpenAI(prompt, category),
                {
                    maxRetries: 2,
                    baseDelay: 1000,
                    operationName: 'sealed-benchmark-id-generation'
                }
            );
        });
    }

    /**
     * Call OpenAI API for in-distribution scenario generation
     */
    async _callOpenAI(prompt, category) {
        const response = await axios.post(
            'https://api.openai.com/v1/chat/completions',
            {
                model: OPENAI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an expert at generating realistic expense categorization scenarios. Return only valid JSON.'
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                temperature: 0.9,
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

        const content = response.data.choices[0].message.content.trim();
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: category,
            reasoning: parsed.reasoning || '',
            generator: 'gpt-style',
            model: OPENAI_MODEL
        };
    }

    /**
     * Build Claude prompt for OOD generation
     * Intentionally different style from Tessa's GPT prompts
     */
    _buildClaudePrompt(category, difficulty) {
        const difficultyInstructions = {
            'easy': 'straightforward and unambiguous',
            'medium': 'moderately complex with some nuance',
            'hard': 'challenging with ambiguity or edge cases',
            'very_hard': 'highly ambiguous requiring expert judgment'
        };

        return `You are creating a test scenario for an AI expense categorization system.

Generate ONE realistic expense transaction for category: ${category}

Difficulty level: ${difficulty} (${difficultyInstructions[difficulty]})

Requirements:
- Create a realistic merchant name (can be fictional but plausible)
- Generate a natural transaction description
- Use a realistic USD amount
- The transaction must CLEARLY and UNAMBIGUOUSLY belong to "${category}"
- The description must make it obvious which category applies

CRITICAL RULES FOR CLARITY:
- For "dining": NEVER mention business, clients, meetings, colleagues, or work. Use phrases like "birthday dinner", "date night", "catching up with friends", "weekend brunch"
- For "business_meal": ALWAYS explicitly mention clients, business meeting, work event, networking, or professional context
- AVOID scenarios that could reasonably fit multiple categories
- The description should make the category obvious to any reader

Category definitions:
- business_meal: Work-related dining - MUST mention clients, business purpose, work meeting, or professional networking
- groceries: Food shopping at supermarkets for home use
- transportation: Travel expenses (gas, rideshare, parking, car-related)
- utilities: Home services (electricity, water, internet, phone)
- entertainment: Leisure activities (movies, concerts, streaming, hobbies)
- health: Medical and wellness (gym, pharmacy, doctor visits)
- dining: Personal restaurant/cafe visits - MUST be clearly personal/social (friends, family, dates), NO work context
- shopping: Retail purchases (clothing, household items, online shopping)

Return ONLY valid JSON in this format:
{
  "merchant": "Merchant Name",
  "amount": 45.50,
  "description": "Transaction description that clearly indicates the category",
  "category": "${category}",
  "reasoning": "Brief explanation why this is ${category}"
}`;
    }

    /**
     * Build GPT-like prompt for in-distribution control benchmarks
     */
    _buildGPTLikePrompt(category, difficulty) {
        const difficultyNotes = {
            'easy': 'Make it obvious and typical',
            'medium': 'Make it realistic and common',
            'hard': 'Include some ambiguity or edge case elements',
            'very_hard': 'Make it highly ambiguous with multiple plausible categories'
        };

        return `Generate a realistic expense categorization scenario.

Target category: ${category}
Difficulty: ${difficulty}
Note: ${difficultyNotes[difficulty]}

Create a JSON object with:
{
  "merchant": "realistic merchant name",
  "amount": numerical amount,
  "description": "transaction description",
  "category": "${category}",
  "reasoning": "why this belongs in ${category}"
}

Return only the JSON object.`;
    }

    /**
     * Call Claude API for OOD generation
     */
    async _callClaude(prompt) {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: ANTHROPIC_MODEL,
                max_tokens: 500,
                temperature: 0.8, // Moderate creativity
                messages: [
                    {
                        role: 'user',
                        content: prompt
                    }
                ]
            },
            {
                headers: {
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                timeout: 15000
            }
        );

        const completion = response.data.content[0].text.trim();

        // Parse JSON from response
        const jsonStr = completion.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);

        return {
            merchant: parsed.merchant,
            amount: parsed.amount,
            description: parsed.description,
            category: parsed.category,
            reasoning: parsed.reasoning || '',
            generator: 'claude',
            model: ANTHROPIC_MODEL
        };
    }

    /**
     * Store sealed benchmark in database
     */
    async _storeSealedBenchmark(benchmarkData) {
        const {
            benchmark_id,
            benchmark_name,
            description,
            scenarios,
            count,
            use_ood,
            difficulty_mix,
            errors
        } = benchmarkData;

        // Store benchmark metadata
        await query(`
            INSERT INTO sealed_benchmarks (
                benchmark_id,
                benchmark_name,
                description,
                scenario_count,
                use_ood,
                difficulty_mix,
                created_at,
                metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
        `, [
            benchmark_id,
            benchmark_name,
            description,
            scenarios.length,
            use_ood,
            difficulty_mix,
            JSON.stringify({
                total_requested: count,
                successful: scenarios.length,
                errors: errors.length,
                generator: use_ood ? 'claude' : 'gpt-style',
                model: ANTHROPIC_MODEL
            })
        ]);

        // Store individual scenarios
        let scenariosStored = 0;
        for (const scenario of scenarios) {
            try {
                await query(`
                    INSERT INTO sealed_benchmark_scenarios (
                        scenario_id,
                        benchmark_id,
                        order_index,
                        merchant,
                        amount,
                        description,
                        correct_category,
                        reasoning,
                        generator,
                        model
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    scenario.scenario_id,
                    benchmark_id,
                    scenario.order_index,
                    scenario.merchant,
                    scenario.amount,
                    scenario.description,
                    scenario.category,
                    scenario.reasoning,
                    scenario.generator || 'claude',
                    scenario.model || ANTHROPIC_MODEL
                ]);
                scenariosStored++;
            } catch (insertError) {
                logger.warn('Failed to insert scenario', {
                    benchmark_id,
                    scenario_id: scenario.scenario_id,
                    category: scenario.category,
                    error: insertError.message
                });
            }
        }

        // Update scenario_count with actual stored count
        if (scenariosStored !== scenarios.length) {
            await query(`
                UPDATE sealed_benchmarks
                SET scenario_count = $1
                WHERE benchmark_id = $2
            `, [scenariosStored, benchmark_id]);
        }

        logger.info('Sealed benchmark stored in database', {
            benchmark_id,
            scenarios_generated: scenarios.length,
            scenarios_stored: scenariosStored
        });
    }

    /**
     * Get sealed benchmark by ID or name
     */
    async getSealedBenchmark(identifier) {
        // Check if identifier is UUID or name
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

        const benchmarkQuery = isUUID
            ? 'SELECT * FROM sealed_benchmarks WHERE benchmark_id = $1'
            : 'SELECT * FROM sealed_benchmarks WHERE benchmark_name = $1';

        const benchmarkResult = await query(benchmarkQuery, [identifier]);

        if (benchmarkResult.rows.length === 0) {
            throw new Error(`Sealed benchmark not found: ${identifier}`);
        }

        const benchmark = benchmarkResult.rows[0];

        // Get scenarios
        const scenariosResult = await query(`
            SELECT * FROM sealed_benchmark_scenarios
            WHERE benchmark_id = $1
            ORDER BY order_index
        `, [benchmark.benchmark_id]);

        return {
            ...benchmark,
            scenarios: scenariosResult.rows
        };
    }

    /**
     * List all sealed benchmarks
     */
    async listSealedBenchmarks() {
        const result = await query(`
            SELECT
                benchmark_id,
                benchmark_name,
                description,
                scenario_count,
                use_ood,
                difficulty_mix,
                created_at,
                metadata
            FROM sealed_benchmarks
            ORDER BY created_at DESC
        `);

        return result.rows;
    }

    /**
     * Select difficulty based on mix strategy
     */
    _selectDifficulty(difficulty_mix, index, total) {
        switch (difficulty_mix) {
            case 'easy':
                return 'easy';
            case 'hard':
                return Math.random() > 0.5 ? 'hard' : 'very_hard';
            case 'balanced':
                const rand = Math.random();
                if (rand < 0.25) return 'easy';
                if (rand < 0.50) return 'medium';
                if (rand < 0.75) return 'hard';
                return 'very_hard';
            case 'mixed':
                // Progressive difficulty
                const progress = index / total;
                if (progress < 0.25) return 'easy';
                if (progress < 0.50) return 'medium';
                if (progress < 0.75) return 'hard';
                return 'very_hard';
            default:
                return 'medium';
        }
    }

    _randomCategory() {
        return this.categories[Math.floor(Math.random() * this.categories.length)];
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const sealedBenchmarkGenerator = new SealedBenchmarkGenerator();

module.exports = sealedBenchmarkGenerator;
