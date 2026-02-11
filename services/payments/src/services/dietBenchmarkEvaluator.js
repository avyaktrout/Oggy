/**
 * Diet Benchmark Evaluator
 * Tests Oggy vs Base on sealed diet benchmarks for nutrition estimation.
 * Measures true improvement in nutritional knowledge through memory and learning.
 *
 * Evaluation criteria:
 * - Scenario "correct" if calories within 15% AND protein within 20%
 * - Creates memory cards from mistakes to enable learning
 *
 * Diet Training System - Scientific Evaluation
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const { costGovernor } = require('../middleware/costGovernor');
const providerResolver = require('../providers/providerResolver');
const dietBenchmarkGenerator = require('./dietBenchmarkGenerator');
const { parallelMap } = require('../utils/parallel');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

// Accuracy thresholds for "correct" verdict
const ACCURACY_THRESHOLDS = {
    calories: 0.15,   // 15%
    protein_g: 0.20   // 20%
};

class DietBenchmarkEvaluator {
    constructor() {
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
    }

    /**
     * Run a full diet benchmark evaluation: Oggy vs Base
     * @param {object} options - { benchmark_identifier, user_id }
     * @returns {object} Comparison results with accuracy, wrong scenarios, and advantage
     */
    async testOnDietBenchmark(options) {
        const { benchmark_identifier, user_id } = options;

        logger.info('Starting diet benchmark evaluation', {
            benchmark_identifier,
            user_id
        });

        // Load the diet benchmark
        const benchmark = await dietBenchmarkGenerator.getDietBenchmark(benchmark_identifier);

        if (!benchmark || !benchmark.scenarios || benchmark.scenarios.length === 0) {
            throw new Error(`Diet benchmark has no scenarios: ${benchmark_identifier}`);
        }

        const total = benchmark.scenarios.length;

        logger.info('Diet benchmark loaded', {
            benchmark_id: benchmark.benchmark_id,
            benchmark_name: benchmark.benchmark_name,
            scenario_count: total
        });

        // Test Base model (no memory/learning) in parallel
        logger.info('Running Base model evaluation', { scenario_count: total });
        const baseParallelResult = await parallelMap(
            benchmark.scenarios,
            (scenario) => this._evaluateScenario(scenario, user_id, 'base'),
            5,
            { operationName: 'diet-benchmark-base', interTaskDelayMs: 100 }
        );

        const baseResults = baseParallelResult.results.map((r, i) =>
            r.success ? r.value : this._errorResult(benchmark.scenarios[i], 'base')
        );

        // Brief cooldown between Base and Oggy
        await this._sleep(2000);

        // Test Oggy model (with memory/learning) in parallel
        logger.info('Running Oggy model evaluation', { scenario_count: total });
        const oggyParallelResult = await parallelMap(
            benchmark.scenarios,
            (scenario) => this._evaluateScenario(scenario, user_id, 'oggy'),
            5,
            { operationName: 'diet-benchmark-oggy', interTaskDelayMs: 100 }
        );

        const oggyResults = oggyParallelResult.results.map((r, i) =>
            r.success ? r.value : this._errorResult(benchmark.scenarios[i], 'oggy')
        );

        // Calculate accuracies
        const oggyCorrect = oggyResults.filter(r => r.correct).length;
        const baseCorrect = baseResults.filter(r => r.correct).length;

        const oggyAccuracy = total > 0 ? oggyCorrect / total : 0;
        const baseAccuracy = total > 0 ? baseCorrect / total : 0;
        const advantagePercent = baseAccuracy > 0
            ? ((oggyAccuracy / baseAccuracy - 1) * 100)
            : (oggyAccuracy > 0 ? 100 : 0);

        // Collect wrong scenarios for Oggy
        const oggyWrongScenarios = oggyResults
            .filter(r => !r.correct)
            .map(r => ({
                scenario_id: r.scenario_id,
                description: r.description,
                correct_category: r.correct_nutrition_json,
                predicted_category: r.predicted_nutrition_json,
                reasoning: r.reasoning
            }));

        // Collect wrong scenarios for Base
        const baseWrongScenarios = baseResults
            .filter(r => !r.correct)
            .map(r => ({
                scenario_id: r.scenario_id,
                description: r.description,
                correct_category: r.correct_nutrition_json,
                predicted_category: r.predicted_nutrition_json,
                reasoning: r.reasoning
            }));

        // Learn from Oggy's mistakes: create memory cards
        await this._learnFromMistakes(user_id, oggyResults.filter(r => !r.correct));

        // Store results in DB
        const result_id = await this._storeResults({
            benchmark_id: benchmark.benchmark_id,
            user_id,
            total,
            oggy_correct: oggyCorrect,
            oggy_accuracy: oggyAccuracy,
            base_correct: baseCorrect,
            base_accuracy: baseAccuracy,
            advantage_percent: advantagePercent,
            oggy_results: oggyResults,
            base_results: baseResults
        });

        logger.info('Diet benchmark evaluation complete', {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            oggy_accuracy: (oggyAccuracy * 100).toFixed(1) + '%',
            base_accuracy: (baseAccuracy * 100).toFixed(1) + '%',
            advantage_percent: advantagePercent.toFixed(1) + '%',
            oggy_wrong: oggyWrongScenarios.length,
            base_wrong: baseWrongScenarios.length
        });

        return {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            benchmark_name: benchmark.benchmark_name,
            oggy: {
                accuracy: oggyAccuracy,
                correct: oggyCorrect,
                total,
                wrong_scenarios: oggyWrongScenarios
            },
            base: {
                accuracy: baseAccuracy,
                correct: baseCorrect,
                total,
                wrong_scenarios: baseWrongScenarios
            },
            comparison: {
                advantage_percent: parseFloat(advantagePercent.toFixed(1)),
                verdict: oggyAccuracy > baseAccuracy ? 'OGGY_BETTER' :
                         oggyAccuracy < baseAccuracy ? 'BASE_BETTER' : 'TIE'
            }
        };
    }

    /**
     * Evaluate a single scenario for either Oggy or Base
     * @param {object} scenario - Benchmark scenario from DB
     * @param {string} userId - User ID
     * @param {string} role - 'oggy' or 'base'
     * @returns {object} Evaluation result
     */
    async _evaluateScenario(scenario, userId, role) {
        try {
            // Parse the ground truth nutrition from correct_category (stored as JSON string)
            let groundTruth;
            try {
                groundTruth = typeof scenario.correct_category === 'string'
                    ? JSON.parse(scenario.correct_category)
                    : scenario.correct_category;
            } catch (parseErr) {
                logger.warn('Failed to parse ground truth nutrition', {
                    scenario_id: scenario.scenario_id,
                    correct_category: scenario.correct_category
                });
                return this._errorResult(scenario, role);
            }

            // Prompt the model to estimate nutrition
            await costGovernor.checkBudget(500);

            const resolved = role === 'oggy'
                ? await providerResolver.getAdapter(userId, 'oggy')
                : await providerResolver.getAdapter(userId, 'base');

            const prompt = `Estimate the nutritional content of: ${scenario.description}. Respond with JSON only: {"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0}`;

            const result = await this.openaiBreaker.execute(() =>
                resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a nutrition estimation expert. Estimate the nutritional content of the described food. Use your knowledge of food databases and nutritional science. Respond with JSON only, no markdown.'
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 200
                })
            );

            costGovernor.recordUsage(result.tokens_used || 150);

            // Parse the model's response
            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            let predicted;
            try {
                predicted = JSON.parse(jsonStr);
            } catch (parseErr) {
                logger.warn('Failed to parse model nutrition response', {
                    scenario_id: scenario.scenario_id,
                    role,
                    raw: jsonStr.substring(0, 200)
                });
                return this._errorResult(scenario, role);
            }

            // Evaluate: correct if calories within 15% AND protein within 20%
            const calError = this._percentError(predicted.calories, groundTruth.calories);
            const proError = this._percentError(predicted.protein_g, groundTruth.protein_g);

            const correct = (
                calError <= ACCURACY_THRESHOLDS.calories &&
                proError <= ACCURACY_THRESHOLDS.protein_g
            );

            return {
                scenario_id: scenario.scenario_id,
                description: scenario.description,
                correct,
                role,
                ground_truth: groundTruth,
                predicted,
                errors: {
                    cal_pct: Math.round(calError * 100),
                    pro_pct: Math.round(proError * 100)
                },
                correct_nutrition_json: JSON.stringify(groundTruth),
                predicted_nutrition_json: JSON.stringify(predicted),
                reasoning: scenario.reasoning
            };
        } catch (error) {
            logger.warn('Diet benchmark scenario evaluation failed', {
                scenario_id: scenario.scenario_id,
                role,
                error: error.message
            });
            return this._errorResult(scenario, role);
        }
    }

    /**
     * Create an error result for a scenario that could not be evaluated
     */
    _errorResult(scenario, role) {
        return {
            scenario_id: scenario.scenario_id,
            description: scenario.description,
            correct: false,
            role,
            ground_truth: null,
            predicted: null,
            errors: { cal_pct: 100, pro_pct: 100 },
            correct_nutrition_json: scenario.correct_category,
            predicted_nutrition_json: '{}',
            reasoning: scenario.reasoning,
            error: true
        };
    }

    /**
     * Learn from Oggy's mistakes by creating memory cards with corrections
     * @param {string} userId - User ID
     * @param {Array} wrongResults - Array of wrong evaluation results
     */
    async _learnFromMistakes(userId, wrongResults) {
        let cardsCreated = 0;

        for (const result of wrongResults) {
            try {
                if (!result.ground_truth || !result.predicted || result.error) {
                    continue;
                }

                const gt = result.ground_truth;
                const pred = result.predicted;

                const correctionText = `Correction: "${result.description}" has ${gt.calories} cal, ${gt.protein_g}g protein, ${gt.carbs_g}g carbs, ${gt.fat_g}g fat. Estimated incorrectly as ${pred.calories || 0} cal, ${pred.protein_g || 0}g protein. Calorie error: ${result.errors.cal_pct}%, protein error: ${result.errors.pro_pct}%.`;

                await axios.post(
                    `${MEMORY_SERVICE_URL}/store`,
                    {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: 'diet_benchmark_correction',
                        content: {
                            type: 'CORRECTION',
                            text: correctionText,
                            food_description: result.description,
                            ground_truth: gt,
                            predicted: pred,
                            errors: result.errors,
                            source: 'diet_benchmark'
                        },
                        tags: ['diet', 'nutrition', 'training', 'benchmark_correction'],
                        utility_weight: 0.85,
                        reliability: 0.95
                    },
                    {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    }
                );

                cardsCreated++;
            } catch (error) {
                logger.warn('Failed to create benchmark correction memory', {
                    description: result.description?.substring(0, 60),
                    error: error.message
                });
            }
        }

        if (cardsCreated > 0) {
            logger.info('Created diet benchmark correction memories', {
                cards_created: cardsCreated,
                total_wrong: wrongResults.length
            });
        }
    }

    /**
     * Store evaluation results in the database
     * Uses sealed_benchmark_results table with diet-specific detailed_results
     */
    async _storeResults(data) {
        const result_id = uuidv4();

        try {
            await query(`
                INSERT INTO sealed_benchmark_results (
                    result_id,
                    benchmark_id,
                    user_id,
                    total_scenarios,
                    oggy_correct,
                    oggy_accuracy,
                    base_correct,
                    base_accuracy,
                    advantage_delta,
                    advantage_percent,
                    training_state,
                    detailed_results
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                result_id,
                data.benchmark_id,
                data.user_id,
                data.total,
                data.oggy_correct,
                data.oggy_accuracy,
                data.base_correct,
                data.base_accuracy,
                data.oggy_accuracy - data.base_accuracy,
                data.advantage_percent,
                JSON.stringify({ domain: 'diet', evaluated_at: new Date().toISOString() }),
                JSON.stringify({
                    domain: 'diet',
                    oggy: data.oggy_results.map(r => ({
                        scenario_id: r.scenario_id,
                        correct: r.correct,
                        errors: r.errors
                    })),
                    base: data.base_results.map(r => ({
                        scenario_id: r.scenario_id,
                        correct: r.correct,
                        errors: r.errors
                    }))
                })
            ]);

            logger.debug('Stored diet benchmark results', { result_id });
        } catch (error) {
            logger.logError(error, {
                operation: 'dietBenchmarkEvaluator._storeResults',
                benchmark_id: data.benchmark_id
            });
        }

        return result_id;
    }

    /**
     * Calculate percent error between estimated and actual values
     */
    _percentError(estimated, actual) {
        const est = parseFloat(estimated) || 0;
        const act = parseFloat(actual) || 0;

        if (act === 0 && est === 0) return 0;
        if (act === 0) return est > 5 ? 1.0 : 0;

        return Math.abs(est - act) / act;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const dietBenchmarkEvaluator = new DietBenchmarkEvaluator();

module.exports = dietBenchmarkEvaluator;
