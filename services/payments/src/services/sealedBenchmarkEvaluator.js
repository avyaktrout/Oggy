/**
 * Sealed Benchmark Evaluator
 * Tests Oggy vs Base on fixed, sealed benchmark sets
 * Provides scientific measurement of true performance improvement
 *
 * Week 8: Scientific Evaluation
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const OggyCategorizer = require('./oggyCategorizer');
const sealedBenchmarkGenerator = require('./sealedBenchmarkGenerator');
const { adaptiveDifficultyScaler } = require('./adaptiveDifficultyScaler');

class SealedBenchmarkEvaluator {
    constructor() {
        this.oggyCategorizer = new OggyCategorizer();
    }

    /**
     * Test Oggy and Base on a sealed benchmark
     * Returns comparison showing true performance improvement
     */
    async testOnSealedBenchmark(options) {
        const {
            benchmark_identifier,
            user_id
        } = options;

        logger.info('Starting sealed benchmark test', {
            benchmark_identifier,
            user_id
        });

        // Get sealed benchmark
        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(benchmark_identifier);

        // Capture training state at test time
        const training_state = await this._captureTrainingState(user_id);

        // Test Oggy on all scenarios
        const oggy_results = [];
        for (const scenario of benchmark.scenarios) {
            const result = await this._testOggyOnScenario(user_id, scenario);
            oggy_results.push(result);
        }

        // Test Base on all scenarios
        const base_results = [];
        for (const scenario of benchmark.scenarios) {
            const result = await this._testBaseOnScenario(scenario);
            base_results.push(result);
        }

        // Calculate statistics
        const oggy_correct = oggy_results.filter(r => r.correct).length;
        const base_correct = base_results.filter(r => r.correct).length;
        const total = benchmark.scenarios.length;

        const oggy_accuracy = oggy_correct / total;
        const base_accuracy = base_correct / total;
        const advantage_delta = oggy_accuracy - base_accuracy;
        const advantage_percent = base_accuracy > 0
            ? ((oggy_accuracy / base_accuracy - 1) * 100)
            : 0;

        // Store results
        const result_id = await this._storeResults({
            benchmark_id: benchmark.benchmark_id,
            user_id,
            total_scenarios: total,
            oggy_correct,
            oggy_accuracy,
            base_correct,
            base_accuracy,
            advantage_delta,
            advantage_percent,
            training_state,
            oggy_results,
            base_results
        });

        logger.info('Sealed benchmark test complete', {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            oggy_accuracy,
            base_accuracy,
            advantage_percent
        });

        // Generate report
        const report = this._generateReport({
            benchmark,
            oggy_correct,
            base_correct,
            total,
            oggy_accuracy,
            base_accuracy,
            advantage_delta,
            advantage_percent,
            training_state
        });

        // Collect Oggy's mistakes for learning
        const oggy_wrong_scenarios = oggy_results
            .filter(r => !r.correct)
            .map((r, idx) => {
                const scenario = benchmark.scenarios.find(s => s.scenario_id === r.scenario_id);
                return {
                    scenario_id: r.scenario_id,
                    merchant: scenario?.merchant,
                    amount: scenario?.amount,
                    description: scenario?.description,
                    predicted_category: r.predicted_category,
                    correct_category: r.correct_category,
                    reasoning: scenario?.reasoning
                };
            });

        return {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            benchmark_name: benchmark.benchmark_name,
            oggy: {
                correct: oggy_correct,
                total,
                accuracy: oggy_accuracy,
                wrong_scenarios: oggy_wrong_scenarios
            },
            base: {
                correct: base_correct,
                total,
                accuracy: base_accuracy
            },
            comparison: {
                advantage_delta,
                advantage_percent,
                verdict: oggy_accuracy > base_accuracy ? 'OGGY_BETTER' :
                         oggy_accuracy < base_accuracy ? 'BASE_BETTER' : 'TIE'
            },
            training_state,
            report
        };
    }

    /**
     * Test Oggy on a single scenario
     */
    async _testOggyOnScenario(user_id, scenario) {
        try {
            const suggestion = await this.oggyCategorizer.suggestCategory(user_id, {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                transaction_date: new Date().toISOString().split('T')[0]
            });

            const correct = suggestion.suggested_category === scenario.correct_category;

            return {
                scenario_id: scenario.scenario_id,
                predicted_category: suggestion.suggested_category,
                correct_category: scenario.correct_category,
                correct,
                confidence: suggestion.confidence,
                trace_id: suggestion.trace_id
            };
        } catch (error) {
            logger.warn('Oggy test failed on scenario', {
                scenario_id: scenario.scenario_id,
                error: error.message
            });

            return {
                scenario_id: scenario.scenario_id,
                predicted_category: 'ERROR',
                correct_category: scenario.correct_category,
                correct: false,
                error: error.message
            };
        }
    }

    /**
     * Test Base on a single scenario
     */
    async _testBaseOnScenario(scenario) {
        try {
            const suggestion = await this.oggyCategorizer.suggestCategory(null, {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                transaction_date: new Date().toISOString().split('T')[0]
            });

            const correct = suggestion.suggested_category === scenario.correct_category;

            return {
                scenario_id: scenario.scenario_id,
                predicted_category: suggestion.suggested_category,
                correct_category: scenario.correct_category,
                correct,
                confidence: suggestion.confidence
            };
        } catch (error) {
            logger.warn('Base test failed on scenario', {
                scenario_id: scenario.scenario_id,
                error: error.message
            });

            return {
                scenario_id: scenario.scenario_id,
                predicted_category: 'ERROR',
                correct_category: scenario.correct_category,
                correct: false,
                error: error.message
            };
        }
    }

    /**
     * Capture current training state for context
     */
    async _captureTrainingState(user_id) {
        try {
            // Get domain knowledge count
            const knowledgeResult = await query(`
                SELECT COUNT(*) as count
                FROM domain_knowledge
                WHERE domain = 'payments'
            `);

            // Get adaptive difficulty scale info
            const scale_info = adaptiveDifficultyScaler.getScaleInfo();

            // Get memory card count
            const memoryResult = await query(`
                SELECT COUNT(*) as count
                FROM memory_cards
                WHERE owner_type = 'user' AND owner_id = $1
            `, [user_id]);

            return {
                domain_knowledge_count: parseInt(knowledgeResult.rows[0].count),
                memory_card_count: parseInt(memoryResult.rows[0]?.count || 0),
                baseline_scale: scale_info.baseline_scale,
                scale_status: scale_info.scale_status,
                captured_at: new Date().toISOString()
            };
        } catch (error) {
            logger.warn('Failed to capture training state', { error: error.message });
            return {
                error: error.message,
                captured_at: new Date().toISOString()
            };
        }
    }

    /**
     * Store test results in database
     */
    async _storeResults(data) {
        const result_id = uuidv4();

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
            data.total_scenarios,
            data.oggy_correct,
            data.oggy_accuracy,
            data.base_correct,
            data.base_accuracy,
            data.advantage_delta,
            data.advantage_percent,
            JSON.stringify(data.training_state),
            JSON.stringify({
                oggy: data.oggy_results,
                base: data.base_results
            })
        ]);

        return result_id;
    }

    /**
     * Generate human-readable report
     */
    _generateReport(data) {
        const {
            benchmark,
            oggy_correct,
            base_correct,
            total,
            oggy_accuracy,
            base_accuracy,
            advantage_delta,
            advantage_percent,
            training_state
        } = data;

        return `============================================================
📊 SEALED BENCHMARK TEST REPORT
============================================================

Benchmark: ${benchmark.benchmark_name}
${benchmark.description ? `Description: ${benchmark.description}\n` : ''}
Type: ${benchmark.use_ood ? 'Out-of-Distribution (Claude)' : 'In-Distribution (GPT-style)'}
Difficulty: ${benchmark.difficulty_mix}
Total Scenarios: ${total}

RESULTS:
------------------------------------------------------------

🤖 OGGY (with memory/learning):
   Correct:    ${oggy_correct}/${total}
   Accuracy:   ${(oggy_accuracy * 100).toFixed(1)}%

🔹 BASE (no memory/learning):
   Correct:    ${base_correct}/${total}
   Accuracy:   ${(base_accuracy * 100).toFixed(1)}%

📈 COMPARISON:
   Accuracy Delta:      ${(advantage_delta * 100).toFixed(1)} percentage points
   Relative Advantage:  ${advantage_percent >= 0 ? '+' : ''}${advantage_percent.toFixed(1)}%
   Additional Correct:  ${oggy_correct - base_correct}

🏆 VERDICT:
   ${oggy_accuracy > base_accuracy ? '✅ OGGY outperforms BASE' :
     oggy_accuracy < base_accuracy ? '⚠️ BASE outperforms OGGY' : '➖ TIE'}
   ${oggy_accuracy > base_accuracy ?
     `Oggy's training provides ${advantage_percent.toFixed(1)}% improvement!` :
     ''}

TRAINING STATE AT TEST TIME:
------------------------------------------------------------
Domain Knowledge:     ${training_state.domain_knowledge_count} examples
Memory Cards:         ${training_state.memory_card_count} cards
Baseline Scale:       ${training_state.baseline_scale}/100 (${training_state.scale_status})

============================================================`;
    }

    /**
     * Get historical results for a benchmark
     */
    async getHistoricalResults(benchmark_identifier) {
        // Get benchmark first to resolve ID
        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(benchmark_identifier);

        const result = await query(`
            SELECT
                result_id,
                user_id,
                tested_at,
                oggy_accuracy,
                base_accuracy,
                advantage_delta,
                advantage_percent,
                training_state
            FROM sealed_benchmark_results
            WHERE benchmark_id = $1
            ORDER BY tested_at DESC
        `, [benchmark.benchmark_id]);

        return result.rows;
    }

    /**
     * Compare performance over time on same sealed benchmark
     */
    async compareOverTime(options) {
        const { benchmark_identifier, user_id } = options;

        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(benchmark_identifier);

        const result = await query(`
            SELECT
                result_id,
                tested_at,
                oggy_accuracy,
                base_accuracy,
                advantage_percent,
                training_state
            FROM sealed_benchmark_results
            WHERE benchmark_id = $1 AND user_id = $2
            ORDER BY tested_at ASC
        `, [benchmark.benchmark_id, user_id]);

        if (result.rows.length === 0) {
            return {
                benchmark_name: benchmark.benchmark_name,
                user_id,
                message: 'No historical tests found',
                results: []
            };
        }

        // Calculate improvement from first to last test
        const first = result.rows[0];
        const last = result.rows[result.rows.length - 1];

        const improvement = {
            oggy_accuracy_change: last.oggy_accuracy - first.oggy_accuracy,
            advantage_change: last.advantage_percent - first.advantage_percent,
            tests_count: result.rows.length,
            time_span_days: (new Date(last.tested_at) - new Date(first.tested_at)) / (1000 * 60 * 60 * 24)
        };

        return {
            benchmark_name: benchmark.benchmark_name,
            benchmark_id: benchmark.benchmark_id,
            user_id,
            tests: result.rows,
            improvement,
            message: improvement.advantage_change > 0
                ? `Performance improved by ${improvement.advantage_change.toFixed(1)}% over ${improvement.tests_count} tests`
                : `No significant improvement detected over ${improvement.tests_count} tests`
        };
    }
}

// Singleton instance
const sealedBenchmarkEvaluator = new SealedBenchmarkEvaluator();

module.exports = sealedBenchmarkEvaluator;
