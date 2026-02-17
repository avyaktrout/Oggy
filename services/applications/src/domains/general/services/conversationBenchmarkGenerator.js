/**
 * Conversation Benchmark Generator
 * Creates sealed, fixed benchmark sets for evaluating Oggy's conversation quality.
 * Generates scenarios testing context retention, preference adherence, and general helpfulness.
 *
 * Scenario distribution (per benchmark, default 20 scenarios):
 *   40% Context retention  - from user's actual conversation history
 *   30% Preference adherence - from user's preference events
 *   30% General helpfulness  - AI-generated reasoning/instruction tests
 *
 * Scale complexity (conversation-specific):
 *   S1: Simple factual recall, direct instruction following
 *   S2: Multi-turn context, explicit preference adherence
 *   S3: Implicit preferences, subtle context references
 *   S4: Conflicting instructions, nuanced tone matching
 *   S5: Ambiguous requests requiring user model inference
 *
 * Storage: sealed_benchmarks / sealed_benchmark_scenarios with domain='general'
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const providerResolver = require('../../../shared/providers/providerResolver');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const { parallelMap } = require('../../../shared/utils/parallel');

// Scenario type distribution (base: no domain learning active)
const SCENARIO_TYPE_DISTRIBUTION_BASE = {
    context_retention: 0.40,
    preference_adherence: 0.30,
    general_helpfulness: 0.30
};

// Scenario type distribution (with domain learning active)
const SCENARIO_TYPE_DISTRIBUTION_DL = {
    context_retention: 0.25,
    preference_adherence: 0.20,
    general_helpfulness: 0.20,
    domain_knowledge_recall: 0.20,
    domain_knowledge_application: 0.15
};

// Scale complexity definitions (conversation-specific)
const SCALE_COMPLEXITY = {
    1: {
        name: 'S1 - Basic Recall',
        description: 'Simple factual recall, direct instruction following',
        requirements: [
            'Single clear fact to recall',
            'Direct, explicit instructions',
            'Straightforward preference matching'
        ],
        prompt_hint: 'Simple and direct. The expected behavior should be obvious.'
    },
    2: {
        name: 'S2 - Multi-Turn Context',
        description: 'Multi-turn context, explicit preference adherence',
        requirements: [
            'Requires recalling information from 2+ turns ago',
            'Explicit preferences that should be followed',
            'Moderate reasoning about context'
        ],
        prompt_hint: 'Requires reading multiple messages to get the full picture. Preferences are stated directly.'
    },
    3: {
        name: 'S3 - Implicit Signals',
        description: 'Implicit preferences, subtle context references',
        requirements: [
            'Preferences implied but not explicitly stated',
            'Subtle references to prior discussions',
            'Requires inference from conversation patterns'
        ],
        prompt_hint: 'The user implies preferences through behavior, not direct statements. Context references are indirect.'
    },
    4: {
        name: 'S4 - Conflicting Signals',
        description: 'Conflicting instructions, nuanced tone matching',
        requirements: [
            'Multiple potentially conflicting user signals',
            'Tone and style must match user expectations',
            'Requires resolving ambiguity in prior context'
        ],
        prompt_hint: 'Include conflicting signals that require careful judgment. The assistant must pick the right interpretation.'
    },
    5: {
        name: 'S5 - User Model Inference',
        description: 'Ambiguous requests requiring user model inference',
        requirements: [
            'Genuinely ambiguous user requests',
            'Requires building a mental model of the user',
            'Must infer unstated needs from conversation history',
            'Subtle personality/style matching'
        ],
        prompt_hint: 'The user request is deliberately vague. The assistant must infer what the user actually wants based on their history and personality.'
    }
};

class ConversationBenchmarkGenerator {
    constructor() {
        this.scaleComplexity = SCALE_COMPLEXITY;
    }

    /**
     * Create a sealed conversation benchmark.
     * @param {object} options
     * @param {string} options.name - Benchmark name
     * @param {number} options.count - Number of scenarios (default 20)
     * @param {string} options.difficulty_mix - balanced, easy, hard, mixed
     * @param {number} options.scale - Scale level 1-5
     * @param {number} options.level - Difficulty within scale 1-5
     * @param {string} options.userId - User to pull conversation history from
     * @returns {object} Created benchmark summary
     */
    async createConversationBenchmark(options = {}) {
        const {
            name = null,
            count = 20,
            difficulty_mix = 'balanced',
            scale = 2,
            level = 3,
            userId
        } = options;

        if (!userId) {
            throw new Error('userId is required to generate conversation benchmarks');
        }

        const benchmark_id = uuidv4();
        const benchmark_name = name || `conversation_benchmark_${Date.now()}`;
        const scaleConfig = this.scaleComplexity[Math.min(scale, 5)] || this.scaleComplexity[3];

        logger.info('Creating conversation benchmark', {
            benchmark_id,
            benchmark_name,
            count,
            scale,
            level,
            scale_name: scaleConfig.name,
            userId
        });

        // Distribute scenario types
        const scenarioTasks = await this._buildScenarioTasks(count, difficulty_mix, scale, level, userId);

        // Generate scenarios in parallel (5 concurrency to stay within rate limits)
        const parallelResult = await parallelMap(
            scenarioTasks,
            async (task, index) => {
                const scenario = await this._generateScenario(task, userId);
                return {
                    scenario_id: uuidv4(),
                    order_index: index,
                    ...scenario
                };
            },
            5,
            { operationName: 'conversation-benchmark-generation', interTaskDelayMs: 100 }
        );

        const scenarios = parallelResult.results.filter(r => r.success).map(r => r.value);
        const errors = parallelResult.errors;

        if (errors.length > 0) {
            logger.warn('Some conversation benchmark scenarios failed to generate', {
                benchmark_id,
                errors_count: errors.length,
                errors: errors.slice(0, 5).map(e => e.error)
            });
        }

        // Store in database
        await this._storeBenchmark({
            benchmark_id,
            benchmark_name,
            scenarios,
            count,
            scale,
            level,
            difficulty_mix,
            userId,
            errors
        });

        logger.info('Conversation benchmark created', {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length
        });

        return {
            benchmark_id,
            benchmark_name,
            scenarios_count: scenarios.length,
            errors_count: errors.length,
            scale,
            scale_name: scaleConfig.name,
            message: `Conversation benchmark created with ${scenarios.length} scenarios`
        };
    }

    /**
     * Retrieve a conversation benchmark by name or ID.
     */
    async getConversationBenchmark(identifier) {
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

        const benchmarkQuery = isUUID
            ? `SELECT * FROM sealed_benchmarks WHERE benchmark_id = $1 AND metadata->>'domain' = 'general'`
            : `SELECT * FROM sealed_benchmarks WHERE benchmark_name = $1 AND metadata->>'domain' = 'general'`;

        const benchmarkResult = await query(benchmarkQuery, [identifier]);

        if (benchmarkResult.rows.length === 0) {
            throw new Error(`Conversation benchmark not found: ${identifier}`);
        }

        const benchmark = benchmarkResult.rows[0];

        // Get scenarios
        const scenariosResult = await query(`
            SELECT * FROM sealed_benchmark_scenarios
            WHERE benchmark_id = $1
            ORDER BY order_index
        `, [benchmark.benchmark_id]);

        return {
            ...benchmark,
            scenarios: scenariosResult.rows
        };
    }

    // ─── Scenario Generation ───────────────────────────────────────────

    /**
     * Build the list of scenario generation tasks with proper type distribution.
     */
    async _buildScenarioTasks(count, difficulty_mix, scale, level, userId) {
        // Check if user has active domain learning
        let hasDomainLearning = false;
        try {
            const dlResult = await query(
                `SELECT COUNT(*) as cnt FROM dl_domain_tags WHERE user_id = $1 AND status = 'enabled'`,
                [userId]
            );
            hasDomainLearning = parseInt(dlResult.rows[0].cnt) > 0;
        } catch { /* table may not exist */ }

        const distribution = hasDomainLearning ? SCENARIO_TYPE_DISTRIBUTION_DL : SCENARIO_TYPE_DISTRIBUTION_BASE;

        const tasks = [];

        for (let i = 0; i < count; i++) {
            const scenarioType = this._selectScenarioType(i, count, distribution);
            const difficulty = this._selectDifficulty(difficulty_mix, i, count);

            tasks.push({
                index: i,
                scenarioType,
                difficulty,
                scale,
                level,
                userId
            });
        }

        return tasks;
    }

    /**
     * Generate a single benchmark scenario based on its type.
     */
    async _generateScenario(task, userId) {
        switch (task.scenarioType) {
            case 'context_retention':
                return await this._generateContextRetentionScenario(task, userId);
            case 'preference_adherence':
                return await this._generatePreferenceAdherenceScenario(task, userId);
            case 'general_helpfulness':
                return await this._generateGeneralHelpfulnessScenario(task, userId);
            case 'domain_knowledge_recall':
                return await this._generateDomainKnowledgeRecallScenario(task, userId);
            case 'domain_knowledge_application':
                return await this._generateDomainKnowledgeApplicationScenario(task, userId);
            default:
                return await this._generateGeneralHelpfulnessScenario(task, userId);
        }
    }

    /**
     * Generate a context retention benchmark scenario from user's actual conversation history.
     */
    async _generateContextRetentionScenario(task, userId) {
        // Pull real conversation history
        const messagesResult = await query(`
            SELECT content, role, created_at
            FROM v2_project_messages
            WHERE user_id = $1
              AND role = 'user'
              AND content IS NOT NULL
              AND LENGTH(content) > 20
            ORDER BY RANDOM()
            LIMIT 5
        `, [userId]);

        if (messagesResult.rows.length === 0) {
            // Fallback: generate synthetic context retention scenario
            return await this._generateSyntheticContextScenario(task, userId);
        }

        const contextMessages = messagesResult.rows.map(m => ({
            role: m.role,
            content: m.content
        }));

        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create benchmark scenarios for evaluating an AI assistant's context retention.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Hint: ${scaleConfig.prompt_hint}
Difficulty: ${task.difficulty}/5

Given real conversation history, create a follow-up question that tests whether the assistant remembers key information.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Real conversation history:
${contextMessages.map(m => `${m.role}: ${m.content}`).join('\n')}

Generate a benchmark scenario at scale S${task.scale}, difficulty ${task.difficulty}/5.

Return JSON:
{
  "prompt": "A follow-up question testing context recall",
  "expected_behavior": "What the assistant should recall or reference",
  "evaluation_criteria": "How to judge the response",
  "reasoning": "Why this is the expected behavior given the conversation history"
}`
                }
            ],
            temperature: 0.7,
            max_tokens: 600
        });

        const tokensUsed = result.tokens_used || 600;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'context_retention', // scenario type stored in merchant field
            description: parsed.prompt || 'Can you remind me what we discussed?',
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || 'Should reference conversation history',
                evaluation_criteria: parsed.evaluation_criteria || 'mentions_context'
            }),
            reasoning: parsed.reasoning || 'Context from conversation history should be recalled',
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'context_retention',
            context: contextMessages,
            scale: task.scale
        };
    }

    /**
     * Generate synthetic context retention scenario when no real history exists.
     */
    async _generateSyntheticContextScenario(task, userId) {
        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create realistic conversation scenarios for AI evaluation.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Difficulty: ${task.difficulty}/5
Create a multi-turn conversation followed by a test question that checks context retention.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Generate a synthetic conversation scenario with a test question.

Return JSON:
{
  "context": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}, ...],
  "prompt": "Follow-up question testing context recall",
  "expected_behavior": "What should be recalled",
  "evaluation_criteria": "Judging criteria",
  "reasoning": "Why this is the correct expected behavior"
}`
                }
            ],
            temperature: 0.8,
            max_tokens: 800
        });

        const tokensUsed = result.tokens_used || 800;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'context_retention',
            description: parsed.prompt || 'What did we talk about regarding the project?',
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || 'Should recall conversation topics',
                evaluation_criteria: parsed.evaluation_criteria || 'mentions_context'
            }),
            reasoning: parsed.reasoning || 'Synthetic context retention test',
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'context_retention',
            context: parsed.context || [],
            scale: task.scale
        };
    }

    /**
     * Generate a preference adherence benchmark scenario from user's actual preferences.
     */
    async _generatePreferenceAdherenceScenario(task, userId) {
        // Pull real user preferences
        const prefResult = await query(`
            SELECT preference_type, preference_key, preference_value
            FROM v2_preference_events
            WHERE user_id = $1
            ORDER BY RANDOM()
            LIMIT 1
        `, [userId]);

        let preference;
        if (prefResult.rows.length > 0) {
            preference = prefResult.rows[0];
        } else {
            // Synthetic preference for benchmarking
            preference = this._generateSyntheticPreference();
        }

        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create benchmark scenarios for evaluating an AI assistant's preference adherence.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Hint: ${scaleConfig.prompt_hint}
Difficulty: ${task.difficulty}/5

Given a user preference, create a scenario that tests whether the assistant respects it.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `User preference:
- Type: ${preference.preference_type}
- Key: ${preference.preference_key}
- Value: ${preference.preference_value}

Generate a benchmark scenario at scale S${task.scale}, difficulty ${task.difficulty}/5.

Return JSON:
{
  "prompt": "A request where the preference should influence the response",
  "expected_behavior": "How the assistant should adapt to the preference",
  "evaluation_criteria": "How to judge preference adherence",
  "reasoning": "Why this behavior is expected given the preference"
}`
                }
            ],
            temperature: 0.7,
            max_tokens: 600
        });

        const tokensUsed = result.tokens_used || 600;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'preference_adherence',
            description: parsed.prompt || 'Help me with this task.',
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || `Should respect ${preference.preference_key} = ${preference.preference_value}`,
                evaluation_criteria: parsed.evaluation_criteria || 'respects_preference',
                preference
            }),
            reasoning: parsed.reasoning || `Preference: ${preference.preference_key} = ${preference.preference_value}`,
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'preference_adherence',
            context: [],
            scale: task.scale
        };
    }

    /**
     * Generate a general helpfulness benchmark scenario.
     */
    async _generateGeneralHelpfulnessScenario(task, userId) {
        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create benchmark scenarios for evaluating an AI assistant's general helpfulness.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Hint: ${scaleConfig.prompt_hint}
Difficulty: ${task.difficulty}/5

Create a question testing reasoning, instruction following, and communication quality.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Generate a general helpfulness benchmark scenario at scale S${task.scale}, difficulty ${task.difficulty}/5.

Topics can include: technical explanation, creative writing, analysis, planning, problem-solving, code review, summarization.

Return JSON:
{
  "prompt": "The user's question or request",
  "expected_behavior": "What a high-quality response should include",
  "evaluation_criteria": "Specific criteria for judging helpfulness and accuracy",
  "reasoning": "Why these criteria matter for this question"
}`
                }
            ],
            temperature: 0.9,
            max_tokens: 600
        });

        const tokensUsed = result.tokens_used || 600;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'general_helpfulness',
            description: parsed.prompt || 'Explain the trade-offs between microservices and monolithic architecture.',
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || 'Should provide a clear, structured, and accurate response',
                evaluation_criteria: parsed.evaluation_criteria || 'helpful_and_accurate'
            }),
            reasoning: parsed.reasoning || 'Tests general reasoning and communication quality',
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'general_helpfulness',
            context: [],
            scale: task.scale
        };
    }

    /**
     * Generate a domain knowledge recall scenario.
     * Tests whether Oggy can recall specific facts from applied knowledge packs.
     */
    async _generateDomainKnowledgeRecallScenario(task, userId) {
        // Pull knowledge cards from user's applied packs
        const cardsResult = await query(
            `SELECT kc.topic, kc.summary, t.display_name, t.tag
             FROM dl_knowledge_cards kc
             JOIN dl_knowledge_packs kp ON kp.pack_id = kc.pack_id
             JOIN dl_domain_tags t ON t.tag_id = kc.tag_id
             WHERE kp.user_id = $1 AND kp.status = 'applied'
             ORDER BY RANDOM() LIMIT 3`,
            [userId]
        );

        if (cardsResult.rows.length === 0) {
            // Fallback to general helpfulness if no applied packs
            return await this._generateGeneralHelpfulnessScenario(task, userId);
        }

        const card = cardsResult.rows[0];
        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create benchmark scenarios testing an AI assistant's domain knowledge recall.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Difficulty: ${task.difficulty}/5

The assistant has been taught domain knowledge. Create a question that directly tests recall of specific facts.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Domain: ${card.display_name || card.tag}
Knowledge card topic: ${card.topic}
Knowledge card content: ${card.summary}

Generate a question that tests if the assistant can recall this knowledge at difficulty ${task.difficulty}/5.

Return JSON:
{
  "prompt": "A question about this domain topic",
  "expected_behavior": "The specific facts/details the assistant should recall",
  "evaluation_criteria": "How to judge accuracy of domain knowledge recall",
  "reasoning": "Why this tests domain knowledge recall"
}`
                }
            ],
            temperature: 0.6,
            max_tokens: 600
        });

        const tokensUsed = result.tokens_used || 600;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'domain_knowledge_recall',
            description: parsed.prompt || `Tell me about ${card.topic}`,
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || card.summary,
                evaluation_criteria: parsed.evaluation_criteria || 'recalls_domain_facts',
                domain_tag: card.tag,
                knowledge_topic: card.topic
            }),
            reasoning: parsed.reasoning || `Tests recall of ${card.tag} domain knowledge`,
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'domain_knowledge_recall',
            context: [],
            scale: task.scale
        };
    }

    /**
     * Generate a domain knowledge application scenario.
     * Tests whether Oggy can apply domain knowledge to novel problems.
     */
    async _generateDomainKnowledgeApplicationScenario(task, userId) {
        // Pull knowledge cards from user's applied packs
        const cardsResult = await query(
            `SELECT kc.topic, kc.summary, t.display_name, t.tag
             FROM dl_knowledge_cards kc
             JOIN dl_knowledge_packs kp ON kp.pack_id = kc.pack_id
             JOIN dl_domain_tags t ON t.tag_id = kc.tag_id
             WHERE kp.user_id = $1 AND kp.status = 'applied'
             ORDER BY RANDOM() LIMIT 3`,
            [userId]
        );

        if (cardsResult.rows.length === 0) {
            return await this._generateGeneralHelpfulnessScenario(task, userId);
        }

        // Use multiple cards to create a novel application scenario
        const cards = cardsResult.rows;
        await costGovernor.checkBudget(1500);

        const scaleConfig = this.scaleComplexity[Math.min(task.scale, 5)];
        const resolved = await providerResolver.getAdapter(userId, 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                {
                    role: 'system',
                    content: `You create benchmark scenarios testing an AI assistant's ability to APPLY domain knowledge to novel problems.
Scale: ${scaleConfig.name} - ${scaleConfig.description}
Difficulty: ${task.difficulty}/5

The assistant has domain knowledge loaded. Create a novel problem that requires applying that knowledge creatively.
Return ONLY valid JSON.`
                },
                {
                    role: 'user',
                    content: `Domain: ${cards[0].display_name || cards[0].tag}
Available knowledge:
${cards.map(c => `- ${c.topic}: ${c.summary.substring(0, 150)}`).join('\n')}

Generate a novel application problem at difficulty ${task.difficulty}/5 that requires using this domain knowledge to solve a new problem or scenario.

Return JSON:
{
  "prompt": "A practical problem or scenario requiring domain knowledge application",
  "expected_behavior": "How the assistant should apply the domain knowledge",
  "evaluation_criteria": "How to judge the quality of knowledge application",
  "reasoning": "Why this tests knowledge application vs just recall"
}`
                }
            ],
            temperature: 0.8,
            max_tokens: 600
        });

        const tokensUsed = result.tokens_used || 600;
        costGovernor.recordUsage(tokensUsed);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'convBenchmarkGen', tokensUsed, result.latency_ms, true, null);

        const parsed = this._safeParseJson(result.text);

        return {
            merchant: 'domain_knowledge_application',
            description: parsed.prompt || `Help me solve a problem using ${cards[0].tag} concepts`,
            correct_category: JSON.stringify({
                expected_behavior: parsed.expected_behavior || 'Should apply domain concepts to solve the problem',
                evaluation_criteria: parsed.evaluation_criteria || 'applies_domain_knowledge',
                domain_tag: cards[0].tag,
                knowledge_topics: cards.map(c => c.topic)
            }),
            reasoning: parsed.reasoning || `Tests application of ${cards[0].tag} domain knowledge`,
            amount: task.difficulty,
            generator: 'conversation_benchmark',
            model: resolved.model,
            scenario_type: 'domain_knowledge_application',
            context: [],
            scale: task.scale
        };
    }

    // ─── Storage ───────────────────────────────────────────────────────

    /**
     * Store the benchmark and its scenarios in the database.
     * Uses domain='general' to distinguish from payment benchmarks.
     */
    async _storeBenchmark(data) {
        const {
            benchmark_id,
            benchmark_name,
            scenarios,
            count,
            scale,
            level,
            difficulty_mix,
            userId,
            errors
        } = data;

        // Store benchmark metadata
        await query(`
            INSERT INTO sealed_benchmarks (
                benchmark_id,
                benchmark_name,
                description,
                scenario_count,
                use_ood,
                difficulty_mix,
                created_at,
                metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
        `, [
            benchmark_id,
            benchmark_name,
            `Conversation quality benchmark (S${scale} L${level})`,
            scenarios.length,
            true, // conversation benchmarks use the user's own provider
            difficulty_mix,
            JSON.stringify({
                domain: 'general',
                scale,
                level,
                total_requested: count,
                successful: scenarios.length,
                errors: errors.length,
                scenario_types: this._countByType(scenarios),
                userId,
                generator: 'conversation_benchmark'
            })
        ]);

        // Store individual scenarios
        let stored = 0;
        for (const scenario of scenarios) {
            try {
                await query(`
                    INSERT INTO sealed_benchmark_scenarios (
                        scenario_id,
                        benchmark_id,
                        order_index,
                        merchant,
                        amount,
                        description,
                        correct_category,
                        reasoning,
                        generator,
                        model
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    scenario.scenario_id,
                    benchmark_id,
                    scenario.order_index,
                    scenario.merchant,      // scenario type (context_retention, etc.)
                    scenario.amount,         // difficulty level
                    scenario.description,    // the prompt/question
                    scenario.correct_category, // JSON string of expected behavior/criteria
                    scenario.reasoning,
                    scenario.generator || 'conversation_benchmark',
                    scenario.model || 'unknown'
                ]);
                stored++;
            } catch (insertError) {
                logger.warn('Failed to insert conversation benchmark scenario', {
                    benchmark_id,
                    scenario_id: scenario.scenario_id,
                    type: scenario.scenario_type,
                    error: insertError.message
                });
            }
        }

        // Correct count if some scenarios failed to store
        if (stored !== scenarios.length) {
            await query(`
                UPDATE sealed_benchmarks
                SET scenario_count = $1
                WHERE benchmark_id = $2
            `, [stored, benchmark_id]);
        }

        logger.info('Conversation benchmark stored', {
            benchmark_id,
            scenarios_generated: scenarios.length,
            scenarios_stored: stored
        });
    }

    // ─── Utility ───────────────────────────────────────────────────────

    /**
     * Select scenario type based on distribution weights.
     */
    _selectScenarioType(index, total, distribution) {
        const rand = Math.random();
        let cumulative = 0;

        for (const [type, weight] of Object.entries(distribution)) {
            cumulative += weight;
            if (rand < cumulative) {
                return type;
            }
        }

        return 'general_helpfulness';
    }

    /**
     * Select difficulty based on mix strategy.
     */
    _selectDifficulty(difficulty_mix, index, total) {
        switch (difficulty_mix) {
            case 'easy':
                return Math.random() > 0.5 ? 1 : 2;
            case 'hard':
                return Math.random() > 0.5 ? 4 : 5;
            case 'balanced': {
                const rand = Math.random();
                if (rand < 0.20) return 1;
                if (rand < 0.40) return 2;
                if (rand < 0.60) return 3;
                if (rand < 0.80) return 4;
                return 5;
            }
            case 'mixed': {
                // Progressive difficulty
                const progress = index / total;
                if (progress < 0.20) return 1;
                if (progress < 0.40) return 2;
                if (progress < 0.60) return 3;
                if (progress < 0.80) return 4;
                return 5;
            }
            default:
                return 3;
        }
    }

    /**
     * Generate a synthetic preference for when no real preferences exist.
     */
    _generateSyntheticPreference() {
        const syntheticPreferences = [
            { preference_type: 'communication', preference_key: 'response_length', preference_value: 'concise' },
            { preference_type: 'communication', preference_key: 'tone', preference_value: 'professional' },
            { preference_type: 'communication', preference_key: 'code_style', preference_value: 'well-commented' },
            { preference_type: 'content', preference_key: 'explanation_depth', preference_value: 'detailed with examples' },
            { preference_type: 'content', preference_key: 'format', preference_value: 'bullet points preferred' },
            { preference_type: 'behavior', preference_key: 'proactiveness', preference_value: 'suggest related topics' }
        ];

        return syntheticPreferences[Math.floor(Math.random() * syntheticPreferences.length)];
    }

    /**
     * Count scenarios by type.
     */
    _countByType(scenarios) {
        const counts = {};
        for (const s of scenarios) {
            const type = s.scenario_type || s.merchant || 'unknown';
            counts[type] = (counts[type] || 0) + 1;
        }
        return counts;
    }

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
                logger.warn('Failed to parse benchmark generation JSON', {
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
        instances.set(userId, new ConversationBenchmarkGenerator());
    }
    return instances.get(userId);
}

module.exports = { getInstance, ConversationBenchmarkGenerator };
