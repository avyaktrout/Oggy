/**
 * Conversation Self-Driven Learning Service
 * Enables Oggy to autonomously practice and improve conversation quality by:
 *   1. Generating practice questions (context retention, preference adherence, helpfulness)
 *   2. Retrieving relevant memories to build an informed response
 *   3. Producing a response with injected memory context
 *   4. Evaluating the response via LLM-as-judge
 *   5. Creating memory cards for improvement areas when performance is weak
 *
 * Mirrors the selfDrivenLearning.js pattern for payment categorization.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/utils/logger');
const { query } = require('../../../shared/utils/db');
const providerResolver = require('../../../shared/providers/providerResolver');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const { getInstance: getAssessmentInstance } = require('./conversationAssessmentGenerator');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const LEARNING_INTERVAL_MS = parseInt(process.env.CONVERSATION_LEARNING_INTERVAL_MS || '600000', 10); // 10 min default

class ConversationSelfDrivenLearning {
    constructor() {
        this.isRunning = false;
        this.intervalHandle = null;
        this.userId = null;
        this.practiceCount = 3;
        this._sessionInProgress = false;

        this.stats = {
            total_attempts: 0,
            correct: 0,
            accuracy: 0,
            last_session: null
        };
    }

    /**
     * Start the autonomous conversation learning loop.
     * @param {string} userId - The user to train for
     * @param {object} options - Configuration options
     */
    start(userId, options = {}) {
        if (this.isRunning) {
            logger.warn('Conversation self-driven learning already running', { userId });
            return;
        }

        const {
            interval = LEARNING_INTERVAL_MS,
            practiceCount = 3,
            enabled = true
        } = options;

        if (!enabled) {
            logger.info('Conversation self-driven learning is disabled');
            return;
        }

        this.isRunning = true;
        this.userId = userId;
        this.practiceCount = practiceCount;

        // Reset stats for fresh session
        this.stats = {
            total_attempts: 0,
            correct: 0,
            accuracy: 0,
            last_session: null
        };

        logger.info('Starting conversation self-driven learning', {
            userId,
            interval_ms: interval,
            practice_count_per_session: practiceCount
        });

        // Run immediately, then at interval
        this._runSession(userId);

        this.intervalHandle = setInterval(async () => {
            await this._runSession(userId);
        }, interval);
    }

    /**
     * Stop the autonomous learning loop.
     */
    stop() {
        if (!this.isRunning) {
            return;
        }

        logger.info('Stopping conversation self-driven learning', {
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
     * Get current learning statistics.
     */
    getStats() {
        return {
            total_attempts: this.stats.total_attempts,
            correct: this.stats.correct,
            accuracy: this.stats.total_attempts > 0
                ? parseFloat((this.stats.correct / this.stats.total_attempts).toFixed(3))
                : 0,
            last_session: this.stats.last_session,
            is_running: this.isRunning
        };
    }

    /**
     * Run a single learning session with practiceCount exercises.
     * @param {string} userId - The user to train for
     */
    async _runSession(userId) {
        // Prevent overlapping sessions
        if (this._sessionInProgress) {
            logger.debug('Skipping conversation learning session - previous still in progress');
            return;
        }
        this._sessionInProgress = true;

        const sessionId = uuidv4();
        const startTime = Date.now();
        let sessionCorrect = 0;
        let sessionErrors = 0;

        try {
            logger.info('Starting conversation learning session', {
                sessionId,
                userId,
                practice_count: this.practiceCount
            });

            const assessmentGen = getAssessmentInstance(userId);

            for (let i = 0; i < this.practiceCount; i++) {
                try {
                    // Step 1: Generate a practice question
                    const difficulty = this._selectDifficulty();
                    const question = await assessmentGen.generateQuestion(userId, difficulty);

                    if (!question) {
                        logger.warn('No question generated, skipping', { sessionId, attempt: i + 1 });
                        continue;
                    }

                    // Step 2: Retrieve Oggy's memories relevant to the question
                    const memories = await this._retrieveMemories(userId, question.prompt);

                    // Step 3: Generate Oggy's response with memory-enhanced context
                    const oggyAnswer = await this._generateOggyResponse(userId, question, memories);

                    // Step 4: Evaluate the response
                    const evaluation = await assessmentGen.evaluateAnswer(question, oggyAnswer, userId);

                    // Track stats
                    this.stats.total_attempts++;
                    if (evaluation.correct) {
                        sessionCorrect++;
                        this.stats.correct++;
                    }

                    logger.debug('Conversation practice attempt completed', {
                        sessionId,
                        attempt: i + 1,
                        questionType: question.type,
                        score: evaluation.score,
                        correct: evaluation.correct
                    });

                    // Step 5: If wrong (score < 4), create memory card for improvement area
                    if (!evaluation.correct) {
                        await this._createImprovementMemory(userId, question, oggyAnswer, evaluation);
                    }

                    // Record practice event for audit trail
                    await this._recordPracticeEvent(userId, sessionId, {
                        question_type: question.type,
                        difficulty: question.difficulty,
                        score: evaluation.score,
                        correct: evaluation.correct,
                        feedback: evaluation.feedback
                    });

                    // Brief delay between attempts
                    await this._sleep(300);
                } catch (attemptError) {
                    sessionErrors++;
                    logger.logError(attemptError, {
                        operation: 'conversationPracticeAttempt',
                        sessionId,
                        attempt: i + 1
                    });
                }
            }

            const duration = Date.now() - startTime;
            const sessionAttempts = this.practiceCount - sessionErrors;
            const sessionAccuracy = sessionAttempts > 0
                ? (sessionCorrect / sessionAttempts * 100).toFixed(1)
                : '0.0';

            this.stats.last_session = new Date().toISOString();

            logger.info('Conversation learning session completed', {
                sessionId,
                userId,
                duration_ms: duration,
                correct: sessionCorrect,
                total_attempted: sessionAttempts,
                errors: sessionErrors,
                session_accuracy: sessionAccuracy + '%',
                lifetime_stats: {
                    total_attempts: this.stats.total_attempts,
                    overall_accuracy: this.stats.total_attempts > 0
                        ? (this.stats.correct / this.stats.total_attempts * 100).toFixed(1) + '%'
                        : 'N/A'
                }
            });
        } catch (error) {
            logger.logError(error, {
                operation: '_runSession',
                sessionId,
                userId
            });
        } finally {
            this._sessionInProgress = false;
        }
    }

    // ─── Memory Retrieval ──────────────────────────────────────────────

    /**
     * Retrieve Oggy's memories relevant to the practice question.
     * GET http://memory:3000/retrieve?user_id=...&query=...&tags=general,conversation&top_k=5
     */
    async _retrieveMemories(userId, questionPrompt) {
        try {
            const response = await axios.get(`${MEMORY_SERVICE_URL}/retrieve`, {
                params: {
                    user_id: userId,
                    query: questionPrompt,
                    tags: 'general,conversation',
                    top_k: 5
                },
                timeout: 5000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });

            const memories = response.data?.selected || response.data?.cards || [];

            logger.debug('Retrieved memories for practice', {
                userId,
                count: memories.length,
                query_preview: questionPrompt.substring(0, 80)
            });

            return memories;
        } catch (error) {
            logger.warn('Memory retrieval failed during conversation practice', {
                userId,
                error: error.message
            });
            return [];
        }
    }

    // ─── Oggy Response Generation ──────────────────────────────────────

    /**
     * Generate Oggy's response with retrieved memories injected into the system prompt.
     */
    async _generateOggyResponse(userId, question, memories) {
        await costGovernor.checkBudget(2000);

        // Build memory context for the system prompt
        const memoryContext = memories.length > 0
            ? memories.map((m, i) => `${i + 1}. ${m.content?.text || JSON.stringify(m.content)}`).join('\n')
            : 'No previous context available.';

        const systemPrompt = `You are Oggy, a helpful AI assistant. You remember previous conversations and learn from interactions.

# Learned Context
${memoryContext}

Respond helpfully and naturally. If you recall relevant information from past conversations, use it.
When you have relevant context from memory, incorporate it naturally into your response.`;

        // Build messages array including any prior context from the question
        const messages = [
            { role: 'system', content: systemPrompt }
        ];

        // Add conversation context if available (for context_retention questions)
        if (question.context && question.context.length > 0) {
            for (const msg of question.context) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }

        // Add the actual question
        messages.push({ role: 'user', content: question.prompt });

        try {
            const resolved = await providerResolver.getAdapter(userId, 'oggy');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.7,
                max_tokens: 800
            });

            const tokensUsed = result.tokens_used || Math.ceil((systemPrompt.length + question.prompt.length + (result.text || '').length) / 4);
            costGovernor.recordUsage(tokensUsed);
            providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'conversationPractice', tokensUsed, result.latency_ms, true, null);

            return result.text || '';
        } catch (error) {
            logger.logError(error, {
                operation: '_generateOggyResponse',
                userId,
                questionType: question.type
            });
            return `[Response generation failed: ${error.message}]`;
        }
    }

    // ─── Improvement Memory ────────────────────────────────────────────

    /**
     * Create a memory card capturing what Oggy should improve on.
     * Only called when score < 4 (incorrect response).
     */
    async _createImprovementMemory(userId, question, oggyAnswer, evaluation) {
        try {
            const improvementText = this._buildImprovementText(question, oggyAnswer, evaluation);

            await axios.post(
                `${MEMORY_SERVICE_URL}/store`,
                {
                    owner_type: 'user',
                    owner_id: userId,
                    tier: 2, // short-term memory
                    kind: 'conversation_improvement',
                    content: {
                        type: 'CORRECTION',
                        text: improvementText,
                        question_type: question.type,
                        score: evaluation.score,
                        feedback: evaluation.feedback,
                        expected_behavior: question.expected_behavior,
                        source: 'conversation_self_learning'
                    },
                    tags: ['general', 'conversation', 'improvement', question.type],
                    utility_weight: 0.7,
                    reliability: 0.8
                },
                {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                }
            );

            logger.info('Created improvement memory from conversation practice', {
                userId,
                questionType: question.type,
                score: evaluation.score
            });
        } catch (error) {
            logger.warn('Failed to create improvement memory', {
                userId,
                error: error.message,
                questionType: question.type
            });
        }
    }

    /**
     * Build a concise improvement description for the memory card.
     */
    _buildImprovementText(question, oggyAnswer, evaluation) {
        const answerPreview = oggyAnswer.substring(0, 150);
        const feedbackPreview = evaluation.feedback.substring(0, 200);

        switch (question.type) {
            case 'context_retention':
                return `IMPROVEMENT NEEDED (Context Retention, score ${evaluation.score}/5): ` +
                    `When asked "${question.prompt.substring(0, 100)}", Oggy should have recalled: ${question.expected_behavior}. ` +
                    `Instead responded: "${answerPreview}...". Feedback: ${feedbackPreview}`;

            case 'preference_adherence':
                return `IMPROVEMENT NEEDED (Preference Adherence, score ${evaluation.score}/5): ` +
                    `User prefers ${question.preference?.key} = ${question.preference?.value}. ` +
                    `When asked "${question.prompt.substring(0, 100)}", Oggy should have: ${question.expected_behavior}. ` +
                    `Feedback: ${feedbackPreview}`;

            case 'general_helpfulness':
                return `IMPROVEMENT NEEDED (General Helpfulness, score ${evaluation.score}/5): ` +
                    `When asked "${question.prompt.substring(0, 100)}", expected: ${question.expected_behavior}. ` +
                    `Oggy responded: "${answerPreview}...". Feedback: ${feedbackPreview}`;

            default:
                return `IMPROVEMENT NEEDED (score ${evaluation.score}/5): ${feedbackPreview}`;
        }
    }

    // ─── Audit Trail ───────────────────────────────────────────────────

    /**
     * Record a practice event in app_events for audit and analytics.
     */
    async _recordPracticeEvent(userId, sessionId, practiceData) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id, user_id, event_type, entity_type, action, event_data,
                    processed_for_domain_knowledge, processed_for_memory_substrate
                ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE)
            `, [
                uuidv4(),
                userId,
                'OGGY_CONVERSATION_PRACTICE',
                'conversation',
                'evaluate',
                JSON.stringify({
                    session_id: sessionId,
                    ...practiceData,
                    learning_mode: 'conversation_self_driven',
                    timestamp: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.warn('Failed to record conversation practice event', {
                error: error.message,
                sessionId
            });
        }
    }

    // ─── Utility ───────────────────────────────────────────────────────

    /**
     * Select difficulty for the current attempt.
     * Starts moderate and varies randomly.
     */
    _selectDifficulty() {
        const rand = Math.random();
        if (rand < 0.15) return 1;
        if (rand < 0.35) return 2;
        if (rand < 0.65) return 3;
        if (rand < 0.85) return 4;
        return 5;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ─── Per-user Instance Registry ────────────────────────────────────────

const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new ConversationSelfDrivenLearning());
    }
    return instances.get(userId);
}

module.exports = { getInstance, ConversationSelfDrivenLearning };
