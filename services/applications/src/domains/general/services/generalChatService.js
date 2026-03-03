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
const { getApplicationKnowledge, detectAppKnowledgeIntent, getCrossDomainGuidance, detectCrossDomainIntent } = require('../../../shared/services/applicationKnowledge');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const DIET_SERVICE_URL = process.env.DIET_SERVICE_URL || 'http://diet-service:3012';
const PAYMENTS_SERVICE_URL = process.env.PAYMENTS_SERVICE_URL || 'http://payments-service:3010';

class GeneralChatService {
    constructor() {
        this.memoryBreaker = circuitBreakerRegistry.getOrCreate('memory-service');
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
    }

    _cleanJson(text) {
        let cleaned = text.trim();
        cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
        return cleaned.trim();
    }

    async chat(userId, message, options = {}) {
        const { project_id = null, conversation_history = [], learn_from_chat = false } = options;
        const startTime = Date.now();

        // Handle explicit "remember that..." requests
        if (this._isMemoryStoreRequest(message)) {
            return this._handleExplicitMemoryStore(userId, message, conversation_history, startTime);
        }

        // Check if domain learning is active for this project
        let domainTags = [];
        if (project_id) {
            try {
                const proj = await query(
                    'SELECT metadata FROM v2_projects WHERE project_id = $1 AND user_id = $2',
                    [project_id, userId]
                );
                if (proj.rows.length && (proj.rows[0].metadata?.learning?.domain_learning)) {
                    const tagResult = await query(
                        `SELECT t.tag FROM dl_project_domain_tags pt
                         JOIN dl_domain_tags t ON t.tag_id = pt.tag_id
                         WHERE pt.project_id = $1 AND t.status = 'enabled'`,
                        [project_id]
                    );
                    domainTags = tagResult.rows.map(r => r.tag);
                }
            } catch (err) {
                logger.debug('Domain tag lookup failed', { error: err.message });
            }
        }

        // Build tag filter — include domain tags if DL is active
        const tagFilter = ['general', 'conversation'];
        if (domainTags.length > 0) {
            tagFilter.push('domain_knowledge', ...domainTags);
        }

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
                    top_k: domainTags.length > 0 ? 8 : 5,
                    tier_scope: [1, 2, 3],
                    tag_filter: tagFilter,
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

        // Check for cross-domain intent (food, expenses, research help)
        let crossDomainContext = '';
        const crossDomainIntents = detectCrossDomainIntent(message);
        // Check conversation history for pending entry creation offers (user might be confirming)
        const recentHistory = conversation_history.slice(-4);
        const hasPendingEntryOffer = recentHistory.some(m =>
            m.role === 'assistant' && m.content &&
            (m.content.includes('create a diet entry') || m.content.includes('create an entry') ||
             m.content.includes('log this') || m.content.includes('log that') ||
             m.content.includes('diet entry') || m.content.includes('payment entry') ||
             m.content.includes('expense entry') || m.content.includes('Diet Tracker'))
        );
        if (hasPendingEntryOffer && crossDomainIntents.length === 0) {
            crossDomainIntents.push({ domain: 'diet', type: 'entry_creation_followup' });
        }
        if (crossDomainIntents.length > 0 || detectAppKnowledgeIntent(message)) {
            crossDomainContext = getCrossDomainGuidance();
        }

        // Fetch auto-learned user preferences
        const preferenceContext = await this._getPreferenceContext(userId);

        const domainContext = domainTags.length > 0
            ? `\nActive domain knowledge: ${domainTags.join(', ')}. Use domain-specific knowledge from your learned context when relevant.`
            : '';

        const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are Oggy, a helpful AI assistant. You remember previous conversations and learn from interactions.
Today is ${todayStr}. When the user refers to relative dates like "yesterday" or "last week", use today's date to resolve them.${projectContext}${domainContext}

# Learned Context
${memoryContext}
${preferenceContext}${performanceContext}${appKnowledgeContext}${crossDomainContext ? `\n${crossDomainContext}` : ''}
Respond helpfully and naturally. If you recall relevant information from past conversations, use it.${domainTags.length > 0 ? ' You have domain knowledge loaded — use it to give detailed, accurate answers about domain-specific topics.' : ''}${performanceContext ? `

IMPORTANT: The user is asking about your performance. You MUST answer using the REAL performance data provided above in "My Performance Data". Do NOT say you don't have access to data or can't evaluate yourself — you DO have this data. Reference specific numbers, levels, accuracy percentages, and trends from the data above. If no benchmarks exist yet, say so honestly and suggest starting a training session.` : ''}${appKnowledgeContext ? `

IMPORTANT: The user is asking about the Oggy application, its architecture, security, or features. You MUST answer using the detailed application knowledge provided above in "About Oggy". You have comprehensive knowledge of how you work, your security model, database schema, features, and architecture. Answer confidently and accurately using the information above. Do NOT say you don't know how you work or that you can't answer questions about yourself — you CAN and you MUST use the knowledge above.` : ''}${crossDomainIntents.length > 0 ? `

CRITICAL — CROSS-DOMAIN ENTRY CREATION (YOU MUST FOLLOW THIS):
You can CREATE Diet and Payment entries for the user directly from this chat.

${crossDomainIntents.some(i => i.type === 'feature_guidance') ? `The user wants to learn or research something, or is asking what you can do. DO NOT give a generic answer. Instead:
1. Briefly acknowledge their interest (1 sentence)
2. Guide them step-by-step: Go to General > Projects, create a project for this topic, enable Domain Learning, click Suggest Tags, build a knowledge pack, apply it, then generate a Study Plan
3. Explain this loads domain expertise into your memory so you can give expert-level answers
4. Include navigation: Click the hamburger menu (☰ top-left) > General > Projects
` : ''}${crossDomainIntents.some(i => i.domain === 'diet') ? `The user mentioned food, drinks, or meals — OR you previously offered to create an entry and they may be confirming.

YOU MUST CREATE BOTH DIET AND PAYMENT ENTRIES WHEN APPLICABLE. Do NOT create only one type and forget the other.

FLOW:
1. If the user describes consuming something, OFFER to create a DIET entry for it.
2. If the same message mentions buying/purchasing from a store/merchant, ALSO offer to create ONE payment entry.
3. When the user CONFIRMS (yes, sure, please, go ahead, do it) or you already have sufficient details, CREATE the entries by appending action blocks at the END of your message.
4. If you need more info (e.g., cost for payment), ASK for it — but still create the diet entry if you have enough info for that.

IMPORTANT RULES:
- ALWAYS create diet entries when food/drink consumption is described, even if a purchase is also mentioned.
- Create SEPARATE diet entries for DIFFERENT DATES. Example: "I drank two today and two yesterday" = one diet entry for today + one diet entry for yesterday with entry_date.
- Create only ONE payment entry per purchase transaction. "I bought 4 drinks from 7-Eleven" = ONE expense for the total, not 4 separate expenses.
- Never duplicate entries. Each unique item/transaction gets exactly one action block.
- Use quantity field for multiple items: "drank 2 energy drinks today" = quantity 2.
- For yesterday/past dates, use entry_date in YYYY-MM-DD format.

ACTION BLOCK FORMAT — append at the very end of your response, AFTER all natural text:
[ENTRY_ACTION:{"type":"diet","description":"Ghost Energy Drink","entry_type":"liquid","meal_type":"snack","quantity":2}]
[ENTRY_ACTION:{"type":"diet","description":"Ghost Energy Drink","entry_type":"liquid","meal_type":"snack","quantity":2,"entry_date":"2026-02-17"}]
[ENTRY_ACTION:{"type":"expense","amount":12.00,"description":"4x Ghost Energy Drink","merchant":"7-Eleven"}]

FIELD REFERENCE:
- type: "diet" or "expense" (REQUIRED)
- description: what was consumed or purchased (REQUIRED)
- entry_type: "food" for solid food, "liquid" for drinks (diet only)
- meal_type: "breakfast", "lunch", "dinner", or "snack" (diet only, infer from time)
- quantity: number of items (diet only, default 1)
- entry_date: "YYYY-MM-DD" (diet only, omit for today)
- amount: cost as a number (expense only, REQUIRED for expense)
- merchant: store/restaurant name (expense only, if known)
` : ''}${crossDomainIntents.some(i => i.domain === 'payments') && !crossDomainIntents.some(i => i.domain === 'diet') ? `The user mentioned spending, purchases, or expenses. Offer to create a payment entry.
Create only ONE entry per transaction. When confirmed, append:
[ENTRY_ACTION:{"type":"expense","amount":X.XX,"description":"...","merchant":"..."}]
` : ''}` : ''}`;

        // Call LLM via provider adapter
        await costGovernor.checkBudget(3000);

        const chatMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        try {
            // Run Oggy + Base responses in parallel (independent LLM calls)
            const oggyResolvedP = providerResolver.getAdapter(userId, 'oggy');
            const baseResolvedP = providerResolver.getAdapter(userId, 'base');
            const [oggyResolved, baseResolved] = await Promise.all([oggyResolvedP, baseResolvedP]);

            const [oggyResult, baseResult] = await Promise.all([
                this.openaiBreaker.execute(() =>
                    oggyResolved.adapter.chatCompletion({
                        model: oggyResolved.model,
                        messages: chatMessages,
                        temperature: 0.7,
                        max_tokens: 1000
                    })
                ),
                baseResolved.adapter.chatCompletion({
                    model: baseResolved.model,
                    messages: [
                        { role: 'system', content: `You are a helpful AI assistant.\nToday is ${todayStr}. When the user refers to relative dates like "yesterday" or "last week", use today's date to resolve them.` },
                        ...conversation_history.slice(-10),
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 1000
                }).catch(err => ({ text: 'Base model unavailable.', tokens_used: 0, latency_ms: 0, _failed: true }))
            ]);

            const oggyText = oggyResult.text;
            costGovernor.recordUsage(oggyResult.tokens_used || Math.ceil((systemPrompt.length + message.length + oggyText.length) / 4));
            providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'generalChat', oggyResult.tokens_used, oggyResult.latency_ms, true, null);

            const baseText = baseResult.text;
            if (!baseResult._failed) {
                providerResolver.logRequest(userId, baseResolved.provider, baseResolved.model, 'base', 'generalChat', baseResult.tokens_used, baseResult.latency_ms, true, null);
            }

            // Auto behavior learning (async, non-blocking)
            if (project_id) {
                this._runBehaviorLearning(userId, message, oggyText, project_id).catch(err =>
                    logger.debug('Behavior learning failed', { error: err.message })
                );
            }

            // Proactive suggestion (async, non-blocking)
            let proactiveSuggestion = null;
            if (project_id && domainTags.length === 0) {
                proactiveSuggestion = await this._generateProactiveSuggestion(userId, message, project_id);
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
                    const insertValues = [project_id, userId, message, oggyText, memoryCards.length > 0, traceId];
                    let insertSQL = `INSERT INTO v2_project_messages (project_id, user_id, role, content, oggy_response, used_memory, trace_id)
                         VALUES ($1, $2, 'user', $3, false, false, NULL), ($1, $2, 'assistant', $4, true, $5, $6)`;
                    if (baseText && !baseResult._failed) {
                        insertSQL += `, ($1, $2, 'base', $7, false, false, NULL)`;
                        insertValues.push(baseText);
                    }
                    await query(insertSQL, insertValues);
                } catch (err) {
                    logger.debug('Failed to store project message', { error: err.message });
                }
            }

            // Process cross-domain entry creation actions from LLM response
            let responseOggyText = oggyText;
            if (crossDomainIntents.length > 0) {
                try {
                    const actionResult = await this._processEntryActions(userId, oggyText);
                    responseOggyText = actionResult.cleanedText;
                    if (actionResult.confirmations.length > 0) {
                        responseOggyText += '\n\n' + actionResult.confirmations.join('\n');
                    }
                } catch (err) {
                    logger.debug('Entry action processing failed', { error: err.message });
                }
            }

            const response = {
                oggy_response: {
                    text: responseOggyText,
                    used_memory: memoryCards.length > 0
                },
                base_response: {
                    text: baseText
                },
                trace_id: traceId,
                latency_ms: Date.now() - startTime
            };

            if (proactiveSuggestion) {
                response.suggestion = proactiveSuggestion;
            }

            return response;
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

    async updateProjectMetadata(userId, projectId, metadata) {
        await query(
            `UPDATE v2_projects SET metadata = $3, updated_at = NOW()
             WHERE project_id = $1 AND user_id = $2`,
            [projectId, userId, JSON.stringify(metadata)]
        );
    }

    async deleteProject(userId, projectId) {
        await query('DELETE FROM v2_project_messages WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
        const result = await query('DELETE FROM v2_projects WHERE project_id = $1 AND user_id = $2 RETURNING project_id', [projectId, userId]);
        return result.rowCount > 0;
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
     * Run auto behavior learning if enabled for the project.
     */
    async _runBehaviorLearning(userId, message, response, projectId) {
        try {
            const proj = await query(
                'SELECT metadata FROM v2_projects WHERE project_id = $1 AND user_id = $2',
                [projectId, userId]
            );
            if (!proj.rows.length) return;

            const metadata = proj.rows[0].metadata || {};
            const blEnabled = metadata.learning?.behavior_learning ?? true; // default ON
            if (!blEnabled) return;

            // Only process substantive messages
            if (message.length < 20) return;

            await this._extractBehaviorSignals(userId, message, response, projectId);
        } catch (err) {
            logger.debug('Behavior learning check failed', { error: err.message });
        }
    }

    /**
     * Extract behavior signals from a chat exchange using LLM.
     * Stores as preference events and optionally as memory cards.
     */
    async _extractBehaviorSignals(userId, message, response, projectId) {
        const extractPrompt = `Analyze this chat exchange and extract any user behavior signals or preferences.

User: ${message.substring(0, 500)}
Assistant: ${response.substring(0, 300)}

Extract ONLY clear signals. Return a JSON array (may be empty). Each item:
- "type": one of "tone", "verbosity", "topic_interest", "workflow", "communication_style", "expertise_level"
- "key": short identifier (e.g., "prefers_concise", "interested_in_math")
- "value": brief description
- "confidence": 0.0-1.0

Only include signals with confidence >= 0.6. Return [] if no clear signals.
Respond with ONLY the JSON array.`;

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const result = await this.openaiBreaker.execute(() =>
            resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [{ role: 'user', content: extractPrompt }],
                temperature: 0.1,
                max_tokens: 300
            })
        );
        costGovernor.recordUsage(result.tokens_used || 500);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'behaviorExtract', result.tokens_used, result.latency_ms, true, null);

        let signals;
        try {
            signals = JSON.parse(this._cleanJson(result.text));
            if (!Array.isArray(signals)) return;
        } catch {
            return;
        }

        signals = signals.filter(s => s && s.key && s.confidence >= 0.6);
        if (signals.length === 0) return;

        for (const signal of signals) {
            // Store as preference event
            try {
                await query(
                    `INSERT INTO v2_preference_events (user_id, preference_type, preference_key, preference_value, confidence, source)
                     VALUES ($1, $2, $3, $4, $5, 'behavior_auto')`,
                    [userId, signal.type, signal.key, signal.value, signal.confidence]
                );
            } catch (err) {
                logger.debug('Failed to store preference event', { error: err.message });
            }

            // High-confidence signals → memory card
            if (signal.confidence >= 0.85) {
                try {
                    await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 1,
                        kind: 'behavior_signal',
                        content: {
                            type: 'PATTERN',
                            text: `User behavior: ${signal.key} — ${signal.value}`,
                            source: 'behavior_auto',
                            confidence: signal.confidence
                        },
                        tags: ['general', 'conversation', 'behavior'],
                        utility_weight: 0.6,
                        reliability: signal.confidence
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    });
                    logger.info('Behavior signal stored as memory', { key: signal.key, confidence: signal.confidence });
                } catch (err) {
                    logger.debug('Failed to store behavior memory card', { error: err.message });
                }
            }
        }

        logger.info('Behavior signals extracted', { userId, count: signals.length, projectId });
    }

    /**
     * Fetch recent preference context for system prompt injection.
     */
    async _getPreferenceContext(userId) {
        try {
            const result = await query(
                `SELECT preference_type, preference_key, preference_value, confidence
                 FROM v2_preference_events
                 WHERE user_id = $1 AND source = 'behavior_auto' AND confidence >= 0.7
                 ORDER BY created_at DESC LIMIT 10`,
                [userId]
            );
            if (result.rows.length === 0) return '';

            const prefs = result.rows.map(r =>
                `- ${r.preference_type}: ${r.preference_key} = ${r.preference_value} (confidence: ${r.confidence})`
            ).join('\n');

            return `\n# User Preferences (auto-learned)\n${prefs}\n`;
        } catch (err) {
            logger.debug('Preference context fetch failed', { error: err.message });
            return '';
        }
    }

    /**
     * Parse LLM response for entry creation action blocks and execute them.
     */
    async _processEntryActions(userId, text) {
        const actionRegex = /\[ENTRY_ACTION:\s*(\{[^}]+\})\s*\]/g;
        const actions = [];
        let match;
        while ((match = actionRegex.exec(text)) !== null) {
            try {
                actions.push(JSON.parse(match[1]));
            } catch (e) {
                logger.debug('Failed to parse entry action JSON', { raw: match[1] });
            }
        }

        // Deduplicate: same type + same description (normalized) = duplicate
        const seen = new Set();
        const uniqueActions = actions.filter(a => {
            const key = `${a.type}:${(a.description || '').toLowerCase().trim()}:${a.entry_date || 'today'}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const cleanedText = text.replace(/\s*\[ENTRY_ACTION:\s*\{[^}]+\}\s*\]/g, '').trim();
        const confirmations = [];

        for (const action of uniqueActions) {
            try {
                if (action.type === 'diet') {
                    await this._createDietEntry(userId, action);
                    const dateLabel = action.entry_date ? ` (${action.entry_date})` : '';
                    const qtyLabel = action.quantity && action.quantity > 1 ? `${action.quantity}x ` : '';
                    confirmations.push(`Diet entry created: ${qtyLabel}${action.description}${dateLabel}`);
                } else if (action.type === 'expense') {
                    await this._createExpenseEntry(userId, action);
                    confirmations.push(`Expense logged: $${action.amount} — ${action.description}${action.merchant ? ` at ${action.merchant}` : ''}`);
                }
            } catch (err) {
                logger.warn('Failed to create cross-domain entry', { type: action.type, error: err.message });
                if (action.type === 'diet') {
                    confirmations.push(`Could not create diet entry automatically — you can add it in Diet > Entries`);
                } else {
                    confirmations.push(`Could not create expense entry automatically — you can add it in Payments`);
                }
            }
        }

        return { cleanedText, confirmations };
    }

    async _createDietEntry(userId, data) {
        const today = new Date().toISOString().split('T')[0];
        const qty = data.quantity && data.quantity > 1 ? data.quantity : 1;
        const desc = qty > 1 ? `${qty}x ${data.description}` : data.description;
        const response = await axios.post(`${DIET_SERVICE_URL}/v0/diet/entries`, {
            user_id: userId,
            entry_type: data.entry_type || 'food',
            description: desc,
            quantity: qty,
            unit: data.unit || 'serving',
            meal_type: data.meal_type || null,
            entry_date: data.entry_date || today
        }, {
            headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        logger.info('Cross-domain diet entry created from general chat', { userId, description: data.description });
        return response.data;
    }

    async _createExpenseEntry(userId, data) {
        const today = new Date().toISOString().split('T')[0];
        const response = await axios.post(`${PAYMENTS_SERVICE_URL}/v0/expenses`, {
            user_id: userId,
            amount: data.amount,
            currency: data.currency || 'USD',
            description: data.description,
            merchant: data.merchant || null,
            transaction_date: data.transaction_date || today,
            category: null,
            tags: [],
            notes: 'Created from General Chat'
        }, {
            headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
            timeout: 15000
        });
        logger.info('Cross-domain expense entry created from general chat', { userId, amount: data.amount });
        return response.data;
    }

    /**
     * Check if a chat message suggests the user is learning a topic.
     * If so, suggest enabling domain learning or offer a study plan.
     */
    async _generateProactiveSuggestion(userId, message, projectId) {
        try {
            // Check if the project has DL enabled
            const proj = await query(
                'SELECT metadata FROM v2_projects WHERE project_id = $1 AND user_id = $2',
                [projectId, userId]
            );
            if (!proj.rows.length) return null;
            const metadata = proj.rows[0].metadata || {};

            // Only suggest if DL is NOT already enabled (no point suggesting what they already have)
            if (metadata.learning?.domain_learning) return null;

            // Simple heuristic: if message contains learning-related keywords
            const lower = message.toLowerCase();
            const learningKeywords = [
                'how do i', 'explain', 'teach me', 'what is', 'help me understand',
                'learn about', 'study', 'tutorial', 'concept', 'beginner',
                'how does', 'can you explain', 'introduction to', 'basics of',
                'getting started', 'resources for'
            ];
            const isLearning = learningKeywords.some(kw => lower.includes(kw));
            if (!isLearning) return null;

            // Don't suggest too often — check if we suggested recently
            try {
                const recent = await query(
                    `SELECT COUNT(*) as cnt FROM dl_audit_events
                     WHERE user_id = $1 AND project_id = $2 AND event_type = 'proactive_suggestion'
                     AND created_at > NOW() - INTERVAL '1 day'`,
                    [userId, projectId]
                );
                if (parseInt(recent.rows[0].cnt) > 0) return null;
            } catch { /* table may not exist */ }

            // Log the suggestion
            try {
                await query(
                    `INSERT INTO dl_audit_events (user_id, project_id, event_type, payload)
                     VALUES ($1, $2, 'proactive_suggestion', $3)`,
                    [userId, projectId, JSON.stringify({ trigger_message: message.substring(0, 100) })]
                );
            } catch { /* ignore */ }

            return {
                type: 'enable_domain_learning',
                message: 'It looks like you\'re exploring a specific topic. Would you like to enable Domain Learning? I can build knowledge packs and suggest study plans to help you learn more effectively.'
            };
        } catch (err) {
            logger.debug('Proactive suggestion check failed', { error: err.message });
            return null;
        }
    }

    _isMemoryStoreRequest(message) {
        const lower = message.toLowerCase();
        return /\b(remember that|store this|save this|don't forget|keep in mind|note that|memorize)\b/.test(lower);
    }

    async _handleExplicitMemoryStore(userId, message, conversationHistory, startTime) {
        try {
            const recentContext = conversationHistory.slice(-6).map(m =>
                `${m.role === 'user' ? 'User' : 'Oggy'}: ${m.content}`
            ).join('\n');

            const extractPrompt = `The user is explicitly asking you to remember something. Extract ALL facts they want stored.

Recent conversation:
${recentContext}

User: ${message}

Return a JSON ARRAY of objects. Each object should have:
- "fact": the concise statement to remember (e.g., "User prefers dark mode")
- "type": one of "preference", "fact"

Respond with ONLY the JSON array, no markdown.`;

            const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
            const llmResult = await this.openaiBreaker.execute(() =>
                oggyResolved.adapter.chatCompletion({
                    model: oggyResolved.model,
                    messages: [{ role: 'user', content: extractPrompt }],
                    temperature: 0.1,
                    max_tokens: 400
                })
            );
            costGovernor.recordUsage(llmResult.tokens_used || 2000);
            providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'memoryStore', llmResult.tokens_used, llmResult.latency_ms, true, null);

            let facts;
            try {
                const parsed = JSON.parse(this._cleanJson(llmResult.text));
                facts = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
                return {
                    oggy_response: { text: "I understood you want me to remember something, but I couldn't parse it clearly. Could you rephrase?", used_memory: false },
                    base_response: { text: "I can't store memories." },
                    latency_ms: Date.now() - startTime
                };
            }

            facts = facts.filter(f => f && f.fact);
            if (facts.length === 0) {
                return {
                    oggy_response: { text: "I couldn't determine what you'd like me to remember. Could you be more specific?", used_memory: false },
                    base_response: { text: "I can't store memories." },
                    latency_ms: Date.now() - startTime
                };
            }

            const storedFacts = [];
            for (const parsed of facts) {
                try {
                    await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: 'user_preference',
                        content: {
                            type: 'PATTERN',
                            text: `USER STATED: ${parsed.fact}`,
                            source: 'explicit_user_request',
                            confidence: 1.0
                        },
                        tags: ['general', 'conversation', 'user_explicit'],
                        utility_weight: 0.95,
                        reliability: 0.95
                    }, {
                        timeout: 5000,
                        headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                    });
                    storedFacts.push(parsed.fact);
                    logger.info('Explicit memory stored from general chat', { fact: parsed.fact });
                } catch (err) {
                    logger.warn('Failed to store explicit memory', { error: err.message });
                }
            }

            const confirmText = storedFacts.length === 1
                ? `Got it! I'll remember: "${storedFacts[0]}"`
                : `Got it! I've stored ${storedFacts.length} things to memory:\n${storedFacts.map(f => `• ${f}`).join('\n')}`;

            return {
                oggy_response: { text: confirmText, used_memory: false },
                base_response: { text: "I don't have memory capabilities. I can't store or recall information between conversations." },
                latency_ms: Date.now() - startTime
            };
        } catch (err) {
            logger.logError(err, { operation: 'generalMemoryStore', userId });
            return {
                oggy_response: { text: 'Sorry, I had trouble storing that to memory. Please try again.', used_memory: false },
                base_response: { text: "I can't store memories." },
                latency_ms: Date.now() - startTime
            };
        }
    }

    /**
     * Detect if user is asking about Oggy's own performance.
     */
    // --- Project Suggestions ---

    async getProjectSuggestions(userId) {
        // Fetch user's memory cards for interests
        let memoryContext = 'No previous interests detected.';
        try {
            const retrieval = await this.memoryBreaker.execute(() =>
                axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    agent: 'oggy',
                    owner_type: 'user',
                    owner_id: userId,
                    query: 'user interests topics hobbies research areas goals',
                    top_k: 10,
                    tier_scope: [1, 2, 3],
                    tag_filter: ['general', 'conversation', 'user_explicit', 'behavior'],
                    include_scores: true
                }, {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                })
            );
            const cards = retrieval.data?.selected || [];
            if (cards.length > 0) {
                memoryContext = cards.map(c => c.content?.text || JSON.stringify(c.content)).join('\n');
            }
        } catch (err) {
            logger.debug('Memory retrieval for project suggestions failed', { error: err.message });
        }

        // Fetch existing projects to avoid duplicates
        let existingProjects = [];
        try {
            const projResult = await query('SELECT name FROM v2_projects WHERE user_id = $1', [userId]);
            existingProjects = projResult.rows.map(r => r.name);
        } catch (err) {
            logger.debug('Existing projects fetch failed', { error: err.message });
        }

        const prompt = `Based on the user's known interests and conversation history, suggest 4 research project ideas they might find valuable.

User's known interests and context:
${memoryContext}

Existing projects (do NOT suggest duplicates): ${existingProjects.join(', ') || 'none'}

Return a JSON array of exactly 4 suggestions. Each item:
{
  "name": "Short project name (max 50 chars)",
  "description": "1-2 sentence description of what this project explores",
  "reason": "Brief explanation of why this is suggested for THIS user"
}

If no user interests are available, suggest 4 diverse, universally interesting research topics (science, technology, history, self-improvement, finance, health).
Mix topics — do not cluster around one area.
Respond with ONLY the JSON array.`;

        await costGovernor.checkBudget(1500);

        const resolved = await providerResolver.getAdapter(userId, 'oggy');
        const result = await this.openaiBreaker.execute(() =>
            resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.8,
                max_tokens: 600
            })
        );
        costGovernor.recordUsage(result.tokens_used || 500);
        providerResolver.logRequest(userId, resolved.provider, resolved.model, 'oggy', 'projectSuggestions', result.tokens_used, result.latency_ms, true, null);

        try {
            const cleaned = this._cleanJson(result.text);
            const suggestions = JSON.parse(cleaned);
            return Array.isArray(suggestions) ? suggestions.slice(0, 4) : [];
        } catch {
            return [];
        }
    }

    // --- Notes CRUD ---

    async createNote(userId, projectId, content, sourceMessageId = null, sourceRole = null) {
        const result = await query(
            `INSERT INTO v2_project_notes (project_id, user_id, content, source_message_id, source_role)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [projectId, userId, content, sourceMessageId, sourceRole]
        );
        return result.rows[0];
    }

    async getNotes(userId, projectId) {
        const result = await query(
            `SELECT * FROM v2_project_notes
             WHERE project_id = $1 AND user_id = $2
             ORDER BY created_at DESC`,
            [projectId, userId]
        );
        return result.rows;
    }

    async deleteNote(userId, noteId) {
        const result = await query(
            'DELETE FROM v2_project_notes WHERE note_id = $1 AND user_id = $2 RETURNING note_id',
            [noteId, userId]
        );
        return result.rowCount > 0;
    }

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
