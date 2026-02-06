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

const BENCHMARK_UPGRADE_THRESHOLD = parseFloat(process.env.BENCHMARK_UPGRADE_THRESHOLD || '0.90');

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

        await adaptiveDifficultyScaler.loadBaselineScale(user_id);

        // Get sealed benchmark
        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(benchmark_identifier);

        // Capture training state at test time
        const training_state = await this._captureTrainingState(user_id);

        // Test Base first and measure duration to set time limit for Oggy
        const base_results = [];
        const baseStartTime = Date.now();
        for (const scenario of benchmark.scenarios) {
            const result = await this._testBaseOnScenario(scenario);
            base_results.push(result);
        }
        const baseDurationMs = Date.now() - baseStartTime;
        const safetyMarginMs = Math.max(250, Math.floor(baseDurationMs * 0.02));
        const oggyTimeLimitMs = Math.max(0, baseDurationMs - safetyMarginMs);

        // Test Oggy with a hard time limit equal to base duration
        const oggy_results = [];
        const oggyStartTime = Date.now();
        let oggyTimedOut = false;
        const targetPerItem = oggyTimeLimitMs / benchmark.scenarios.length;
        let memoryMode = 'benchmark';
        let speedMode = 'normal';
        for (const scenario of benchmark.scenarios) {
            const elapsed = Date.now() - oggyStartTime;
            if (elapsed > oggyTimeLimitMs) {
                oggyTimedOut = true;
                break;
            }
            const idx = oggy_results.length;
            const avgPerItem = idx > 0 ? (elapsed / idx) : targetPerItem;
            const remaining = benchmark.scenarios.length - idx;
            const projected = elapsed + (avgPerItem * remaining);

            // Adaptive mode selection:
            // - If ahead of schedule, allow full memory
            // - If falling behind, switch to fast mode
            // - If very late, switch to very fast mode (minimal prompt)
            if (avgPerItem < targetPerItem * 0.75 && projected < oggyTimeLimitMs * 0.8) {
                memoryMode = 'full';
                speedMode = 'normal';
            } else if (
                elapsed > oggyTimeLimitMs * 0.9 ||
                avgPerItem > targetPerItem * 1.2 ||
                projected > oggyTimeLimitMs * 0.95
            ) {
                memoryMode = 'none';
                speedMode = 'very_fast';
            } else if (avgPerItem > targetPerItem * 1.05 || projected > oggyTimeLimitMs * 0.9) {
                memoryMode = 'benchmark';
                speedMode = 'fast';
            } else {
                memoryMode = 'benchmark';
                speedMode = 'normal';
            }

            const result = await this._testOggyOnScenario(user_id, scenario, {
                memory_mode: memoryMode,
                speed_mode: speedMode
            });
            oggy_results.push(result);
        }

        // If Oggy timed out, mark remaining scenarios as incorrect
        if (oggyTimedOut && oggy_results.length < benchmark.scenarios.length) {
            for (let i = oggy_results.length; i < benchmark.scenarios.length; i++) {
                const scenario = benchmark.scenarios[i];
                oggy_results.push({
                    scenario_id: scenario.scenario_id,
                    predicted_category: 'TIMEOUT',
                    correct_category: scenario.correct_category,
                    correct: false,
                    error: 'OGGY_TIMEOUT'
                });
            }
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

        const oggyDurationMs = Date.now() - oggyStartTime;

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
            base_results,
            timing: {
                base_duration_ms: baseDurationMs,
                oggy_duration_ms: oggyDurationMs,
                oggy_time_limit_ms: oggyTimeLimitMs,
                safety_margin_ms: safetyMarginMs,
                oggy_timed_out: oggyTimedOut
            }
        });

        const upgradeResult = await this._maybeAdvanceDifficultyFromBenchmark(
            user_id,
            oggy_accuracy
        );

        logger.info('Sealed benchmark test complete', {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            oggy_accuracy,
            base_accuracy,
            advantage_percent,
            timing: {
                base_duration_ms: baseDurationMs,
                oggy_duration_ms: oggyDurationMs,
                oggy_time_limit_ms: oggyTimeLimitMs,
                safety_margin_ms: safetyMarginMs,
                oggy_timed_out: oggyTimedOut
            },
            upgrade: upgradeResult
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
            timing: {
                base_duration_ms: baseDurationMs,
                oggy_duration_ms: oggyDurationMs,
                oggy_time_limit_ms: oggyTimeLimitMs,
                safety_margin_ms: safetyMarginMs,
                oggy_timed_out: oggyTimedOut
            },
            upgrade: upgradeResult,
            report
        };
    }

    /**
     * Test Oggy on a single scenario
     */
    async _testOggyOnScenario(user_id, scenario, options = {}) {
        try {
            const suggestion = await this.oggyCategorizer.suggestCategory(user_id, {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                transaction_date: new Date().toISOString().split('T')[0]
            }, { benchmark_mode: true, ...options });

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
            }, { benchmark_mode: true, memory_mode: 'benchmark', speed_mode: 'normal' });

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

    async _maybeAdvanceDifficultyFromBenchmark(userId, oggyAccuracy) {
        if (!userId) {
            return { upgraded: false, reason: 'missing_user_id' };
        }

        if (oggyAccuracy < BENCHMARK_UPGRADE_THRESHOLD) {
            return { upgraded: false, reason: 'threshold_not_met' };
        }

        const { scale, level } = await this._loadScaleAndLevel(userId);
        const next = this._computeNextScaleLevel(scale, level);

        if (!next.advanced) {
            return { upgraded: false, reason: 'at_max', scale, level };
        }

        await this._saveScaleAndLevel(userId, next.scale, next.level);
        await adaptiveDifficultyScaler.bumpBaselineScale(userId, { reason: 'benchmark' });

        return {
            upgraded: true,
            old_scale: scale,
            old_level: level,
            new_scale: next.scale,
            new_level: next.level
        };
    }

    _computeNextScaleLevel(scale, level) {
        if (level < 5) {
            return { scale, level: level + 1, advanced: true };
        }

        if (scale < 10) {
            return { scale: scale + 1, level: 1, advanced: true };
        }

        return { scale, level, advanced: false };
    }

    async _loadScaleAndLevel(userId) {
        await this._ensureStateTable();
        const result = await query(`
            SELECT scale, difficulty_level
            FROM continuous_learning_state
            WHERE user_id = $1
        `, [userId]);

        if (result.rows.length > 0) {
            return {
                scale: result.rows[0].scale || 1,
                level: result.rows[0].difficulty_level || 3
            };
        }

        await this._saveScaleAndLevel(userId, 1, 3);
        return { scale: 1, level: 3 };
    }

    async _saveScaleAndLevel(userId, scale, level) {
        await query(`
            INSERT INTO continuous_learning_state (user_id, scale, difficulty_level, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (user_id)
            DO UPDATE SET scale = $2, difficulty_level = $3, updated_at = NOW()
        `, [userId, scale, level]);
    }

    async _ensureStateTable() {
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS continuous_learning_state (
                    user_id VARCHAR(255) PRIMARY KEY,
                    scale INTEGER DEFAULT 1,
                    difficulty_level INTEGER DEFAULT 3,
                    baseline_scale INTEGER DEFAULT 50,
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);

            await query(`
                ALTER TABLE continuous_learning_state
                ADD COLUMN IF NOT EXISTS scale INTEGER DEFAULT 1
            `);

            await query(`
                ALTER TABLE continuous_learning_state
                ADD COLUMN IF NOT EXISTS difficulty_level INTEGER DEFAULT 3
            `);

            await query(`
                ALTER TABLE continuous_learning_state
                ADD COLUMN IF NOT EXISTS baseline_scale INTEGER DEFAULT 50
            `);
        } catch (error) {
            logger.debug('Failed to ensure continuous_learning_state table', { error: error.message });
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
                base: data.base_results,
                timing: data.timing || {}
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
Base Duration: ${(data.timing?.base_duration_ms || 0) / 1000}s
Oggy Duration: ${(data.timing?.oggy_duration_ms || 0) / 1000}s
Oggy Timed Out: ${data.timing?.oggy_timed_out ? 'YES' : 'NO'}

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
