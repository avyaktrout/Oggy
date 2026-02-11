/**
 * Diet Benchmark Generator
 * Creates sealed diet benchmarks for evaluating nutrition estimation accuracy.
 * Generates food scenarios with known nutritional ground truth from three sources:
 * - 50% branded foods (definitive ground truth from labels)
 * - 30% common whole foods (AI-generated with validated nutrition)
 * - 20% complex meals (AI-generated multi-ingredient meals)
 *
 * Diet Training System - Scientific Evaluation
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const { costGovernor } = require('../middleware/costGovernor');
const providerResolver = require('../providers/providerResolver');
const { parallelMap } = require('../utils/parallel');

// Scale complexity definitions for diet domain
const SCALE_COMPLEXITY = {
    1: {
        name: 'S1 - Simple Foods',
        description: 'Single simple whole foods with standard portions',
        examples: 'banana, chicken breast, white rice, hard-boiled egg',
        prompt_note: 'Use a single, common whole food with a standard serving size. No preparation variance.'
    },
    2: {
        name: 'S2 - Branded Products',
        description: 'Branded products with specific serving sizes',
        examples: 'Chobani Greek yogurt (5.3oz), Clif Bar (68g), Kind bar',
        prompt_note: 'Use a real branded food product with a specific serving size. Include the brand name and exact product variant.'
    },
    3: {
        name: 'S3 - Multi-Ingredient Meals',
        description: 'Meals with multiple components and toppings',
        examples: 'Chipotle burrito bowl with rice, beans, cheese, guac; Caesar salad with grilled chicken',
        prompt_note: 'Create a multi-ingredient meal with 3-5 components. Each component affects total nutrition.'
    },
    4: {
        name: 'S4 - Restaurant Meals',
        description: 'Restaurant meals with preparation method variance',
        examples: 'Olive Garden chicken alfredo, Cheesecake Factory Glamburger, Panera bread bowl',
        prompt_note: 'Create a restaurant-style meal where preparation method significantly affects nutrition. Include cooking method details.'
    },
    5: {
        name: 'S5 - Ambiguous Descriptions',
        description: 'Vague or ambiguous food descriptions requiring best-guess estimation',
        examples: '"a large coffee", "some pasta", "a big salad", "leftover Chinese food"',
        prompt_note: 'Create an intentionally vague or ambiguous food description. The description should be something a real person might casually say, leaving serving size and ingredients uncertain.'
    }
};

class DietBenchmarkGenerator {
    constructor() {
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
    }

    /**
     * Create a sealed diet benchmark set
     * @param {object} options - Benchmark creation options
     * @returns {object} Created benchmark with ID and scenario count
     */
    async createDietBenchmark(options = {}) {
        const {
            name = null,
            count = 20,
            difficulty_mix = 'balanced',
            scale = 1,
            level = 3,
            userId = null
        } = options;

        const benchmark_id = uuidv4();
        const benchmark_name = name || `diet_benchmark_${Date.now()}`;
        const scaleConfig = SCALE_COMPLEXITY[Math.min(Math.max(scale, 1), 5)] || SCALE_COMPLEXITY[3];

        logger.info('Creating sealed diet benchmark', {
            benchmark_id,
            benchmark_name,
            count,
            scale,
            level,
            scale_name: scaleConfig.name
        });

        // Build task list: 50% branded, 30% whole foods, 20% complex meals
        const brandedCount = Math.round(count * 0.50);
        const wholeFoodCount = Math.round(count * 0.30);
        const complexMealCount = count - brandedCount - wholeFoodCount;

        const tasks = [];

        // Branded food tasks
        for (let i = 0; i < brandedCount; i++) {
            tasks.push({ index: tasks.length, type: 'branded', scale, level, scaleConfig });
        }

        // Whole food tasks
        for (let i = 0; i < wholeFoodCount; i++) {
            tasks.push({ index: tasks.length, type: 'whole_food', scale, level, scaleConfig });
        }

        // Complex meal tasks
        for (let i = 0; i < complexMealCount; i++) {
            tasks.push({ index: tasks.length, type: 'complex_meal', scale, level, scaleConfig });
        }

        // Generate scenarios in parallel
        logger.info('Generating diet benchmark scenarios', {
            total_tasks: tasks.length,
            branded: brandedCount,
            whole_food: wholeFoodCount,
            complex_meal: complexMealCount,
            concurrency: 5
        });

        const parallelResult = await parallelMap(
            tasks,
            async (task) => {
                let scenario;
                switch (task.type) {
                    case 'branded':
                        scenario = await this._generateBrandedScenario();
                        break;
                    case 'whole_food':
                        scenario = await this._generateWholeFoodScenario(userId, task.scaleConfig);
                        break;
                    case 'complex_meal':
                        scenario = await this._generateComplexMealScenario(userId, task.scaleConfig);
                        break;
                    default:
                        throw new Error(`Unknown task type: ${task.type}`);
                }

                if (!scenario) throw new Error('Empty scenario returned');

                return {
                    scenario_id: uuidv4(),
                    ...scenario,
                    order_index: task.index,
                    scale,
                    level
                };
            },
            5,
            { operationName: 'diet-benchmark-generation', interTaskDelayMs: 100 }
        );

        const scenarios = parallelResult.results
            .filter(r => r.success)
            .map(r => r.value);

        const errors = parallelResult.errors.map(e => {
            logger.warn('Failed to generate diet benchmark scenario', {
                index: e.index,
                error: e.error
            });
            return { index: e.index, error: e.error };
        });

        // Store benchmark to database
        await this._storeBenchmark({
            benchmark_id,
            benchmark_name,
            scenarios,
            count,
            difficulty_mix,
            scale,
            level,
            errors
        });

        logger.info('Diet benchmark created', {
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
            message: `Diet benchmark created with ${scenarios.length} scenarios`
        };
    }

    /**
     * Retrieve a diet benchmark by name or ID
     * @param {string} identifier - Benchmark name or UUID
     * @returns {object} Benchmark with scenarios
     */
    async getDietBenchmark(identifier) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

        const benchmarkQuery = isUUID
            ? `SELECT * FROM sealed_benchmarks WHERE benchmark_id = $1 AND metadata->>'domain' = 'diet'`
            : `SELECT * FROM sealed_benchmarks WHERE benchmark_name = $1 AND metadata->>'domain' = 'diet'`;

        const benchmarkResult = await query(benchmarkQuery, [identifier]);

        if (benchmarkResult.rows.length === 0) {
            throw new Error(`Diet benchmark not found: ${identifier}`);
        }

        const benchmark = benchmarkResult.rows[0];

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
     * Generate a scenario from the branded_foods table
     * These have definitive ground truth from nutritional labels
     */
    async _generateBrandedScenario() {
        try {
            const result = await query(`
                SELECT brand, product, serving_size, serving_unit,
                       calories, protein_g, carbs_g, fat_g,
                       fiber_g, sugar_g, sodium_mg
                FROM branded_foods
                WHERE calories IS NOT NULL AND calories > 0
                  AND protein_g IS NOT NULL
                ORDER BY RANDOM()
                LIMIT 1
            `);

            if (result.rows.length === 0) {
                logger.debug('No branded foods available for benchmark');
                return null;
            }

            const row = result.rows[0];
            const servingInfo = row.serving_size && row.serving_unit
                ? ` (${row.serving_size} ${row.serving_unit})`
                : '';
            const foodDescription = `${row.brand} ${row.product}${servingInfo}`;

            const nutritionJson = JSON.stringify({
                calories: parseFloat(row.calories) || 0,
                protein_g: parseFloat(row.protein_g) || 0,
                carbs_g: parseFloat(row.carbs_g) || 0,
                fat_g: parseFloat(row.fat_g) || 0
            });

            return {
                merchant: row.brand || 'Generic',
                description: foodDescription,
                correct_category: nutritionJson,
                reasoning: `Nutrition data from branded food label: ${row.brand} ${row.product}`,
                amount: parseFloat(row.calories) || 0,
                generator: 'branded_foods_db',
                full_nutrition: {
                    calories: parseFloat(row.calories) || 0,
                    protein_g: parseFloat(row.protein_g) || 0,
                    carbs_g: parseFloat(row.carbs_g) || 0,
                    fat_g: parseFloat(row.fat_g) || 0,
                    fiber_g: parseFloat(row.fiber_g) || 0,
                    sugar_g: parseFloat(row.sugar_g) || 0,
                    sodium_mg: parseFloat(row.sodium_mg) || 0
                }
            };
        } catch (error) {
            logger.warn('Failed to generate branded food scenario', { error: error.message });
            return null;
        }
    }

    /**
     * Generate a common whole food scenario via AI
     * e.g., "1 medium banana", "6oz grilled chicken breast"
     */
    async _generateWholeFoodScenario(userId, scaleConfig) {
        const prompt = `Generate a single common whole food item with accurate USDA-based nutritional data.

${scaleConfig.prompt_note}

CRITICAL: Return ONLY valid JSON, no markdown:
{
  "food_description": "specific food with portion size (e.g., '1 medium banana (118g)' or '6oz grilled chicken breast')",
  "calories": <number>,
  "protein_g": <number>,
  "carbs_g": <number>,
  "fat_g": <number>,
  "fiber_g": <number>,
  "sugar_g": <number>,
  "sodium_mg": <number>,
  "reasoning": "USDA source or nutritional basis"
}`;

        return await this._generateAIScenario(userId, prompt, 'whole_food');
    }

    /**
     * Generate a complex multi-ingredient meal scenario via AI
     * e.g., "homemade chicken stir fry with rice and vegetables"
     */
    async _generateComplexMealScenario(userId, scaleConfig) {
        const prompt = `Generate a complex multi-ingredient meal or restaurant dish with accurate nutritional data.

${scaleConfig.prompt_note}

The meal should have 3+ components and realistic nutritional values for the full portion.

CRITICAL: Return ONLY valid JSON, no markdown:
{
  "food_description": "detailed meal description with all components (e.g., 'Chipotle chicken burrito bowl with cilantro-lime rice, black beans, fajita veggies, fresh tomato salsa, cheese, and guacamole')",
  "calories": <number>,
  "protein_g": <number>,
  "carbs_g": <number>,
  "fat_g": <number>,
  "fiber_g": <number>,
  "sugar_g": <number>,
  "sodium_mg": <number>,
  "reasoning": "breakdown of how total nutrition was calculated from components"
}`;

        return await this._generateAIScenario(userId, prompt, 'complex_meal');
    }

    /**
     * Shared AI scenario generation logic
     */
    async _generateAIScenario(userId, prompt, generatorType) {
        try {
            await costGovernor.checkBudget(500);

            const resolvedUserId = userId || 'system';
            const resolved = await providerResolver.getAdapter(resolvedUserId, 'oggy');

            const result = await this.openaiBreaker.execute(() =>
                resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a certified nutritionist with access to USDA FoodData Central. Generate food items with accurate nutritional data. Always use real nutritional values, not estimates. Return JSON only.'
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.8,
                    max_tokens: 500
                })
            );

            costGovernor.recordUsage(result.tokens_used || 350);

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(jsonStr);

            const nutritionJson = JSON.stringify({
                calories: parseFloat(parsed.calories) || 0,
                protein_g: parseFloat(parsed.protein_g) || 0,
                carbs_g: parseFloat(parsed.carbs_g) || 0,
                fat_g: parseFloat(parsed.fat_g) || 0
            });

            return {
                merchant: 'Generic',
                description: parsed.food_description,
                correct_category: nutritionJson,
                reasoning: parsed.reasoning || `AI-generated ${generatorType} with validated nutrition`,
                amount: parseFloat(parsed.calories) || 0,
                generator: `ai_${generatorType}`,
                full_nutrition: {
                    calories: parseFloat(parsed.calories) || 0,
                    protein_g: parseFloat(parsed.protein_g) || 0,
                    carbs_g: parseFloat(parsed.carbs_g) || 0,
                    fat_g: parseFloat(parsed.fat_g) || 0,
                    fiber_g: parseFloat(parsed.fiber_g) || 0,
                    sugar_g: parseFloat(parsed.sugar_g) || 0,
                    sodium_mg: parseFloat(parsed.sodium_mg) || 0
                }
            };
        } catch (error) {
            logger.logError(error, {
                operation: `dietBenchmarkGenerator._generateAIScenario`,
                type: generatorType
            });
            return null;
        }
    }

    /**
     * Store the benchmark and its scenarios in the database
     * Uses the existing sealed_benchmarks and sealed_benchmark_scenarios tables
     * with domain='diet' in metadata
     */
    async _storeBenchmark(benchmarkData) {
        const {
            benchmark_id,
            benchmark_name,
            scenarios,
            count,
            difficulty_mix,
            scale,
            level,
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
            `Diet nutrition estimation benchmark (S${scale} L${level})`,
            scenarios.length,
            false,
            difficulty_mix,
            JSON.stringify({
                domain: 'diet',
                scale,
                level,
                total_requested: count,
                successful: scenarios.length,
                errors: errors.length,
                source_mix: {
                    branded_foods: scenarios.filter(s => s.generator === 'branded_foods_db').length,
                    whole_food: scenarios.filter(s => s.generator === 'ai_whole_food').length,
                    complex_meal: scenarios.filter(s => s.generator === 'ai_complex_meal').length
                }
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
                    scenario.merchant || 'Generic',
                    scenario.amount || 0,
                    scenario.description,
                    scenario.correct_category,
                    scenario.reasoning,
                    scenario.generator || 'unknown',
                    'diet-benchmark'
                ]);
                scenariosStored++;
            } catch (insertError) {
                logger.warn('Failed to insert diet benchmark scenario', {
                    benchmark_id,
                    scenario_id: scenario.scenario_id,
                    error: insertError.message
                });
            }
        }

        // Update scenario count if any failed to insert
        if (scenariosStored !== scenarios.length) {
            await query(`
                UPDATE sealed_benchmarks
                SET scenario_count = $1
                WHERE benchmark_id = $2
            `, [scenariosStored, benchmark_id]);
        }

        logger.info('Diet benchmark stored in database', {
            benchmark_id,
            scenarios_generated: scenarios.length,
            scenarios_stored: scenariosStored
        });
    }
}

// Singleton instance
const dietBenchmarkGenerator = new DietBenchmarkGenerator();

module.exports = dietBenchmarkGenerator;
