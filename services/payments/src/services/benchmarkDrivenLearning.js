/**
 * Benchmark-Driven Learning
 * Implements a feedback loop where:
 * 1. Run benchmark test
 * 2. Analyze weaknesses from mistakes
 * 3. Configure targeted training on weak categories
 * 4. Train for specified duration
 * 5. Repeat cycle
 *
 * Week 8+: Closing the learning feedback loop
 */

const sealedBenchmarkEvaluator = require('./sealedBenchmarkEvaluator');
const weaknessAnalyzer = require('./weaknessAnalyzer');
const selfDrivenLearning = require('./selfDrivenLearning'); // Singleton instance
const logger = require('../utils/logger');

class BenchmarkDrivenLearning {
    constructor() {
        this.selfDrivenLearning = selfDrivenLearning;
    }

    /**
     * Run benchmark-driven learning cycles
     * @param {object} options - Configuration
     * @returns {object} Results from all cycles
     */
    async runLearningCycles(options) {
        const {
            benchmark_identifier,
            user_id,
            cycles = 3,
            training_duration_seconds = 90,
            training_interval_ms = 10000,
            practice_count_per_session = 5
        } = options;

        logger.info('Starting benchmark-driven learning cycles', {
            benchmark_identifier,
            user_id,
            cycles,
            training_duration_seconds
        });

        const results = {
            cycles: [],
            summary: null
        };

        for (let cycle = 0; cycle < cycles; cycle++) {
            logger.info(`===== CYCLE ${cycle + 1}/${cycles} =====`, { user_id });

            // STEP 1: Run benchmark
            logger.info(`Cycle ${cycle + 1}: Running benchmark test`, { user_id });
            const benchmarkResult = await sealedBenchmarkEvaluator.testOnSealedBenchmark({
                benchmark_identifier,
                user_id
            });

            // STEP 2: Analyze weaknesses from benchmark mistakes
            logger.info(`Cycle ${cycle + 1}: Analyzing weaknesses`, { user_id });
            const weaknessAnalysis = await weaknessAnalyzer.analyzeWeaknesses({
                user_id,
                result_id: benchmarkResult.result_id
            });

            const weakCategories = weaknessAnalysis.weaknesses.map(w => w.category);
            const avgWeakAccuracy = weaknessAnalysis.weaknesses.length > 0
                ? weaknessAnalysis.weaknesses.reduce((sum, w) => sum + w.accuracy, 0) / weaknessAnalysis.weaknesses.length
                : 1.0;

            logger.info(`Cycle ${cycle + 1}: Identified ${weakCategories.length} weak categories`, {
                user_id,
                weak_categories: weakCategories,
                avg_weak_accuracy: (avgWeakAccuracy * 100).toFixed(1) + '%'
            });

            // Store cycle results
            const cycleResult = {
                cycle_number: cycle + 1,
                benchmark: {
                    result_id: benchmarkResult.result_id,
                    oggy_accuracy: benchmarkResult.oggy.accuracy,
                    base_accuracy: benchmarkResult.base.accuracy,
                    advantage: benchmarkResult.comparison.advantage_percent
                },
                weakness_analysis: {
                    weak_categories: weakCategories,
                    weak_count: weakCategories.length,
                    confusion_patterns: weaknessAnalysis.confusion_patterns?.slice(0, 3) || []
                },
                training: null
            };

            // STEP 3: Configure targeted training (if weaknesses found)
            if (cycle < cycles - 1) { // Don't train after last cycle
                if (weaknessAnalysis.recommendations.priority === 'targeted') {
                    logger.info(`Cycle ${cycle + 1}: Configuring TARGETED training`, {
                        user_id,
                        focus_categories: weaknessAnalysis.recommendations.focus_categories,
                        training_mix: weaknessAnalysis.recommendations.training_mix
                    });

                    this.selfDrivenLearning.setTargetedLearning(
                        weaknessAnalysis.recommendations.training_mix,
                        weaknessAnalysis.recommendations.focus_categories
                    );
                } else {
                    logger.info(`Cycle ${cycle + 1}: No weaknesses - using BALANCED training`, { user_id });
                    this.selfDrivenLearning.clearTargetedLearning();
                }

                // STEP 4: Run targeted training
                logger.info(`Cycle ${cycle + 1}: Starting ${training_duration_seconds}s training`, { user_id });

                this.selfDrivenLearning.start(user_id, {
                    interval: training_interval_ms,
                    practiceCount: practice_count_per_session,
                    enabled: true
                });

                // Wait for training duration
                await this._sleep(training_duration_seconds * 1000);

                // Stop training
                this.selfDrivenLearning.stop();

                const trainingStats = this.selfDrivenLearning.getStats();
                logger.info(`Cycle ${cycle + 1}: Training complete`, {
                    user_id,
                    attempts: trainingStats.total_attempts,
                    accuracy: trainingStats.accuracy
                });

                cycleResult.training = {
                    duration_seconds: training_duration_seconds,
                    attempts: trainingStats.total_attempts,
                    accuracy: trainingStats.accuracy,
                    was_targeted: weaknessAnalysis.recommendations.priority === 'targeted',
                    focus_categories: weaknessAnalysis.recommendations.focus_categories || []
                };
            }

            results.cycles.push(cycleResult);
        }

        // Generate summary
        results.summary = this._generateSummary(results.cycles);

        logger.info('Benchmark-driven learning cycles complete', {
            user_id,
            total_cycles: cycles,
            improvement: results.summary.improvement
        });

        return results;
    }

    /**
     * Generate summary of learning cycles
     */
    _generateSummary(cycles) {
        const firstCycle = cycles[0];
        const lastCycle = cycles[cycles.length - 1];

        const oggy_improvement = lastCycle.benchmark.oggy_accuracy - firstCycle.benchmark.oggy_accuracy;
        const advantage_improvement = lastCycle.benchmark.advantage - firstCycle.benchmark.advantage;

        const total_training_attempts = cycles
            .filter(c => c.training)
            .reduce((sum, c) => sum + (c.training?.attempts || 0), 0);

        const avg_training_accuracy = cycles
            .filter(c => c.training && c.training.accuracy)
            .reduce((sum, c) => sum + parseFloat(c.training.accuracy), 0) / cycles.filter(c => c.training).length;

        return {
            total_cycles: cycles.length,
            first_benchmark: {
                oggy_accuracy: firstCycle.benchmark.oggy_accuracy,
                advantage: firstCycle.benchmark.advantage
            },
            last_benchmark: {
                oggy_accuracy: lastCycle.benchmark.oggy_accuracy,
                advantage: lastCycle.benchmark.advantage
            },
            improvement: {
                oggy_accuracy_delta: oggy_improvement,
                oggy_accuracy_delta_pct: (oggy_improvement * 100).toFixed(1) + ' pp',
                advantage_delta: advantage_improvement,
                advantage_delta_pct: advantage_improvement.toFixed(1) + ' pp'
            },
            training: {
                total_attempts: total_training_attempts,
                avg_accuracy: avg_training_accuracy.toFixed(1) + '%'
            },
            weakness_evolution: cycles.map(c => ({
                cycle: c.cycle_number,
                weak_count: c.weakness_analysis.weak_count,
                weak_categories: c.weakness_analysis.weak_categories
            }))
        };
    }

    /**
     * Sleep utility
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = BenchmarkDrivenLearning;
