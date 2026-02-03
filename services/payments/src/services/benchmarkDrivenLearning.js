/**
 * Benchmark-Driven Learning Service
 * Connects sealed benchmark performance to targeted SDL training
 *
 * Flow:
 * 1. Analyze benchmark result for weak categories
 * 2. Generate targeted practice items via Tessa
 * 3. Run time-boxed training on weak areas
 * 4. Re-test benchmark to measure improvement
 *
 * Week 8: Targeted Learning from Benchmarks
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const weaknessAnalyzer = require('./weaknessAnalyzer');
const tessaAssessmentGenerator = require('./tessaAssessmentGenerator');
const sealedBenchmarkEvaluator = require('./sealedBenchmarkEvaluator');
const OggyCategorizer = require('./oggyCategorizer');
const { DIFFICULTY_TIERS } = require('./adaptiveDifficultyScaler');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

class BenchmarkDrivenLearning {
    constructor() {
        this.oggyCategorizer = new OggyCategorizer();
        this.isRunning = false;
        this.currentSession = null;
    }

    /**
     * Main entry point - run benchmark-driven targeted training
     * @param {object} options
     * @param {string} options.result_id - Sealed benchmark result to analyze
     * @param {string} options.user_id - User to train for
     * @param {number} options.duration_minutes - Training duration (default 5)
     * @param {number} options.items_per_category - Items per weak category (default 10)
     * @param {boolean} options.auto_retest - Re-run benchmark after training (default true)
     */
    async runBenchmarkDrivenTraining(options) {
        const {
            result_id,
            user_id,
            duration_minutes = 5,
            items_per_category = 10,
            auto_retest = true
        } = options;

        if (this.isRunning) {
            throw new Error('Benchmark-driven training already in progress');
        }

        const session_id = uuidv4();
        this.isRunning = true;
        this.currentSession = {
            session_id,
            result_id,
            user_id,
            started_at: new Date(),
            status: 'analyzing'
        };

        logger.info('Starting benchmark-driven training', {
            session_id,
            result_id,
            user_id,
            duration_minutes,
            items_per_category
        });

        try {
            // Step 1: Get original benchmark result info
            const originalBenchmark = await this._getOriginalBenchmark(result_id);
            this.currentSession.benchmark_id = originalBenchmark.benchmark_id;

            // Step 2: Extract weak categories AND confusion patterns
            this.currentSession.status = 'analyzing_weaknesses';
            const analysis = await this._extractWeaknessAnalysis(result_id);
            const weakCategories = analysis.weaknesses.sort((a, b) => a.accuracy - b.accuracy);
            const confusionPatterns = analysis.confusion_patterns;

            if (weakCategories.length === 0 && confusionPatterns.length === 0) {
                logger.info('No weak categories or confusion patterns found, training not needed', {
                    session_id,
                    result_id
                });

                this.isRunning = false;
                this.currentSession = null;

                return {
                    session_id,
                    status: 'completed',
                    message: 'No weak categories or confusion patterns detected - training not needed',
                    original_benchmark: {
                        result_id,
                        oggy_accuracy: originalBenchmark.oggy_accuracy
                    },
                    weak_categories_identified: [],
                    confusion_patterns_identified: [],
                    training_summary: null,
                    retest_results: null
                };
            }

            logger.info('Weakness analysis complete', {
                session_id,
                weak_categories: weakCategories.map(w => ({
                    category: w.category,
                    accuracy: w.accuracy,
                    severity: w.severity
                })),
                confusion_patterns: confusionPatterns.map(p => ({
                    pattern: `${p.actual}→${p.predicted}`,
                    count: p.count,
                    rate: p.confusion_rate
                }))
            });

            // Step 3: Generate targeted practice items (failed scenarios + confusion patterns + weak categories)
            this.currentSession.status = 'generating_practice_items';
            const failedScenarios = analysis.failed_scenarios || [];
            const practiceItems = await this._generateAllTargetedItems(
                weakCategories,
                confusionPatterns,
                failedScenarios,
                items_per_category
            );

            logger.info('Generated targeted practice items', {
                session_id,
                total_items: practiceItems.length,
                by_category: this._countByCategory(practiceItems),
                from_actual_failures: practiceItems.filter(i => i.source === 'benchmark_failure').length,
                confusion_targeted: practiceItems.filter(i => i.confusion_context).length,
                weakness_targeted: practiceItems.filter(i => i.weakness_context).length
            });

            // Store confusion patterns for result
            this.currentSession.confusion_patterns = confusionPatterns;

            // Step 4: Run time-boxed training
            this.currentSession.status = 'training';
            const trainingResults = await this._runTimeboxedTraining(
                user_id,
                practiceItems,
                duration_minutes
            );

            logger.info('Training session completed', {
                session_id,
                items_practiced: trainingResults.items_practiced,
                accuracy: trainingResults.accuracy,
                duration_seconds: trainingResults.duration_seconds
            });

            // Step 5: Re-test benchmark (if enabled)
            let retestResults = null;
            if (auto_retest) {
                this.currentSession.status = 'retesting';
                retestResults = await this._retestBenchmark(
                    originalBenchmark.benchmark_id,
                    user_id,
                    originalBenchmark.oggy_accuracy
                );

                logger.info('Benchmark retest completed', {
                    session_id,
                    original_accuracy: originalBenchmark.oggy_accuracy,
                    new_accuracy: retestResults.oggy_accuracy,
                    improvement: retestResults.improvement
                });
            }

            // Build final result
            const result = {
                session_id,
                status: 'completed',
                original_benchmark: {
                    result_id,
                    benchmark_id: originalBenchmark.benchmark_id,
                    oggy_accuracy: originalBenchmark.oggy_accuracy,
                    base_accuracy: originalBenchmark.base_accuracy
                },
                weak_categories_identified: weakCategories.map(w => ({
                    category: w.category,
                    accuracy: w.accuracy,
                    severity: w.severity,
                    gap: w.gap
                })),
                confusion_patterns_identified: confusionPatterns.map(p => ({
                    pattern: `${p.actual}→${p.predicted}`,
                    actual: p.actual,
                    predicted: p.predicted,
                    count: p.count,
                    confusion_rate: p.confusion_rate,
                    severity: p.severity
                })),
                training_summary: {
                    items_practiced: trainingResults.items_practiced,
                    correct: trainingResults.correct,
                    incorrect: trainingResults.incorrect,
                    accuracy: trainingResults.accuracy,
                    duration_seconds: trainingResults.duration_seconds,
                    stopped_reason: trainingResults.stopped_reason,
                    accuracy_by_category: trainingResults.by_category
                },
                retest_results: retestResults,
                report: this._generateReport(
                    originalBenchmark,
                    weakCategories,
                    confusionPatterns,
                    trainingResults,
                    retestResults
                )
            };

            // Store session result
            await this._storeSessionResult(result);

            this.isRunning = false;
            this.currentSession = null;

            return result;

        } catch (error) {
            logger.logError(error, {
                operation: 'runBenchmarkDrivenTraining',
                session_id,
                result_id
            });

            this.isRunning = false;
            this.currentSession = null;

            throw error;
        }
    }

    /**
     * Get original benchmark result info
     */
    async _getOriginalBenchmark(result_id) {
        const result = await query(`
            SELECT
                result_id,
                benchmark_id,
                oggy_accuracy,
                base_accuracy,
                advantage_delta,
                training_state
            FROM sealed_benchmark_results
            WHERE result_id = $1
        `, [result_id]);

        if (result.rows.length === 0) {
            throw new Error(`Benchmark result not found: ${result_id}`);
        }

        return result.rows[0];
    }

    /**
     * Extract weak categories and confusion patterns from benchmark result
     */
    async _extractWeaknessAnalysis(result_id) {
        const analysis = await weaknessAnalyzer.analyzeWeaknesses({ result_id });

        // Also extract the ACTUAL failed scenarios from the benchmark
        const failedScenarios = await this._extractFailedScenarios(result_id);

        return {
            weaknesses: analysis.weaknesses || [],
            confusion_patterns: analysis.confusion_patterns || [],
            confusion_matrix: analysis.confusion_matrix || {},
            failed_scenarios: failedScenarios
        };
    }

    /**
     * Extract the actual scenarios that Oggy failed on
     * These are the EXACT edge cases we need to train on
     */
    async _extractFailedScenarios(result_id) {
        // Get detailed results to find failed scenario IDs
        const resultsQuery = await query(`
            SELECT detailed_results
            FROM sealed_benchmark_results
            WHERE result_id = $1
        `, [result_id]);

        if (resultsQuery.rows.length === 0) {
            return [];
        }

        const detailedResults = resultsQuery.rows[0].detailed_results;
        const oggyResults = detailedResults.oggy || [];

        // Find failed scenarios
        const failedScenarioIds = oggyResults
            .filter(r => !r.correct)
            .map(r => r.scenario_id);

        if (failedScenarioIds.length === 0) {
            return [];
        }

        // Get the actual scenario data
        const scenariosQuery = await query(`
            SELECT
                scenario_id,
                merchant,
                amount,
                description,
                correct_category,
                reasoning
            FROM sealed_benchmark_scenarios
            WHERE scenario_id = ANY($1)
        `, [failedScenarioIds]);

        // Map to training format with metadata about the failure
        const failedScenarios = scenariosQuery.rows.map(scenario => {
            const failure = oggyResults.find(r => r.scenario_id === scenario.scenario_id);
            return {
                scenario_id: scenario.scenario_id,
                merchant: scenario.merchant,
                amount: parseFloat(scenario.amount),
                description: scenario.description,
                correctCategory: scenario.correct_category,
                reasoning: scenario.reasoning,
                source: 'benchmark_failure',
                failure_context: {
                    predicted_category: failure?.predicted_category,
                    confidence: failure?.confidence,
                    trace_id: failure?.trace_id,
                    is_actual_benchmark_failure: true
                }
            };
        });

        logger.info('Extracted failed benchmark scenarios', {
            result_id,
            failed_count: failedScenarios.length,
            scenarios: failedScenarios.map(s => ({
                merchant: s.merchant,
                correct: s.correctCategory,
                predicted: s.failure_context.predicted_category
            }))
        });

        return failedScenarios;
    }

    /**
     * Extract weak categories from benchmark result (legacy method)
     */
    async _extractWeakCategories(result_id) {
        const analysis = await this._extractWeaknessAnalysis(result_id);

        if (!analysis.weaknesses || analysis.weaknesses.length === 0) {
            return [];
        }

        // Return weaknesses sorted by severity (most severe first)
        return analysis.weaknesses.sort((a, b) => a.accuracy - b.accuracy);
    }

    /**
     * Generate ALL targeted practice items (failed scenarios + confusion patterns + weak categories)
     * Priority order:
     * 1. ACTUAL failed scenarios from the benchmark (highest priority - train on exact failures)
     * 2. Confusion-targeted items (address general confusion patterns)
     * 3. Weak category items (reinforce weak areas)
     */
    async _generateAllTargetedItems(weakCategories, confusionPatterns, failedScenarios, itemsPerCategory) {
        const allItems = [];

        // 1. Add ACTUAL failed scenarios FIRST (highest priority)
        // Repeat them multiple times to reinforce the correct answer
        if (failedScenarios && failedScenarios.length > 0) {
            const repetitionsPerFailure = Math.min(10, Math.ceil(itemsPerCategory / failedScenarios.length));

            logger.info('Adding actual failed benchmark scenarios', {
                failed_count: failedScenarios.length,
                repetitions_each: repetitionsPerFailure
            });

            for (let rep = 0; rep < repetitionsPerFailure; rep++) {
                for (const scenario of failedScenarios) {
                    allItems.push({
                        ...scenario,
                        repetition: rep + 1,
                        priority: 'critical',
                        training_note: `ACTUAL BENCHMARK FAILURE: Learn that "${scenario.description}" is ${scenario.correctCategory}, NOT ${scenario.failure_context.predicted_category}`
                    });
                }
            }
        }

        // 2. Generate confusion-targeted items (40% of remaining items)
        if (confusionPatterns.length > 0) {
            const confusionItemsPerPattern = Math.ceil(itemsPerCategory * 0.4);
            logger.info('Generating confusion-targeted items', {
                patterns: confusionPatterns.length,
                items_per_pattern: confusionItemsPerPattern
            });

            const confusionItems = await tessaAssessmentGenerator.generateForConfusionPatterns(
                confusionPatterns,
                confusionItemsPerPattern
            );
            allItems.push(...confusionItems);
        }

        // 3. Generate weak category items (remaining items)
        if (weakCategories.length > 0) {
            const weakItemsPerCategory = Math.ceil(itemsPerCategory * 0.3);
            logger.info('Generating weak category items', {
                categories: weakCategories.length,
                items_per_category: weakItemsPerCategory
            });

            const weakItems = await this._generateTargetedItems(weakCategories, weakItemsPerCategory);
            allItems.push(...weakItems);
        }

        logger.info('Total training items prepared', {
            total: allItems.length,
            from_failed_scenarios: allItems.filter(i => i.source === 'benchmark_failure').length,
            from_confusion_patterns: allItems.filter(i => i.confusion_context).length,
            from_weak_categories: allItems.filter(i => i.weakness_context).length
        });

        // 4. Shuffle but keep some failed scenarios at the start for immediate focus
        const failedItems = allItems.filter(i => i.source === 'benchmark_failure');
        const otherItems = allItems.filter(i => i.source !== 'benchmark_failure');

        // Put half of failed items first, then mix, then other half at end
        const halfFailed = Math.ceil(failedItems.length / 2);
        const firstHalf = failedItems.slice(0, halfFailed);
        const secondHalf = failedItems.slice(halfFailed);

        return [
            ...firstHalf,
            ...this._shuffleArray([...otherItems, ...secondHalf])
        ];
    }

    /**
     * Generate targeted practice items for weak categories
     * Uses Tessa to generate novel scenarios for each weak category
     */
    async _generateTargetedItems(weakCategories, itemsPerCategory) {
        const items = [];

        for (const weakness of weakCategories) {
            // Select difficulty tier based on severity
            const tier = this._severityToTier(weakness.severity);

            logger.debug('Generating items for weak category', {
                category: weakness.category,
                severity: weakness.severity,
                tier: tier.name,
                count: itemsPerCategory
            });

            for (let i = 0; i < itemsPerCategory; i++) {
                try {
                    const scenario = await tessaAssessmentGenerator.generateNovelScenario({
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

        // Shuffle items to mix categories during training
        return this._shuffleArray(items);
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
     * Run time-boxed training session
     * Practices until time expires or items exhausted
     */
    async _runTimeboxedTraining(user_id, items, duration_minutes) {
        const endTime = Date.now() + (duration_minutes * 60 * 1000);
        const startTime = Date.now();

        const results = {
            items_practiced: 0,
            correct: 0,
            incorrect: 0,
            by_category: {},
            start_time: new Date().toISOString(),
            end_time: null,
            stopped_reason: null
        };

        for (const item of items) {
            // Check time budget
            if (Date.now() >= endTime) {
                results.stopped_reason = 'time_expired';
                break;
            }

            try {
                const outcome = await this._practiceItem(user_id, item);

                results.items_practiced++;
                if (outcome.correct) {
                    results.correct++;
                } else {
                    results.incorrect++;
                }

                // Track per-category
                const cat = item.correctCategory;
                if (!results.by_category[cat]) {
                    results.by_category[cat] = { correct: 0, total: 0 };
                }
                results.by_category[cat].total++;
                if (outcome.correct) {
                    results.by_category[cat].correct++;
                }

                // Brief delay between items
                await this._sleep(500);

            } catch (error) {
                logger.warn('Practice item failed', {
                    knowledge_id: item.knowledge_id,
                    error: error.message
                });
            }
        }

        if (!results.stopped_reason) {
            results.stopped_reason = 'items_exhausted';
        }

        results.end_time = new Date().toISOString();
        results.duration_seconds = (Date.now() - startTime) / 1000;
        results.accuracy = results.items_practiced > 0
            ? results.correct / results.items_practiced
            : 0;

        // Calculate per-category accuracy
        for (const cat of Object.keys(results.by_category)) {
            const catStats = results.by_category[cat];
            catStats.accuracy = catStats.total > 0
                ? catStats.correct / catStats.total
                : 0;
        }

        return results;
    }

    /**
     * Practice a single item
     */
    async _practiceItem(user_id, item) {
        const { merchant, amount, description, correctCategory } = item;
        const isActualBenchmarkFailure = item.source === 'benchmark_failure';

        // Oggy attempts categorization
        const suggestion = await this.oggyCategorizer.suggestCategory(user_id, {
            merchant,
            amount,
            description,
            transaction_date: new Date().toISOString().split('T')[0]
        });

        const predictedCategory = suggestion.suggested_category;
        const trace_id = suggestion.trace_id;
        const correct = predictedCategory === correctCategory;

        logger.debug('Benchmark-driven practice attempt', {
            merchant,
            expected: correctCategory,
            predicted: predictedCategory,
            correct,
            confidence: suggestion.confidence,
            is_actual_benchmark_failure: isActualBenchmarkFailure
        });

        // Update memory based on correctness - STRONGER for actual benchmark failures
        if (trace_id) {
            await this._updateMemoryFromPractice(trace_id, correct, {
                merchant,
                correctCategory,
                predictedCategory,
                description,
                weakness_context: item.weakness_context,
                is_benchmark_failure: isActualBenchmarkFailure,
                failure_context: item.failure_context
            });
        }

        // For actual benchmark failures that Oggy still gets wrong, create a correction memory
        if (isActualBenchmarkFailure && !correct) {
            await this._createCorrectionMemory(user_id, item, suggestion);
        }

        // Record practice event
        await this._recordPracticeEvent(user_id, {
            merchant,
            amount,
            description,
            expected_category: correctCategory,
            predicted_category: predictedCategory,
            correct,
            trace_id,
            confidence: suggestion.confidence,
            training_mode: 'benchmark_driven',
            weakness_context: item.weakness_context,
            is_benchmark_failure: isActualBenchmarkFailure,
            training_note: item.training_note
        });

        return {
            correct,
            expectedCategory: correctCategory,
            predictedCategory,
            confidence: suggestion.confidence,
            trace_id,
            was_benchmark_failure: isActualBenchmarkFailure
        };
    }

    /**
     * Create an explicit correction memory for a specific benchmark failure
     * This directly teaches Oggy the correct answer for this exact scenario
     *
     * NOTE: We skip correction memories for dining↔business_meal confusion
     * because these categories have significant overlap and the benchmark
     * labels can be ambiguous. Creating hard rules for these cases
     * can actually hurt performance.
     */
    async _createCorrectionMemory(user_id, item, suggestion) {
        try {
            const axios = require('axios');

            // Skip correction memories for dining↔business_meal confusion
            // These categories are inherently ambiguous and hard rules hurt performance
            const confusedPair = new Set([item.correctCategory, suggestion.suggested_category]);
            if (confusedPair.has('dining') && confusedPair.has('business_meal')) {
                logger.info('Skipping correction memory for dining↔business_meal confusion (inherently ambiguous)', {
                    merchant: item.merchant,
                    correct: item.correctCategory,
                    wrong: suggestion.suggested_category
                });
                return;
            }

            const correctionContent = {
                type: 'BENCHMARK_CORRECTION',
                merchant: item.merchant,
                description: item.description,
                amount: item.amount,
                correct_category: item.correctCategory,
                wrong_prediction: suggestion.suggested_category,
                reasoning: item.reasoning || `"${item.description}" at "${item.merchant}" is ${item.correctCategory}, NOT ${suggestion.suggested_category}`,
                key_distinction: this._generateDistinctionHint(item.correctCategory, suggestion.suggested_category, item.description),
                confidence_override: 1.0,
                created_from: 'benchmark_failure_correction',
                scenario_id: item.scenario_id
            };

            // Create a memory card via the memory service
            // IMPORTANT: Include 'payments' and 'categorization' tags so retrieval can find them
            await axios.post(
                `${MEMORY_SERVICE_URL}/cards`,
                {
                    owner_type: 'user',
                    owner_id: user_id,
                    kind: 'fact',
                    content: correctionContent,
                    tags: [
                        'payments',          // Required for retrieval
                        'categorization',    // Required for retrieval
                        'correction',
                        'benchmark_failure',
                        item.correctCategory,
                        `not_${suggestion.suggested_category}`
                    ],
                    utility_weight: 1.0,  // High weight for corrections
                    source: 'benchmark_driven_training'
                },
                {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                }
            );

            logger.info('Created correction memory for benchmark failure', {
                merchant: item.merchant,
                correct: item.correctCategory,
                wrong: suggestion.suggested_category
            });

        } catch (error) {
            logger.warn('Failed to create correction memory', {
                error: error.message,
                merchant: item.merchant
            });
        }
    }

    /**
     * Generate a distinction hint for why one category is correct over another
     */
    _generateDistinctionHint(correctCategory, wrongCategory, description) {
        if (correctCategory === 'dining' && wrongCategory === 'business_meal') {
            return `Even though "${description}" mentions business/work context, it is categorized as DINING when the transaction is primarily at a restaurant/food establishment. The venue type (restaurant/cafe/deli) takes precedence over the social context.`;
        }
        if (correctCategory === 'business_meal' && wrongCategory === 'dining') {
            return `This is a BUSINESS_MEAL because the primary purpose is business-related (client meeting, work event) even though it takes place at a dining establishment.`;
        }
        return `This is ${correctCategory}, not ${wrongCategory}. Pay attention to the primary purpose and context of the transaction.`;
    }

    /**
     * Update memory cards based on practice results
     */
    async _updateMemoryFromPractice(trace_id, correct, context) {
        try {
            const axios = require('axios');

            // Get cards that were used in this attempt
            const traceResult = await query(
                `SELECT selected_card_ids FROM retrieval_traces WHERE trace_id = $1`,
                [trace_id]
            );

            if (traceResult.rows.length === 0 || !traceResult.rows[0].selected_card_ids) {
                return;
            }

            const cardIds = traceResult.rows[0].selected_card_ids;
            const isBenchmarkFailure = context.is_benchmark_failure;

            // MUCH stronger weight adjustment for actual benchmark failures
            // These are the exact cases we need Oggy to learn
            let patch;
            if (isBenchmarkFailure) {
                patch = correct
                    ? {
                        utility_weight_delta: +0.30,  // Strong boost when finally getting it right
                        success_count_delta: +1
                    }
                    : {
                        utility_weight_delta: -0.40,  // Very strong demotion - this memory led to wrong answer
                        failure_count_delta: +1
                    };
            } else {
                patch = correct
                    ? {
                        utility_weight_delta: +0.15,  // Normal boost for targeted training
                        success_count_delta: +1
                    }
                    : {
                        utility_weight_delta: -0.20,  // Normal demotion for failures
                        failure_count_delta: +1
                    };
            }

            // Update each card
            for (const card_id of cardIds) {
                try {
                    await axios.post(
                        `${MEMORY_SERVICE_URL}/utility/update`,
                        {
                            card_id,
                            context: {
                                agent: 'oggy_benchmark_driven',
                                program: 'targeted_training',
                                action: 'PRACTICE_RESULT',
                                evidence: {
                                    trace_id,
                                    practice_result: correct ? 'correct' : 'incorrect',
                                    training_mode: 'benchmark_driven',
                                    weakness_context: context.weakness_context
                                },
                                intent: {
                                    learning_mode: 'benchmark_driven',
                                    timestamp: new Date().toISOString()
                                }
                            },
                            patch
                        },
                        {
                            timeout: 5000,
                            headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                        }
                    );

                    logger.debug('Updated memory card from benchmark training', {
                        card_id,
                        trace_id,
                        correct,
                        patch
                    });
                } catch (error) {
                    logger.warn('Failed to update memory card', {
                        card_id,
                        error: error.message
                    });
                }
            }
        } catch (error) {
            logger.logError(error, {
                operation: '_updateMemoryFromPractice',
                trace_id
            });
        }
    }

    /**
     * Record practice event for audit trail
     */
    async _recordPracticeEvent(user_id, practiceData) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
            `, [
                uuidv4(),
                user_id,
                'OGGY_BENCHMARK_DRIVEN_PRACTICE',
                'practice',
                JSON.stringify({
                    ...practiceData,
                    timestamp: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.warn('Failed to record practice event', {
                error: error.message
            });
        }
    }

    /**
     * Re-test benchmark after training
     */
    async _retestBenchmark(benchmark_id, user_id, original_accuracy) {
        const result = await sealedBenchmarkEvaluator.testOnSealedBenchmark({
            benchmark_identifier: benchmark_id,
            user_id
        });

        return {
            result_id: result.result_id,
            oggy_accuracy: result.oggy.accuracy,
            base_accuracy: result.base.accuracy,
            improvement: result.oggy.accuracy - original_accuracy,
            comparison: result.comparison
        };
    }

    /**
     * Store session result for later analysis
     */
    async _storeSessionResult(result) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
            `, [
                result.session_id,
                result.original_benchmark.benchmark_id,
                'BENCHMARK_DRIVEN_TRAINING_COMPLETE',
                'training_session',
                JSON.stringify(result)
            ]);
        } catch (error) {
            logger.warn('Failed to store session result', {
                error: error.message
            });
        }
    }

    /**
     * Generate human-readable report
     */
    _generateReport(originalBenchmark, weakCategories, confusionPatterns, trainingResults, retestResults) {
        let report = `## Benchmark-Driven Training Report\n\n`;

        report += `### Original Benchmark\n`;
        report += `- Oggy Accuracy: ${(originalBenchmark.oggy_accuracy * 100).toFixed(1)}%\n`;
        report += `- Base Accuracy: ${(originalBenchmark.base_accuracy * 100).toFixed(1)}%\n\n`;

        if (weakCategories.length > 0) {
            report += `### Weak Categories Identified\n`;
            for (const w of weakCategories) {
                report += `- **${w.category}**: ${(w.accuracy * 100).toFixed(1)}% (${w.severity})\n`;
            }
            report += `\n`;
        }

        if (confusionPatterns && confusionPatterns.length > 0) {
            report += `### Confusion Patterns Detected\n`;
            for (const p of confusionPatterns) {
                report += `- **${p.actual} → ${p.predicted}**: ${p.count} errors (${(p.confusion_rate * 100).toFixed(1)}% confusion rate)\n`;
            }
            report += `\n`;
        }

        report += `### Training Summary\n`;
        report += `- Items Practiced: ${trainingResults.items_practiced}\n`;
        report += `- Correct: ${trainingResults.correct}\n`;
        report += `- Incorrect: ${trainingResults.incorrect}\n`;
        report += `- Training Accuracy: ${(trainingResults.accuracy * 100).toFixed(1)}%\n`;
        report += `- Duration: ${trainingResults.duration_seconds.toFixed(0)} seconds\n`;
        report += `- Stopped: ${trainingResults.stopped_reason}\n\n`;

        if (trainingResults.by_category && Object.keys(trainingResults.by_category).length > 0) {
            report += `### Per-Category Training Results\n`;
            for (const [cat, stats] of Object.entries(trainingResults.by_category)) {
                report += `- **${cat}**: ${stats.correct}/${stats.total} (${(stats.accuracy * 100).toFixed(1)}%)\n`;
            }
            report += `\n`;
        }

        if (retestResults) {
            report += `### Retest Results\n`;
            report += `- New Oggy Accuracy: ${(retestResults.oggy_accuracy * 100).toFixed(1)}%\n`;
            report += `- Improvement: ${retestResults.improvement >= 0 ? '+' : ''}${(retestResults.improvement * 100).toFixed(1)} percentage points\n`;
            report += `- Verdict: ${retestResults.comparison?.verdict || 'N/A'}\n`;
        }

        return report;
    }

    /**
     * Get current training status
     */
    getStatus() {
        if (!this.isRunning || !this.currentSession) {
            return {
                is_running: false,
                session: null
            };
        }

        return {
            is_running: true,
            session: {
                session_id: this.currentSession.session_id,
                result_id: this.currentSession.result_id,
                user_id: this.currentSession.user_id,
                started_at: this.currentSession.started_at,
                status: this.currentSession.status
            }
        };
    }

    /**
     * Stop current training session
     */
    async stopTraining() {
        if (!this.isRunning) {
            return { stopped: false, message: 'No training in progress' };
        }

        const session_id = this.currentSession?.session_id;
        this.isRunning = false;
        this.currentSession = null;

        logger.info('Benchmark-driven training stopped', { session_id });

        return {
            stopped: true,
            session_id,
            message: 'Training stopped'
        };
    }

    // Helper methods
    _shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    _countByCategory(items) {
        const counts = {};
        for (const item of items) {
            const cat = item.correctCategory;
            counts[cat] = (counts[cat] || 0) + 1;
        }
        return counts;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const benchmarkDrivenLearning = new BenchmarkDrivenLearning();

module.exports = benchmarkDrivenLearning;
