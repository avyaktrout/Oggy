/**
 * Chat Handler - Dual-model chat orchestration
 * Runs Oggy (with memory + behavior engine) and Base (without memory) in parallel
 * Behavior Design Doc: integrates candidate generation, scoring, audit
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../utils/db');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const { costGovernor } = require('../middleware/costGovernor');
const PreferenceManager = require('./preferenceManager');
const BehaviorEngine = require('./behaviorEngine');
const ResponseAuditor = require('./responseAuditor');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

class ChatHandler {
    constructor() {
        this.memoryBreaker = circuitBreakerRegistry.getOrCreate('memory-service', {
            failureThreshold: 5,
            timeout: 60000
        });
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api', {
            failureThreshold: 3,
            timeout: 30000
        });

        // Behavior system (initialized without Redis, hydrated later)
        this.prefManager = new PreferenceManager(null);
        this.auditor = new ResponseAuditor();
        this.behaviorEngine = new BehaviorEngine(this.prefManager, this.auditor);
    }

    /**
     * Set Redis client for preference caching (called after Redis connects)
     */
    setRedisClient(redisClient) {
        this.prefManager = new PreferenceManager(redisClient);
        this.behaviorEngine = new BehaviorEngine(this.prefManager, this.auditor);
    }

    async handleChat(userId, message, conversationHistory = [], options = {}) {
        const startTime = Date.now();

        // Budget: behavior engine generates 3-4 candidates, ~4x tokens
        await costGovernor.checkBudget(16000);

        const intent = this._detectIntent(message);

        // Handle explicit memory store requests
        if (intent === 'memory_store') {
            const storeResult = await this._handleExplicitMemoryStore(userId, message, conversationHistory);
            const latency_ms = Date.now() - startTime;
            return {
                oggy_response: storeResult,
                base_response: { text: "I don't have memory capabilities. I can't store or recall information between conversations.", used_memory: false },
                intent,
                latency_ms,
                request_id: options.requestId || null
            };
        }

        let contextData = null;
        if (intent === 'spending_query') {
            contextData = await this._queryExpenses(userId, message);
        }

        const [oggyResponse, baseResponse] = await Promise.all([
            this._getOggyResponse(userId, message, conversationHistory, intent, contextData, options),
            this._getBaseResponse(userId, message, conversationHistory, intent, contextData)
        ]);

        const latency_ms = Date.now() - startTime;
        costGovernor.recordUsage(12000);

        // Fire-and-forget: learn from this chat exchange if enabled
        if (options.learnFromChat) {
            this._learnFromChat(userId, message, oggyResponse.text, conversationHistory).catch(err => {
                logger.warn('Chat learning failed (non-blocking)', { error: err.message });
            });
        }

        return {
            oggy_response: oggyResponse,
            base_response: baseResponse,
            intent,
            latency_ms,
            request_id: options.requestId || null
        };
    }

    _detectIntent(message) {
        const lower = message.toLowerCase();
        const memoryKeywords = [
            'remember that', 'remember this', 'remember these',
            'store this', 'store these', 'store to memory', 'save to memory',
            'save this', 'save these', 'memorize', 'keep in mind',
            'note that', 'learn that', 'don\'t forget',
            'to memory', 'into memory'
        ];
        const spendingKeywords = [
            'spend', 'spent', 'how much', 'total', 'summary', 'expenses', 'payments', 'cost', 'budget',
            'description', 'merchant', 'recent', 'transaction', 'purchased', 'bought', 'paid',
            'what did i', 'what have i', 'show me', 'list my', 'my expense', 'details'
        ];
        const categoryKeywords = ['categorize', 'category', 'classify', 'what type', 'is this'];

        if (memoryKeywords.some(k => lower.includes(k))) return 'memory_store';
        if (spendingKeywords.some(k => lower.includes(k))) return 'spending_query';
        if (categoryKeywords.some(k => lower.includes(k))) return 'categorization';
        return 'general';
    }

    async _queryExpenses(userId, message) {
        try {
            const result = await query(
                `SELECT category, COUNT(*) as count, SUM(amount) as total
                 FROM expenses WHERE user_id = $1 AND status = 'active'
                 GROUP BY category ORDER BY total DESC`,
                [userId]
            );

            const recentResult = await query(
                `SELECT merchant, amount, category, description, transaction_date
                 FROM expenses WHERE user_id = $1 AND status = 'active'
                 ORDER BY transaction_date DESC LIMIT 20`,
                [userId]
            );

            return {
                category_summary: result.rows,
                recent_expenses: recentResult.rows
            };
        } catch (err) {
            logger.warn('Chat: failed to query expenses', { error: err.message });
            return null;
        }
    }

    async _retrieveMemory(userId, queryText) {
        try {
            const response = await this.memoryBreaker.execute(() =>
                axios.get(`${MEMORY_SERVICE_URL}/retrieve`, {
                    params: {
                        agent: 'oggy',
                        owner_type: 'user',
                        owner_id: userId,
                        query: queryText,
                        top_k: 5,
                        tag_filter: JSON.stringify(['payments', 'categorization'])
                    },
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                })
            );
            return response.data?.selected || [];
        } catch (err) {
            logger.warn('Chat: memory retrieval failed', { error: err.message });
            return [];
        }
    }

    async _getOggyResponse(userId, message, history, intent, contextData, options = {}) {
        try {
            const memoryCards = await this._retrieveMemory(userId, message);
            const systemPrompt = this._buildSystemPrompt(intent, contextData, memoryCards);
            const memoryCardIds = memoryCards.map(c => c.card_id).filter(Boolean);

            // Use behavior engine for candidate generation + scoring + audit
            const result = await this.behaviorEngine.selectResponse(
                userId, message, systemPrompt, history,
                {
                    requestId: options.requestId,
                    sessionId: options.sessionId,
                    memoryCardIds
                }
            );

            return {
                text: result.text,
                used_memory: memoryCards.length > 0,
                style: result.style,
                audit: result.audit
            };
        } catch (err) {
            logger.error('Chat: Oggy response failed', { error: err.message });
            return { text: 'Sorry, I encountered an error. Please try again.', used_memory: false };
        }
    }

    async _getBaseResponse(userId, message, history, intent, contextData) {
        try {
            const systemPrompt = this._buildSystemPrompt(intent, contextData, []);
            const messages = [
                { role: 'system', content: systemPrompt },
                ...history.slice(-10),
                { role: 'user', content: message }
            ];

            const response = await this.openaiBreaker.execute(() =>
                axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages,
                    temperature: 0.5,
                    max_tokens: 500
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 15000
                })
            );

            return { text: response.data.choices[0].message.content, used_memory: false };
        } catch (err) {
            logger.error('Chat: Base response failed', { error: err.message });
            return { text: 'Sorry, I encountered an error. Please try again.', used_memory: false };
        }
    }

    _buildSystemPrompt(intent, contextData, memoryCards) {
        let prompt = `You are Oggy, a payments assistant with persistent memory. You can remember things across conversations.
You help users with expenses, spending patterns, and categorization. Be concise and helpful.
IMPORTANT: If the user asks you to save, store, or remember something, tell them you can do that — say something like "Sure, just say 'remember that...' and I'll store it to my memory."
Do NOT say you can't remember things or that you don't have memory — you DO.\n\n`;

        if (contextData) {
            if (contextData.category_summary?.length > 0) {
                prompt += 'Spending by category:\n';
                contextData.category_summary.forEach(row => {
                    prompt += `- ${row.category || 'uncategorized'}: ${row.count} payments, $${parseFloat(row.total).toFixed(2)}\n`;
                });
                prompt += '\n';
            }
            if (contextData.recent_expenses?.length > 0) {
                prompt += 'Recent expenses:\n';
                contextData.recent_expenses.slice(0, 10).forEach(e => {
                    const desc = e.description ? ` — "${e.description}"` : '';
                    prompt += `- ${e.transaction_date}: ${e.merchant || 'unknown'} - $${parseFloat(e.amount).toFixed(2)} (${e.category || 'uncategorized'})${desc}\n`;
                });
                prompt += '\n';
            }
        }

        if (memoryCards.length > 0) {
            prompt += 'Learned patterns from memory:\n';
            memoryCards.forEach(card => {
                if (card.content) {
                    const c = typeof card.content === 'string' ? card.content : JSON.stringify(card.content);
                    prompt += `- ${c}\n`;
                }
            });
            prompt += '\n';
        }

        return prompt;
    }

    /**
     * Handle explicit "remember that..." / "store this to memory" requests.
     * Uses OpenAI to extract facts (supports multiple), stores as memory cards,
     * and updates expense records when merchant/category pairs are identified.
     */
    async _handleExplicitMemoryStore(userId, message, conversationHistory) {
        try {
            const recentContext = conversationHistory.slice(-6).map(m =>
                `${m.role === 'user' ? 'User' : 'Oggy'}: ${m.content}`
            ).join('\n');

            const extractPrompt = `The user is explicitly asking you to remember something. Extract ALL facts they want stored.

Recent conversation:
${recentContext}

User: ${message}

Return a JSON ARRAY of objects. Each object should have:
- "fact": the concise statement to remember (e.g., "Costco purchases should be categorized as groceries")
- "merchant": merchant name if mentioned, or null
- "category": category if mentioned, or null
- "type": one of "preference", "correction", "fact"

If there is only one fact, still return it as an array with one element.
If the conversation contains categorizations suggested by Oggy that the user is confirming, extract each merchant-category pair as a separate fact.

Respond with ONLY the JSON array, no markdown.`;

            const response = await this.openaiBreaker.execute(() =>
                axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages: [{ role: 'user', content: extractPrompt }],
                    temperature: 0.1,
                    max_tokens: 600
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 15000
                })
            );

            costGovernor.recordUsage(4000);
            const raw = response.data.choices[0].message.content.trim();

            let facts;
            try {
                const parsed = JSON.parse(raw);
                // Accept both array and single object
                facts = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
                return { text: "I understood you want me to remember something, but I couldn't parse it clearly. Could you rephrase?", used_memory: false };
            }

            // Filter out entries without a fact
            facts = facts.filter(f => f && f.fact);
            if (facts.length === 0) {
                return { text: "I couldn't determine what you'd like me to remember. Could you be more specific?", used_memory: false };
            }

            const storedFacts = [];
            const updatedExpenses = [];

            for (const parsed of facts) {
                // Store as high-confidence, high-reliability memory card
                const tags = ['payments', 'categorization', 'user_explicit'];
                if (parsed.category) tags.push(parsed.category);
                if (parsed.merchant) tags.push(parsed.merchant.toLowerCase().replace(/\s+/g, '_'));

                try {
                    await axios.post(
                        `${MEMORY_SERVICE_URL}/cards`,
                        {
                            owner_type: 'user',
                            owner_id: userId,
                            tier: 2,
                            kind: parsed.type === 'correction' ? 'expense_category_correction' : 'user_preference',
                            content: {
                                type: parsed.type === 'correction' ? 'BENCHMARK_CORRECTION' : 'PATTERN',
                                text: `USER STATED: ${parsed.fact}`,
                                merchant: parsed.merchant || null,
                                category: parsed.category || null,
                                source: 'explicit_user_request',
                                confidence: 1.0
                            },
                            tags,
                            utility_weight: 0.95,
                            reliability: 0.95
                        },
                        { timeout: 5000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } }
                    );

                    storedFacts.push(parsed.fact);

                    logger.info('Explicit memory stored from chat', {
                        fact: parsed.fact,
                        merchant: parsed.merchant,
                        category: parsed.category
                    });

                    // Update expense records if we have a merchant + category
                    if (parsed.merchant && parsed.category) {
                        try {
                            const updated = await query(
                                `UPDATE expenses SET category = $1
                                 WHERE user_id = $2 AND LOWER(merchant) = LOWER($3)
                                   AND (category IS NULL OR category = 'uncategorized')
                                   AND status = 'active'`,
                                [parsed.category, userId, parsed.merchant]
                            );
                            if (updated.rowCount > 0) {
                                updatedExpenses.push({ merchant: parsed.merchant, category: parsed.category, count: updated.rowCount });
                                logger.info('Updated expenses from chat memory store', {
                                    merchant: parsed.merchant, category: parsed.category, count: updated.rowCount
                                });
                            }
                        } catch (updateErr) {
                            logger.warn('Failed to update expenses from chat', { error: updateErr.message });
                        }
                    }
                } catch (cardErr) {
                    logger.warn('Failed to store one memory fact', { fact: parsed.fact, error: cardErr.message });
                }
            }

            if (storedFacts.length === 0) {
                return { text: "Sorry, I had trouble storing that to memory. Please try again.", used_memory: false };
            }

            // Build response message
            let responseText;
            if (storedFacts.length === 1) {
                responseText = `Got it! I've stored this to memory: "${storedFacts[0]}".`;
            } else {
                const factList = storedFacts.map(f => `- ${f}`).join('\n');
                responseText = `Got it! I've stored ${storedFacts.length} facts to memory:\n${factList}`;
            }

            if (updatedExpenses.length > 0) {
                const updateSummary = updatedExpenses.map(u => `${u.count} ${u.merchant} expense(s) → ${u.category}`).join(', ');
                responseText += `\n\nI also updated your expenses: ${updateSummary}.`;
            }

            responseText += '\nI\'ll use these in future categorizations and conversations.';

            return {
                text: responseText,
                used_memory: true,
                stored_memory: true,
                facts_stored: storedFacts.length,
                expenses_updated: updatedExpenses.length
            };

        } catch (err) {
            logger.error('Explicit memory store failed', { error: err.message });
            return { text: "Sorry, I had trouble storing that to memory. Please try again.", used_memory: false };
        }
    }

    /**
     * Extract learnable insights from a chat exchange and store as memory cards.
     * Runs async (fire-and-forget) to avoid slowing down chat responses.
     */
    async _learnFromChat(userId, userMessage, oggyResponse, conversationHistory) {
        try {
            await costGovernor.checkBudget(4000);
        } catch {
            return; // Skip learning if budget is tight
        }

        const recentContext = conversationHistory.slice(-6).map(m =>
            `${m.role === 'user' ? 'User' : 'Oggy'}: ${m.content}`
        ).join('\n');

        const extractPrompt = `Analyze this chat exchange between a user and a payments assistant. Extract any LEARNABLE FACTS about the user's spending habits, merchant preferences, or categorization corrections.

Recent context:
${recentContext}

User: ${userMessage}
Oggy: ${oggyResponse}

Return a JSON array of learnable insights. Each insight should have:
- "type": one of "preference", "correction", "fact"
- "text": a concise statement of what was learned (e.g., "User categorizes Costco purchases as groceries")
- "merchant": merchant name if applicable, or null
- "category": category if applicable, or null
- "confidence": 0.0-1.0 how certain this is a real learning

Rules:
- Only extract CONCRETE, ACTIONABLE insights about the user's spending
- Do NOT extract generic knowledge (e.g., "user asks about spending")
- Do NOT extract things Oggy said — only what the USER revealed
- If there is nothing learnable, return an empty array []
- Maximum 3 insights per exchange

Respond with ONLY the JSON array, no markdown.`;

        try {
            const response = await this.openaiBreaker.execute(() =>
                axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages: [{ role: 'user', content: extractPrompt }],
                    temperature: 0.2,
                    max_tokens: 300
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 10000
                })
            );

            costGovernor.recordUsage(3000);
            const raw = response.data.choices[0].message.content.trim();

            let insights;
            try {
                insights = JSON.parse(raw);
            } catch {
                return; // LLM didn't return valid JSON
            }

            if (!Array.isArray(insights) || insights.length === 0) return;

            // Store each insight as a memory card
            for (const insight of insights.slice(0, 3)) {
                if (!insight.text || (insight.confidence || 0) < 0.5) continue;

                const tags = ['payments', 'categorization', 'chat_learned'];
                if (insight.category) tags.push(insight.category);
                if (insight.merchant) tags.push(insight.merchant.toLowerCase().replace(/\s+/g, '_'));

                await axios.post(
                    `${MEMORY_SERVICE_URL}/cards`,
                    {
                        owner_type: 'user',
                        owner_id: userId,
                        tier: 2,
                        kind: insight.type === 'correction' ? 'expense_category_correction' : 'user_preference',
                        content: {
                            type: insight.type === 'correction' ? 'BENCHMARK_CORRECTION' : 'PATTERN',
                            text: `CHAT LEARNED: ${insight.text}`,
                            merchant: insight.merchant || null,
                            category: insight.category || null,
                            source: 'chat_interaction',
                            confidence: insight.confidence
                        },
                        tags,
                        utility_weight: 0.7,
                        reliability: Math.min(insight.confidence || 0.6, 0.85)
                    },
                    { timeout: 5000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } }
                );

                logger.info('Chat learning: stored insight', {
                    type: insight.type,
                    merchant: insight.merchant,
                    category: insight.category
                });
            }
        } catch (err) {
            logger.warn('Chat learning extraction failed', { error: err.message });
        }
    }
}

module.exports = new ChatHandler();
