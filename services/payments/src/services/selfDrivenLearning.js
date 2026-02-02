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
const { v4: uuidv4 } = require('uuid');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const LEARNING_INTERVAL_MS = parseInt(process.env.LEARNING_INTERVAL_MS || '300000', 10); // 5 minutes default

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
            enabled = true
        } = options;

        if (!enabled) {
            logger.info('Self-driven learning is disabled');
            return;
        }

        this.isRunning = true;
        this.userId = userId;
        this.practiceCount = practiceCount;

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

                // Small delay between attempts to avoid hammering APIs
                await this._sleep(1000);
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

        logger.debug('Oggy practice attempt', {
            merchant,
            expected: correctCategory,
            predicted: predictedCategory,
            correct,
            confidence: suggestion.confidence,
            trace_id
        });

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

        // Step 4: Record practice event for audit trail
        await this._recordPracticeEvent({
            merchant,
            amount,
            description,
            expected_category: correctCategory,
            predicted_category: predictedCategory,
            correct,
            trace_id,
            confidence: suggestion.confidence
        });

        return {
            correct,
            expectedCategory: correctCategory,
            predictedCategory,
            confidence: suggestion.confidence,
            trace_id
        };
    }

    /**
     * Generate assessment from domain knowledge
     * Enhanced to include harder, more challenging cases
     */
    async _generateAssessment() {
        // Strategy: Mix easy and hard cases
        // 30% - Negative examples (rejections - harder)
        // 40% - Standard examples (regular patterns)
        // 30% - Ambiguous cases (could be multiple categories)

        const rand = Math.random();
        let subtopic;

        if (rand < 0.3) {
            // Hard: Negative examples (what NOT to do)
            subtopic = 'negative_examples';
        } else if (rand < 0.7) {
            // Medium: Regular patterns
            subtopic = 'user_patterns';
        } else {
            // Medium: Query patterns or any categorization
            subtopic = null; // Any
        }

        const query_text = subtopic
            ? `SELECT content_structured
               FROM domain_knowledge
               WHERE domain = 'payments'
                 AND topic = 'categorization'
                 AND subtopic = $1
                 AND content_structured->>'merchant' IS NOT NULL
                 AND (content_structured->>'category' IS NOT NULL
                      OR content_structured->>'correct_category' IS NOT NULL)
               ORDER BY RANDOM()
               LIMIT 1`
            : `SELECT content_structured
               FROM domain_knowledge
               WHERE domain = 'payments'
                 AND topic = 'categorization'
                 AND content_structured->>'merchant' IS NOT NULL
                 AND (content_structured->>'category' IS NOT NULL
                      OR content_structured->>'correct_category' IS NOT NULL)
               ORDER BY RANDOM()
               LIMIT 1`;

        const result = subtopic
            ? await query(query_text, [subtopic])
            : await query(query_text);

        if (result.rows.length === 0) {
            logger.warn('No domain knowledge available for practice', { subtopic });
            return null;
        }

        const pattern = result.rows[0].content_structured;

        // For negative examples, use the CORRECT category (not the wrong one)
        const correctCategory = pattern.correct_category || pattern.category;

        // Create a synthetic expense based on the pattern
        return {
            merchant: pattern.merchant,
            amount: pattern.amount || 50.00,
            description: pattern.description || `Purchase at ${pattern.merchant}`,
            correctCategory,
            difficulty: subtopic === 'negative_examples' ? 'hard' : 'medium'
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
     * Record practice event in app_events for audit trail
     */
    async _recordPracticeEvent(practiceData) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
            `, [
                uuidv4(),
                this.userId,
                'OGGY_SELF_PRACTICE',
                'practice', // entity_type is required by schema
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
            is_running: this.isRunning
        };
    }
}

// Singleton instance
const selfDrivenLearning = new SelfDrivenLearning();

module.exports = selfDrivenLearning;
