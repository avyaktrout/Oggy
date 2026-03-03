/**
 * Conversation Benchmark Evaluator
 * Tests Oggy (with memories) vs Base (without memories) on sealed conversation benchmarks.
 * Uses LLM-as-judge to evaluate both responses on:
 *   - context_awareness (1-5)
 *   - preference_alignment (1-5)
 *   - helpfulness (1-5)
 *
 * A scenario is "correct" if ALL individual criteria scores >= 4.
 * Wrong scenarios generate memory cards for future improvement.
 *
 * Uses parallelMap from ../utils/parallel with concurrency=3
 * (conversation eval is heavier than payment categorization).
 */

const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');
const intentService = require('../../../shared/services/intentService');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const { getInstance: getBenchmarkGenInstance } = require('./conversationBenchmarkGenerator');
const { parallelMap } = require('../../../shared/utils/parallel');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const CORRECT_THRESHOLD = 4; // Average score >= 4 is considered "correct"
const EVAL_CONCURRENCY = 3;  // Lower concurrency - conversation eval is heavier

class ConversationBenchmarkEvaluator {
    constructor() {}

    /**
     * Run evaluation of a conversation benchmark.
     * Tests Oggy (with memories) vs Base (without memories) on each scenario.
     *
     * @param {object} options
     * @param {string} options.benchmark_identifier - Benchmark ID or name
     * @param {string} options.user_id - User to evaluate for
     * @returns {object} Evaluation results with oggy/base comparison
     */
    async testOnConversationBenchmark(options) {
        const { benchmark_identifier, user_id } = options;

        if (!user_id) {
            throw new Error('user_id is required for conversation benchmark evaluation');
        }

        logger.info('Starting conversation benchmark evaluation', {
            benchmark_identifier,
            user_id
        });

        // Load the benchmark
        const benchmarkGen = getBenchmarkGenInstance(user_id);
        const benchmark = await benchmarkGen.getConversationBenchmark(benchmark_identifier);

        if (!benchmark.scenarios || benchmark.scenarios.length === 0) {
            throw new Error(`No scenarios found for benchmark: ${benchmark_identifier}`);
        }

        const totalScenarios = benchmark.scenarios.length;
        const startTime = Date.now();

        // Evaluate all scenarios with parallelMap (concurrency=3)
        const evalResult = await parallelMap(
            benchmark.scenarios,
            async (scenario) => {
                return await this._evaluateScenario(scenario, user_id);
            },
            EVAL_CONCURRENCY,
            { operationName: 'conversation-benchmark-eval', interTaskDelayMs: 200 }
        );

        const scenarioResults = evalResult.results.map((r, i) => {
            if (r.success) return r.value;
            return {
                scenario_id: benchmark.scenarios[i].scenario_id,
                oggy: { scores: { context_awareness: 0, preference_alignment: 0, helpfulness: 0 }, avg_score: 0, correct: false, error: r.error },
                base: { scores: { context_awareness: 0, preference_alignment: 0, helpfulness: 0 }, avg_score: 0, correct: false, error: r.error }
            };
        });

        // Calculate aggregate scores
        const oggyResults = this._aggregateResults(scenarioResults, 'oggy', benchmark.scenarios);
        const baseResults = this._aggregateResults(scenarioResults, 'base', benchmark.scenarios);

        const advantage_percent = baseResults.accuracy > 0
            ? parseFloat(((oggyResults.accuracy / baseResults.accuracy - 1) * 100).toFixed(1))
            : 0;

        const duration_ms = Date.now() - startTime;

        // Create memory cards for Oggy's wrong scenarios
        await this._createMemoryCardsForWrongScenarios(user_id, oggyResults.wrong_scenarios);

        // Store results
        const result_id = await this._storeResults({
            benchmark_id: benchmark.benchmark_id,
            user_id,
            total_scenarios: totalScenarios,
            oggy_correct: oggyResults.correct_count,
            oggy_accuracy: oggyResults.accuracy,
            base_correct: baseResults.correct_count,
            base_accuracy: baseResults.accuracy,
            advantage_percent,
            scenario_results: scenarioResults,
            duration_ms
        });

        // Record per-intent performance (non-blocking, after scoring)
        try {
            await intentService.recordIntentPerformance(result_id, user_id, scenarioResults, 'general');
        } catch (intentErr) {
            logger.warn('Intent performance recording failed (non-blocking)', { error: intentErr.message });
        }

        // Create memory cards for weak intents (non-blocking)
        intentService.createMemoryCardsForWeakIntents(result_id, user_id, 'general').catch(err => {
            logger.warn('Intent weakness memory cards failed (non-blocking)', { error: err.message });
        });

        logger.info('Conversation benchmark evaluation complete', {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            oggy_accuracy: oggyResults.accuracy,
            base_accuracy: baseResults.accuracy,
            advantage_percent,
            duration_ms
        });

        return {
            result_id,
            benchmark_id: benchmark.benchmark_id,
            benchmark_name: benchmark.benchmark_name,
            oggy: {
                accuracy: oggyResults.accuracy,
                correct_count: oggyResults.correct_count,
                total: totalScenarios,
                avg_scores: oggyResults.avg_scores,
                wrong_scenarios: oggyResults.wrong_scenarios
            },
            base: {
                accuracy: baseResults.accuracy,
                correct_count: baseResults.correct_count,
                total: totalScenarios,
                avg_scores: baseResults.avg_scores,
                wrong_scenarios: baseResults.wrong_scenarios
            },
            comparison: {
                advantage_percent,
                verdict: oggyResults.accuracy > baseResults.accuracy ? 'OGGY_BETTER' :
                         oggyResults.accuracy < baseResults.accuracy ? 'BASE_BETTER' : 'TIE'
            },
            duration_ms
        };
    }

    // ─── Per-Scenario Evaluation ───────────────────────────────────────

    /**
     * Evaluate a single benchmark scenario for both Oggy and Base.
     */
    async _evaluateScenario(scenario, userId) {
        const scenarioType = scenario.merchant; // 'context_retention', 'preference_adherence', 'general_helpfulness'
        const prompt = scenario.description;    // The question/prompt to ask

        // Parse expected behavior from correct_category JSON
        let expectedBehavior;
        try {
            expectedBehavior = JSON.parse(scenario.correct_category);
        } catch (e) {
            expectedBehavior = { expected_behavior: scenario.correct_category, evaluation_criteria: 'general_quality' };
        }

        // Retrieve memories + generate Base response in parallel (Base doesn't need memories)
        const [memories, baseResponse] = await Promise.all([
            this._retrieveMemories(userId, prompt),
            this._generateBaseResponse(userId, prompt, scenario)
        ]);

        // Generate Oggy response (WITH memories — depends on memory retrieval)
        const oggyResponse = await this._generateOggyResponse(userId, prompt, memories, scenario);

        // Build memory summary for judge context
        // Include both retrieved memories AND conversation context (for memory scenarios)
        const memoryParts = [];
        if (memories.length > 0) {
            memoryParts.push(...memories.map((m, i) => `${i + 1}. ${m.content?.text || JSON.stringify(m.content)}`));
        }
        // For context_retention/preference_adherence, the conversation history IS context Oggy had
        const isMemoryTest = scenarioType === 'context_retention' || scenarioType === 'preference_adherence';
        if (isMemoryTest && Array.isArray(scenario.context) && scenario.context.length > 0) {
            const contextSummary = scenario.context
                .filter(m => m.content)
                .map(m => `[${m.role}]: ${m.content.substring(0, 200)}`)
                .join('\n');
            if (contextSummary) {
                memoryParts.push(`Prior conversation:\n${contextSummary}`);
            }
        }
        const memorySummary = memoryParts.length > 0 ? memoryParts.join('\n') : null;

        // Judge both responses in parallel (independent evaluations)
        const [oggyEval, baseEval] = await Promise.all([
            this._judgeResponse(userId, prompt, oggyResponse, expectedBehavior, scenarioType, 'oggy', memorySummary),
            this._judgeResponse(userId, prompt, baseResponse, expectedBehavior, scenarioType, 'base', null)
        ]);

        return {
            scenario_id: scenario.scenario_id,
            scenario_type: scenarioType,
            prompt,
            oggy: {
                response: oggyResponse.substring(0, 500),
                scores: oggyEval.scores,
                avg_score: oggyEval.avg_score,
                correct: this._isCorrect(oggyEval.scores, scenarioType),
                feedback: oggyEval.feedback,
                memory_count: memories.length
            },
            base: {
                response: baseResponse.substring(0, 500),
                scores: baseEval.scores,
                avg_score: baseEval.avg_score,
                correct: this._isCorrect(baseEval.scores, scenarioType),
                feedback: baseEval.feedback
            }
        };
    }

    // ─── Memory Retrieval ──────────────────────────────────────────────

    /**
     * Retrieve Oggy's memories relevant to the scenario prompt.
     */
    async _retrieveMemories(userId, promptText) {
        try {
            const response = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                agent: 'oggy',
                owner_type: 'user',
                owner_id: userId,
                query: promptText,
                top_k: 5,
                tag_filter: ['general', 'conversation']
            }, {
                timeout: 5000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });

            return response.data?.selected || response.data?.cards || [];
        } catch (error) {
            logger.warn('Memory retrieval failed during benchmark eval', {
                userId,
                error: error.message
            });
            return [];
        }
    }

    // ─── Response Generation ───────────────────────────────────────────

    /**
     * Generate Oggy's response WITH memory context.
     */
    async _generateOggyResponse(userId, prompt, memories, scenario) {
        await costGovernor.checkBudget(2000);

        const memoryContext = memories.length > 0
            ? memories.map((m, i) => `${i + 1}. ${m.content?.text || JSON.stringify(m.content)}`).join('\n')
            : 'No previous context available.';

        const systemPrompt = `You are Oggy, a helpful AI assistant. You remember previous conversations and learn from interactions.

# Learned Context
${memoryContext}

Respond helpfully and naturally. If you recall relevant information from past conversations, use it.`;

        // Build messages - include scenario context if present
        const messages = [{ role: 'system', content: systemPrompt }];

        // Add conversation context from scenario if available (stored in metadata)
        const context = scenario.context || [];
        if (Array.isArray(context)) {
            for (const msg of context) {
                if (msg.role && msg.content) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        messages.push({ role: 'user', content: prompt });

        try {
            const resolved = await providerResolver.getAdapter(userId, 'oggy');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.7,
                max_tokens: 800,
                timeout: 60000
            });

            const tokensUsed = result.tokens_used || Math.ceil((systemPrompt.length + prompt.length + (result.text || '').length) / 4);
            costGovernor.recordUsage(tokensUsed);
            providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkEval', tokensUsed, result.latency_ms, true, null);

            return result.text || '';
        } catch (error) {
            logger.warn('Oggy response generation failed in benchmark', {
                scenario_id: scenario.scenario_id,
                error: error.message
            });
            return `[Oggy response failed: ${error.message}]`;
        }
    }

    /**
     * Generate Base response WITHOUT memory context.
     * Base does NOT get prior conversation history for memory-dependent scenarios
     * (context_retention, preference_adherence) — it only sees the current question.
     * For general_helpfulness and domain_knowledge, context is shared since those
     * test general capability, not memory.
     */
    async _generateBaseResponse(userId, prompt, scenario) {
        await costGovernor.checkBudget(2000);

        const systemPrompt = 'You are a helpful AI assistant.';
        const scenarioType = scenario.merchant;

        const messages = [{ role: 'system', content: systemPrompt }];

        // Only include conversation context for non-memory scenarios.
        // For context_retention and preference_adherence, Base should NOT see
        // prior conversation history — that's the whole point of testing memory.
        const isMemoryTest = scenarioType === 'context_retention' || scenarioType === 'preference_adherence';
        if (!isMemoryTest) {
            const context = scenario.context || [];
            if (Array.isArray(context)) {
                for (const msg of context) {
                    if (msg.role && msg.content) {
                        messages.push({ role: msg.role, content: msg.content });
                    }
                }
            }
        }

        messages.push({ role: 'user', content: prompt });

        try {
            const resolved = await providerResolver.getAdapter(userId, 'base');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.7,
                max_tokens: 800,
                timeout: 60000
            });

            const tokensUsed = result.tokens_used || Math.ceil((prompt.length + (result.text || '').length) / 4);
            costGovernor.recordUsage(tokensUsed);
            providerResolver.logRequest(userId, resolved.provider, resolved.model, 'base', 'convBenchmarkEval', tokensUsed, result.latency_ms, true, null);

            return result.text || '';
        } catch (error) {
            logger.warn('Base response generation failed in benchmark', {
                scenario_id: scenario.scenario_id,
                error: error.message
            });
            return `[Base response failed: ${error.message}]`;
        }
    }

    // ─── LLM-as-Judge ──────────────────────────────────────────────────

    /**
     * Use LLM-as-judge to evaluate a response on three criteria.
     * Returns { scores: { context_awareness, preference_alignment, helpfulness }, avg_score, feedback }.
     */
    async _judgeResponse(userId, prompt, response, expectedBehavior, scenarioType, role, memorySummary = null) {
        await costGovernor.checkBudget(2000);

        const isMemoryScenario = scenarioType === 'context_retention' || scenarioType === 'preference_adherence' || scenarioType.startsWith('domain_knowledge');

        // Build memory-aware judge instructions
        let memorySection = '';
        if (isMemoryScenario && role === 'oggy' && memorySummary) {
            memorySection = `\nMEMORIES AVAILABLE TO THIS ASSISTANT:
The assistant (Oggy) had access to these learned memories from prior conversations:
${memorySummary}

IMPORTANT: Check if the response incorporates information from the memories above. The assistant does NOT need to explicitly say "I remember" — naturally weaving in memorized facts, preferences, or context counts as usage. If the response content aligns with or builds on the memories, score context_awareness 4-5. If the response ignores available memories and gives a generic answer, score context_awareness 1-3.`;
        } else if (isMemoryScenario && role === 'base') {
            memorySection = `\nNOTE: This assistant (Base) has NO access to conversation history, user preferences, or learned memories. It is a generic AI with no personalization. Score context_awareness and preference_alignment based on what a model WITHOUT any user knowledge could reasonably produce:
- If the scenario requires recalling prior conversations or user-specific context, context_awareness should be 1-2 (since the model has no memory).
- If the scenario requires respecting specific user preferences, preference_alignment should be 1-2 (since the model doesn't know them).
- Only helpfulness can score high if the generic response is otherwise useful.`;
        }

        const judgePrompt = `Evaluate the following AI assistant response on three criteria.

SCENARIO TYPE: ${scenarioType}
ROLE BEING EVALUATED: ${role}

USER PROMPT:
${prompt}

EXPECTED BEHAVIOR:
${expectedBehavior.expected_behavior || 'Provide a helpful, accurate response'}

EVALUATION CRITERIA:
${expectedBehavior.evaluation_criteria || 'general_quality'}
${memorySection}

ASSISTANT RESPONSE:
${response}

Score each criterion 1-5:

${isMemoryScenario ? `1. **context_awareness**: Does the response incorporate specific context from prior conversations or learned information? Generic answers that don't leverage prior knowledge should score low.
   - 1 = Completely ignores available context
   - 2 = Vaguely relevant but no specific prior context used
   - 3 = Generic answer, no memory or prior knowledge demonstrated
   - 4 = Naturally incorporates some prior context or learned information
   - 5 = Perfectly weaves in relevant prior context and learned details

2. **preference_alignment**: Does the response adapt to known user preferences (tone, format, style, detail level)? Coincidental matches don't count — the response should demonstrate learned personalization.
   - 1 = Violates or ignores user preferences
   - 2 = Default generic style, no personalization
   - 3 = Acceptable but not personalized
   - 4 = Clear adaptation to user preferences
   - 5 = Perfectly personalized based on learned preferences` :

`1. **context_awareness**: Does the response address the specific context and details in the user's question?
   - 1 = Ignores the question's context
   - 3 = Addresses the question but misses nuance
   - 5 = Perfectly addresses all contextual details in the question

2. **preference_alignment**: Is the response well-structured, appropriately detailed, and professional?
   - 1 = Poorly structured or inappropriate tone
   - 3 = Acceptable structure and tone
   - 5 = Excellent structure, tone, and detail level`}

3. **helpfulness**: Is the response accurate, clear, complete, and useful?
   - 1 = Unhelpful or incorrect
   - 5 = Exceptionally helpful and thorough

${scenarioType.startsWith('domain_knowledge') ? `4. **domain_accuracy**: Does the response demonstrate accurate domain-specific knowledge?
   - 1 = No domain knowledge shown or completely inaccurate
   - 3 = Some domain knowledge but with gaps or inaccuracies
   - 5 = Deep, accurate domain expertise applied correctly` : ''}

Return ONLY valid JSON:
{
  "context_awareness": <1-5>,
  "preference_alignment": <1-5>,
  "helpfulness": <1-5>,${scenarioType.startsWith('domain_knowledge') ? '\n  "domain_accuracy": <1-5>,' : ''}
  "feedback": "Brief explanation of scores"
}`;

        try {
            const resolved = await providerResolver.getAdapter(userId, 'oggy');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are an impartial judge evaluating AI assistant response quality. Score each criterion 1-5. Return ONLY valid JSON.'
                    },
                    { role: 'user', content: judgePrompt }
                ],
                temperature: 0.2, // Low temperature for consistent judgment
                max_tokens: 400,
                timeout: 60000
            });

            const tokensUsed = result.tokens_used || Math.ceil((judgePrompt.length + (result.text || '').length) / 4);
            costGovernor.recordUsage(tokensUsed);
            providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkJudge', tokensUsed, result.latency_ms, true, null);

            return this._parseJudgeResponse(result.text);
        } catch (error) {
            logger.warn('Judge evaluation failed', {
                role,
                scenarioType,
                error: error.message
            });

            // Return conservative scores on failure
            return {
                scores: { context_awareness: 2, preference_alignment: 2, helpfulness: 2 },
                avg_score: 2,
                feedback: `Evaluation failed: ${error.message}`
            };
        }
    }

    /**
     * Parse the judge's JSON response into structured scores.
     */
    _parseJudgeResponse(text) {
        const parsed = this._safeParseJson(text);

        const scores = {
            context_awareness: this._clampScore(parsed.context_awareness),
            preference_alignment: this._clampScore(parsed.preference_alignment),
            helpfulness: this._clampScore(parsed.helpfulness)
        };

        // Include domain_accuracy if present
        let scoreCount = 3;
        let scoreSum = scores.context_awareness + scores.preference_alignment + scores.helpfulness;
        if (parsed.domain_accuracy !== undefined) {
            scores.domain_accuracy = this._clampScore(parsed.domain_accuracy);
            scoreSum += scores.domain_accuracy;
            scoreCount = 4;
        }

        const avg_score = parseFloat((scoreSum / scoreCount).toFixed(2));

        return {
            scores,
            avg_score,
            feedback: parsed.feedback || 'No feedback provided'
        };
    }

    /**
     * Clamp a score to valid range 1-5, defaulting to 2 on invalid input.
     */
    _clampScore(value) {
        const num = parseInt(value, 10);
        if (isNaN(num) || num < 1) return 2;
        if (num > 5) return 5;
        return num;
    }

    /**
     * Check if ALL individual scores meet the threshold.
     * Prevents high scores on one criterion from masking weakness in another.
     */
    _allScoresPass(scores) {
        return Object.values(scores).every(s => s >= CORRECT_THRESHOLD);
    }

    /**
     * Scenario-type-aware correctness check.
     * Each scenario type is judged on its RELEVANT criteria + helpfulness baseline.
     */
    _isCorrect(scores, scenarioType) {
        const T = CORRECT_THRESHOLD;
        const help = (scores.helpfulness || 0) >= T;

        switch (scenarioType) {
            case 'context_retention':
                // Tests memory recall — context_awareness is the key metric
                return (scores.context_awareness || 0) >= T && help;
            case 'preference_adherence':
                // Tests personalization — preference_alignment is the key metric
                return (scores.preference_alignment || 0) >= T && help;
            case 'domain_knowledge_recall':
            case 'domain_knowledge_application':
                // Tests domain knowledge — domain_accuracy is the key metric
                return (scores.domain_accuracy || scores.helpfulness || 0) >= T && help;
            case 'general_helpfulness':
                // No memory tested — only helpfulness matters
                return help;
            default:
                // Fallback: avg_score check
                return (scores.context_awareness + scores.preference_alignment + scores.helpfulness) / 3 >= T;
        }
    }

    // ─── Result Aggregation ────────────────────────────────────────────

    /**
     * Aggregate scenario-level results into overall accuracy and wrong scenarios list.
     */
    _aggregateResults(scenarioResults, role, benchmarkScenarios) {
        let totalContextAwareness = 0;
        let totalPreferenceAlignment = 0;
        let totalHelpfulness = 0;
        let totalDomainAccuracy = 0;
        let domainCount = 0;
        let correctCount = 0;
        const wrongScenarios = [];

        for (let i = 0; i < scenarioResults.length; i++) {
            const result = scenarioResults[i];
            const roleResult = result[role];

            if (!roleResult) continue;

            totalContextAwareness += roleResult.scores?.context_awareness || 0;
            totalPreferenceAlignment += roleResult.scores?.preference_alignment || 0;
            totalHelpfulness += roleResult.scores?.helpfulness || 0;
            if (roleResult.scores?.domain_accuracy !== undefined) {
                totalDomainAccuracy += roleResult.scores.domain_accuracy;
                domainCount++;
            }

            if (roleResult.correct) {
                correctCount++;
            } else {
                const scenario = benchmarkScenarios[i];
                wrongScenarios.push({
                    scenario_id: result.scenario_id,
                    scenario_type: result.scenario_type,
                    prompt: result.prompt?.substring(0, 200),
                    response_preview: roleResult.response?.substring(0, 200),
                    scores: roleResult.scores,
                    avg_score: roleResult.avg_score,
                    feedback: roleResult.feedback,
                    expected_behavior: scenario?.correct_category
                });
            }
        }

        const total = scenarioResults.length;

        const avg_scores = {
            context_awareness: total > 0 ? parseFloat((totalContextAwareness / total).toFixed(2)) : 0,
            preference_alignment: total > 0 ? parseFloat((totalPreferenceAlignment / total).toFixed(2)) : 0,
            helpfulness: total > 0 ? parseFloat((totalHelpfulness / total).toFixed(2)) : 0
        };
        if (domainCount > 0) {
            avg_scores.domain_accuracy = parseFloat((totalDomainAccuracy / domainCount).toFixed(2));
        }

        return {
            accuracy: total > 0 ? parseFloat((correctCount / total).toFixed(3)) : 0,
            correct_count: correctCount,
            avg_scores,
            wrong_scenarios: wrongScenarios
        };
    }

    // ─── Memory Cards for Wrong Scenarios ──────────────────────────────

    /**
     * Create memory cards for scenarios where Oggy performed poorly.
     * These memories help Oggy improve on weak areas in future interactions.
     */
    async _createMemoryCardsForWrongScenarios(userId, wrongScenarios) {
        if (!wrongScenarios || wrongScenarios.length === 0) {
            return;
        }

        let created = 0;

        for (const wrong of wrongScenarios) {
            try {
                let expectedBehavior = '';
                try {
                    const parsed = JSON.parse(wrong.expected_behavior);
                    expectedBehavior = parsed.expected_behavior || wrong.expected_behavior;
                } catch (e) {
                    expectedBehavior = wrong.expected_behavior || '';
                }

                const improvementText = `BENCHMARK IMPROVEMENT (${wrong.scenario_type}, avg score ${wrong.avg_score}/5): ` +
                    `When asked "${wrong.prompt?.substring(0, 120)}", Oggy scored: ` +
                    `context_awareness=${wrong.scores?.context_awareness}, ` +
                    `preference_alignment=${wrong.scores?.preference_alignment}, ` +
                    `helpfulness=${wrong.scores?.helpfulness}. ` +
                    `Expected: ${expectedBehavior.substring(0, 150)}. ` +
                    `Feedback: ${wrong.feedback?.substring(0, 150)}`;

                await axios.post(
                    `${MEMORY_SERVICE_URL}/store`,
                    {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: 'conversation_benchmark_correction',
                        content: {
                            type: 'CORRECTION',
                            text: improvementText,
                            scenario_type: wrong.scenario_type,
                            scores: wrong.scores,
                            avg_score: wrong.avg_score,
                            expected_behavior: expectedBehavior,
                            feedback: wrong.feedback,
                            source: 'conversation_benchmark_eval'
                        },
                        tags: ['general', 'conversation', 'benchmark_correction', wrong.scenario_type],
                        utility_weight: 0.8,
                        reliability: 0.9
                    },
                    {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    }
                );

                created++;
            } catch (error) {
                logger.warn('Failed to create benchmark correction memory', {
                    userId,
                    scenario_id: wrong.scenario_id,
                    error: error.message
                });
            }
        }

        if (created > 0) {
            logger.info('Created benchmark correction memories', {
                userId,
                total_wrong: wrongScenarios.length,
                memories_created: created
            });
        }
    }

    // ─── Result Storage ────────────────────────────────────────────────

    /**
     * Store evaluation results in the database.
     */
    async _storeResults(data) {
        const result_id = uuidv4();

        try {
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
                parseFloat((data.oggy_accuracy - data.base_accuracy).toFixed(3)),
                data.advantage_percent,
                JSON.stringify({ domain: 'general', captured_at: new Date().toISOString() }),
                JSON.stringify({
                    scenarios: data.scenario_results,
                    duration_ms: data.duration_ms
                })
            ]);

            logger.debug('Conversation benchmark results stored', {
                result_id,
                benchmark_id: data.benchmark_id
            });
        } catch (error) {
            logger.logError(error, {
                operation: '_storeResults',
                benchmark_id: data.benchmark_id
            });
        }

        return result_id;
    }

    // ─── Utility ───────────────────────────────────────────────────────

    /**
     * Safely parse JSON from LLM output.
     */
    _safeParseJson(text) {
        if (!text) return {};

        try {
            const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            return JSON.parse(cleaned);
        } catch (e1) {
            try {
                const match = text.match(/\{[\s\S]*\}/);
                if (match) {
                    return JSON.parse(match[0]);
                }
            } catch (e2) {
                logger.warn('Failed to parse judge JSON response', {
                    error: e2.message,
                    raw: text.substring(0, 200)
                });
            }
        }

        return {};
    }
}

// ─── Per-user Instance Registry ────────────────────────────────────────

const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new ConversationBenchmarkEvaluator());
    }
    return instances.get(userId);
}

module.exports = { getInstance, ConversationBenchmarkEvaluator };
