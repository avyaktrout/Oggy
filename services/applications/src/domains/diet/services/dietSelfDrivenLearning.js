/**
 * Diet Self-Driven Learning Service
 * Enables Oggy to autonomously practice nutrition estimation by:
 * 1. Generating diet assessment questions (from user entries, branded foods, AI)
 * 2. Prompting Oggy to estimate nutritional content
 * 3. Evaluating accuracy against ground truth
 * 4. Creating memory cards for corrections when wrong
 *
 * Mirrors selfDrivenLearning.js pattern for the diet/nutrition domain.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/utils/logger');
const { query } = require('../../../shared/utils/db');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const providerResolver = require('../../../shared/providers/providerResolver');
const circuitBreakerRegistry = require('../../../shared/utils/circuitBreakerRegistry');
const dietAssessmentGenerator = require('./dietAssessmentGenerator');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const DIET_LEARNING_INTERVAL_MS = parseInt(process.env.DIET_LEARNING_INTERVAL_MS || '300000', 10); // 5 min default

class DietSelfDrivenLearning {
    constructor() {
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
        this.isRunning = false;
        this.intervalHandle = null;
        this.userId = null;
        this.practiceCount = 5;
        this.stats = {
            total_attempts: 0,
            correct: 0,
            incorrect: 0,
            sessions: 0,
            last_session: null
        };
        this._sessionInProgress = false;
    }

    /**
     * Start the autonomous diet learning loop
     * @param {string} userId - User to train for
     * @param {object} options - Configuration options
     */
    start(userId, options = {}) {
        if (this.isRunning) {
            logger.warn('Diet self-driven learning already running', { userId });
            return;
        }

        const {
            interval = DIET_LEARNING_INTERVAL_MS,
            practiceCount = 5,
            enabled = true
        } = options;

        if (!enabled) {
            logger.info('Diet self-driven learning is disabled');
            return;
        }

        this.isRunning = true;
        this.userId = userId;
        this.practiceCount = practiceCount;

        // Reset stats for new session
        this.stats = {
            total_attempts: 0,
            correct: 0,
            incorrect: 0,
            sessions: 0,
            last_session: null
        };

        logger.info('Starting diet self-driven learning', {
            userId,
            interval_ms: interval,
            practice_count_per_session: practiceCount
        });

        // Run immediately, then periodically
        this._runSession(userId);

        this.intervalHandle = setInterval(async () => {
            await this._runSession(userId);
        }, interval);
    }

    /**
     * Stop the autonomous diet learning loop
     */
    stop() {
        if (!this.isRunning) {
            return;
        }

        logger.info('Stopping diet self-driven learning', {
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
     * Get current learning statistics
     * @returns {object} Learning stats including accuracy
     */
    getStats() {
        return {
            total_attempts: this.stats.total_attempts,
            correct: this.stats.correct,
            accuracy: this.stats.total_attempts > 0
                ? (this.stats.correct / this.stats.total_attempts * 100).toFixed(1) + '%'
                : 'N/A',
            last_session: this.stats.last_session,
            sessions: this.stats.sessions,
            is_running: this.isRunning
        };
    }

    /**
     * Run a single practice session with practiceCount exercises
     * @param {string} userId - User ID for the session
     */
    async _runSession(userId) {
        // Prevent overlapping sessions
        if (this._sessionInProgress) {
            logger.debug('Skipping diet learning session - previous session still in progress');
            return;
        }
        this._sessionInProgress = true;

        try {
            const sessionId = uuidv4();
            const startTime = Date.now();

            logger.info('Starting diet learning session', {
                sessionId,
                userId,
                practice_count: this.practiceCount
            });

            let sessionCorrect = 0;
            let sessionIncorrect = 0;
            let sessionErrors = 0;

            const generator = dietAssessmentGenerator.getInstance(userId);

            for (let i = 0; i < this.practiceCount; i++) {
                try {
                    // Step 1: Generate a diet question
                    const question = await generator.generateQuestion(userId, this._selectDifficulty());

                    if (!question) {
                        sessionErrors++;
                        logger.debug('No diet question generated, skipping', { attempt: i + 1 });
                        continue;
                    }

                    // Step 2: Ask Oggy to estimate nutrition
                    const oggyEstimate = await this._getOggyEstimate(userId, question.food_description);

                    if (!oggyEstimate) {
                        sessionErrors++;
                        logger.debug('Oggy failed to estimate nutrition, skipping', { attempt: i + 1 });
                        continue;
                    }

                    // Step 3: Evaluate the answer
                    const evaluation = generator.evaluateAnswer(question, oggyEstimate);

                    if (evaluation.correct) {
                        sessionCorrect++;
                        this.stats.correct++;
                    } else {
                        sessionIncorrect++;
                        this.stats.incorrect++;

                        // Step 4: Create memory card for wrong answers
                        await this._createCorrectionMemory(userId, question, oggyEstimate, evaluation);
                    }

                    this.stats.total_attempts++;

                    logger.debug('Diet practice attempt completed', {
                        sessionId,
                        attempt: i + 1,
                        correct: evaluation.correct,
                        food: question.food_description.substring(0, 60),
                        errors: evaluation.errors
                    });

                    // Brief delay between attempts
                    await this._sleep(200);
                } catch (error) {
                    sessionErrors++;
                    logger.logError(error, {
                        operation: 'dietSelfDrivenLearning._runSession.attempt',
                        sessionId,
                        attempt: i + 1
                    });
                }
            }

            this.stats.sessions++;
            this.stats.last_session = new Date().toISOString();
            const duration = Date.now() - startTime;
            const totalAttempts = sessionCorrect + sessionIncorrect;
            const accuracy = totalAttempts > 0
                ? (sessionCorrect / totalAttempts * 100)
                : 0;

            logger.info('Diet learning session completed', {
                sessionId,
                userId,
                duration_ms: duration,
                correct: sessionCorrect,
                incorrect: sessionIncorrect,
                errors: sessionErrors,
                accuracy: accuracy.toFixed(1) + '%',
                lifetime_stats: {
                    total_attempts: this.stats.total_attempts,
                    overall_accuracy: this.stats.total_attempts > 0
                        ? (this.stats.correct / this.stats.total_attempts * 100).toFixed(1) + '%'
                        : 'N/A',
                    sessions: this.stats.sessions
                }
            });

            // Record session event
            await this._recordSessionEvent(userId, {
                session_id: sessionId,
                correct: sessionCorrect,
                incorrect: sessionIncorrect,
                errors: sessionErrors,
                accuracy,
                duration_ms: duration
            });
        } finally {
            this._sessionInProgress = false;
        }
    }

    /**
     * Ask Oggy to estimate the nutritional content of a food item
     * Uses providerResolver to get the Oggy adapter
     */
    async _getOggyEstimate(userId, foodDescription) {
        try {
            await costGovernor.checkBudget(500);

            const resolved = await providerResolver.getAdapter(userId, 'oggy');

            const prompt = `Estimate the nutritional content of: ${foodDescription}. Respond with JSON only: {"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0}`;

            const result = await this.openaiBreaker.execute(() =>
                resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a nutrition estimation expert. Estimate the nutritional content of the described food as accurately as possible. Respond with JSON only, no markdown or explanation.'
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 200
                })
            );

            costGovernor.recordUsage(result.tokens_used || 150);

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(jsonStr);

            return {
                calories: parseFloat(parsed.calories) || 0,
                protein_g: parseFloat(parsed.protein_g) || 0,
                carbs_g: parseFloat(parsed.carbs_g) || 0,
                fat_g: parseFloat(parsed.fat_g) || 0,
                fiber_g: parseFloat(parsed.fiber_g) || 0,
                sugar_g: parseFloat(parsed.sugar_g) || 0,
                sodium_mg: parseFloat(parsed.sodium_mg) || 0
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'dietSelfDrivenLearning._getOggyEstimate',
                userId,
                food: foodDescription.substring(0, 60)
            });
            return null;
        }
    }

    /**
     * Create a memory card with the correction when Oggy gets nutrition wrong
     * Posts to memory service to store the learning for future reference
     */
    async _createCorrectionMemory(userId, question, oggyEstimate, evaluation) {
        try {
            const expected = question.expected_nutrition;
            const errors = evaluation.errors;

            // Identify the most-off nutrient for the key learning point
            const errorEntries = [
                { name: 'calories', pct: errors.cal_pct },
                { name: 'protein', pct: errors.pro_pct },
                { name: 'carbs', pct: errors.carb_pct },
                { name: 'fat', pct: errors.fat_pct }
            ];
            const worstError = errorEntries.reduce((worst, curr) =>
                curr.pct > worst.pct ? curr : worst, errorEntries[0]);

            const correctionText = `Correction: "${question.food_description}" actually has ${expected.calories} cal, ${expected.protein_g}g protein, ${expected.carbs_g}g carbs, ${expected.fat_g}g fat. Not ${oggyEstimate.calories} cal, ${oggyEstimate.protein_g}g protein, ${oggyEstimate.carbs_g}g carbs, ${oggyEstimate.fat_g}g fat. Key: ${worstError.name} was ${worstError.pct}% off.`;

            await axios.post(
                `${MEMORY_SERVICE_URL}/store`,
                {
                    owner_type: 'user',
                    owner_id: userId,
                    tier: 2,
                    kind: 'diet_nutrition_correction',
                    content: {
                        type: 'CORRECTION',
                        text: correctionText,
                        food_description: question.food_description,
                        expected: expected,
                        estimated: oggyEstimate,
                        errors: evaluation.errors,
                        worst_nutrient: worstError.name,
                        source: question.source
                    },
                    tags: ['diet', 'nutrition', 'training', 'correction', worstError.name],
                    utility_weight: 0.8,
                    reliability: 0.9
                },
                {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                }
            );

            logger.debug('Created diet correction memory card', {
                food: question.food_description.substring(0, 60),
                worst_nutrient: worstError.name,
                worst_error_pct: worstError.pct
            });
        } catch (error) {
            logger.warn('Failed to create diet correction memory', {
                error: error.message,
                food: question.food_description.substring(0, 60)
            });
        }
    }

    /**
     * Record the session event for audit trail
     */
    async _recordSessionEvent(userId, sessionData) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, action, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE)
            `, [
                uuidv4(),
                userId,
                'OGGY_DIET_SELF_PRACTICE',
                'diet_training',
                'nutrition_estimation',
                JSON.stringify({
                    ...sessionData,
                    learning_mode: 'diet_self_driven',
                    timestamp: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.warn('Failed to record diet practice event', {
                error: error.message
            });
        }
    }

    /**
     * Select a random difficulty level, weighted toward medium
     */
    _selectDifficulty() {
        const rand = Math.random();
        if (rand < 0.15) return 1;
        if (rand < 0.40) return 2;
        if (rand < 0.70) return 3;
        if (rand < 0.90) return 4;
        return 5;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Per-user instance registry
const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new DietSelfDrivenLearning());
    }
    return instances.get(userId);
}

module.exports = { getInstance, DietSelfDrivenLearning };
