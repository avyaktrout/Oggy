/**
 * Self-Driven Learning Service
 * Enables Oggy to autonomously practice and improve by:
 * 1. Requesting assessments from Tessa
 * 2. Attempting categorization
 * 3. Evaluating own performance
 * 4. Updating memory based on results
 *
 * Week 7+: Autonomous Learning Loop
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../utils/db');
const OggyCategorizer = require('./oggyCategorizer');
const tessaAssessmentGenerator = require('./tessaAssessmentGenerator');
const categoryRulesManager = require('./categoryRulesManager');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { adaptiveDifficultyScaler } = require('./adaptiveDifficultyScaler');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const LEARNING_INTERVAL_MS = parseInt(process.env.LEARNING_INTERVAL_MS || '300000', 10); // 5 minutes default
const USE_TESSA_GENERATION = process.env.USE_TESSA_GENERATION !== 'false'; // Default true

class SelfDrivenLearning {
    constructor() {
        this.oggyCategorizer = new OggyCategorizer();
        this.isRunning = false;
        this.intervalHandle = null;
        this.stats = {
            total_attempts: 0,
            correct: 0,
            incorrect: 0,
            sessions: 0
        };
        // Track recent accuracy for adaptive difficulty
        this.recentAccuracy = []; // Track last 20 attempts for adaptive difficulty
        // Targeted learning support
        this.categoryWeights = null; // null = balanced, object = targeted
        this.focusCategories = []; // Categories to focus on
        this.confusionPatterns = []; // Confusion patterns to target
        this.confusionTargetRate = 0.30; // Default % of confusion-targeted assessments
        this._baselineLoadPromise = null;
        this._baselineLoadedFor = null;
    }

    /**
     * Set targeted learning parameters
     * @param {object} categoryWeights - Weight distribution for categories (e.g., {groceries: 0.3, dining: 0.2, ...})
     * @param {array} focusCategories - Categories to focus on
     * @param {array} confusionPatterns - Confusion patterns to target (e.g., [{actual: 'groceries', predicted: 'dining', ...}])
     */
    setTargetedLearning(categoryWeights, focusCategories = [], confusionPatterns = [], options = {}) {
        this.categoryWeights = categoryWeights;
        this.focusCategories = focusCategories;
        this.confusionPatterns = confusionPatterns;
        if (typeof options.confusionTargetRate === 'number') {
            this.confusionTargetRate = Math.max(0, Math.min(1, options.confusionTargetRate));
        }
        logger.info('Targeted learning configured', {
            focusCategories,
            confusionPatterns: confusionPatterns.map(p => `${p.actual}→${p.predicted}`),
            weights: categoryWeights,
            confusionTargetRate: this.confusionTargetRate
        });
    }

    /**
     * Clear targeted learning (return to balanced)
     */
    clearTargetedLearning() {
        this.categoryWeights = null;
        this.focusCategories = [];
        this.confusionPatterns = [];
        this.confusionTargetRate = 0.30;
        logger.info('Targeted learning cleared - returning to balanced training');
    }

    /**
     * Start autonomous learning loop
     * @param {string} userId - User to train for (uses their domain knowledge)
     * @param {object} options - Configuration options
     */
    start(userId, options = {}) {
        if (this.isRunning) {
            logger.warn('Self-driven learning already running', { userId });
            return;
        }

        const {
            interval = LEARNING_INTERVAL_MS,
            practiceCount = 5, // Practice 5 expenses per session
            enabled = true,
            categoryWeights = null, // For targeted learning
            focusCategories = []
        } = options;

        if (!enabled) {
            logger.info('Self-driven learning is disabled');
            return;
        }

        // Set targeted learning if provided
        if (categoryWeights) {
            this.setTargetedLearning(categoryWeights, focusCategories);
        }

        this.isRunning = true;
        this.userId = userId;
        this.practiceCount = practiceCount;

        // Reset stats for new session to prevent stale counts from triggering premature benchmarks
        this.stats = {
            total_attempts: 0,
            correct: 0,
            incorrect: 0,
            sessions: 0
        };
        this.recentAccuracy = [];

        logger.info('Starting self-driven learning', {
            userId,
            interval_ms: interval,
            practice_count_per_session: practiceCount
        });

        // Run immediately on start
        this.runLearningSession();

        // Then run periodically
        this.intervalHandle = setInterval(async () => {
            await this.runLearningSession();
        }, interval);
    }

    /**
     * Stop autonomous learning loop
     */
    stop() {
        if (!this.isRunning) {
            return;
        }

        logger.info('Stopping self-driven learning', {
            userId: this.userId,
            stats: this.stats
        });

        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }

        this.isRunning = false;
    }

    /**
     * Run a single learning session
     */
    async runLearningSession() {
        // Prevent overlapping sessions - skip if previous session is still running
        if (this._sessionInProgress) {
            logger.debug('Skipping learning session - previous session still in progress');
            return;
        }
        this._sessionInProgress = true;

        try {
            const sessionId = uuidv4();
            const startTime = Date.now();

            logger.info('Starting self-driven learning session', {
                sessionId,
                userId: this.userId,
                practice_count: this.practiceCount
            });

            let sessionCorrect = 0;
            let sessionIncorrect = 0;
            let sessionErrors = 0;

            for (let i = 0; i < this.practiceCount; i++) {
                try {
                    const result = await this.practiceSingleExpense();

                    if (result.correct) {
                        sessionCorrect++;
                        this.stats.correct++;
                    } else {
                        sessionIncorrect++;
                        this.stats.incorrect++;
                    }
                    this.stats.total_attempts++;

                    logger.debug('Practice attempt completed', {
                        sessionId,
                        attempt: i + 1,
                        correct: result.correct,
                        expected: result.expectedCategory,
                        predicted: result.predictedCategory
                    });

                    // Brief delay between attempts — circuit breakers handle rate limiting
                    await this._sleep(200);
                } catch (error) {
                    sessionErrors++;
                    logger.logError(error, {
                        operation: 'practiceSingleExpense',
                        sessionId,
                        attempt: i + 1
                    });
                }
            }

            this.stats.sessions++;
            const duration = Date.now() - startTime;
            const accuracy = sessionCorrect / (sessionCorrect + sessionIncorrect) * 100;

            logger.info('Self-driven learning session completed', {
                sessionId,
                userId: this.userId,
                duration_ms: duration,
                correct: sessionCorrect,
                incorrect: sessionIncorrect,
                errors: sessionErrors,
                accuracy: accuracy.toFixed(1) + '%',
                lifetime_stats: {
                    total_attempts: this.stats.total_attempts,
                    overall_accuracy: (this.stats.correct / this.stats.total_attempts * 100).toFixed(1) + '%',
                    sessions: this.stats.sessions
                }
            });
        } finally {
            this._sessionInProgress = false;
        }
    }

    /**
     * Practice on a single synthetic expense
     * 1. Generate assessment from Tessa (via domain knowledge)
     * 2. Attempt categorization with Oggy
     * 3. Evaluate correctness
     * 4. Update memory based on result
     */
    async practiceSingleExpense() {
        // Step 1: Get a synthetic expense from domain knowledge
        const assessment = await this._generateAssessment();

        if (!assessment) {
            throw new Error('No assessment available for practice');
        }

        const { merchant, amount, description, correctCategory } = assessment;

        // Step 2: Oggy attempts categorization
        const suggestion = await this.oggyCategorizer.suggestCategory(this.userId, {
            merchant,
            amount,
            description,
            transaction_date: new Date().toISOString().split('T')[0]
        });

        const predictedCategory = suggestion.suggested_category;
        const trace_id = suggestion.trace_id;
        const correct = predictedCategory === correctCategory;
        const meta = suggestion._meta || {};
        const learningAllowed = meta.learning_allowed !== false;

        logger.debug('Oggy practice attempt', {
            merchant,
            expected: correctCategory,
            predicted: predictedCategory,
            correct,
            confidence: suggestion.confidence,
            trace_id
        });

        // Step 3/4: Apply learning writes only if gate allows
        if (!learningAllowed) {
            logger.warn('Learning write blocked (gate open)', {
                merchant,
                expected: correctCategory,
                predicted: predictedCategory,
                breaker_states: meta.breaker_states || {},
                used_fallback: meta.used_fallback || false
            });
        } else {
            // Step 3: Update memory based on correctness
            if (trace_id) {
                await this._updateMemoryFromPractice(trace_id, correct, {
                    merchant,
                    correctCategory,
                    predictedCategory
                });
            } else {
                // No memory was used, create new memory card from this learning
                await this._createMemoryFromPractice(correct, {
                    merchant,
                    amount,
                    description,
                    correctCategory,
                    predictedCategory
                });
            }

            // Step 4: If correct, add to domain knowledge (expand knowledge base)
            if (correct) {
                await this._expandDomainKnowledge({
                    merchant,
                    amount,
                    description,
                    category: correctCategory,
                    trace_id,
                    confidence: suggestion.confidence,
                    source: assessment.source || 'practice'
                });

                // Step 4.5: If this was a confusion-targeted scenario and we got it right,
                // create a category distinction rule that will be injected into ALL future prompts
                if (assessment.confusion_context) {
                    await this._createCategoryDistinctionRule(assessment, suggestion.reasoning);
                }
            }
        }

        // Step 5: Record practice event for audit trail
        await this._recordPracticeEvent({
            merchant,
            amount,
            description,
            expected_category: correctCategory,
            predicted_category: predictedCategory,
            correct,
            trace_id,
            confidence: suggestion.confidence,
            learning_gate_open: meta.learning_gate_open || false,
            breaker_states: meta.breaker_states || {},
            used_fallback: meta.used_fallback || false,
            memory_retrieval_failed: meta.memory_retrieval_failed || false
        });

        // Step 6: Track recent accuracy for adaptive difficulty
        this.recentAccuracy.push(correct ? 1 : 0);
        if (this.recentAccuracy.length > 20) {
            this.recentAccuracy.shift(); // Keep only last 20 attempts
        }

        return {
            correct,
            expectedCategory: correctCategory,
            predictedCategory,
            confidence: suggestion.confidence,
            trace_id
        };
    }

    /**
     * Select a category based on weights (for targeted learning) or randomly (balanced)
     */
    _selectTargetedCategory() {
        if (!this.categoryWeights) {
            // Balanced - random selection
            const categories = ['business_meal', 'groceries', 'transportation', 'utilities',
                               'entertainment', 'health', 'dining', 'shopping'];
            return categories[Math.floor(Math.random() * categories.length)];
        }

        // Weighted selection based on categoryWeights
        const rand = Math.random();
        let cumulative = 0;

        for (const [category, weight] of Object.entries(this.categoryWeights)) {
            cumulative += weight;
            if (rand < cumulative) {
                return category;
            }
        }

        // Fallback (shouldn't happen if weights sum to 1)
        return Object.keys(this.categoryWeights)[0];
    }

    /**
     * Generate assessment - distribution:
     * - 30% confusion-targeted (if patterns exist)
     * - 35% from Tessa (novel)
     * - 35% from domain knowledge (practice)
     * Uses adaptive 5-tier difficulty system that scales with Oggy's performance
     */
    async _generateAssessment() {
        await this._ensureBaselineLoaded();

        const rand = Math.random();

        // Confusion-targeted scenario if patterns exist
        if (this.confusionPatterns.length > 0 && rand < this.confusionTargetRate) {
            try {
                const scenario = await this._generateConfusionTargetedAssessment();
                if (scenario) {
                    return scenario;
                }
            } catch (error) {
                logger.warn('Confusion-targeted generation failed, falling back', {
                    error: error.message
                });
            }
        }

        const useTessaGeneration = USE_TESSA_GENERATION && rand < 0.65; // 35% Tessa (when not confusion)

        // Select category (targeted or balanced)
        const targetCategory = this._selectTargetedCategory();

        if (useTessaGeneration) {
            // Novel scenarios generated by Tessa using GPT
            // Select difficulty tier based on recent performance
            const difficultyTier = await adaptiveDifficultyScaler.selectDifficultyTier(
                this.recentAccuracy,
                this.userId
            );

            logger.debug('Requesting novel scenario from Tessa', {
                difficulty_tier: difficultyTier.name,
                tier_level: difficultyTier.tier_level,
                target_category: targetCategory,
                is_targeted: !!this.categoryWeights,
                has_confusion_patterns: this.confusionPatterns.length > 0,
                baseline_scale: adaptiveDifficultyScaler.baselineDifficultyScale,
                recent_accuracy: this.recentAccuracy.length > 0
                    ? (this.recentAccuracy.reduce((a,b) => a+b, 0) / this.recentAccuracy.length)
                    : 0
            });

            try {
                const scenario = await tessaAssessmentGenerator.generateNovelScenario({
                    category: targetCategory,
                    difficultyTier
                });

                if (scenario) {
                    return scenario;
                }
            } catch (error) {
                logger.warn('Tessa generation failed, falling back to domain knowledge', {
                    error: error.message
                });
            }
        }

        // Existing domain knowledge (OR fallback if Tessa fails)
        return await this._generateFromDomainKnowledge(targetCategory);
    }

    async _ensureBaselineLoaded() {
        if (!this.userId) {
            return;
        }

        if (this._baselineLoadedFor !== this.userId) {
            this._baselineLoadedFor = this.userId;
            this._baselineLoadPromise = adaptiveDifficultyScaler.loadBaselineScale(this.userId);
        }

        if (this._baselineLoadPromise) {
            await this._baselineLoadPromise;
        }
    }

    /**
     * Generate a confusion-targeted assessment
     * Picks a random confusion pattern and generates a scenario to address it
     */
    async _generateConfusionTargetedAssessment() {
        if (this.confusionPatterns.length === 0) {
            return null;
        }

        // Weight selection toward higher confusion rate patterns
        const totalWeight = this.confusionPatterns.reduce((sum, p) => sum + (p.confusion_rate || 0.1), 0);
        let rand = Math.random() * totalWeight;
        let selectedPattern = this.confusionPatterns[0];

        for (const pattern of this.confusionPatterns) {
            rand -= (pattern.confusion_rate || 0.1);
            if (rand <= 0) {
                selectedPattern = pattern;
                break;
            }
        }

        logger.debug('Generating confusion-targeted scenario', {
            actual: selectedPattern.actual,
            predicted: selectedPattern.predicted,
            confusion_rate: selectedPattern.confusion_rate
        });

        // Use Tessa to generate a scenario that distinguishes these categories
        const scenarios = await tessaAssessmentGenerator.generateForConfusionPatterns(
            [selectedPattern],
            1 // Just one scenario
        );

        if (scenarios.length > 0) {
            const scenario = scenarios[0];
            return {
                merchant: scenario.merchant,
                amount: scenario.amount,
                description: scenario.description,
                correctCategory: scenario.correctCategory,
                difficulty: 'confusion_targeted',
                source: 'confusion_training',
                confusion_context: scenario.confusion_context
            };
        }

        return null;
    }

    /**
     * Generate assessment from existing domain knowledge
     * @param {string} targetCategory - Optional category to filter for targeted learning
     */
    async _generateFromDomainKnowledge(targetCategory = null) {
        // Strategy: Mix easy and hard cases
        // 30% - Negative examples (rejections - harder)
        // 40% - Standard examples (regular patterns)
        // 30% - AI-generated or varied cases

        const rand = Math.random();
        let subtopic;

        if (rand < 0.3) {
            subtopic = 'negative_examples';
        } else if (rand < 0.7) {
            subtopic = 'user_patterns';
        } else {
            subtopic = null; // Any, including AI-generated
        }

        // Build query with optional category filter
        let query_text, query_params;

        if (targetCategory) {
            // Targeted learning - filter by category
            if (subtopic) {
                query_text = `SELECT content_structured
                   FROM domain_knowledge
                   WHERE domain = 'payments'
                     AND topic = 'categorization'
                     AND subtopic = $1
                     AND content_structured->>'merchant' IS NOT NULL
                     AND ((content_structured->>'category' = $2)
                          OR (content_structured->>'correct_category' = $2))
                   ORDER BY RANDOM()
                   LIMIT 1`;
                query_params = [subtopic, targetCategory];
            } else {
                query_text = `SELECT content_structured
                   FROM domain_knowledge
                   WHERE domain = 'payments'
                     AND topic = 'categorization'
                     AND content_structured->>'merchant' IS NOT NULL
                     AND ((content_structured->>'category' = $1)
                          OR (content_structured->>'correct_category' = $1))
                   ORDER BY RANDOM()
                   LIMIT 1`;
                query_params = [targetCategory];
            }
        } else {
            // Balanced learning - any category
            if (subtopic) {
                query_text = `SELECT content_structured
                   FROM domain_knowledge
                   WHERE domain = 'payments'
                     AND topic = 'categorization'
                     AND subtopic = $1
                     AND content_structured->>'merchant' IS NOT NULL
                     AND (content_structured->>'category' IS NOT NULL
                          OR content_structured->>'correct_category' IS NOT NULL)
                   ORDER BY RANDOM()
                   LIMIT 1`;
                query_params = [subtopic];
            } else {
                query_text = `SELECT content_structured
                   FROM domain_knowledge
                   WHERE domain = 'payments'
                     AND topic = 'categorization'
                     AND content_structured->>'merchant' IS NOT NULL
                     AND (content_structured->>'category' IS NOT NULL
                          OR content_structured->>'correct_category' IS NOT NULL)
                   ORDER BY RANDOM()
                   LIMIT 1`;
                query_params = [];
            }
        }

        const result = query_params.length > 0
            ? await query(query_text, query_params)
            : await query(query_text);

        if (result.rows.length === 0) {
            logger.warn('No domain knowledge available for practice', { subtopic });
            return null;
        }

        const pattern = result.rows[0].content_structured;
        const correctCategory = pattern.correct_category || pattern.category;

        return {
            merchant: pattern.merchant,
            amount: pattern.amount || 50.00,
            description: pattern.description || `Purchase at ${pattern.merchant}`,
            correctCategory,
            difficulty: subtopic === 'negative_examples' ? 'hard' : 'medium',
            source: pattern.source || 'domain_knowledge'
        };
    }

    /**
     * Get adaptive difficulty scale information
     * Used for monitoring and debugging
     */
    getScaleInfo() {
        return {
            ...adaptiveDifficultyScaler.getScaleInfo(),
            recent_accuracy_window: this.recentAccuracy.length,
            current_session_accuracy: this.recentAccuracy.length > 0
                ? (this.recentAccuracy.reduce((a,b) => a+b, 0) / this.recentAccuracy.length)
                : 0
        };
    }

    /**
     * Update memory cards based on practice results
     */
    async _updateMemoryFromPractice(trace_id, correct, context) {
        try {
            // Get cards that were used in this attempt
            const traceResult = await query(
                `SELECT selected_card_ids FROM retrieval_traces WHERE trace_id = $1`,
                [trace_id]
            );

            if (traceResult.rows.length === 0 || !traceResult.rows[0].selected_card_ids) {
                logger.debug('No memory cards to update for practice', { trace_id });
                return;
            }

            const cardIds = traceResult.rows[0].selected_card_ids;

            // Determine weight adjustment
            const patch = correct
                ? {
                    utility_weight_delta: +0.1,  // Promote if correct
                    success_count_delta: +1
                }
                : {
                    utility_weight_delta: -0.15,  // Demote if incorrect
                    failure_count_delta: +1
                };

            // Update each card
            for (const card_id of cardIds) {
                try {
                    await axios.post(
                        `${MEMORY_SERVICE_URL}/utility/update`,
                        {
                            card_id,
                            context: {
                                agent: 'oggy_self_learning',
                                program: 'autonomous_practice',
                                action: 'PRACTICE_RESULT',
                                evidence: {
                                    trace_id,
                                    practice_result: correct ? 'correct' : 'incorrect'
                                },
                                intent: {
                                    event_type: 'user_feedback',
                                    feedback: correct ? 'confirmed' : 'corrected',
                                    learning_mode: 'self_driven',
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

                    logger.debug('Updated memory card from practice', {
                        card_id,
                        trace_id,
                        correct,
                        patch
                    });
                } catch (error) {
                    logger.warn('Failed to update memory card from practice', {
                        card_id,
                        trace_id,
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
     * Create new memory card from practice (when no memory was used)
     */
    async _createMemoryFromPractice(correct, expenseData) {
        if (!correct) {
            // Only create memory for correct answers to avoid learning mistakes
            return;
        }

        try {
            const { merchant, amount, description, correctCategory } = expenseData;

            const cardContent = {
                type: 'PATTERN',
                text: `Merchant "${merchant}" with description "${description}" should be categorized as "${correctCategory}". Amount: $${amount}. (Learned autonomously)`,
                pattern: {
                    merchant,
                    category: correctCategory,
                    description_keywords: description.split(' ').filter(w => w.length > 3),
                    amount_range: this._getAmountRange(amount)
                },
                evidence: {
                    source: 'self_driven_learning',
                    confidence: 'medium',
                    learning_mode: 'autonomous_practice'
                }
            };

            const response = await axios.post(
                `${MEMORY_SERVICE_URL}/cards`,
                {
                    owner_type: 'user',
                    owner_id: this.userId,
                    tier: 2, // short-term memory initially
                    kind: 'expense_category_pattern',
                    content: cardContent,
                    tags: ['payments', 'categorization', 'self_learned', correctCategory, merchant.toLowerCase().replace(/\s+/g, '_')],
                    utility_weight: 0.6, // slightly lower initial weight for self-learned
                    reliability: 0.7
                },
                {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                }
            );

            logger.info('Created memory card from autonomous learning', {
                card_id: response.data.card_id,
                merchant,
                category: correctCategory
            });
        } catch (error) {
            logger.logError(error, {
                operation: '_createMemoryFromPractice',
                merchant: expenseData.merchant
            });
        }
    }

    /**
     * Expand domain knowledge when Oggy successfully learns something
     * This creates a self-improving knowledge base
     */
    async _expandDomainKnowledge(learningData) {
        try {
            const { merchant, amount, description, category, trace_id, confidence, source } = learningData;

            const content_structured = {
                merchant,
                category,
                amount,
                description,
                learned_via: 'self_driven_practice',
                confidence,
                trace_id,
                original_source: source
            };

            const content_text = `**Oggy Self-Learned Pattern:**
- Merchant: ${merchant}
- Category: ${category}
- Amount: $${amount}
- Description: ${description}
- Confidence: ${confidence}

Oggy correctly categorized this during autonomous practice and added it to domain knowledge for future learning.`;

            const content_hash = crypto
                .createHash('sha256')
                .update(JSON.stringify({ merchant, category }))
                .digest('hex')
                .substring(0, 16);

            await query(`
                INSERT INTO domain_knowledge (
                    knowledge_id,
                    domain,
                    topic,
                    subtopic,
                    content_text,
                    content_structured,
                    source_type,
                    source_ref,
                    visibility,
                    difficulty_band,
                    tags,
                    content_hash
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            `, [
                uuidv4(),
                'payments',
                'categorization',
                'self_learned_patterns',
                content_text,
                JSON.stringify(content_structured),
                'app_event',
                `self_practice:${trace_id || 'no_trace'}`,
                'shareable',
                2,
                JSON.stringify(['categorization', 'self_learned', category, 'oggy']),
                content_hash
            ]);

            logger.debug('Expanded domain knowledge from successful practice', {
                merchant,
                category,
                trace_id
            });
        } catch (error) {
            // Don't fail practice session if knowledge expansion fails
            logger.warn('Failed to expand domain knowledge', {
                error: error.message,
                merchant: learningData.merchant
            });
        }
    }

    /**
     * Create a category distinction rule from successful confusion-targeted learning
     * These rules are ALWAYS injected into categorization prompts, bypassing semantic retrieval
     */
    async _createCategoryDistinctionRule(assessment, reasoning) {
        try {
            const { confusion_context } = assessment;
            if (!confusion_context) return;

            const { actual_category, confused_with, training_goal } = confusion_context;

            // Build a distinction hint from the training goal and reasoning
            const distinctionHint = training_goal ||
                `${actual_category} differs from ${confused_with}: ${reasoning || 'context determines category'}`;

            // Create the rule using the rules manager
            const ruleId = await categoryRulesManager.createDistinctionRule(
                {
                    actual: actual_category,
                    predicted: confused_with,
                    confusion_rate: confusion_context.confusion_rate || 0.5
                },
                distinctionHint
            );

            if (ruleId) {
                logger.info('Created category distinction rule from confusion training', {
                    rule_id: ruleId,
                    actual: actual_category,
                    confused_with,
                    distinction: distinctionHint.substring(0, 100)
                });
            }
        } catch (error) {
            logger.warn('Failed to create category distinction rule', {
                error: error.message
            });
        }
    }

    /**
     * Record practice event in app_events for audit trail
     */
    async _recordPracticeEvent(practiceData) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, action, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE)
            `, [
                uuidv4(),
                this.userId,
                'OGGY_SELF_PRACTICE',
                'pattern',
                'categorize',
                JSON.stringify({
                    ...practiceData,
                    learning_mode: 'self_driven',
                    timestamp: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.warn('Failed to record practice event', {
                error: error.message
            });
        }
    }

    _getAmountRange(amount) {
        if (amount < 20) return 'small';
        if (amount < 100) return 'medium';
        if (amount < 500) return 'large';
        return 'very_large';
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get current learning statistics
     */
    getStats() {
        return {
            ...this.stats,
            accuracy: this.stats.total_attempts > 0
                ? (this.stats.correct / this.stats.total_attempts * 100).toFixed(1) + '%'
                : 'N/A',
            is_running: this.isRunning,
            adaptive_difficulty_scale: this.getScaleInfo()
        };
    }
}

// Singleton instance
const selfDrivenLearning = new SelfDrivenLearning();

module.exports = selfDrivenLearning;
