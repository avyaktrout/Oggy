/**
 * Continuous Learning Loop
 * Long-running self-driven learning with automatic benchmark generation
 *
 * Features:
 * - Continuous training with question tracking
 * - Auto-generates benchmarks every N questions if accuracy > threshold
 * - Runs Oggy vs Base comparisons
 * - Adaptive difficulty scaling based on performance
 *
 * Week 8+: Advanced autonomous learning
 */

const selfDrivenLearning = require('./selfDrivenLearning');
const sealedBenchmarkEvaluator = require('./sealedBenchmarkEvaluator');
const sealedBenchmarkGenerator = require('./sealedBenchmarkGenerator');
const benchmarkValidator = require('./benchmarkValidator');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

class ContinuousLearningLoop {
    constructor() {
        this.isRunning = false;
        this.userId = null;
        this.stats = {
            total_questions: 0,
            correct_answers: 0,
            current_window_questions: 0,
            current_window_correct: 0,
            benchmarks_generated: 0,
            benchmarks_passed: 0,
            current_difficulty: 'balanced',
            difficulty_level: 1,  // 1-5 scale
            session_start: null,
            session_duration_ms: 0,
            benchmark_results: []
        };

        // Configuration
        this.config = {
            questions_per_benchmark: 100,
            accuracy_threshold_for_benchmark: 0.90,
            both_models_threshold_for_upgrade: 0.95,
            benchmark_scenario_count: 30,
            training_interval_ms: 5000,
            practice_count_per_session: 3,
            max_difficulty_level: 5
        };

        // Difficulty progression
        this.difficultySettings = {
            1: { mix: 'easy', description: 'Easy - clear scenarios' },
            2: { mix: 'balanced', description: 'Balanced - mixed difficulty' },
            3: { mix: 'mixed', description: 'Mixed - emphasis on hard cases' },
            4: { mix: 'hard', description: 'Hard - challenging distinctions' },
            5: { mix: 'hard', description: 'Expert - edge cases and ambiguity', extra_hard: true }
        };
    }

    /**
     * Start the continuous learning loop
     * @param {string} userId - User ID for training context
     * @param {object} options - Configuration options
     * @param {number} options.duration_minutes - How long to run (default: indefinite)
     * @param {number} options.questions_per_benchmark - Questions before benchmark check (default: 100)
     * @param {number} options.accuracy_threshold - Accuracy needed to trigger benchmark (default: 0.90)
     */
    async start(userId, options = {}) {
        if (this.isRunning) {
            logger.warn('Continuous learning loop already running');
            return { error: 'Already running' };
        }

        const {
            duration_minutes = null,
            questions_per_benchmark = 100,
            accuracy_threshold = 0.90,
            training_interval_ms = 5000,
            practice_count = 3
        } = options;

        this.userId = userId;
        this.isRunning = true;
        this.config.questions_per_benchmark = questions_per_benchmark;
        this.config.accuracy_threshold_for_benchmark = accuracy_threshold;
        this.config.training_interval_ms = training_interval_ms;
        this.config.practice_count_per_session = practice_count;

        // Reset stats
        this.stats = {
            total_questions: 0,
            correct_answers: 0,
            current_window_questions: 0,
            current_window_correct: 0,
            benchmarks_generated: 0,
            benchmarks_passed: 0,
            current_difficulty: this.difficultySettings[1].description,
            difficulty_level: 1,
            session_start: Date.now(),
            session_duration_ms: 0,
            benchmark_results: []
        };

        logger.info('Starting continuous learning loop', {
            userId,
            duration_minutes,
            questions_per_benchmark,
            accuracy_threshold
        });

        // Set up stop timer if duration specified
        const stopTime = duration_minutes ? Date.now() + (duration_minutes * 60 * 1000) : null;

        // Run the loop
        await this._runLoop(stopTime);

        return this.getStats();
    }

    /**
     * Stop the learning loop
     */
    stop() {
        this.isRunning = false;
        this.stats.session_duration_ms = Date.now() - this.stats.session_start;
        selfDrivenLearning.stop();
        logger.info('Continuous learning loop stopped', this.getStats());
    }

    /**
     * Get current statistics
     */
    getStats() {
        const runningDuration = this.isRunning
            ? Date.now() - this.stats.session_start
            : this.stats.session_duration_ms;

        return {
            ...this.stats,
            session_duration_ms: runningDuration,
            session_duration_readable: this._formatDuration(runningDuration),
            overall_accuracy: this.stats.total_questions > 0
                ? ((this.stats.correct_answers / this.stats.total_questions) * 100).toFixed(1) + '%'
                : 'N/A',
            current_window_accuracy: this.stats.current_window_questions > 0
                ? ((this.stats.current_window_correct / this.stats.current_window_questions) * 100).toFixed(1) + '%'
                : 'N/A',
            questions_until_next_benchmark: this.config.questions_per_benchmark - this.stats.current_window_questions,
            is_running: this.isRunning
        };
    }

    /**
     * Main learning loop
     */
    async _runLoop(stopTime) {
        // Start self-driven learning
        selfDrivenLearning.start(this.userId, {
            interval: this.config.training_interval_ms,
            practiceCount: this.config.practice_count_per_session,
            enabled: true
        });

        while (this.isRunning) {
            // Check if we should stop
            if (stopTime && Date.now() >= stopTime) {
                logger.info('Continuous learning loop reached duration limit');
                this.stop();
                break;
            }

            // Wait for training progress
            await this._sleep(this.config.training_interval_ms + 1000);

            // Update stats from self-driven learning
            const learningStats = selfDrivenLearning.getStats();
            const newQuestions = learningStats.total_attempts - this.stats.total_questions;

            if (newQuestions > 0) {
                const newCorrect = Math.round(
                    (parseFloat(learningStats.accuracy) / 100) * learningStats.total_attempts
                ) - this.stats.correct_answers;

                this.stats.total_questions = learningStats.total_attempts;
                this.stats.correct_answers = Math.round(
                    (parseFloat(learningStats.accuracy) / 100) * learningStats.total_attempts
                );
                this.stats.current_window_questions += newQuestions;
                this.stats.current_window_correct += Math.max(0, newCorrect);

                // Check if we've hit the benchmark threshold
                if (this.stats.current_window_questions >= this.config.questions_per_benchmark) {
                    await this._checkAndRunBenchmark();
                }
            }
        }
    }

    /**
     * Check accuracy and run benchmark if threshold met
     */
    async _checkAndRunBenchmark() {
        const windowAccuracy = this.stats.current_window_correct / this.stats.current_window_questions;

        logger.info('Checking benchmark eligibility', {
            window_questions: this.stats.current_window_questions,
            window_accuracy: (windowAccuracy * 100).toFixed(1) + '%',
            threshold: (this.config.accuracy_threshold_for_benchmark * 100) + '%'
        });

        if (windowAccuracy >= this.config.accuracy_threshold_for_benchmark) {
            logger.info('Accuracy threshold met - generating benchmark', {
                accuracy: (windowAccuracy * 100).toFixed(1) + '%'
            });

            // Pause training during benchmark
            selfDrivenLearning.stop();

            try {
                // Generate a new benchmark at current difficulty
                const benchmarkResult = await this._generateAndRunBenchmark();
                this.stats.benchmark_results.push(benchmarkResult);
                this.stats.benchmarks_generated++;

                // Check if both models scored > 95%
                if (benchmarkResult.oggy_accuracy >= this.config.both_models_threshold_for_upgrade &&
                    benchmarkResult.base_accuracy >= this.config.both_models_threshold_for_upgrade) {

                    logger.info('Both models exceeded 95% - increasing difficulty', {
                        oggy: (benchmarkResult.oggy_accuracy * 100).toFixed(1) + '%',
                        base: (benchmarkResult.base_accuracy * 100).toFixed(1) + '%',
                        current_level: this.stats.difficulty_level
                    });

                    this._increaseDifficulty();
                }

                // Count as passed if Oggy beats or matches base
                if (benchmarkResult.oggy_accuracy >= benchmarkResult.base_accuracy) {
                    this.stats.benchmarks_passed++;
                }

            } catch (error) {
                logger.error('Benchmark generation/run failed', { error: error.message });
            }

            // Resume training
            selfDrivenLearning.start(this.userId, {
                interval: this.config.training_interval_ms,
                practiceCount: this.config.practice_count_per_session,
                enabled: true
            });
        } else {
            logger.info('Accuracy below threshold - continuing training', {
                accuracy: (windowAccuracy * 100).toFixed(1) + '%',
                threshold: (this.config.accuracy_threshold_for_benchmark * 100) + '%'
            });
        }

        // Reset window
        this.stats.current_window_questions = 0;
        this.stats.current_window_correct = 0;
    }

    /**
     * Generate a new benchmark and run Oggy vs Base
     */
    async _generateAndRunBenchmark() {
        const difficultyConfig = this.difficultySettings[this.stats.difficulty_level];
        const benchmarkName = `auto_benchmark_L${this.stats.difficulty_level}_${Date.now()}`;

        logger.info('Generating new benchmark', {
            name: benchmarkName,
            difficulty: difficultyConfig.description,
            scenario_count: this.config.benchmark_scenario_count
        });

        // Generate benchmark
        const generationResult = await sealedBenchmarkGenerator.createSealedBenchmark({
            name: benchmarkName,
            description: `Auto-generated benchmark at difficulty level ${this.stats.difficulty_level}`,
            count: this.config.benchmark_scenario_count,
            difficulty_mix: difficultyConfig.mix,
            use_ood: true  // Use Claude for out-of-distribution scenarios
        });

        // Validate the generated scenarios
        const benchmark = await sealedBenchmarkGenerator.getSealedBenchmark(benchmarkName);

        // Quick validation to check for obvious mislabels
        const validationIssues = [];
        for (const scenario of benchmark.scenarios) {
            const quickCheck = benchmarkValidator.quickValidate(scenario);
            if (quickCheck.has_flags) {
                validationIssues.push({
                    scenario_id: scenario.scenario_id,
                    flags: quickCheck.flags
                });
            }
        }

        if (validationIssues.length > 0) {
            logger.warn('Benchmark has potential labeling issues', {
                issue_count: validationIssues.length,
                issues: validationIssues.slice(0, 3)
            });

            // Run full validation and fix
            const validated = await benchmarkValidator.validateAndFixScenarios(benchmark.scenarios);

            // Update scenarios in database if fixes were made
            const fixedCount = validated.filter(s => s.auto_corrected).length;
            if (fixedCount > 0) {
                logger.info('Auto-corrected benchmark scenarios', { fixed_count: fixedCount });
                await this._updateBenchmarkScenarios(benchmark.benchmark_id, validated);
            }
        }

        // Run the benchmark
        logger.info('Running benchmark test', { benchmark_name: benchmarkName });

        const testResult = await sealedBenchmarkEvaluator.testOnSealedBenchmark({
            benchmark_identifier: benchmarkName,
            user_id: this.userId
        });

        const result = {
            benchmark_name: benchmarkName,
            benchmark_id: generationResult.benchmark_id,
            difficulty_level: this.stats.difficulty_level,
            difficulty_description: difficultyConfig.description,
            scenario_count: this.config.benchmark_scenario_count,
            oggy_accuracy: testResult.oggy.accuracy,
            base_accuracy: testResult.base.accuracy,
            advantage: testResult.comparison.advantage_percent,
            oggy_passed: testResult.oggy.accuracy >= testResult.base.accuracy,
            timestamp: new Date().toISOString(),
            validation_issues_found: validationIssues.length
        };

        logger.info('Benchmark completed', result);

        return result;
    }

    /**
     * Update benchmark scenarios after validation fixes
     */
    async _updateBenchmarkScenarios(benchmarkId, scenarios) {
        const { query: dbQuery } = require('../utils/db');

        for (const scenario of scenarios) {
            if (scenario.auto_corrected) {
                await dbQuery(`
                    UPDATE sealed_benchmark_scenarios
                    SET correct_category = $1
                    WHERE scenario_id = $2
                `, [scenario.correct_category, scenario.scenario_id]);
            }
        }
    }

    /**
     * Increase difficulty level
     */
    _increaseDifficulty() {
        if (this.stats.difficulty_level < this.config.max_difficulty_level) {
            this.stats.difficulty_level++;
            this.stats.current_difficulty = this.difficultySettings[this.stats.difficulty_level].description;

            logger.info('Difficulty increased', {
                new_level: this.stats.difficulty_level,
                description: this.stats.current_difficulty
            });
        } else {
            logger.info('Already at maximum difficulty level');
        }
    }

    /**
     * Format duration for display
     */
    _formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Sleep utility
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Singleton instance
const continuousLearningLoop = new ContinuousLearningLoop();

module.exports = continuousLearningLoop;