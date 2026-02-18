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
const providerResolver = require('../providers/providerResolver');
const { getApplicationKnowledge, detectAppKnowledgeIntent } = require('./applicationKnowledge');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

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

        // Always load recent expense context (last 3 days) + date-specific if spending query
        let contextData = null;
        let recentExpenseContext = '';
        try {
            // Always include last 3 days of expenses as background context
            const now = options.clientDate ? new Date(options.clientDate + 'T12:00:00') : new Date(Date.now() - 5 * 60 * 60 * 1000);
            const days = [];
            for (let i = 0; i < 3; i++) {
                const d = new Date(now); d.setDate(d.getDate() - i);
                const ds = d.toISOString().slice(0, 10);
                const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : ds;
                const dayExpenses = await query(
                    `SELECT merchant, amount, category, description, transaction_date
                     FROM expenses WHERE user_id = $1 AND status = 'active' AND transaction_date = $2
                     ORDER BY created_at DESC LIMIT 10`,
                    [userId, ds]
                );
                if (dayExpenses.rows.length > 0) {
                    const total = dayExpenses.rows.reduce((s, e) => s + parseFloat(e.amount), 0);
                    const items = dayExpenses.rows.map(e => `${e.merchant || 'unknown'} $${parseFloat(e.amount).toFixed(2)} (${e.category || 'uncategorized'})`).join(', ');
                    days.push(`${label} (${ds}): ${dayExpenses.rows.length} expense(s), $${total.toFixed(2)} total — ${items}`);
                }
            }
            if (days.length > 0) {
                recentExpenseContext = `\n# Recent Expenses\n${days.join('\n')}\n`;
            }
        } catch (err) {
            logger.debug('Failed to load recent expense context', { error: err.message });
        }

        if (intent === 'spending_query') {
            contextData = await this._queryExpenses(userId, message, options.clientDate);
        }

        const [oggyResponse, baseResponse] = await Promise.all([
            this._getOggyResponse(userId, message, conversationHistory, intent, contextData, options, performanceContext, appKnowledgeContext, recentExpenseContext),
            this._getBaseResponse(userId, message, conversationHistory, intent, contextData, recentExpenseContext)
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
            'what did i', 'what have i', 'show me', 'list my', 'my expense', 'details',
            'today', 'yesterday', 'this week', 'this month', 'last week', 'last month',
            'entered', 'logged', 'recorded', 'added'
        ];
        const categoryKeywords = ['categorize', 'category', 'classify', 'what type', 'is this'];

        if (memoryKeywords.some(k => lower.includes(k))) return 'memory_store';
        if (spendingKeywords.some(k => lower.includes(k))) return 'spending_query';
        if (categoryKeywords.some(k => lower.includes(k))) return 'categorization';
        return 'general';
    }

    _parseDateRange(message, clientDate) {
        const lower = message.toLowerCase();
        // Use client's local date if provided, otherwise fall back to UTC-5
        const now = clientDate ? new Date(clientDate + 'T12:00:00') : new Date(Date.now() - 5 * 60 * 60 * 1000);
        const today = clientDate || now.toISOString().slice(0, 10);

        // "today" or "today's"
        if (/\btoday\b/.test(lower)) {
            return { start: today, end: today, label: 'today' };
        }
        // "yesterday"
        if (/\byesterday\b/.test(lower)) {
            const d = new Date(now); d.setDate(d.getDate() - 1);
            const y = d.toISOString().slice(0, 10);
            return { start: y, end: y, label: 'yesterday' };
        }
        // "this week"
        if (/\bthis week\b/.test(lower)) {
            const d = new Date(now); d.setDate(d.getDate() - d.getDay());
            return { start: d.toISOString().slice(0, 10), end: today, label: 'this week' };
        }
        // "last week"
        if (/\blast week\b/.test(lower)) {
            const d = new Date(now); d.setDate(d.getDate() - d.getDay() - 7);
            const e = new Date(d); e.setDate(e.getDate() + 6);
            return { start: d.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10), label: 'last week' };
        }
        // "this month"
        if (/\bthis month\b/.test(lower)) {
            return { start: `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`, end: today, label: 'this month' };
        }
        // "last month"
        if (/\blast month\b/.test(lower)) {
            const m = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const e = new Date(now.getFullYear(), now.getMonth(), 0);
            return { start: m.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10), label: 'last month' };
        }
        // Specific date like "February 15" or "Feb 15th" or "2/15"
        const monthNames = { jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11 };
        const dateMatch = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
        if (dateMatch) {
            const month = monthNames[dateMatch[1]];
            const day = parseInt(dateMatch[2]);
            const d = new Date(now.getFullYear(), month, day);
            const ds = d.toISOString().slice(0, 10);
            return { start: ds, end: ds, label: `${dateMatch[1]} ${dateMatch[2]}` };
        }
        // Numeric date like "2/15" or "02/15"
        const numMatch = lower.match(/\b(\d{1,2})\/(\d{1,2})\b/);
        if (numMatch) {
            const d = new Date(now.getFullYear(), parseInt(numMatch[1]) - 1, parseInt(numMatch[2]));
            const ds = d.toISOString().slice(0, 10);
            return { start: ds, end: ds, label: `${numMatch[1]}/${numMatch[2]}` };
        }
        return null;
    }

    async _queryExpenses(userId, message, clientDate) {
        try {
            const dateRange = this._parseDateRange(message, clientDate);

            const dateFilter = dateRange
                ? `AND transaction_date >= '${dateRange.start}' AND transaction_date <= '${dateRange.end}'`
                : '';
            const dateLabel = dateRange ? dateRange.label : 'all time';

            const result = await query(
                `SELECT category, COUNT(*) as count, SUM(amount) as total
                 FROM expenses WHERE user_id = $1 AND status = 'active' ${dateFilter}
                 GROUP BY category ORDER BY total DESC`,
                [userId]
            );

            const recentResult = await query(
                `SELECT merchant, amount, category, description, transaction_date
                 FROM expenses WHERE user_id = $1 AND status = 'active' ${dateFilter}
                 ORDER BY transaction_date DESC LIMIT 20`,
                [userId]
            );

            return {
                category_summary: result.rows,
                recent_expenses: recentResult.rows,
                date_label: dateLabel,
                date_range: dateRange,
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

    async _getOggyResponse(userId, message, history, intent, contextData, options = {}, performanceContext = '', appKnowledgeContext = '', recentExpenseContext = '') {
        try {
            const memoryCards = await this._retrieveMemory(userId, message);
            const systemPrompt = this._buildSystemPrompt(intent, contextData, memoryCards, performanceContext, appKnowledgeContext, recentExpenseContext);
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

    async _getBaseResponse(userId, message, history, intent, contextData, recentExpenseContext = '') {
        try {
            const systemPrompt = this._buildSystemPrompt(intent, contextData, [], '', '', recentExpenseContext);
            const messages = [
                { role: 'system', content: systemPrompt },
                ...history.slice(-10),
                { role: 'user', content: message }
            ];

            const baseResolved = await providerResolver.getAdapter(userId, 'base');
            const result = await this.openaiBreaker.execute(() =>
                baseResolved.adapter.chatCompletion({
                    model: baseResolved.model,
                    messages,
                    temperature: 0.5,
                    max_tokens: 500
                })
            );
            providerResolver.logRequest(userId, baseResolved.provider, baseResolved.model, 'base', 'chat', result.tokens_used, result.latency_ms, true, null);

            return { text: result.text, used_memory: false };
        } catch (err) {
            logger.error('Chat: Base response failed', { error: err.message });
            return { text: 'Sorry, I encountered an error. Please try again.', used_memory: false };
        }
    }

    _buildSystemPrompt(intent, contextData, memoryCards, performanceContext = '', appKnowledgeContext = '', recentExpenseContext = '') {
        const todayStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const todayISO = new Date().toISOString().split('T')[0];
        let prompt = `You are Oggy, a payments assistant with persistent memory. You can remember things across conversations.
Today is ${todayStr} (${todayISO}).
You help users with expenses, spending patterns, and categorization. Be concise and helpful.
IMPORTANT: The Recent Expenses section below contains the user's ACTUAL expenses for each date. When answering about what the user spent or bought, ONLY reference expenses from the correct date. "Yesterday" means the day before today. Do NOT confuse expenses from different dates.
IMPORTANT: If the user asks you to save, store, or remember something, tell them you can do that — say something like "Sure, just say 'remember that...' and I'll store it to my memory."
Do NOT say you can't remember things or that you don't have memory — you DO.
${recentExpenseContext}\n`;

        if (performanceContext) {
            prompt += performanceContext;
            prompt += `\nIMPORTANT: The user is asking about your performance. You MUST answer using the REAL performance data provided above in "My Performance Data". Do NOT say you don't have access to data or can't evaluate yourself — you DO have this data. Reference specific numbers, levels, accuracy percentages, and trends from the data above. If no benchmarks exist yet, say so honestly and suggest starting a training session.\n\n`;
        }

        if (appKnowledgeContext) {
            prompt += appKnowledgeContext;
            prompt += `\nIMPORTANT: The user is asking about the Oggy application, its architecture, security, or features. You MUST answer using the detailed application knowledge provided above in "About Oggy". You have comprehensive knowledge of how you work, your security model, database schema, features, and architecture. Answer confidently and accurately using the information above. Do NOT say you don't know how you work or that you can't answer questions about yourself — you CAN and you MUST use the knowledge above.\n\n`;
        }

        if (contextData) {
            const scope = contextData.date_label || 'all time';
            if (contextData.category_summary?.length > 0) {
                prompt += `Spending by category (${scope}):\n`;
                contextData.category_summary.forEach(row => {
                    prompt += `- ${row.category || 'uncategorized'}: ${row.count} payments, $${parseFloat(row.total).toFixed(2)}\n`;
                });
                prompt += '\n';
            } else if (contextData.date_range) {
                prompt += `No expenses found for ${scope}.\n\n`;
            }
            if (contextData.recent_expenses?.length > 0) {
                prompt += `Expenses (${scope}):\n`;
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

            const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
            const llmResult = await this.openaiBreaker.execute(() =>
                oggyResolved.adapter.chatCompletion({
                    model: oggyResolved.model,
                    messages: [{ role: 'user', content: extractPrompt }],
                    temperature: 0.1,
                    max_tokens: 600
                })
            );

            costGovernor.recordUsage(llmResult.tokens_used || 4000);
            providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'memoryStore', llmResult.tokens_used, llmResult.latency_ms, true, null);
            const raw = llmResult.text;

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

            return `# My Performance Data\n${parts.join('\n')}\n`;
        } catch (err) {
            logger.debug('Performance context fetch failed', { error: err.message });
            return '';
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
            const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
            const learnResult = await this.openaiBreaker.execute(() =>
                oggyResolved.adapter.chatCompletion({
                    model: oggyResolved.model,
                    messages: [{ role: 'user', content: extractPrompt }],
                    temperature: 0.2,
                    max_tokens: 300,
                    timeout: 10000
                })
            );

            costGovernor.recordUsage(learnResult.tokens_used || 3000);
            const raw = learnResult.text;

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
