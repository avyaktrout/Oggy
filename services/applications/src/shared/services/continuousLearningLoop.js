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

const benchmarkValidator = require('./benchmarkValidator');
const sessionCleanupManager = require('./sessionCleanupManager');
const serviceHealthManager = require('./serviceHealthManager');
const categoryRulesManager = require('../../domains/payments/services/categoryRulesManager');
const tessaAssessmentGenerator = require('../../domains/payments/services/tessaAssessmentGenerator');
const adaptiveDifficultyScaler = require('./adaptiveDifficultyScaler'); // { getInstance }
const intentService = require('./intentService');
const { registerDomain, getDomainAdapter } = require('../DomainAdapter');

// Register domain adapters (lazy-loaded via factories to avoid circular deps)
registerDomain('payments', () => {
    const sdl = require('../../domains/payments/services/selfDrivenLearning');
    const gen = require('../../domains/payments/services/sealedBenchmarkGenerator');
    const evl = require('../../domains/payments/services/sealedBenchmarkEvaluator');
    return {
        getSdl: (userId) => sdl.getInstance(userId),
        createBenchmark: (opts) => gen.createSealedBenchmark(opts),
        getBenchmark: (name) => gen.getSealedBenchmark(name),
        runBenchmark: (opts) => evl.testOnSealedBenchmark(opts),
        scaleComplexity: {
            1: { name: 'Foundation', complexity_factors: ['single_category', 'clear_merchants', 'standard_amounts'] },
            2: { name: 'Intermediate', complexity_factors: ['category_overlap', 'context_dependent', 'amount_edge_cases', 'time_sensitivity'] },
            3: { name: 'Advanced', complexity_factors: ['multi_category_transactions', 'subscription_variations', 'business_personal_blur', 'international_payments'] },
            4: { name: 'Expert', complexity_factors: ['tax_implications', 'regulatory_nuances', 'fraud_adjacent', 'unusual_merchant_types'] },
            5: { name: 'Master', complexity_factors: ['multi_valid_categories', 'temporal_context', 'user_intent_inference', 'chained_transactions'] }
        },
        postBenchmarkProcess: async (benchmark, testResult, userId, helpers) => {
            let mistakes_learned = 0;
            const validationIssues = [];

            const reasoningFix = benchmarkValidator.applyReasoningAutoFix(benchmark.scenarios);
            if (reasoningFix.fixedCount > 0) {
                await helpers.updateScenarios(benchmark.benchmark_id, reasoningFix.scenarios);
                benchmark.scenarios = reasoningFix.scenarios;
            }
            for (const scenario of benchmark.scenarios) {
                const quickCheck = benchmarkValidator.quickValidate(scenario);
                if (quickCheck.has_flags) validationIssues.push({ scenario_id: scenario.scenario_id, flags: quickCheck.flags });
            }
            if (validationIssues.length > 0) {
                const flaggedIds = new Set(validationIssues.map(v => v.scenario_id));
                const flaggedScenarios = benchmark.scenarios.filter(s => flaggedIds.has(s.scenario_id));
                const validated = await benchmarkValidator.validateAndFixScenarios(flaggedScenarios);
                const corrected = validated.filter(s => s.auto_corrected);
                if (corrected.length > 0) await helpers.updateScenarios(benchmark.benchmark_id, corrected);
            }
            if (testResult.oggy.wrong_scenarios && testResult.oggy.wrong_scenarios.length > 0) {
                const learningResult = await helpers.learnFromMistakes(testResult.oggy.wrong_scenarios);
                mistakes_learned = learningResult.learned;
                if (learningResult.confusion_summary) {
                    helpers.applyConfusionTraining(learningResult.confusion_summary);
                    await helpers.generateConfusionBatch(learningResult.confusion_summary);
                }
            }
            return { mistakes_learned, validation_issues_found: validationIssues.length };
        }
    };
});

registerDomain('diet', () => {
    const sdl = require('../../domains/diet/services/dietSelfDrivenLearning');
    const gen = require('../../domains/diet/services/dietBenchmarkGenerator');
    const evl = require('../../domains/diet/services/dietBenchmarkEvaluator');
    return {
        getSdl: (userId) => sdl.getInstance(userId),
        createBenchmark: (opts) => gen.createDietBenchmark(opts),
        getBenchmark: (name) => gen.getDietBenchmark(name),
        runBenchmark: (opts) => evl.testOnDietBenchmark(opts),
        scaleComplexity: {
            1: { name: 'Foundation', complexity_factors: ['single_ingredient', 'standard_portions', 'common_foods'] },
            2: { name: 'Intermediate', complexity_factors: ['branded_products', 'serving_size_variations', 'common_drinks'] },
            3: { name: 'Advanced', complexity_factors: ['combination_meals', 'restaurant_dishes', 'mixed_ingredients'] },
            4: { name: 'Expert', complexity_factors: ['cooking_method_impact', 'regional_variations', 'hidden_ingredients'] },
            5: { name: 'Master', complexity_factors: ['vague_descriptions', 'portion_ambiguity', 'preparation_unknowns'] }
        }
    };
});

registerDomain('general', () => {
    const sdl = require('../../domains/general/services/conversationSelfDrivenLearning');
    const gen = require('../../domains/general/services/conversationBenchmarkGenerator');
    const evl = require('../../domains/general/services/conversationBenchmarkEvaluator');
    return {
        getSdl: (userId) => sdl.getInstance(userId),
        createBenchmark: (opts) => { const inst = gen.getInstance(opts.userId); return inst.createConversationBenchmark(opts); },
        getBenchmark: (name, userId) => { const inst = gen.getInstance(userId); return inst.getConversationBenchmark(name); },
        runBenchmark: (opts) => { const inst = evl.getInstance(opts.user_id); return inst.testOnConversationBenchmark(opts); },
        scaleComplexity: {
            1: { name: 'Foundation', complexity_factors: ['direct_recall', 'explicit_preferences', 'simple_instructions'] },
            2: { name: 'Intermediate', complexity_factors: ['conversation_continuity', 'preference_application', 'context_switching'] },
            3: { name: 'Advanced', complexity_factors: ['implicit_preferences', 'subtle_references', 'tone_matching'] },
            4: { name: 'Expert', complexity_factors: ['conflicting_instructions', 'nuanced_preferences', 'multi_source_context'] },
            5: { name: 'Master', complexity_factors: ['user_intent_inference', 'preference_conflicts', 'unstated_expectations'] }
        }
    };
});

registerDomain('harmony', () => {
    const sdl = require('../../domains/harmony/services/harmonySelfDrivenLearning');
    const gen = require('../../domains/harmony/services/harmonyBenchmarkGenerator');
    const evl = require('../../domains/harmony/services/harmonyBenchmarkEvaluator');
    const harmonySuggestionService = require('../../domains/harmony/services/harmonySuggestionService');
    return {
        getSdl: (userId) => sdl.getInstance(userId),
        createBenchmark: (opts) => gen.createBenchmark(opts),
        getBenchmark: (name, userId) => gen.getBenchmark(name, userId),
        runBenchmark: (opts) => evl.testOnBenchmark(opts),
        scaleComplexity: {
            1: { name: 'Foundation', complexity_factors: ['indicator_classification', 'basic_formulas'] },
            2: { name: 'Intermediate', complexity_factors: ['score_prediction', 'weight_reasoning', 'data_quality'] },
            3: { name: 'Advanced', complexity_factors: ['cross_city_comparison', 'model_critique', 'indicator_gaps'] },
            4: { name: 'Expert', complexity_factors: ['policy_simulation', 'multi_dimension_impact', 'temporal_analysis'] },
            5: { name: 'Master', complexity_factors: ['model_redesign', 'novel_indicators', 'cross_domain_synthesis'] }
        },
        postBenchmarkProcess: async (benchmark, testResult, userId, helpers) => {
            // Generate 10 suggestions per benchmark cycle
            let suggestionsGenerated = 0;
            try {
                const result = await harmonySuggestionService.generateOnDemand(userId, 10, 'all');
                suggestionsGenerated = Array.isArray(result) ? result.length : 0;
            } catch (err) {
                // Non-critical
            }
            return { mistakes_learned: 0, validation_issues_found: 0, suggestions_generated: suggestionsGenerated };
        }
    };
});
const logger = require('../utils/logger');
const correctionValidator = require('../utils/correctionValidator');
const { getReporter } = require('./trainingReporter');
const { recordBenchmarkMetrics } = require('../utils/telemetry');
const { parallelMap } = require('../utils/parallel');
const { query } = require('../utils/db');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

class ContinuousLearningLoop {
    constructor() {
        this.isRunning = false;
        this.userId = null;
        this.domain = 'payments';  // Training domain: 'payments', 'diet', 'general'
        this.sessionGeneration = 0;  // Prevents old async loops from affecting new sessions
        this.stats = {
            total_questions: 0,
            correct_answers: 0,
            current_window_questions: 0,
            current_window_correct: 0,
            benchmarks_generated: 0,
            benchmarks_passed: 0,
            benchmark_underperform_streak: 0,
            current_scale: 1,        // S1, S2, S3... (higher = more complex)
            difficulty_level: 1,      // 1-5 within each scale
            current_difficulty: 'S1 L1 - Easy',
            session_start: null,
            session_duration_ms: 0,
            benchmark_results: [],
            // Separate time tracking: training time vs benchmark time vs maintenance time
            training_time_ms: 0,           // Actual time spent training (counts against limit)
            benchmark_time_ms: 0,          // Total time spent on benchmarks (does NOT count against limit)
            maintenance_time_ms: 0,        // Rate limit cooldown time (does NOT count against limit)
            is_benchmarking: false,        // Flag indicating benchmark in progress
            current_benchmark_start: null, // When current benchmark started
            last_training_timestamp: null  // Last time we were actively training
        };

        // Configuration
        this.config = {
            questions_per_benchmark: 20,              // Training questions before benchmark check
            optional_benchmark_questions: 20,         // Soft threshold to consider benchmark
            hard_benchmark_questions: 35,             // Hard cap to force benchmark if accuracy meets threshold
            accuracy_threshold_for_benchmark: 0.80,   // 80% accuracy on training to trigger benchmark
            both_models_threshold_for_upgrade: 0.90,  // 90% accuracy on benchmark to advance level
            benchmark_scenario_count: 40,             // Questions per benchmark
            training_interval_ms: 10000,              // 10s between sessions (overlap guard prevents pile-up)
            practice_count_per_session: 3,             // 3 exercises per session (~9 API calls/session)
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
            original_stop_time: null,
            optional_benchmark_declined: false
        };

        // Base difficulty progression (within each scale)
        this.baseDifficultySettings = {
            1: { mix: 'easy', description: 'Easy - clear scenarios' },
            2: { mix: 'balanced', description: 'Balanced - mixed difficulty' },
            3: { mix: 'mixed', description: 'Mixed - emphasis on hard cases' },
            4: { mix: 'hard', description: 'Hard - challenging distinctions' },
            5: { mix: 'hard', description: 'Expert - edge cases and ambiguity', extra_hard: true }
        };

        // Scale complexity maps are now in domain adapters (see DomainAdapter.js)
    }

    /**
     * Get difficulty settings for current scale and level
     */
    getDifficultyConfig(scale, level) {
        const baseConfig = this.baseDifficultySettings[level];
        const adapter = getDomainAdapter(this.domain);
        const complexityMap = adapter.scaleComplexity;
        const scaleConfig = complexityMap[Math.min(scale, 5)] || complexityMap[5];

        return {
            ...baseConfig,
            scale: scale,
            level: level,
            scale_name: scaleConfig.name,
            complexity_factors: scaleConfig.complexity_factors,
            description: `S${scale} L${level} - ${scaleConfig.name}: ${baseConfig.description}`,
            effective_mix: scale >= 3 ? 'hard' : baseConfig.mix,
            require_context: scale >= 2,
            require_reasoning: scale >= 3,
            multi_step: scale >= 4
        };
    }

    /** Get per-user selfDrivenLearning instance (domain-aware) */
    _getSdl() {
        return getDomainAdapter(this.domain).getSdl(this.userId);
    }
    /** Get per-user adaptiveDifficultyScaler instance */
    _getAds() { return adaptiveDifficultyScaler.getInstance(this.userId); }

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
            questions_per_benchmark = 20,             // Training questions before benchmark
            optional_benchmark_questions = 20,        // Soft threshold for optional benchmark
            hard_benchmark_questions = 35,            // Hard cap for forced benchmark
            accuracy_threshold = 0.80,                // 80% on training to trigger benchmark
            benchmark_scenario_count = 40,            // Questions per benchmark
            upgrade_threshold = 0.90,                 // 90% on benchmark to advance level
            training_interval_ms = 10000,
            practice_count = 3,
            starting_difficulty = null,  // null = load from DB, or use specified level
            starting_scale = null,       // null = load from DB, or use specified scale
            domain = 'payments',         // Training domain: 'payments', 'diet', 'general'
            target_intents = null,       // Optional intent names to focus training on
            intent_focus = null          // Optional focus levels: { intent_name: 'low'|'medium'|'high' }
        } = options;

        // Increment session generation - any old async loops will see this and stop
        const myGeneration = ++this.sessionGeneration;

        this.userId = userId;
        this.domain = domain;
        this.isRunning = true;
        this.currentGeneration = myGeneration;  // Store for this session
        this.config.questions_per_benchmark = questions_per_benchmark;
        this.config.optional_benchmark_questions = optional_benchmark_questions;
        this.config.hard_benchmark_questions = hard_benchmark_questions;
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
            benchmark_underperform_streak: 0,
            current_scale: scale,
            difficulty_level: level,
            current_difficulty: difficultyConfig.description,
            session_start: now,
            session_duration_ms: 0,
            benchmark_results: [],
            // Separate time tracking
            training_time_ms: 0,
            benchmark_time_ms: 0,
            maintenance_time_ms: 0,        // Rate limit cooldown, health checks, etc.
            is_benchmarking: false,
            current_benchmark_start: null,
            last_training_timestamp: now  // Start tracking training time from now
        };

        // Wait for rate limits to clear before training begins
        // This prevents stale 429s from a previous session from poisoning accuracy
        logger.info('Checking rate limit status before training...');
        const maintenanceStart = Date.now();
        const evaluator = require('../../domains/payments/services/sealedBenchmarkEvaluator');
        const cooldownMs = await evaluator._waitForRateLimitCooldown(120000);
        if (cooldownMs > 1000) {
            this.stats.maintenance_time_ms += cooldownMs;
            // Reset training timestamp to after cooldown (don't count cooldown as training)
            this.stats.last_training_timestamp = Date.now();
            logger.info('Pre-training rate limit cooldown completed', {
                cooldown_ms: cooldownMs,
                maintenance_time_ms: this.stats.maintenance_time_ms
            });
        }

        // If target_intents specified, resolve to focus areas for targeted training
        if (target_intents && target_intents.length > 0) {
            try {
                if (domain === 'payments') {
                    // Payments: resolve intents to focus categories for SDL
                    const focusCategories = await intentService.resolveIntentsToFocusCategories(target_intents);
                    if (focusCategories.length > 0) {
                        const adapter = getDomainAdapter(domain);
                        const sdl = adapter.getSdl(userId);
                        const weightMap = {};
                        focusCategories.forEach(cat => { weightMap[cat] = 1 / focusCategories.length; });
                        sdl.setTargetedLearning(weightMap, focusCategories, [], { confusionTargetRate: 0.9 });
                        logger.info('Intent-targeted training enabled (payments)', { target_intents, focusCategories });
                    }
                } else {
                    // Diet/General/Harmony: pass focus intents to SDL if it supports them
                    const adapter = getDomainAdapter(domain);
                    const sdl = adapter.getSdl(userId);
                    if (typeof sdl.setFocusIntents === 'function') {
                        sdl.setFocusIntents(target_intents, intent_focus);
                        logger.info('Intent-targeted training enabled', { domain, target_intents, intent_focus });
                    }
                }
            } catch (intentErr) {
                logger.warn('Intent-to-focus resolution failed (non-blocking)', { error: intentErr.message });
            }
        }
        this.stats.target_intents = target_intents || [];

        logger.info('Starting continuous learning loop', {
            userId,
            duration_minutes,
            questions_per_benchmark,
            accuracy_threshold,
            starting_scale: scale,
            starting_difficulty: level,
            scale_name: difficultyConfig.scale_name,
            complexity_factors: difficultyConfig.complexity_factors,
            maintenance_time_ms: this.stats.maintenance_time_ms,
            target_intents: target_intents || []
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
        this._getSdl().stop();

        // Cleanup session - log completion and clear transient state
        try {
            await sessionCleanupManager.cleanupSession(this.userId, this.getStats());
        } catch (error) {
            logger.warn('Session cleanup failed', { error: error.message });
        }

        // Send final training report email (per-user reporter)
        try {
            const reporter = getReporter(this.userId);
            await reporter.onSessionEnd(this.getStats());
        } catch (error) {
            logger.warn('Final training report failed', { error: error.message });
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
            // Separate training vs benchmark vs maintenance time
            training_time_ms: currentTrainingTime,
            training_time_readable: this._formatDuration(currentTrainingTime),
            benchmark_time_ms: currentBenchmarkTime,
            benchmark_time_readable: this._formatDuration(currentBenchmarkTime),
            maintenance_time_ms: this.stats.maintenance_time_ms,
            maintenance_time_readable: this._formatDuration(this.stats.maintenance_time_ms),
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
            questions_until_next_benchmark: this.config.hard_benchmark_questions - this.stats.current_window_questions,
            is_running: this.isRunning,
            // Scale information
            scale_name: difficultyConfig.scale_name,
            scale_level_display: `S${this.stats.current_scale} L${this.stats.difficulty_level}`,
            complexity_factors: difficultyConfig.complexity_factors,
            upgrade_threshold: (this.config.both_models_threshold_for_upgrade * 100) + '%',
            // Reporter config (so UI can restore after page refresh)
            report_email: this._getReporterConfig()?.email || null,
            report_interval: this._getReporterConfig()?.interval || null,
            // Training domain
            domain: this.domain || 'payments'
        };
    }

    _getReporterConfig() {
        try {
            if (!this.userId) return null;
            const reporter = getReporter(this.userId);
            return reporter.config;
        } catch { return null; }
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
        this._getSdl().start(this.userId, {
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
            const learningStats = this._getSdl().getStats();
            const newQuestions = learningStats.total_attempts - this.stats.total_questions;

            if (newQuestions > 0) {
                // Normalize accuracy: payments returns "85.3%", general returns 0.853
                const accuracyDecimal = this._parseAccuracyToDecimal(learningStats.accuracy);

                const totalCorrectNow = Math.round(accuracyDecimal * learningStats.total_attempts);
                const newCorrect = totalCorrectNow - this.stats.correct_answers;

                this.stats.total_questions = learningStats.total_attempts;
                this.stats.correct_answers = totalCorrectNow;
                this.stats.current_window_questions += newQuestions;
                this.stats.current_window_correct += Math.max(0, isNaN(newCorrect) ? 0 : newCorrect);

                await this._maybeTriggerBenchmark();
            }
        }
    }

    /**
     * Check accuracy and run benchmark if threshold met
     * Benchmark time does NOT count against the training time limit.
     */
    async _checkAndRunBenchmark(options = {}) {
        const { force = false, reason = 'threshold' } = options;
        const windowAccuracy = this.stats.current_window_correct / this.stats.current_window_questions;

        logger.info('Checking benchmark eligibility', {
            window_questions: this.stats.current_window_questions,
            window_accuracy: (windowAccuracy * 100).toFixed(1) + '%',
            threshold: (this.config.accuracy_threshold_for_benchmark * 100) + '%'
        });

        if (force || windowAccuracy >= this.config.accuracy_threshold_for_benchmark) {
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
                trigger_reason: reason,
                forced: force,
                note: 'Benchmark time does NOT count against training time limit'
            });

            // Pause training during benchmark
            this._getSdl().stop();

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

                // Check if Oggy scored >= threshold (upgrade gate)
                if (benchmarkResult.oggy_accuracy >= this.config.both_models_threshold_for_upgrade) {
                    logger.info('Oggy exceeded benchmark threshold - advancing difficulty', {
                        oggy: (benchmarkResult.oggy_accuracy * 100).toFixed(1) + '%',
                        base: (benchmarkResult.base_accuracy * 100).toFixed(1) + '%',
                        current_scale: this.stats.current_scale,
                        current_level: this.stats.difficulty_level
                    });

                    await this._advanceDifficulty();
                    await this._getAds().bumpBaselineScale(this.userId, { reason: 'benchmark' });
                }

                // Count as passed if Oggy beats or matches base
                if (benchmarkResult.oggy_accuracy >= benchmarkResult.base_accuracy) {
                    this.stats.benchmarks_passed++;
                }
                await this._maybeDemoteDifficultyFromBenchmark(benchmarkResult);

                // Send email report if configured for benchmark events (per-user reporter)
                try {
                    const reporter = getReporter(this.userId);
                    await reporter.onBenchmarkComplete(this.getStats(), benchmarkResult);
                } catch (reportErr) {
                    logger.warn('Benchmark report failed', { error: reportErr.message });
                }

                // Record OTEL metrics for this benchmark
                try {
                    recordBenchmarkMetrics({
                        oggy_accuracy: benchmarkResult.oggy_accuracy,
                        base_accuracy: benchmarkResult.base_accuracy,
                        advantage_delta: benchmarkResult.oggy_accuracy - benchmarkResult.base_accuracy,
                        training_state: benchmarkResult.training_state,
                        level: benchmarkResult.scale_level_display || `S${this.stats.current_scale}L${this.stats.difficulty_level}`,
                        difficulty_mix: benchmarkResult.difficulty_mix || 'unknown'
                    });
                } catch (otelErr) {
                    // Non-critical, don't interrupt training
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

            // Resume training — SDL.start() resets its internal stats, so re-sync
            this._getSdl().start(this.userId, {
                interval: this.config.training_interval_ms,
                practiceCount: this.config.practice_count_per_session,
                enabled: true
            });
            this.stats.total_questions = 0;
            this.stats.correct_answers = 0;
        } else {
            logger.info('Accuracy below threshold - continuing training', {
                accuracy: (windowAccuracy * 100).toFixed(1) + '%',
                threshold: (this.config.accuracy_threshold_for_benchmark * 100) + '%',
                trigger_reason: reason,
                forced: force
            });
        }

        // Reset window
        this.stats.current_window_questions = 0;
        this.stats.current_window_correct = 0;
        this.decisionState.optional_benchmark_declined = false;
    }

    async _maybeTriggerBenchmark() {
        const windowQuestions = this.stats.current_window_questions;
        const windowAccuracy = windowQuestions > 0
            ? this.stats.current_window_correct / windowQuestions : 0;
        const threshold = this.config.accuracy_threshold_for_benchmark;

        // Guard against NaN from upstream parsing issues
        if (isNaN(windowAccuracy)) {
            logger.warn('Window accuracy is NaN — resetting window', { windowQuestions, correct: this.stats.current_window_correct });
            this.stats.current_window_questions = 0;
            this.stats.current_window_correct = 0;
            return;
        }

        // Hard cap: force benchmark when accuracy meets threshold
        if (windowQuestions >= this.config.hard_benchmark_questions) {
            if (windowAccuracy >= threshold) {
                await this._checkAndRunBenchmark({ force: true, reason: 'hard_cap' });
                return;
            }

            // Track consecutive resets — force benchmark after 3 resets (105+ questions)
            // so domains with inherently lower training accuracy still get evaluated
            this.stats._hardCapResets = (this.stats._hardCapResets || 0) + 1;
            if (this.stats._hardCapResets >= 3 && this.stats.benchmarks_generated === 0) {
                logger.info('Forcing benchmark after repeated hard cap resets with no benchmarks', {
                    resets: this.stats._hardCapResets,
                    window_accuracy: (windowAccuracy * 100).toFixed(1) + '%'
                });
                await this._checkAndRunBenchmark({ force: true, reason: 'forced_after_resets' });
                this.stats._hardCapResets = 0;
                return;
            }

            logger.info('Hard cap reached but accuracy below threshold - resetting window', {
                window_questions: windowQuestions,
                window_accuracy: (windowAccuracy * 100).toFixed(1) + '%',
                threshold: (threshold * 100) + '%',
                consecutive_resets: this.stats._hardCapResets
            });
            this.stats.current_window_questions = 0;
            this.stats.current_window_correct = 0;
            this.decisionState.optional_benchmark_declined = false;
            return;
        }

        // Soft cap: optional benchmark if accuracy meets threshold
        if (windowQuestions >= this.config.optional_benchmark_questions && windowAccuracy >= threshold) {
            if (this.decisionState.optional_benchmark_declined) {
                return;
            }

            const decision = this._shouldRunOptionalBenchmark(windowAccuracy);
            if (decision.run) {
                await this._checkAndRunBenchmark({ force: false, reason: decision.reason });
            } else {
                this.decisionState.optional_benchmark_declined = true;
                logger.info('Optional benchmark declined - continuing training', {
                    window_questions: windowQuestions,
                    window_accuracy: (windowAccuracy * 100).toFixed(1) + '%',
                    reason: decision.reason
                });
            }
        }
    }

    _shouldRunOptionalBenchmark(windowAccuracy) {
        // Heuristic: run if no benchmarks yet, or if recent performance suggests evaluation is useful
        if (this.stats.benchmarks_generated === 0) {
            return { run: true, reason: 'no_benchmarks_yet' };
        }

        const analysis = this._analyzePerformance();
        if (analysis.avg_advantage < 0) {
            return { run: true, reason: 'negative_advantage' };
        }

        if (analysis.weaknesses.length > 0) {
            return { run: true, reason: 'weaknesses_detected' };
        }

        if (windowAccuracy >= 0.90) {
            return { run: true, reason: 'high_confidence_window' };
        }

        return { run: false, reason: 'training_continues' };
    }

    /**
     * Generate a new benchmark and run Oggy vs Base
     */
    async _generateAndRunBenchmark() {
        const scale = this.stats.current_scale;
        const level = this.stats.difficulty_level;
        const difficultyConfig = this.getDifficultyConfig(scale, level);
        const benchmarkName = `auto_benchmark_S${scale}L${level}_${Date.now()}`;
        const adapter = getDomainAdapter(this.domain);

        logger.info('Generating new benchmark', {
            domain: this.domain,
            name: benchmarkName,
            scale, level,
            scale_name: difficultyConfig.scale_name,
            difficulty: difficultyConfig.description,
            complexity_factors: difficultyConfig.complexity_factors,
            scenario_count: this.config.benchmark_scenario_count
        });

        // Generate benchmark via domain adapter
        const maxCount = this.domain === 'diet' ? 30 : this.domain === 'general' ? 20 : this.config.benchmark_scenario_count;
        const generationResult = await adapter.createBenchmark({
            name: benchmarkName,
            description: `Auto-generated benchmark at S${scale} L${level} (${difficultyConfig.scale_name})`,
            count: Math.min(this.config.benchmark_scenario_count, maxCount),
            difficulty_mix: difficultyConfig.effective_mix,
            use_ood: true,
            scale, level, userId: this.userId,
            complexity_factors: difficultyConfig.complexity_factors,
            require_context: difficultyConfig.require_context,
            require_reasoning: difficultyConfig.require_reasoning,
            multi_step: difficultyConfig.multi_step
        });

        let benchmark = await adapter.getBenchmark(benchmarkName, this.userId);

        // Domain-specific post-generation processing (validation, auto-fix, mistake learning)
        let mistakes_learned = 0;
        let validation_issues_found = 0;

        if (adapter.postBenchmarkProcess) {
            // Run pre-test processing (validation + auto-fix) before running benchmark
            const self = this;
            const helpers = {
                updateScenarios: (bmId, scenarios) => self._updateBenchmarkScenarios(bmId, scenarios),
                learnFromMistakes: (wrongScenarios) => self._learnFromBenchmarkMistakes(wrongScenarios),
                applyConfusionTraining: (summary) => self._applyConfusionFocusedTraining(summary),
                generateConfusionBatch: (summary) => self._generateConfusionTrainingBatch(summary)
            };

            // Run benchmark test
            logger.info('Running benchmark test', { domain: this.domain, benchmark_name: benchmarkName });
            const testResult = await adapter.runBenchmark({
                benchmark_identifier: benchmarkName,
                user_id: this.userId
            });

            const postResult = await adapter.postBenchmarkProcess(benchmark, testResult, this.userId, helpers);
            mistakes_learned = postResult.mistakes_learned || 0;
            validation_issues_found = postResult.validation_issues_found || 0;

            const result = {
                benchmark_name: benchmarkName,
                benchmark_id: generationResult.benchmark_id,
                scale, difficulty_level: level,
                scale_level_display: `S${scale} L${level}`,
                scale_name: difficultyConfig.scale_name,
                difficulty_description: difficultyConfig.description,
                complexity_factors: difficultyConfig.complexity_factors,
                scenario_count: this.config.benchmark_scenario_count,
                oggy_accuracy: testResult.oggy.accuracy,
                base_accuracy: testResult.base.accuracy,
                advantage: testResult.comparison.advantage_percent,
                oggy_passed: testResult.oggy.accuracy >= testResult.base.accuracy,
                mistakes_learned,
                timestamp: new Date().toISOString(),
                validation_issues_found
            };
            logger.info('Benchmark completed', result);
            return result;
        }

        // Standard path (diet, general — no post-processing)
        logger.info('Running benchmark test', { domain: this.domain, benchmark_name: benchmarkName });
        const testResult = await adapter.runBenchmark({
            benchmark_identifier: benchmarkName,
            user_id: this.userId
        });

        const result = {
            benchmark_name: benchmarkName,
            benchmark_id: generationResult.benchmark_id,
            scale, difficulty_level: level,
            scale_level_display: `S${scale} L${level}`,
            scale_name: difficultyConfig.scale_name,
            difficulty_description: difficultyConfig.description,
            complexity_factors: difficultyConfig.complexity_factors,
            scenario_count: this.config.benchmark_scenario_count,
            oggy_accuracy: testResult.oggy.accuracy,
            base_accuracy: testResult.base.accuracy,
            advantage: testResult.comparison.advantage_percent,
            oggy_passed: testResult.oggy.accuracy >= testResult.base.accuracy,
            mistakes_learned: 0,
            timestamp: new Date().toISOString(),
            validation_issues_found: 0
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
        return correctionValidator.isReasoningConsistent(reasoning, correctCategory);
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
        let skippedTimeout = 0;
        let skippedDuplicate = 0;
        let rulesCreated = 0;
        const seenByDescription = new Map();
        const confusionCounts = new Map();

        // Phase 1: Sequential filtering and validation
        const cardsToCreate = [];
        for (const mistake of wrongScenarios) {
            if (!mistake.correct_category || mistake.predicted_category === 'TIMEOUT' || mistake.error === 'OGGY_TIMEOUT') {
                skippedTimeout++;
                continue;
            }

            const descKey = `${(mistake.merchant || '').toLowerCase()}|${(mistake.description || '').toLowerCase()}`;
            const existing = seenByDescription.get(descKey);
            if (existing && existing !== mistake.correct_category) {
                skippedContradictory++;
                continue;
            }
            if (existing === mistake.correct_category) {
                skippedDuplicate++;
                continue;
            }
            seenByDescription.set(descKey, mistake.correct_category);

            const confusionKey = `${mistake.correct_category}|${mistake.predicted_category}`;
            confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) || 0) + 1);

            const isConsistent = this._isReasoningConsistent(
                mistake.reasoning,
                mistake.correct_category,
                mistake.predicted_category
            );

            if (!isConsistent) {
                logger.warn('Skipping contradictory correction', {
                    merchant: mistake.merchant,
                    stated_correct: mistake.correct_category,
                    reasoning_suggests: mistake.predicted_category,
                    reasoning: mistake.reasoning?.substring(0, 100)
                });
                skippedContradictory++;
                continue;
            }

            const reasoningHint = this._extractReasoningHint(
                mistake.reasoning,
                mistake.correct_category,
                mistake.predicted_category
            );

            const safeDistinction = correctionValidator.sanitizeKeyDistinction(mistake.reasoning || '', mistake.correct_category);
            cardsToCreate.push({ mistake, reasoningHint, safeDistinction });
        }

        // Phase 2: Parallel API calls (rule creation + memory card creation)
        const createResults = await parallelMap(
            cardsToCreate,
            async (item) => {
                const { mistake, reasoningHint, safeDistinction } = item;
                let localRules = 0;

                if (reasoningHint) {
                    const ruleId = await categoryRulesManager.createScenarioReasonRule({
                        actual: mistake.correct_category,
                        predicted: mistake.predicted_category,
                        scenario_id: mistake.scenario_id
                    }, reasoningHint, this.userId);
                    if (ruleId) localRules++;
                }

                const cardContent = {
                    type: 'BENCHMARK_CORRECTION',
                    text: `CORRECTION: "${mistake.merchant}" with "${mistake.description}" is "${mistake.correct_category}" NOT "${mistake.predicted_category}".${safeDistinction ? ' ' + safeDistinction : ''}`,
                    description: mistake.description,
                    merchant: mistake.merchant,
                    correct_category: mistake.correct_category,
                    wrong_prediction: mistake.predicted_category,
                    key_distinction: safeDistinction,
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
                        tier: 1,
                        kind: 'expense_category_correction',
                        content: cardContent,
                        tags: [
                            'payments',
                            'categorization',
                            'correction',
                            'benchmark_learned',
                            mistake.correct_category,
                            `not_${mistake.predicted_category}`,
                            mistake.merchant.toLowerCase().replace(/\s+/g, '_')
                        ],
                        utility_weight: 0.9,
                        reliability: 0.95
                    },
                    {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    }
                );

                logger.info('Created correction memory from benchmark mistake', {
                    merchant: mistake.merchant,
                    wrong: mistake.predicted_category,
                    correct: mistake.correct_category
                });

                return { rules: localRules };
            },
            5,  // Memory service concurrency
            { operationName: 'learn-from-mistakes' }
        );

        learned = createResults.results.filter(r => r.success).length;
        rulesCreated = createResults.results
            .filter(r => r.success)
            .reduce((sum, r) => sum + r.value.rules, 0);

        for (const err of createResults.errors) {
            logger.warn('Failed to create correction memory', {
                merchant: cardsToCreate[err.index]?.mistake?.merchant,
                error: err.error
            });
        }

        const confusionRulesCreated = await this._createConfusionRulesFromMistakes(confusionCounts);
        rulesCreated += confusionRulesCreated;
        const confusionSummary = this._buildConfusionSummary(confusionCounts, wrongScenarios.length);

        logger.info('📚 BENCHMARK LEARNING COMPLETE', {
            mistakes_processed: wrongScenarios.length,
            memories_created: learned,
            rules_created: rulesCreated,
            skipped_contradictory: skippedContradictory,
            skipped_timeout: skippedTimeout,
            skipped_duplicate: skippedDuplicate
        });

        return { learned, skipped: skippedContradictory, confusion_summary: confusionSummary };
    }

    _buildConfusionSummary(confusionCounts, totalMistakes) {
        if (!confusionCounts || confusionCounts.size === 0 || !totalMistakes) {
            return null;
        }

        const patterns = Array.from(confusionCounts.entries()).map(([key, count]) => {
            const [actual, predicted] = key.split('|');
            return {
                actual,
                predicted,
                count,
                confusion_rate: count / totalMistakes
            };
        }).sort((a, b) => b.count - a.count);

        const confusionTotal = patterns.reduce((sum, p) => sum + p.count, 0);
        const majority = confusionTotal / totalMistakes >= 0.5;

        return {
            totalMistakes,
            confusionTotal,
            majority,
            patterns
        };
    }

    _applyConfusionFocusedTraining(confusionSummary) {
        if (!confusionSummary || !confusionSummary.patterns) {
            return;
        }

        if (!confusionSummary.majority) {
            return;
        }

        const topPatterns = confusionSummary.patterns.slice(0, 5);
        const focusCategories = Array.from(new Set(topPatterns.map(p => p.actual))).slice(0, 3);

        const weightMap = {};
        const total = topPatterns.reduce((sum, p) => sum + p.count, 0) || 1;
        for (const pattern of topPatterns) {
            weightMap[pattern.actual] = (weightMap[pattern.actual] || 0) + (pattern.count / total);
        }

        logger.info('Applying confusion-focused training', {
            focusCategories,
            topPatterns: topPatterns.map(p => `${p.actual}→${p.predicted} (${(p.confusion_rate * 100).toFixed(0)}%)`)
        });

        this._getSdl().setTargetedLearning(
            weightMap,
            focusCategories,
            topPatterns,
            { confusionTargetRate: 0.9 }
        );
    }

    async _generateConfusionTrainingBatch(confusionSummary) {
        if (!confusionSummary || !confusionSummary.patterns || !confusionSummary.majority) {
            return;
        }

        const topPatterns = confusionSummary.patterns.slice(0, 3);
        const itemsPerPattern = 4;

        logger.info('Generating explicit confusion training batch', {
            patterns: topPatterns.map(p => `${p.actual}→${p.predicted}`),
            items_per_pattern: itemsPerPattern
        });

        let scenarios = [];
        try {
            scenarios = await tessaAssessmentGenerator.generateForConfusionPatterns(topPatterns, itemsPerPattern);
        } catch (error) {
            logger.warn('Failed to generate confusion training batch', { error: error.message });
            return;
        }

        if (!scenarios || scenarios.length === 0) {
            return;
        }

        // Parallel confusion training — each scenario creates pattern + correction cards + rules
        const confusionResults = await parallelMap(
            scenarios,
            async (scenario) => {
                let localMemories = 0;
                let localRules = 0;

                const confusionContext = scenario.confusion_context || {};
                const actual = confusionContext.actual_category || scenario.correctCategory;
                const predicted = confusionContext.confused_with || 'unknown';

                const safeHint = correctionValidator.sanitizeKeyDistinction(
                    scenario.distinction_hint || '', scenario.correctCategory
                );

                // Create pattern memory card
                const cardContent = {
                    type: 'PATTERN',
                    text: `CONFUSION TRAINING: "${scenario.merchant}" with "${scenario.description}" is "${scenario.correctCategory}" (not "${predicted}").${safeHint ? ' ' + safeHint : ''}`,
                    pattern: {
                        merchant: scenario.merchant,
                        category: scenario.correctCategory,
                        description_keywords: scenario.description.split(' ').filter(w => w.length > 3),
                        amount_range: this._getAmountRange(scenario.amount)
                    },
                    evidence: {
                        source: 'confusion_training_batch',
                        confidence: 'high',
                        learning_mode: 'confusion_pair'
                    }
                };

                await axios.post(
                    `${MEMORY_SERVICE_URL}/cards`,
                    {
                        owner_type: 'user',
                        owner_id: this.userId,
                        tier: 2,
                        kind: 'expense_category_pattern',
                        content: cardContent,
                        tags: [
                            'payments', 'categorization', 'confusion_training',
                            scenario.correctCategory, `not_${predicted}`,
                            scenario.merchant.toLowerCase().replace(/\s+/g, '_')
                        ],
                        utility_weight: 0.8,
                        reliability: 0.9
                    },
                    { timeout: 5000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } }
                );
                localMemories++;

                if (predicted && predicted !== 'unknown') {
                    const correctionContent = {
                        type: 'BENCHMARK_CORRECTION',
                        text: `CORRECTION: "${scenario.merchant}" with "${scenario.description}" is "${scenario.correctCategory}" NOT "${predicted}".${safeHint ? ' ' + safeHint : ''}`,
                        description: scenario.description,
                        merchant: scenario.merchant,
                        correct_category: scenario.correctCategory,
                        wrong_prediction: predicted,
                        key_distinction: safeHint,
                        correction: {
                            merchant: scenario.merchant, description: scenario.description,
                            wrong_prediction: predicted, correct_category: scenario.correctCategory,
                            amount: scenario.amount
                        },
                        evidence: { source: 'confusion_training_batch', confidence: 'high', learning_mode: 'confusion_pair' }
                    };

                    await axios.post(
                        `${MEMORY_SERVICE_URL}/cards`,
                        {
                            owner_type: 'user',
                            owner_id: this.userId,
                            tier: 1,
                            kind: 'expense_category_correction',
                            content: correctionContent,
                            tags: [
                                'payments', 'categorization', 'correction', 'benchmark_learned',
                                scenario.correctCategory, `not_${predicted}`,
                                scenario.merchant.toLowerCase().replace(/\s+/g, '_')
                            ],
                            utility_weight: 0.95,
                            reliability: 0.95
                        },
                        { timeout: 5000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } }
                    );
                    localMemories++;
                }

                const hint = safeHint || correctionValidator.sanitizeKeyDistinction(scenario.reasoning || '', scenario.correctCategory);
                if (actual && predicted && hint) {
                    const ruleId = await categoryRulesManager.createDistinctionRule({
                        actual, predicted,
                        confusion_rate: confusionContext.confusion_rate || 0.5
                    }, hint, this.userId);
                    if (ruleId) localRules++;
                }

                return { memories: localMemories, rules: localRules };
            },
            5,  // Memory service concurrency
            { operationName: 'confusion-training-batch' }
        );

        const memoriesCreated = confusionResults.results
            .filter(r => r.success)
            .reduce((sum, r) => sum + r.value.memories, 0);
        const rulesCreated = confusionResults.results
            .filter(r => r.success)
            .reduce((sum, r) => sum + r.value.rules, 0);

        for (const err of confusionResults.errors) {
            logger.warn('Failed to store confusion training memory', {
                merchant: scenarios[err.index]?.merchant,
                error: err.error
            });
        }

        logger.info('Confusion training batch stored', {
            total: scenarios.length,
            memories_created: memoriesCreated,
            rules_created: rulesCreated
        });
    }

    async _maybeDemoteDifficultyFromBenchmark(benchmarkResult) {
        if (!benchmarkResult) return;

        if (benchmarkResult.oggy_accuracy < benchmarkResult.base_accuracy) {
            this.stats.benchmark_underperform_streak++;
        } else {
            this.stats.benchmark_underperform_streak = 0;
        }

        if (this.stats.benchmark_underperform_streak < 5) {
            return;
        }

        const oldScale = this.stats.current_scale;
        const oldLevel = this.stats.difficulty_level;

        if (this.stats.difficulty_level > 1) {
            this.stats.difficulty_level--;
        } else if (this.stats.current_scale > 1) {
            this.stats.current_scale--;
            this.stats.difficulty_level = this.config.max_difficulty_level;
        } else {
            logger.info('Already at minimum scale/level, cannot demote further');
            this.stats.benchmark_underperform_streak = 0;
            return;
        }

        const difficultyConfig = this.getDifficultyConfig(this.stats.current_scale, this.stats.difficulty_level);
        this.stats.current_difficulty = difficultyConfig.description;
        await this._saveScaleAndLevel(this.userId, this.stats.current_scale, this.stats.difficulty_level);

        logger.warn('Demoted difficulty after benchmark underperformance', {
            old_scale: oldScale,
            old_level: oldLevel,
            new_scale: this.stats.current_scale,
            new_level: this.stats.difficulty_level,
            streak: this.stats.benchmark_underperform_streak,
            user_id: this.userId
        });

        this.stats.benchmark_underperform_streak = 0;
    }

    async _createConfusionRulesFromMistakes(confusionCounts) {
        if (!confusionCounts || confusionCounts.size === 0) return 0;

        const sorted = Array.from(confusionCounts.entries())
            .map(([key, count]) => ({ key, count }))
            .filter(item => item.count >= 2)
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);

        let created = 0;
        for (const item of sorted) {
            const [actual, predicted] = item.key.split('|');
            const hint = this._defaultDistinctionHint(actual, predicted);
            if (!hint) continue;
            const ruleId = await categoryRulesManager.createDistinctionRule({
                actual,
                predicted,
                confusion_rate: Math.min(1, item.count / 10)
            }, hint, this.userId);
            if (ruleId) created++;
        }

        return created;
    }

    _defaultDistinctionHint(actual, predicted) {
        const pair = `${actual}|${predicted}`;
        const hints = {
            'business_meal|dining': 'If the meal includes explicit business tasks (client, project, budget, meeting decisions), choose business_meal; if it is primarily social or personal, choose dining.',
            'dining|business_meal': 'Choose dining when work is incidental; choose business_meal only when business is the primary purpose or decision-making occurs.',
            'groceries|shopping': 'If the primary purchase is food for home (produce, meat, dairy), choose groceries; if non-food retail items dominate, choose shopping.',
            'shopping|groceries': 'If non-food retail items dominate (clothing, electronics, home goods), choose shopping; if food for home is the main purpose, choose groceries.',
            'entertainment|dining': 'If the main draw is a show/event (concert, performance, tickets), choose entertainment; if the main draw is the meal, choose dining.',
            'health|other': 'If there is a prescription, medical service, pharmacy visit, or clinical treatment, choose health; otherwise consider other.',
            'shopping|other': 'If there are specific retail goods purchased (clothes, electronics, home items), choose shopping; use other only when no category fits.',
            'groceries|other': 'If food for home is purchased (produce, meat, dairy, meal prep), choose groceries; use other only if no category applies.',
            'entertainment|other': 'If a show, performance, tickets, or venue is the focus, choose entertainment; use other only if no category applies.',
            'dining|other': 'If the expense is a meal at a restaurant or cafe, choose dining; use other only if no category applies.',
            'transportation|other': 'If gas, fuel, parking, rideshare, or transit is involved, choose transportation; otherwise consider other.',
            'utilities|shopping': 'If the primary expense is a recurring service bill (internet, phone, cable, electric), choose utilities; otherwise choose shopping.'
        };

        return hints[pair] || null;
    }

    /**
     * Extract a concise reasoning hint for category distinction rules.
     */
    _extractReasoningHint(reasoning, correctCategory, wrongPrediction) {
        if (!reasoning) return null;

        const text = reasoning.replace(/\s+/g, ' ').trim();
        const lower = text.toLowerCase();

        // Prefer sentences with primary-purpose language
        const sentences = text.split(/(?<=[.!?])\s+/);
        const primarySentence = sentences.find(s =>
            /primary purpose|takes precedence|main reason|dominant|core/.test(s.toLowerCase())
        );
        const candidate = primarySentence || sentences[0];
        if (!candidate) return null;

        const maxLen = 240;
        let hint = candidate.length > maxLen ? `${candidate.slice(0, maxLen)}...` : candidate;

        // Normalize into a rule-like hint
        hint = hint.replace(/according to.*$/i, '').trim();
        if (!hint.toLowerCase().includes(correctCategory)) {
            hint = `${hint} -> prefer "${correctCategory}" over "${wrongPrediction}".`;
        }

        // Avoid rules that explicitly endorse the wrong prediction
        if (lower.includes(`should be ${wrongPrediction}`) || lower.includes(`${wrongPrediction} is correct`)) {
            return null;
        }

        return hint;
    }

    /**
     * Advance difficulty level with scale system
     * At level 5, advance to next scale at level 1
     */
    async _advanceDifficulty() {
        const oldScale = this.stats.current_scale;
        const oldLevel = this.stats.difficulty_level;

        if (this.stats.difficulty_level < this.config.max_difficulty_level) {
            // Advance within current scale
            this.stats.difficulty_level++;
        } else if (this.stats.current_scale < this.config.max_scale) {
            // At level 5, advance to next scale at level 1
            this.stats.current_scale++;
            this.stats.difficulty_level = 1;  // Start new scale at level 1

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
        let baselineScale = null;
        let loadedFromDb = false;

        // If not explicitly provided, try to load from database
        if (scale === null || level === null) {
            try {
                const result = await query(`
                    SELECT scale, difficulty_level, baseline_scale FROM continuous_learning_state
                    WHERE user_id = $1 AND domain = $2
                `, [userId, this.domain || 'payments']);

                if (result.rows.length > 0) {
                    if (scale === null) scale = result.rows[0].scale;
                    if (level === null) level = result.rows[0].difficulty_level;
                    if (result.rows[0].baseline_scale !== null && result.rows[0].baseline_scale !== undefined) {
                        baselineScale = result.rows[0].baseline_scale;
                    }
                    loadedFromDb = true;

                    logger.info('Loaded scale and level from database', {
                        user_id: userId,
                        scale: scale,
                        difficulty_level: level,
                        baseline_scale: baselineScale
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

        // Apply baseline scale if available
        if (baselineScale !== null) {
            this._getAds().setBaselineScale(parseInt(baselineScale, 10));
        }

        // Always save the initial state to ensure it's persisted
        // This handles cases where the row doesn't exist or explicit starting values were provided
        if (!loadedFromDb || startingScale !== null || startingLevel !== null) {
            const initialBaseline = baselineScale !== null
                ? parseInt(baselineScale, 10)
                : this._getAds().getBaselineScale();
            await this._saveScaleAndLevel(userId, scale, level, initialBaseline);
            logger.info('Saved initial scale and level', {
                user_id: userId,
                scale: scale,
                difficulty_level: level,
                explicit_start: startingScale !== null || startingLevel !== null,
                baseline_scale: initialBaseline
            });
        }

        return { scale, level };
    }

    /**
     * Save scale and level to database
     */
    async _saveScaleAndLevel(userId, scale, level, baselineScale = null) {
        try {
            const domain = this.domain || 'payments';
            // Upsert the scale and level (domain-scoped)
            await query(`
                INSERT INTO continuous_learning_state (user_id, domain, scale, difficulty_level, baseline_scale, updated_at)
                VALUES ($1, $5, $2, $3, COALESCE($4, 50), NOW())
                ON CONFLICT (user_id, domain)
                DO UPDATE SET scale = $2, difficulty_level = $3,
                    baseline_scale = COALESCE($4, continuous_learning_state.baseline_scale),
                    updated_at = NOW()
            `, [userId, scale, level, baselineScale, domain]);

            logger.debug('Saved scale and level to database', {
                user_id: userId,
                scale: scale,
                difficulty_level: level,
                baseline_scale: baselineScale
            });
        } catch (error) {
            // If table doesn't exist or missing column, create/update it
            if (error.message.includes('does not exist') || error.message.includes('column')) {
                await this._createStateTable();
                await this._saveScaleAndLevel(userId, scale, level, baselineScale);
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
                    baseline_scale INTEGER DEFAULT 50,
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

            try {
                await query(`
                    ALTER TABLE continuous_learning_state
                    ADD COLUMN IF NOT EXISTS difficulty_level INTEGER DEFAULT 3
                `);
            } catch (alterError) {
                // Column might already exist, that's OK
            }

            try {
                await query(`
                    ALTER TABLE continuous_learning_state
                    ADD COLUMN IF NOT EXISTS baseline_scale INTEGER DEFAULT 50
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
    _getAmountRange(amount) {
        if (amount < 20) return 'small';
        if (amount < 100) return 'medium';
        if (amount < 500) return 'large';
        return 'very_large';
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
     * Parse accuracy from any SDL format into a 0-1 decimal.
     * Payments returns "85.3%" (string with %), General returns 0.853 (number 0-1),
     * Harmony returns "85.3%" (string with %).
     */
    _parseAccuracyToDecimal(accuracy) {
        if (!accuracy || accuracy === 'N/A') return 0;
        if (typeof accuracy === 'string') {
            // "85.3%" → 0.853
            const parsed = parseFloat(accuracy);
            if (isNaN(parsed)) return 0;
            return parsed / 100;
        }
        // Number: if > 1, treat as percentage (e.g. 85.3); if <= 1, treat as decimal (e.g. 0.853)
        if (typeof accuracy === 'number') {
            return accuracy > 1 ? accuracy / 100 : accuracy;
        }
        return 0;
    }

    /**
     * Sleep utility
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Per-user instance registry (replaces singleton for tenant isolation)
const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new ContinuousLearningLoop());
    }
    return instances.get(userId);
}

function removeInstance(userId) {
    const inst = instances.get(userId);
    if (inst && inst.isRunning) inst.stop();
    instances.delete(userId);
}

function getAllInstances() {
    return instances;
}

module.exports = { getInstance, removeInstance, getAllInstances, ContinuousLearningLoop };
