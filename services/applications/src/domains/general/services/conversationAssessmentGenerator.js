/**
 * Conversation Assessment Generator
 * Generates practice questions for conversation quality training.
 * Tests Oggy's ability to retain context, respect preferences, and provide helpful responses.
 *
 * Practice type distribution (configurable):
 *   40% Context retention  - recall facts from user's recent chat history
 *   30% Preference adherence - respect user's stored preferences
 *   30% General helpfulness - reasoning and instruction following
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');
const { costGovernor } = require('../../../shared/middleware/costGovernor');

// Practice type weights (must sum to 1.0)
const PRACTICE_TYPE_WEIGHTS = {
    context_retention: 0.40,
    preference_adherence: 0.30,
    general_helpfulness: 0.30
};

// Score threshold: score >= 4 is considered "correct"
const CORRECT_THRESHOLD = 4;

class ConversationAssessmentGenerator {
    constructor() {
        this.practiceTypeWeights = { ...PRACTICE_TYPE_WEIGHTS };
    }

    /**
     * Generate a single practice question for conversation quality training.
     * @param {string} userId - The user to generate a question for
     * @param {number} difficulty - Difficulty level 1-5
     * @returns {object} Practice question object
     */
    async generateQuestion(userId, difficulty = 3) {
        const practiceType = this._selectPracticeType();

        logger.debug('Generating conversation practice question', {
            userId,
            practiceType,
            difficulty
        });

        try {
            switch (practiceType) {
                case 'context_retention':
                    return await this._generateContextRetentionQuestion(userId, difficulty);
                case 'preference_adherence':
                    return await this._generatePreferenceAdherenceQuestion(userId, difficulty);
                case 'general_helpfulness':
                    return await this._generateGeneralHelpfulnessQuestion(userId, difficulty);
                default:
                    return await this._generateGeneralHelpfulnessQuestion(userId, difficulty);
            }
        } catch (error) {
            logger.logError(error, {
                operation: 'generateQuestion',
                userId,
                practiceType,
                difficulty
            });

            // Fallback to general helpfulness if specific type fails
            if (practiceType !== 'general_helpfulness') {
                logger.warn('Falling back to general helpfulness question', { originalType: practiceType });
                return await this._generateGeneralHelpfulnessQuestion(userId, difficulty);
            }

            throw error;
        }
    }

    /**
     * Evaluate Oggy's answer to a practice question using LLM-as-judge.
     * @param {object} question - The practice question object
     * @param {string} oggyAnswer - Oggy's response text
     * @param {string} userId - The user ID for provider resolution
     * @returns {{ correct: boolean, score: number, feedback: string }}
     */
    async evaluateAnswer(question, oggyAnswer, userId) {
        await costGovernor.checkBudget(2000);

        const judgePrompt = this._buildJudgePrompt(question, oggyAnswer);

        try {
            const resolved = await providerResolver.getAdapter(userId, 'oggy');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are an impartial judge evaluating an AI assistant's response quality.
You must evaluate the response on a scale of 1-5 and provide specific feedback.
Return ONLY valid JSON with no additional text.`
                    },
                    { role: 'user', content: judgePrompt }
                ],
                temperature: 0.2, // Low temperature for consistent evaluation
                max_tokens: 500
            });

            const tokensUsed = result.tokens_used || Math.ceil((judgePrompt.length + (result.text || '').length) / 4);
            costGovernor.recordUsage(tokensUsed);
            providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'conversationAssessment', tokensUsed, result.latency_ms, true, null);

            // Parse judge response
            const evaluation = this._parseJudgeResponse(result.text);

            logger.debug('Conversation answer evaluated', {
                userId,
                questionType: question.type,
                score: evaluation.score,
                correct: evaluation.score >= CORRECT_THRESHOLD
            });

            return {
                correct: evaluation.score >= CORRECT_THRESHOLD,
                score: evaluation.score,
                feedback: evaluation.feedback
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'evaluateAnswer',
                userId,
                questionType: question.type
            });

            // Conservative fallback: assume incorrect on evaluation failure
            return {
                correct: false,
                score: 0,
                feedback: `Evaluation failed: ${error.message}`
            };
        }
    }

    // ─── Context Retention Questions ───────────────────────────────────

    /**
     * Generate a question that tests whether Oggy recalls facts from recent chat history.
     * Pulls a key fact from v2_project_messages and generates a follow-up question.
     */
    async _generateContextRetentionQuestion(userId, difficulty) {
        // Pull recent messages from the user's chat history
        const messagesResult = await query(`
            SELECT content, role, created_at, project_id
            FROM v2_project_messages
            WHERE user_id = $1
              AND role = 'user'
              AND content IS NOT NULL
              AND LENGTH(content) > 20
            ORDER BY created_at DESC
            LIMIT 20
        `, [userId]);

        if (messagesResult.rows.length === 0) {
            logger.debug('No chat history found, falling back to general helpfulness', { userId });
            return await this._generateGeneralHelpfulnessQuestion(userId, difficulty);
        }

        // Select a random message from recent history
        const messages = messagesResult.rows;
        const selectedIndex = Math.floor(Math.random() * Math.min(messages.length, 10));
        const selectedMessage = messages[selectedIndex];

        // Build context window around the selected message
        const contextMessages = messages.slice(
            Math.max(0, selectedIndex - 3),
            Math.min(messages.length, selectedIndex + 3)
        ).map(m => ({
            role: m.role,
            content: m.content
        }));

        // Use LLM to generate a follow-up question based on the chat excerpt
        await costGovernor.checkBudget(1500);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const generationResult = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You generate practice questions for evaluating an AI assistant's context retention.
Given a user's chat history excerpt, create a follow-up question that tests whether the assistant remembers key facts.
Difficulty: ${difficulty}/5 (higher = more subtle references, lower = direct recall).
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Chat history excerpt:
${contextMessages.map(m => `${m.role}: ${m.content}`).join('\n')}

Generate a follow-up question that tests context retention at difficulty ${difficulty}/5.

Return JSON:
{
  "prompt": "The user's follow-up question that references something from the conversation",
  "expected_behavior": "What the assistant should recall/reference in its answer",
  "evaluation_criteria": "Specific criterion for judging the response",
  "key_fact": "The specific fact from history that should be recalled"
}`
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const tokensUsed = generationResult.tokens_used || 500;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'conversationAssessmentGen', tokensUsed, generationResult.latency_ms, true, null);

        const parsed = this._safeParseJson(generationResult.text);

        return {
            type: 'context_retention',
            prompt: parsed.prompt || `Can you remind me what we discussed recently?`,
            context: contextMessages,
            expected_behavior: parsed.expected_behavior || 'Should reference recent conversation topics',
            evaluation_criteria: parsed.evaluation_criteria || 'mentions_relevant_context',
            difficulty,
            key_fact: parsed.key_fact || selectedMessage.content.substring(0, 100),
            metadata: {
                source_message_date: selectedMessage.created_at,
                project_id: selectedMessage.project_id
            }
        };
    }

    // ─── Preference Adherence Questions ────────────────────────────────

    /**
     * Generate a question that tests whether Oggy respects the user's preferences.
     * Pulls from v2_preference_events table.
     */
    async _generatePreferenceAdherenceQuestion(userId, difficulty) {
        // Pull user preferences
        const prefResult = await query(`
            SELECT preference_type, preference_key, preference_value, created_at
            FROM v2_preference_events
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 10
        `, [userId]);

        if (prefResult.rows.length === 0) {
            logger.debug('No preferences found, falling back to general helpfulness', { userId });
            return await this._generateGeneralHelpfulnessQuestion(userId, difficulty);
        }

        // Select a random preference
        const preferences = prefResult.rows;
        const selectedPref = preferences[Math.floor(Math.random() * preferences.length)];

        // Use LLM to generate a scenario that tests preference adherence
        await costGovernor.checkBudget(1500);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const generationResult = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You generate practice scenarios for evaluating an AI assistant's preference adherence.
Given a user preference, create a scenario that tests whether the assistant respects it.
Difficulty: ${difficulty}/5 (higher = more subtle/implicit preference testing).
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `User preference:
- Type: ${selectedPref.preference_type}
- Key: ${selectedPref.preference_key}
- Value: ${selectedPref.preference_value}

Generate a scenario at difficulty ${difficulty}/5 that tests if the assistant respects this preference.

Return JSON:
{
  "prompt": "A user message/request where the preference should influence the response",
  "expected_behavior": "How the assistant should adapt its response to honor the preference",
  "evaluation_criteria": "Specific criterion for judging preference adherence"
}`
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const tokensUsed = generationResult.tokens_used || 500;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'conversationAssessmentGen', tokensUsed, generationResult.latency_ms, true, null);

        const parsed = this._safeParseJson(generationResult.text);

        return {
            type: 'preference_adherence',
            prompt: parsed.prompt || `Help me with a task.`,
            context: [],
            expected_behavior: parsed.expected_behavior || `Should respect preference: ${selectedPref.preference_key} = ${selectedPref.preference_value}`,
            evaluation_criteria: parsed.evaluation_criteria || 'prefers_user_style',
            difficulty,
            preference: {
                type: selectedPref.preference_type,
                key: selectedPref.preference_key,
                value: selectedPref.preference_value
            },
            metadata: {
                preference_date: selectedPref.created_at
            }
        };
    }

    // ─── General Helpfulness Questions ─────────────────────────────────

    /**
     * Generate an AI-created question testing reasoning and instruction following.
     */
    async _generateGeneralHelpfulnessQuestion(userId, difficulty) {
        await costGovernor.checkBudget(1500);

        const difficultyDescriptions = {
            1: 'Simple factual question or straightforward instruction',
            2: 'Moderate reasoning required, clear instructions with some nuance',
            3: 'Multi-step reasoning, requires thoughtful analysis',
            4: 'Complex scenario with subtle requirements and edge cases',
            5: 'Ambiguous request requiring careful interpretation and nuanced response'
        };

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const generationResult = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You generate practice questions for evaluating an AI assistant's general helpfulness.
Create diverse questions testing reasoning, instruction following, and communication quality.
Difficulty: ${difficulty}/5 - ${difficultyDescriptions[difficulty] || difficultyDescriptions[3]}.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Generate a practice question at difficulty ${difficulty}/5 for testing general AI helpfulness.

Topics can include: coding help, writing assistance, analysis, brainstorming, explanations, comparisons, planning, problem-solving.

Return JSON:
{
  "prompt": "The user's question or request",
  "expected_behavior": "What a high-quality response should include",
  "evaluation_criteria": "Specific criteria for judging helpfulness and accuracy"
}`
                }
            ],
            temperature: 0.9, // High creativity for diverse questions
            max_tokens: 500
        });

        const tokensUsed = generationResult.tokens_used || 500;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'conversationAssessmentGen', tokensUsed, generationResult.latency_ms, true, null);

        const parsed = this._safeParseJson(generationResult.text);

        return {
            type: 'general_helpfulness',
            prompt: parsed.prompt || 'Explain the trade-offs between REST and GraphQL APIs.',
            context: [],
            expected_behavior: parsed.expected_behavior || 'Should provide a clear, accurate, and well-structured response',
            evaluation_criteria: parsed.evaluation_criteria || 'helpful_and_accurate',
            difficulty,
            metadata: {}
        };
    }

    // ─── Judge Prompt ──────────────────────────────────────────────────

    /**
     * Build the LLM-as-judge evaluation prompt.
     */
    _buildJudgePrompt(question, oggyAnswer) {
        let typeSpecificCriteria = '';

        switch (question.type) {
            case 'context_retention':
                typeSpecificCriteria = `
CONTEXT RETENTION EVALUATION:
- The assistant was given prior conversation context and should recall/reference specific facts.
- Key fact to recall: ${question.key_fact || 'See expected behavior'}
- Prior context was provided: ${question.context?.length || 0} messages
- Higher scores if the assistant naturally weaves recalled information into its response.
- Lower scores if the assistant ignores or contradicts the conversation history.`;
                break;

            case 'preference_adherence':
                typeSpecificCriteria = `
PREFERENCE ADHERENCE EVALUATION:
- The user has a known preference: ${question.preference?.key} = ${question.preference?.value}
- The assistant should adapt its response to honor this preference.
- Higher scores if the response clearly reflects the preference without being asked.
- Lower scores if the response ignores or contradicts the preference.`;
                break;

            case 'general_helpfulness':
                typeSpecificCriteria = `
GENERAL HELPFULNESS EVALUATION:
- Judge the response on accuracy, clarity, completeness, and usefulness.
- Higher scores for well-structured, thorough, and actionable responses.
- Lower scores for vague, incorrect, or unhelpful responses.`;
                break;
        }

        return `Evaluate the following AI assistant response.

QUESTION TYPE: ${question.type}
DIFFICULTY: ${question.difficulty}/5

USER PROMPT:
${question.prompt}

EXPECTED BEHAVIOR:
${question.expected_behavior}

EVALUATION CRITERIA:
${question.evaluation_criteria}
${typeSpecificCriteria}

ASSISTANT'S RESPONSE:
${oggyAnswer}

Score the response 1-5:
1 = Completely wrong, irrelevant, or harmful
2 = Partially addresses the question but significant issues
3 = Adequate response but misses key elements
4 = Good response that meets most criteria
5 = Excellent response that fully meets all criteria

Return ONLY valid JSON:
{
  "score": <1-5>,
  "feedback": "Specific explanation of what was good/bad and why this score"
}`;
    }

    // ─── Utility Methods ───────────────────────────────────────────────

    /**
     * Select a practice type based on configured weights.
     */
    _selectPracticeType() {
        const rand = Math.random();
        let cumulative = 0;

        for (const [type, weight] of Object.entries(this.practiceTypeWeights)) {
            cumulative += weight;
            if (rand < cumulative) {
                return type;
            }
        }

        // Fallback (shouldn't happen if weights sum to 1)
        return 'general_helpfulness';
    }

    /**
     * Safely parse JSON from LLM output, with fallback repair.
     */
    _safeParseJson(text) {
        if (!text) return {};

        try {
            // Strip markdown code blocks
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            return JSON.parse(cleaned);
        } catch (e1) {
            try {
                // Try extracting JSON object from surrounding text
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return JSON.parse(match[0]);
                }
            } catch (e2) {
                logger.warn('Failed to parse LLM JSON response', {
                    error: e2.message,
                    raw: text.substring(0, 200)
                });
            }
        }

        return {};
    }

    /**
     * Parse the judge's evaluation response.
     */
    _parseJudgeResponse(text) {
        const parsed = this._safeParseJson(text);

        const score = parseInt(parsed.score, 10);
        if (isNaN(score) || score < 1 || score > 5) {
            logger.warn('Invalid judge score, defaulting to 2', { raw: text?.substring(0, 200) });
            return { score: 2, feedback: parsed.feedback || 'Unable to parse evaluation score' };
        }

        return {
            score,
            feedback: parsed.feedback || 'No detailed feedback provided'
        };
    }
}

// ─── Per-user Instance Registry ────────────────────────────────────────

const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new ConversationAssessmentGenerator());
    }
    return instances.get(userId);
}

module.exports = { getInstance, ConversationAssessmentGenerator };
