/**
 * Continuous Learning Loop
 * Long-running self-driven learning with automatic benchmark generation
 *
 * Features:
 * - Continuous training with question tracking
 * - Auto-generates benchmarks every N questions if accuracy > threshold
 * - Runs Oggy vs Base comparisons
 * - Adaptive difficulty scaling with SCALE system (S1, S2, S3...)
 *   - Each scale has levels 1-5
 *   - Passing level 5 advances to next scale at level 3
 *   - Higher scales = more complex payment scenarios
 *
 * Week 8+: Advanced autonomous learning
 */

const selfDrivenLearning = require('./selfDrivenLearning');
const sealedBenchmarkEvaluator = require('./sealedBenchmarkEvaluator');
const sealedBenchmarkGenerator = require('./sealedBenchmarkGenerator');
const benchmarkValidator = require('./benchmarkValidator');
const sessionCleanupManager = require('./sessionCleanupManager');
const serviceHealthManager = require('./serviceHealthManager');
const logger = require('../utils/logger');
const { query } = require('../utils/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

class ContinuousLearningLoop {
    constructor() {
        this.isRunning = false;
        this.userId = null;
        this.sessionGeneration = 0;  // Prevents old async loops from affecting new sessions
        this.stats = {
            total_questions: 0,
            correct_answers: 0,
            current_window_questions: 0,
            current_window_correct: 0,
            benchmarks_generated: 0,
            benchmarks_passed: 0,
            current_scale: 1,        // S1, S2, S3... (higher = more complex)
            difficulty_level: 1,      // 1-5 within each scale
            current_difficulty: 'S1 L1 - Easy',
            session_start: null,
            session_duration_ms: 0,
            benchmark_results: [],
            // Separate time tracking: training time vs benchmark time
            training_time_ms: 0,           // Actual time spent training (counts against limit)
            benchmark_time_ms: 0,          // Total time spent on benchmarks (does NOT count against limit)
            is_benchmarking: false,        // Flag indicating benchmark in progress
            current_benchmark_start: null, // When current benchmark started
            last_training_timestamp: null  // Last time we were actively training
        };

        // Configuration
        this.config = {
            questions_per_benchmark: 35,              // Training questions before benchmark check
            accuracy_threshold_for_benchmark: 0.80,   // 80% accuracy on training to trigger benchmark
            both_models_threshold_for_upgrade: 0.90,  // 90% accuracy on benchmark to advance level
            benchmark_scenario_count: 70,             // Questions per benchmark
            training_interval_ms: 5000,
            practice_count_per_session: 3,
            max_difficulty_level: 5,
            max_scale: 10,  // Allow up to S10
            // Decision maker settings
            allow_extension: true,                    // Allow Oggy to extend training
            extension_minutes: 3,                     // Minutes to extend per decision (within original duration)
            max_extensions: 3,                        // Maximum number of extensions (within original duration)
            weakness_threshold: 0.75,                 // Below this = weakness needing work
            advantage_target: 5.0                     // Target advantage over base (%)
        };

        // Decision maker state
        this.decisionState = {
            extensions_used: 0,
            weaknesses_identified: [],
            extension_decisions: [],
            original_stop_time: null
        };

        // Base difficulty progression (within each scale)
        this.baseDifficultySettings = {
            1: { mix: 'easy', description: 'Easy - clear scenarios' },
            2: { mix: 'balanced', description: 'Balanced - mixed difficulty' },
            3: { mix: 'mixed', description: 'Mixed - emphasis on hard cases' },
            4: { mix: 'hard', description: 'Hard - challenging distinctions' },
            5: { mix: 'hard', description: 'Expert - edge cases and ambiguity', extra_hard: true }
        };

        // Scale complexity multipliers - each scale adds new challenges
        this.scaleComplexity = {
            1: {
                name: 'Foundation',
                description: 'Basic payment categorization',
                complexity_factors: ['single_category', 'clear_merchants', 'standard_amounts']
            },
            2: {
                name: 'Intermediate',
                description: 'Multi-factor payment scenarios',
                complexity_factors: ['category_overlap', 'context_dependent', 'amount_edge_cases', 'time_sensitivity']
            },
            3: {
                name: 'Advanced',
                description: 'Complex real-world payment patterns',
                complexity_factors: ['multi_category_transactions', 'subscription_variations', 'business_personal_blur', 'international_payments']
            },
            4: {
                name: 'Expert',
                description: 'Edge cases requiring deep context',
                complexity_factors: ['tax_implications', 'regulatory_nuances', 'fraud_adjacent', 'unusual_merchant_types']
            },
            5: {
                name: 'Master',
                description: 'Ambiguous scenarios with multiple valid interpretations',
                complexity_factors: ['multi_valid_categories', 'temporal_context', 'user_intent_inference', 'chained_transactions']
            }
        };
    }

    /**
     * Get difficulty settings for current scale and level
     */
    getDifficultyConfig(scale, level) {
        const baseConfig = this.baseDifficultySettings[level];
        const scaleConfig = this.scaleComplexity[Math.min(scale, 5)] || this.scaleComplexity[5];

        return {
            ...baseConfig,
            scale: scale,
            level: level,
            scale_name: scaleConfig.name,
            complexity_factors: scaleConfig.complexity_factors,
            description: `S${scale} L${level} - ${scaleConfig.name}: ${baseConfig.description}`,
            // Higher scales get progressively harder mix adjustments
            effective_mix: scale >= 3 ? 'hard' : baseConfig.mix,
            require_context: scale >= 2,
            require_reasoning: scale >= 3,
            multi_step: scale >= 4
        };
    }

    /**
     * Start the continuous learning loop
     * @param {string} userId - User ID for training context
     * @param {object} options - Configuration options
     * @param {number} options.duration_minutes - How long to run (default: indefinite)
     * @param {number} options.questions_per_benchmark - Questions before benchmark check (default: 100)
     * @param {number} options.accuracy_threshold - Accuracy needed to trigger benchmark (default: 0.90)
     * @param {number} options.starting_difficulty - Starting difficulty level 1-5 (default: load from DB or 3)
     * @param {number} options.starting_scale - Starting scale S1, S2, etc. (default: load from DB or 1)
     */
    async start(userId, options = {}) {
        if (this.isRunning) {
            logger.warn('Continuous learning loop already running');
            return { error: 'Already running' };
        }

        const {
            duration_minutes = null,
            questions_per_benchmark = 35,             // Training questions before benchmark
            accuracy_threshold = 0.80,                // 80% on training to trigger benchmark
            benchmark_scenario_count = 70,            // Questions per benchmark
            upgrade_threshold = 0.90,                 // 90% on benchmark to advance level
            training_interval_ms = 5000,
            practice_count = 3,
            starting_difficulty = null,  // null = load from DB, or use specified level
            starting_scale = null        // null = load from DB, or use specified scale
        } = options;

        // Increment session generation - any old async loops will see this and stop
        const myGeneration = ++this.sessionGeneration;

        this.userId = userId;
        this.isRunning = true;
        this.currentGeneration = myGeneration;  // Store for this session
        this.config.questions_per_benchmark = questions_per_benchmark;
        this.config.accuracy_threshold_for_benchmark = accuracy_threshold;
        this.config.benchmark_scenario_count = benchmark_scenario_count;
        this.config.both_models_threshold_for_upgrade = upgrade_threshold;
        this.config.training_interval_ms = training_interval_ms;
        this.config.practice_count_per_session = practice_count;
        this.config.duration_minutes = duration_minutes;  // Store for time limit enforcement

        // Prepare session - reset circuit breakers and run health checks
        const readiness = await sessionCleanupManager.prepareNewSession(userId);
        if (!readiness.healthy) {
            logger.warn('Starting with degraded services', {
                unhealthy: readiness.unhealthyServices,
                circuitBreakersReset: readiness.circuitBreakersReset
            });
        } else {
            logger.info('Session prepared - all services healthy', {
                circuitBreakersReset: readiness.circuitBreakersReset
            });
        }

        // Load or set scale and difficulty level
        let { scale, level } = await this._loadScaleAndLevel(userId, starting_scale, starting_difficulty);

        // Get the difficulty config for this scale/level
        const difficultyConfig = this.getDifficultyConfig(scale, level);

        // Reset stats but preserve/set difficulty
        const now = Date.now();
        this.stats = {
            total_questions: 0,
            correct_answers: 0,
            current_window_questions: 0,
            current_window_correct: 0,
            benchmarks_generated: 0,
            benchmarks_passed: 0,
            current_scale: scale,
            difficulty_level: level,
            current_difficulty: difficultyConfig.description,
            session_start: now,
            session_duration_ms: 0,
            benchmark_results: [],
            // Separate time tracking
            training_time_ms: 0,
            benchmark_time_ms: 0,
            is_benchmarking: false,
            current_benchmark_start: null,
            last_training_timestamp: now  // Start tracking training time from now
        };

        logger.info('Starting continuous learning loop', {
            userId,
            duration_minutes,
            questions_per_benchmark,
            accuracy_threshold,
            starting_scale: scale,
            starting_difficulty: level,
            scale_name: difficultyConfig.scale_name,
            complexity_factors: difficultyConfig.complexity_factors
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
    async stop() {
        this.isRunning = false;
        this.stats.session_duration_ms = Date.now() - this.stats.session_start;
        selfDrivenLearning.stop();

        // Cleanup session - log completion and clear transient state
        try {
            await sessionCleanupManager.cleanupSession(this.userId, this.getStats());
        } catch (error) {
            logger.warn('Session cleanup failed', { error: error.message });
        }

        logger.info('Continuous learning loop stopped', this.getStats());
    }

    /**
     * Get current statistics
     */
    getStats() {
        const now = Date.now();
        const totalElapsed = this.isRunning
            ? now - this.stats.session_start
            : this.stats.session_duration_ms;

        // Calculate current training time (add time since last timestamp if actively training)
        let currentTrainingTime = this.stats.training_time_ms;
        if (this.isRunning && !this.stats.is_benchmarking && this.stats.last_training_timestamp) {
            currentTrainingTime += now - this.stats.last_training_timestamp;
        }

        // Calculate current benchmark time if in benchmark
        let currentBenchmarkTime = this.stats.benchmark_time_ms;
        if (this.stats.is_benchmarking && this.stats.current_benchmark_start) {
            currentBenchmarkTime += now - this.stats.current_benchmark_start;
        }

        const difficultyConfig = this.getDifficultyConfig(this.stats.current_scale, this.stats.difficulty_level);

        // Calculate remaining training time and ETA
        const trainingLimitMs = this.config.duration_minutes ? this.config.duration_minutes * 60 * 1000 : null;
        const trainingTimeRemaining = trainingLimitMs ? Math.max(0, trainingLimitMs - currentTrainingTime) : null;

        // Estimate completion: remaining training time + potential benchmark time
        const avgBenchmarkTime = this.stats.benchmarks_generated > 0
            ? this.stats.benchmark_time_ms / this.stats.benchmarks_generated
            : 3 * 60 * 1000; // Default estimate: 3 minutes per benchmark
        const estimatedCompletion = trainingTimeRemaining !== null
            ? new Date(now + trainingTimeRemaining + avgBenchmarkTime).toISOString()
            : null;

        return {
            ...this.stats,
            // Total session time
            session_duration_ms: totalElapsed,
            session_duration_readable: this._formatDuration(totalElapsed),
            // Separate training vs benchmark time
            training_time_ms: currentTrainingTime,
            training_time_readable: this._formatDuration(currentTrainingTime),
            benchmark_time_ms: currentBenchmarkTime,
            benchmark_time_readable: this._formatDuration(currentBenchmarkTime),
            // Training time remaining (this is what counts against the limit)
            training_time_remaining_ms: trainingTimeRemaining,
            training_time_remaining_readable: trainingTimeRemaining !== null ? this._formatDuration(trainingTimeRemaining) : 'unlimited',
            // Estimated completion
            estimated_completion: estimatedCompletion,
            // Status
            status: this.stats.is_benchmarking ? 'benchmarking' : (this.isRunning ? 'training' : 'stopped'),
            overall_accuracy: this.stats.total_questions > 0
                ? ((this.stats.correct_answers / this.stats.total_questions) * 100).toFixed(1) + '%'
                : 'N/A',
            current_window_accuracy: this.stats.current_window_questions > 0
                ? ((this.stats.current_window_correct / this.stats.current_window_questions) * 100).toFixed(1) + '%'
                : 'N/A',
            questions_until_next_benchmark: this.config.questions_per_benchmark - this.stats.current_window_questions,
            is_running: this.isRunning,
            // Scale information
            scale_name: difficultyConfig.scale_name,
            scale_level_display: `S${this.stats.current_scale} L${this.stats.difficulty_level}`,
            complexity_factors: difficultyConfig.complexity_factors,
            upgrade_threshold: (this.config.both_models_threshold_for_upgrade * 100) + '%'
        };
    }

    /**
     * Main learning loop
     * Training time is tracked separately from benchmark time.
     * Only training time counts against the duration limit.
     */
    async _runLoop(stopTime) {
        // Store original stop time for decision maker
        this.decisionState.original_stop_time = stopTime;
        const trainingLimitMs = this.config.duration_minutes ? this.config.duration_minutes * 60 * 1000 : null;

        // Start self-driven learning
        selfDrivenLearning.start(this.userId, {
            interval: this.config.training_interval_ms,
            practiceCount: this.config.practice_count_per_session,
            enabled: true
        });

        // Capture generation for this loop instance
        const loopGeneration = this.currentGeneration;

        while (this.isRunning && this.currentGeneration === loopGeneration) {
            const now = Date.now();

            // Update training time (only if not benchmarking)
            if (!this.stats.is_benchmarking && this.stats.last_training_timestamp) {
                const timeSinceLastUpdate = now - this.stats.last_training_timestamp;
                this.stats.training_time_ms += timeSinceLastUpdate;
            }
            this.stats.last_training_timestamp = now;

            // Check if TRAINING TIME has exceeded the limit (not total elapsed time)
            if (trainingLimitMs && this.stats.training_time_ms >= trainingLimitMs) {
                logger.info('⏰ Training time limit reached', {
                    training_time_ms: this.stats.training_time_ms,
                    training_time_readable: this._formatDuration(this.stats.training_time_ms),
                    benchmark_time_ms: this.stats.benchmark_time_ms,
                    total_session_time: this._formatDuration(now - this.stats.session_start),
                    limit_minutes: this.config.duration_minutes
                });

                // Only act if we're still the current session
                if (this.currentGeneration !== loopGeneration) {
                    logger.info('Old session loop detected - exiting without affecting current session');
                    break;
                }

                // Run decision maker to see if we should extend
                const decision = await this._makeExtensionDecision();

                if (decision.extend) {
                    // Extend the training time limit
                    this.config.duration_minutes += this.config.extension_minutes;
                    this.decisionState.extensions_used++;
                    this.decisionState.extension_decisions.push(decision);

                    logger.info('🧠 OGGY DECISION: Extending training time', {
                        reason: decision.reason,
                        weaknesses: decision.weaknesses,
                        extensions_used: this.decisionState.extensions_used,
                        new_training_limit_minutes: this.config.duration_minutes
                    });
                } else {
                    logger.info('🧠 OGGY DECISION: Training complete', {
                        reason: decision.reason,
                        final_stats: this.getStats()
                    });
                    this.stop();
                    break;
                }
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
     * Benchmark time does NOT count against the training time limit.
     */
    async _checkAndRunBenchmark() {
        const windowAccuracy = this.stats.current_window_correct / this.stats.current_window_questions;

        logger.info('Checking benchmark eligibility', {
            window_questions: this.stats.current_window_questions,
            window_accuracy: (windowAccuracy * 100).toFixed(1) + '%',
            threshold: (this.config.accuracy_threshold_for_benchmark * 100) + '%'
        });

        if (windowAccuracy >= this.config.accuracy_threshold_for_benchmark) {
            // === PAUSE TRAINING TIME - ENTERING BENCHMARK MODE ===
            const benchmarkStartTime = Date.now();

            // Accumulate training time up to this point
            if (this.stats.last_training_timestamp) {
                this.stats.training_time_ms += benchmarkStartTime - this.stats.last_training_timestamp;
            }

            // Mark as benchmarking (this pauses training time tracking)
            this.stats.is_benchmarking = true;
            this.stats.current_benchmark_start = benchmarkStartTime;

            // Estimate benchmark time based on previous benchmarks
            const avgBenchmarkTime = this.stats.benchmarks_generated > 0
                ? Math.round(this.stats.benchmark_time_ms / this.stats.benchmarks_generated)
                : 3 * 60 * 1000; // Default: 3 minutes

            // Calculate updated completion time
            const trainingLimitMs = this.config.duration_minutes ? this.config.duration_minutes * 60 * 1000 : null;
            const trainingTimeRemaining = trainingLimitMs ? Math.max(0, trainingLimitMs - this.stats.training_time_ms) : null;
            const estimatedCompletion = trainingTimeRemaining !== null
                ? new Date(benchmarkStartTime + avgBenchmarkTime + trainingTimeRemaining).toISOString()
                : null;

            logger.info('📊 OGGY ENTERING BENCHMARK MODE', {
                accuracy: (windowAccuracy * 100).toFixed(1) + '%',
                training_time_so_far: this._formatDuration(this.stats.training_time_ms),
                training_time_remaining: trainingTimeRemaining !== null ? this._formatDuration(trainingTimeRemaining) : 'unlimited',
                estimated_benchmark_duration: this._formatDuration(avgBenchmarkTime),
                estimated_completion: estimatedCompletion,
                benchmark_count: this.stats.benchmarks_generated + 1,
                note: 'Benchmark time does NOT count against training time limit'
            });

            // Pause training during benchmark
            selfDrivenLearning.stop();

            try {
                // Pre-benchmark health check - ensure memory service is available
                const ready = await serviceHealthManager.ensureReadyForBenchmark();
                if (!ready.memoryService) {
                    logger.warn('Memory service unhealthy before benchmark - resetting circuit breakers', {
                        memoryStatus: ready.memoryService,
                        openBreakers: ready.openCircuitBreakers
                    });
                    await serviceHealthManager.resetHealthyCircuitBreakers();
                }

                // Capture current generation before async benchmark
                const benchmarkGeneration = this.currentGeneration;

                // Generate a new benchmark at current difficulty
                const benchmarkResult = await this._generateAndRunBenchmark();

                // Check if we're still the current session before updating stats
                if (this.currentGeneration !== benchmarkGeneration) {
                    logger.info('Session changed during benchmark - discarding results');
                    return;  // Don't affect the new session's stats
                }

                this.stats.benchmark_results.push(benchmarkResult);
                this.stats.benchmarks_generated++;

                // Check if both models scored >= 80% (threshold for upgrade)
                if (benchmarkResult.oggy_accuracy >= this.config.both_models_threshold_for_upgrade &&
                    benchmarkResult.base_accuracy >= this.config.both_models_threshold_for_upgrade) {

                    logger.info('Both models exceeded 80% threshold - advancing difficulty', {
                        oggy: (benchmarkResult.oggy_accuracy * 100).toFixed(1) + '%',
                        base: (benchmarkResult.base_accuracy * 100).toFixed(1) + '%',
                        current_scale: this.stats.current_scale,
                        current_level: this.stats.difficulty_level
                    });

                    await this._advanceDifficulty();
                }

                // Count as passed if Oggy beats or matches base
                if (benchmarkResult.oggy_accuracy >= benchmarkResult.base_accuracy) {
                    this.stats.benchmarks_passed++;
                }

            } catch (error) {
                logger.error('Benchmark generation/run failed', { error: error.message });
            }

            // === RESUME TRAINING TIME - EXITING BENCHMARK MODE ===
            const benchmarkEndTime = Date.now();
            const benchmarkDuration = benchmarkEndTime - this.stats.current_benchmark_start;

            // Add this benchmark's time to total benchmark time
            this.stats.benchmark_time_ms += benchmarkDuration;
            this.stats.is_benchmarking = false;
            this.stats.current_benchmark_start = null;
            this.stats.last_training_timestamp = benchmarkEndTime; // Reset training timestamp

            logger.info('📊 OGGY EXITING BENCHMARK MODE - RESUMING TRAINING', {
                benchmark_duration: this._formatDuration(benchmarkDuration),
                total_benchmark_time: this._formatDuration(this.stats.benchmark_time_ms),
                training_time_so_far: this._formatDuration(this.stats.training_time_ms),
                benchmarks_completed: this.stats.benchmarks_generated
            });

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
        const scale = this.stats.current_scale;
        const level = this.stats.difficulty_level;
        const difficultyConfig = this.getDifficultyConfig(scale, level);
        const benchmarkName = `auto_benchmark_S${scale}L${level}_${Date.now()}`;

        logger.info('Generating new benchmark', {
            name: benchmarkName,
            scale: scale,
            level: level,
            scale_name: difficultyConfig.scale_name,
            difficulty: difficultyConfig.description,
            complexity_factors: difficultyConfig.complexity_factors,
            scenario_count: this.config.benchmark_scenario_count
        });

        // Generate benchmark using Claude (Anthropic) for out-of-distribution scenarios
        // This prevents overfitting to Tessa's GPT-4o-mini generation patterns
        const generationResult = await sealedBenchmarkGenerator.createSealedBenchmark({
            name: benchmarkName,
            description: `Auto-generated benchmark at S${scale} L${level} (${difficultyConfig.scale_name})`,
            count: this.config.benchmark_scenario_count,
            difficulty_mix: difficultyConfig.effective_mix,
            use_ood: true,  // Use Claude for truly independent OOD test sets
            // Pass scale-specific complexity requirements
            scale: scale,
            level: level,
            complexity_factors: difficultyConfig.complexity_factors,
            require_context: difficultyConfig.require_context,
            require_reasoning: difficultyConfig.require_reasoning,
            multi_step: difficultyConfig.multi_step
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

        // Learn from Oggy's mistakes on this benchmark
        let mistakes_learned = 0;
        if (testResult.oggy.wrong_scenarios && testResult.oggy.wrong_scenarios.length > 0) {
            const learningResult = await this._learnFromBenchmarkMistakes(testResult.oggy.wrong_scenarios);
            mistakes_learned = learningResult.learned;
        }

        const result = {
            benchmark_name: benchmarkName,
            benchmark_id: generationResult.benchmark_id,
            scale: scale,
            difficulty_level: level,
            scale_level_display: `S${scale} L${level}`,
            scale_name: difficultyConfig.scale_name,
            difficulty_description: difficultyConfig.description,
            complexity_factors: difficultyConfig.complexity_factors,
            scenario_count: this.config.benchmark_scenario_count,
            oggy_accuracy: testResult.oggy.accuracy,
            base_accuracy: testResult.base.accuracy,
            advantage: testResult.comparison.advantage_percent,
            oggy_passed: testResult.oggy.accuracy >= testResult.base.accuracy,
            mistakes_learned: mistakes_learned,
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
     * Validate that the reasoning supports the correct category
     * Returns true if reasoning is consistent, false if contradictory
     */
    _isReasoningConsistent(reasoning, correctCategory, wrongPrediction) {
        if (!reasoning) return true; // No reasoning to validate

        const reasoningLower = reasoning.toLowerCase();

        // Phrases that indicate what category "should" be or "wins"
        const supportsPhrases = [
            `${correctCategory} is correct`,
            `${correctCategory} takes precedence`,
            `categorized as ${correctCategory}`,
            `${correctCategory} wins`,
            `should be ${correctCategory}`,
            `correctly categorized as ${correctCategory}`,
            `this is a ${correctCategory} expense`,
            `primary purpose.*${correctCategory}`
        ];

        // Check if reasoning actually supports the WRONG category instead
        const contradictsCorrect = [
            `${wrongPrediction} takes precedence`,
            `${wrongPrediction} is correct`,
            `should be ${wrongPrediction}`,
            `categorized as ${wrongPrediction}`,
            `${wrongPrediction} wins`,
            `this is a ${wrongPrediction} expense`,
            `primary purpose.*${wrongPrediction}`
        ];

        // If reasoning explicitly supports the wrong prediction, it's contradictory
        for (const phrase of contradictsCorrect) {
            const regex = new RegExp(phrase.replace('.*', '.*'), 'i');
            if (regex.test(reasoningLower)) {
                return false; // Reasoning contradicts the correct category
            }
        }

        return true; // No contradiction detected
    }

    /**
     * Learn from benchmark mistakes
     * Creates memory cards encoding the corrections so Oggy improves
     */
    async _learnFromBenchmarkMistakes(wrongScenarios) {
        if (!wrongScenarios || wrongScenarios.length === 0) {
            logger.info('No benchmark mistakes to learn from');
            return { learned: 0 };
        }

        logger.info('📚 LEARNING FROM BENCHMARK MISTAKES', {
            mistake_count: wrongScenarios.length
        });

        let learned = 0;
        let skippedContradictory = 0;

        for (const mistake of wrongScenarios) {
            try {
                // Validate reasoning consistency before learning
                const isConsistent = this._isReasoningConsistent(
                    mistake.reasoning,
                    mistake.correct_category,
                    mistake.predicted_category
                );

                if (!isConsistent) {
                    logger.warn('⚠️ Skipping contradictory correction', {
                        merchant: mistake.merchant,
                        stated_correct: mistake.correct_category,
                        reasoning_suggests: mistake.predicted_category,
                        reasoning: mistake.reasoning?.substring(0, 100)
                    });
                    skippedContradictory++;
                    continue; // Don't learn from contradictory corrections
                }
                // Create a correction memory card with type for proper formatting
                const cardContent = {
                    type: 'BENCHMARK_CORRECTION',  // Used by oggyCategorizer._formatMemoryCard
                    text: `CORRECTION: "${mistake.merchant}" with "${mistake.description}" is "${mistake.correct_category}" NOT "${mistake.predicted_category}". ${mistake.reasoning || ''}`,
                    description: mistake.description,
                    merchant: mistake.merchant,
                    correct_category: mistake.correct_category,
                    wrong_prediction: mistake.predicted_category,
                    key_distinction: mistake.reasoning || '',
                    correction: {
                        merchant: mistake.merchant,
                        description: mistake.description,
                        wrong_prediction: mistake.predicted_category,
                        correct_category: mistake.correct_category,
                        amount: mistake.amount
                    },
                    evidence: {
                        source: 'benchmark_mistake_correction',
                        confidence: 'high',
                        learning_mode: 'benchmark_driven'
                    }
                };

                await axios.post(
                    `${MEMORY_SERVICE_URL}/cards`,
                    {
                        owner_type: 'user',
                        owner_id: this.userId,
                        tier: 1, // Long-term memory for corrections
                        kind: 'expense_category_correction',
                        content: cardContent,
                        tags: [
                            'payments',
                            'categorization',  // CRITICAL: Must include this for retrieval during categorization
                            'correction',
                            'benchmark_learned',
                            mistake.correct_category,
                            `not_${mistake.predicted_category}`,
                            mistake.merchant.toLowerCase().replace(/\s+/g, '_')
                        ],
                        utility_weight: 0.9, // High weight for corrections
                        reliability: 0.95
                    },
                    {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    }
                );

                learned++;

                logger.info('Created correction memory from benchmark mistake', {
                    merchant: mistake.merchant,
                    wrong: mistake.predicted_category,
                    correct: mistake.correct_category
                });
            } catch (error) {
                logger.warn('Failed to create correction memory', {
                    merchant: mistake.merchant,
                    error: error.message
                });
            }
        }

        logger.info('📚 BENCHMARK LEARNING COMPLETE', {
            mistakes_processed: wrongScenarios.length,
            memories_created: learned,
            skipped_contradictory: skippedContradictory
        });

        return { learned, skipped: skippedContradictory };
    }

    /**
     * Advance difficulty level with scale system
     * At level 5, advance to next scale at level 3
     */
    async _advanceDifficulty() {
        const oldScale = this.stats.current_scale;
        const oldLevel = this.stats.difficulty_level;

        if (this.stats.difficulty_level < this.config.max_difficulty_level) {
            // Advance within current scale
            this.stats.difficulty_level++;
        } else if (this.stats.current_scale < this.config.max_scale) {
            // At level 5, advance to next scale at level 3
            this.stats.current_scale++;
            this.stats.difficulty_level = 3;  // Start new scale at level 3

            logger.info('🎉 SCALE ADVANCEMENT! Moving to next scale', {
                old_scale: oldScale,
                new_scale: this.stats.current_scale,
                new_level: this.stats.difficulty_level,
                user_id: this.userId
            });
        } else {
            logger.info('Already at maximum scale and difficulty level (S10 L5)');
            return;
        }

        // Update difficulty description
        const difficultyConfig = this.getDifficultyConfig(this.stats.current_scale, this.stats.difficulty_level);
        this.stats.current_difficulty = difficultyConfig.description;

        // Persist to database
        await this._saveScaleAndLevel(this.userId, this.stats.current_scale, this.stats.difficulty_level);

        logger.info('Difficulty advanced and saved', {
            old_scale: oldScale,
            old_level: oldLevel,
            new_scale: this.stats.current_scale,
            new_level: this.stats.difficulty_level,
            new_description: this.stats.current_difficulty,
            scale_name: difficultyConfig.scale_name,
            user_id: this.userId
        });
    }

    /**
     * 🧠 OGGY DECISION MAKER
     * Analyzes current performance and decides whether to extend training
     * Returns: { extend: boolean, reason: string, weaknesses: array }
     */
    async _makeExtensionDecision() {
        // Check if extensions are allowed
        if (!this.config.allow_extension) {
            return { extend: false, reason: 'Extensions disabled', weaknesses: [] };
        }

        // Check if we've used max extensions
        if (this.decisionState.extensions_used >= this.config.max_extensions) {
            return { extend: false, reason: 'Maximum extensions reached', weaknesses: [] };
        }

        // TIME LIMIT CHECK - use TRAINING TIME (not total elapsed) against the limit
        // This ensures benchmark time doesn't count against the training time limit
        const trainingTimeMs = this.stats.training_time_ms;
        const maxTrainingTimeMs = this.config.duration_minutes * 60 * 1000;
        if (trainingTimeMs >= maxTrainingTimeMs) {
            logger.warn('🛑 TRAINING TIME LIMIT REACHED - cannot extend beyond original duration', {
                training_time_minutes: (trainingTimeMs / 60000).toFixed(1),
                duration_minutes: this.config.duration_minutes,
                benchmark_time_minutes: (this.stats.benchmark_time_ms / 60000).toFixed(1),
                total_session_minutes: ((Date.now() - this.stats.session_start) / 60000).toFixed(1),
                extensions_used: this.decisionState.extensions_used
            });
            return { extend: false, reason: `Training time limit of ${this.config.duration_minutes} minutes reached`, weaknesses: [] };
        }

        // Analyze benchmark results to identify weaknesses
        const analysis = this._analyzePerformance();

        // Decision criteria:
        // 1. If no benchmarks yet, extend to get at least one
        // 2. If Oggy has negative advantage, extend to improve
        // 3. If there are category weaknesses, extend to address them
        // 4. If training accuracy is below threshold, extend

        let shouldExtend = false;
        let reasons = [];

        // Criterion 1: Need at least one benchmark
        if (this.stats.benchmarks_generated === 0) {
            shouldExtend = true;
            reasons.push('No benchmarks completed yet - need evaluation data');
        }

        // Criterion 2: Oggy underperforming vs Base
        if (analysis.avg_advantage < 0) {
            shouldExtend = true;
            reasons.push(`Oggy underperforming Base by ${Math.abs(analysis.avg_advantage).toFixed(1)}%`);
        }

        // Criterion 3: Category-specific weaknesses
        if (analysis.weaknesses.length > 0) {
            shouldExtend = true;
            reasons.push(`Weaknesses in: ${analysis.weaknesses.join(', ')}`);
        }

        // Criterion 4: Recent benchmark performance below target
        if (analysis.recent_accuracy < this.config.weakness_threshold) {
            shouldExtend = true;
            reasons.push(`Recent accuracy ${(analysis.recent_accuracy * 100).toFixed(1)}% below ${(this.config.weakness_threshold * 100)}% target`);
        }

        // If Oggy is doing well, no need to extend
        if (analysis.avg_advantage >= this.config.advantage_target && analysis.weaknesses.length === 0) {
            return {
                extend: false,
                reason: `Target achieved: ${analysis.avg_advantage.toFixed(1)}% advantage, no weaknesses`,
                weaknesses: []
            };
        }

        // Store weaknesses for targeted training
        this.decisionState.weaknesses_identified = analysis.weaknesses;

        return {
            extend: shouldExtend,
            reason: reasons.join('; ') || 'Training complete - targets met',
            weaknesses: analysis.weaknesses,
            analysis: analysis
        };
    }

    /**
     * Analyze performance across all benchmarks
     */
    _analyzePerformance() {
        const results = this.stats.benchmark_results;

        if (results.length === 0) {
            return {
                avg_oggy: 0,
                avg_base: 0,
                avg_advantage: 0,
                weaknesses: [],
                recent_accuracy: 0,
                trends: []
            };
        }

        // Calculate averages
        const totalOggy = results.reduce((sum, r) => sum + r.oggy_accuracy, 0);
        const totalBase = results.reduce((sum, r) => sum + r.base_accuracy, 0);
        const avgOggy = totalOggy / results.length;
        const avgBase = totalBase / results.length;
        const avgAdvantage = results.reduce((sum, r) => sum + r.advantage, 0) / results.length;

        // Recent performance (last benchmark)
        const recentResult = results[results.length - 1];
        const recentAccuracy = recentResult.oggy_accuracy;

        // Identify weaknesses based on where Oggy underperformed
        const weaknesses = [];

        // Check if Oggy lost to Base in recent benchmarks
        const recentLosses = results.slice(-3).filter(r => r.oggy_accuracy < r.base_accuracy);
        if (recentLosses.length >= 2) {
            weaknesses.push('consistency (lost to Base multiple times)');
        }

        // Check for declining performance
        if (results.length >= 2) {
            const lastTwo = results.slice(-2);
            if (lastTwo[1].oggy_accuracy < lastTwo[0].oggy_accuracy - 0.05) {
                weaknesses.push('declining accuracy trend');
            }
        }

        // Check for low absolute accuracy
        if (recentAccuracy < 0.70) {
            weaknesses.push('low overall accuracy');
        }

        // Check for validation issues (indicates labeling problems)
        const avgValidationIssues = results.reduce((sum, r) => sum + (r.validation_issues_found || 0), 0) / results.length;
        if (avgValidationIssues > 10) {
            weaknesses.push('high validation issues (ambiguous scenarios)');
        }

        return {
            avg_oggy: avgOggy,
            avg_base: avgBase,
            avg_advantage: avgAdvantage,
            weaknesses: weaknesses,
            recent_accuracy: recentAccuracy,
            benchmark_count: results.length,
            recent_advantage: recentResult.advantage
        };
    }

    /**
     * Load scale and level from database or use provided values
     * Also saves the initial state to ensure persistence
     */
    async _loadScaleAndLevel(userId, startingScale, startingLevel) {
        let scale = startingScale;
        let level = startingLevel;
        let loadedFromDb = false;

        // If not explicitly provided, try to load from database
        if (scale === null || level === null) {
            try {
                const result = await query(`
                    SELECT scale, difficulty_level FROM continuous_learning_state
                    WHERE user_id = $1
                `, [userId]);

                if (result.rows.length > 0) {
                    if (scale === null) scale = result.rows[0].scale;
                    if (level === null) level = result.rows[0].difficulty_level;
                    loadedFromDb = true;

                    logger.info('Loaded scale and level from database', {
                        user_id: userId,
                        scale: scale,
                        difficulty_level: level
                    });
                }
            } catch (error) {
                // Table might not exist yet or missing column, that's OK
                logger.debug('Could not load scale/level', { error: error.message });
            }
        }

        // Ensure valid ranges with defaults
        scale = Math.max(1, Math.min(this.config.max_scale, scale || 1));
        level = Math.max(1, Math.min(5, level || 3));

        // Always save the initial state to ensure it's persisted
        // This handles cases where the row doesn't exist or explicit starting values were provided
        if (!loadedFromDb || startingScale !== null || startingLevel !== null) {
            await this._saveScaleAndLevel(userId, scale, level);
            logger.info('Saved initial scale and level', {
                user_id: userId,
                scale: scale,
                difficulty_level: level,
                explicit_start: startingScale !== null || startingLevel !== null
            });
        }

        return { scale, level };
    }

    /**
     * Save scale and level to database
     */
    async _saveScaleAndLevel(userId, scale, level) {
        try {
            // Upsert the scale and level
            await query(`
                INSERT INTO continuous_learning_state (user_id, scale, difficulty_level, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_id)
                DO UPDATE SET scale = $2, difficulty_level = $3, updated_at = NOW()
            `, [userId, scale, level]);

            logger.debug('Saved scale and level to database', {
                user_id: userId,
                scale: scale,
                difficulty_level: level
            });
        } catch (error) {
            // If table doesn't exist or missing column, create/update it
            if (error.message.includes('does not exist') || error.message.includes('column')) {
                await this._createStateTable();
                await this._saveScaleAndLevel(userId, scale, level);
            } else {
                logger.warn('Could not save scale/level', { error: error.message });
            }
        }
    }

    /**
     * Create or update the state table with scale support
     */
    async _createStateTable() {
        try {
            // Create table with scale column
            await query(`
                CREATE TABLE IF NOT EXISTS continuous_learning_state (
                    user_id VARCHAR(255) PRIMARY KEY,
                    scale INTEGER DEFAULT 1,
                    difficulty_level INTEGER DEFAULT 3,
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // Add scale column if it doesn't exist (for existing tables)
            try {
                await query(`
                    ALTER TABLE continuous_learning_state
                    ADD COLUMN IF NOT EXISTS scale INTEGER DEFAULT 1
                `);
            } catch (alterError) {
                // Column might already exist, that's OK
            }

            logger.info('Created/updated continuous_learning_state table with scale support');
        } catch (error) {
            logger.warn('Could not create state table', { error: error.message });
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