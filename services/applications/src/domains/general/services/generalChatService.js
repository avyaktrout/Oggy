/**
 * V2: General Conversation Service
 * Handles general-purpose chat with project context and memory-enhanced responses.
 */

const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const circuitBreakerRegistry = require('../../../shared/utils/circuitBreakerRegistry');
const providerResolver = require('../../../shared/providers/providerResolver');
const { getApplicationKnowledge, detectAppKnowledgeIntent } = require('../../../shared/services/applicationKnowledge');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

class GeneralChatService {
    constructor() {
        this.memoryBreaker = circuitBreakerRegistry.getOrCreate('memory-service');
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
    }

    async chat(userId, message, options = {}) {
        const { project_id = null, conversation_history = [], learn_from_chat = false } = options;
        const startTime = Date.now();

        // Retrieve relevant memory
        let memoryCards = [];
        let traceId = null;
        try {
            const retrieval = await this.memoryBreaker.execute(() =>
                axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    agent: 'oggy',
                    owner_type: 'user',
                    owner_id: userId,
                    query: message,
                    top_k: 5,
                    tier_scope: [1, 2, 3],
                    tag_filter: ['general', 'conversation'],
                    include_scores: true
                }, {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                })
            );
            traceId = retrieval.data?.trace_id;
            memoryCards = retrieval.data?.selected || [];
        } catch (err) {
            logger.debug('Memory retrieval failed for general chat', { error: err.message });
        }

        // Build prompt with memory context
        const memoryContext = memoryCards.length > 0
            ? memoryCards.map((c, i) => `${i + 1}. ${c.content?.text || JSON.stringify(c.content)}`).join('\n')
            : 'No previous context available.';

        // Get project context if applicable
        let projectContext = '';
        if (project_id) {
            try {
                const proj = await query('SELECT name, description FROM v2_projects WHERE project_id = $1 AND user_id = $2', [project_id, userId]);
                if (proj.rows.length > 0) {
                    projectContext = `\nProject: ${proj.rows[0].name}\nDescription: ${proj.rows[0].description || 'None'}`;
                }
            } catch (err) {
                logger.debug('Project context fetch failed', { error: err.message });
            }
        }

        // Check if user is asking about performance
        let performanceContext = '';
        if (this._detectPerformanceIntent(message)) {
            performanceContext = await this._getPerformanceContext(userId);
        }

        // Check if user is asking about the application itself
        let appKnowledgeContext = '';
        if (detectAppKnowledgeIntent(message)) {
            appKnowledgeContext = getApplicationKnowledge();
        }

        const systemPrompt = `You are Oggy, a helpful AI assistant. You remember previous conversations and learn from interactions.${projectContext}

# Learned Context
${memoryContext}
${performanceContext}${appKnowledgeContext}
Respond helpfully and naturally. If you recall relevant information from past conversations, use it.${performanceContext ? `

IMPORTANT: The user is asking about your performance. You MUST answer using the REAL performance data provided above in "My Performance Data". Do NOT say you don't have access to data or can't evaluate yourself — you DO have this data. Reference specific numbers, levels, accuracy percentages, and trends from the data above. If no benchmarks exist yet, say so honestly and suggest starting a training session.` : ''}${appKnowledgeContext ? `

IMPORTANT: The user is asking about the Oggy application, its architecture, security, or features. You MUST answer using the detailed application knowledge provided above in "About Oggy". You have comprehensive knowledge of how you work, your security model, database schema, features, and architecture. Answer confidently and accurately using the information above. Do NOT say you don't know how you work or that you can't answer questions about yourself — you CAN and you MUST use the knowledge above.` : ''}`;

        // Call LLM via provider adapter
        await costGovernor.checkBudget(3000);

        const chatMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        try {
            // Oggy response (with memory)
            const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
            const oggyResult = await this.openaiBreaker.execute(() =>
                oggyResolved.adapter.chatCompletion({
                    model: oggyResolved.model,
                    messages: chatMessages,
                    temperature: 0.7,
                    max_tokens: 1000
                })
            );

            const oggyText = oggyResult.text;
            costGovernor.recordUsage(oggyResult.tokens_used || Math.ceil((systemPrompt.length + message.length + oggyText.length) / 4));
            providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'generalChat', oggyResult.tokens_used, oggyResult.latency_ms, true, null);

            // Base model response (no memory)
            let baseText = '';
            try {
                const baseResolved = await providerResolver.getAdapter(userId, 'base');
                const baseResult = await baseResolved.adapter.chatCompletion({
                    model: baseResolved.model,
                    messages: [
                        { role: 'system', content: 'You are a helpful AI assistant.' },
                        ...conversation_history.slice(-10),
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 1000
                });
                baseText = baseResult.text;
                providerResolver.logRequest(userId, baseResolved.provider, baseResolved.model, 'base', 'generalChat', baseResult.tokens_used, baseResult.latency_ms, true, null);
            } catch (err) {
                baseText = 'Base model unavailable.';
            }

            // Learn from chat if enabled
            if (learn_from_chat && message.length > 10) {
                try {
                    await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 1,
                        kind: 'conversation_context',
                        content: {
                            type: 'PATTERN',
                            text: `User said: "${message.substring(0, 200)}" — Oggy replied about: ${oggyText.substring(0, 100)}`,
                            source: 'general_chat'
                        },
                        tags: ['general', 'conversation'],
                        utility_weight: 0.5,
                        reliability: 0.7
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    });
                } catch (err) {
                    logger.debug('Failed to store chat memory', { error: err.message });
                }
            }

            // Store message in DB if project context
            if (project_id) {
                try {
                    await query(
                        `INSERT INTO v2_project_messages (project_id, user_id, role, content, oggy_response, used_memory, trace_id)
                         VALUES ($1, $2, 'user', $3, false, false, NULL), ($1, $2, 'assistant', $4, true, $5, $6)`,
                        [project_id, userId, message, oggyText, memoryCards.length > 0, traceId]
                    );
                } catch (err) {
                    logger.debug('Failed to store project message', { error: err.message });
                }
            }

            return {
                oggy_response: {
                    text: oggyText,
                    used_memory: memoryCards.length > 0
                },
                base_response: {
                    text: baseText
                },
                trace_id: traceId,
                latency_ms: Date.now() - startTime
            };
        } catch (err) {
            logger.logError(err, { operation: 'generalChat', userId });
            throw err;
        }
    }

    // Project CRUD
    async createProject(userId, name, description) {
        const result = await query(
            'INSERT INTO v2_projects (user_id, name, description) VALUES ($1, $2, $3) RETURNING *',
            [userId, name, description]
        );
        return result.rows[0];
    }

    async getProjects(userId) {
        const result = await query(
            'SELECT * FROM v2_projects WHERE user_id = $1 ORDER BY updated_at DESC',
            [userId]
        );
        return result.rows;
    }

    async getProject(userId, projectId) {
        const result = await query(
            'SELECT * FROM v2_projects WHERE project_id = $1 AND user_id = $2',
            [projectId, userId]
        );
        return result.rows[0] || null;
    }

    async updateProject(userId, projectId, updates) {
        const { name, description, status } = updates;
        await query(
            `UPDATE v2_projects SET
                name = COALESCE($3, name),
                description = COALESCE($4, description),
                status = COALESCE($5, status),
                updated_at = NOW()
             WHERE project_id = $1 AND user_id = $2`,
            [projectId, userId, name, description, status]
        );
    }

    async getProjectMessages(userId, projectId, limit = 50) {
        const result = await query(
            `SELECT * FROM v2_project_messages
             WHERE project_id = $1 AND user_id = $2
             ORDER BY created_at ASC LIMIT $3`,
            [projectId, userId, limit]
        );
        return result.rows;
    }

    /**
     * Detect if user is asking about Oggy's own performance.
     */
    _detectPerformanceIntent(message) {
        const lower = message.toLowerCase();
        const keywords = [
            'how are you performing', 'how are you doing', 'your performance',
            'your accuracy', 'benchmark', 'how accurate', 'your level',
            'what level', 'have you improved', 'your progress', 'training history',
            'how smart are you', 'your score', 'your results', 'performance stats',
            'how well do you', 'are you getting better', 'your weaknesses',
            'weak categories', 'strong categories', 'confusion', 'improvement',
            'performance recently', 'training session', 'how have you been doing',
            'tell me about your', 'know about your performance', 'how good are you',
            'are you improving', 'what do you think of your', 'your stats',
            'how is your', 'scale level', 'difficulty level', 'learning progress',
            'how much have you learned', 'what have you learned', 'how trained',
            'about yourself', 'your capabilities', 'your strengths'
        ];
        return keywords.some(kw => lower.includes(kw));
    }

    /**
     * Fetch real performance data for the system prompt.
     */
    async _getPerformanceContext(userId) {
        try {
            const parts = [];
            // Also check legacy 'oggy' user_id for old data
            const userIds = [userId];
            if (userId !== 'oggy') userIds.push('oggy');

            // Current scale/level
            const stateResult = await query(
                `SELECT scale, difficulty_level FROM continuous_learning_state WHERE user_id = ANY($1) ORDER BY user_id = $2 DESC LIMIT 1`,
                [userIds, userId]
            );
            if (stateResult.rows.length > 0) {
                const s = stateResult.rows[0];
                parts.push(`Current Level: Scale ${s.scale}, Difficulty Level ${s.difficulty_level}`);
            }

            // Recent benchmarks (last 5) — check both user IDs
            const bmResult = await query(
                `SELECT oggy_accuracy, base_accuracy, advantage_delta,
                        tested_at, training_state
                 FROM sealed_benchmark_results
                 WHERE user_id = ANY($1)
                 ORDER BY tested_at DESC LIMIT 5`,
                [userIds]
            );
            if (bmResult.rows.length > 0) {
                const bmLines = bmResult.rows.map((r, i) => {
                    const oggy = (r.oggy_accuracy * 100).toFixed(1);
                    const base = (r.base_accuracy * 100).toFixed(1);
                    const passed = r.advantage_delta >= 0;
                    const scaleStatus = r.training_state?.scale_status || 'unknown';
                    const date = new Date(r.tested_at).toLocaleDateString();
                    return `  ${i + 1}. ${scaleStatus} — Oggy: ${oggy}% vs Base: ${base}% — ${passed ? 'PASSED' : 'FAILED'} (${date})`;
                });
                parts.push(`Recent Benchmarks (newest first):\n${bmLines.join('\n')}`);

                // Trend
                if (bmResult.rows.length >= 2) {
                    const newest = bmResult.rows[0].oggy_accuracy;
                    const oldest = bmResult.rows[bmResult.rows.length - 1].oggy_accuracy;
                    const trend = newest > oldest ? 'improving' : newest < oldest ? 'declining' : 'stable';
                    parts.push(`Accuracy Trend: ${trend} (${(oldest * 100).toFixed(1)}% → ${(newest * 100).toFixed(1)}%)`);
                }
            } else {
                parts.push('No benchmarks completed yet.');
            }

            // Training sessions count
            const trainingResult = await query(
                `SELECT COUNT(*) as count FROM app_events
                 WHERE user_id = ANY($1) AND event_type = 'training_session_completed'`,
                [userIds]
            );
            const sessionCount = parseInt(trainingResult.rows[0]?.count || '0');
            parts.push(`Training Sessions Completed: ${sessionCount}`);

            if (parts.length === 0) return '';

            return `\n# My Performance Data\n${parts.join('\n')}\n`;
        } catch (err) {
            logger.debug('Performance context fetch failed', { error: err.message });
            return '';
        }
    }
}

module.exports = new GeneralChatService();
