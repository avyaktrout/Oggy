/**
 * Conversation Benchmark Evaluator
 * Tests Oggy (with memories) vs Base (without memories) on sealed conversation benchmarks.
 * Uses LLM-as-judge to evaluate both responses on:
 *   - context_awareness (1-5)
 *   - preference_alignment (1-5)
 *   - helpfulness (1-5)
 *
 * A scenario is "correct" if the average score across criteria >= 4.
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

        // Retrieve Oggy's memories for this scenario
        const memories = await this._retrieveMemories(userId, prompt);

        // Generate Oggy response (WITH memories)
        const oggyResponse = await this._generateOggyResponse(userId, prompt, memories, scenario);

        // Generate Base response (WITHOUT memories)
        const baseResponse = await this._generateBaseResponse(userId, prompt, scenario);

        // Use LLM-as-judge to evaluate both responses
        const oggyEval = await this._judgeResponse(userId, prompt, oggyResponse, expectedBehavior, scenarioType, 'oggy');
        const baseEval = await this._judgeResponse(userId, prompt, baseResponse, expectedBehavior, scenarioType, 'base');

        return {
            scenario_id: scenario.scenario_id,
            scenario_type: scenarioType,
            prompt,
            oggy: {
                response: oggyResponse.substring(0, 500),
                scores: oggyEval.scores,
                avg_score: oggyEval.avg_score,
                correct: oggyEval.avg_score >= CORRECT_THRESHOLD,
                feedback: oggyEval.feedback,
                memory_count: memories.length
            },
            base: {
                response: baseResponse.substring(0, 500),
                scores: baseEval.scores,
                avg_score: baseEval.avg_score,
                correct: baseEval.avg_score >= CORRECT_THRESHOLD,
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
            const response = await axios.get(`${MEMORY_SERVICE_URL}/retrieve`, {
                params: {
                    user_id: userId,
                    query: promptText,
                    tags: 'general,conversation',
                    top_k: 5
                },
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
                max_tokens: 800
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
     */
    async _generateBaseResponse(userId, prompt, scenario) {
        await costGovernor.checkBudget(2000);

        const systemPrompt = 'You are a helpful AI assistant.';

        const messages = [{ role: 'system', content: systemPrompt }];

        // Include conversation context from scenario (base still gets the conversation flow, just no memories)
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
            const resolved = await providerResolver.getAdapter(userId, 'base');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages,
                temperature: 0.7,
                max_tokens: 800
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
    async _judgeResponse(userId, prompt, response, expectedBehavior, scenarioType, role) {
        await costGovernor.checkBudget(2000);

        const judgePrompt = `Evaluate the following AI assistant response on three criteria.

SCENARIO TYPE: ${scenarioType}
ROLE BEING EVALUATED: ${role}

USER PROMPT:
${prompt}

EXPECTED BEHAVIOR:
${expectedBehavior.expected_behavior || 'Provide a helpful, accurate response'}

EVALUATION CRITERIA:
${expectedBehavior.evaluation_criteria || 'general_quality'}

ASSISTANT RESPONSE:
${response}

Score each criterion 1-5:

1. **context_awareness**: Does the response show awareness of relevant context, prior conversations, or situational details?
   - 1 = Completely ignores context
   - 5 = Perfectly incorporates all relevant context

2. **preference_alignment**: Does the response respect known user preferences (tone, format, style, etc.)?
   - 1 = Violates preferences
   - 5 = Perfectly aligns with preferences

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
                max_tokens: 400
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
