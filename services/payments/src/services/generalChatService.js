/**
 * V2: General Conversation Service
 * Handles general-purpose chat with project context and memory-enhanced responses.
 */

const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { costGovernor } = require('../middleware/costGovernor');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

        const systemPrompt = `You are Oggy, a helpful AI assistant. You remember previous conversations and learn from interactions.${projectContext}

# Learned Context
${memoryContext}

Respond helpfully and naturally. If you recall relevant information from past conversations, use it.`;

        // Call OpenAI
        await costGovernor.checkBudget(3000);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        try {
            const response = await this.openaiBreaker.execute(() =>
                axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages,
                    temperature: 0.7,
                    max_tokens: 1000
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 15000
                })
            );

            const oggyText = response.data.choices[0].message.content.trim();
            costGovernor.recordUsage(Math.ceil((systemPrompt.length + message.length + oggyText.length) / 4));

            // Base model response (no memory)
            let baseText = '';
            try {
                const baseResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages: [
                        { role: 'system', content: 'You are a helpful AI assistant.' },
                        ...conversation_history.slice(-10),
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 1000
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 15000
                });
                baseText = baseResponse.data.choices[0].message.content.trim();
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
}

module.exports = new GeneralChatService();
