/**
 * Oggy Categorization Service
 * Uses memory retrieval to suggest expense categories
 * Stage 0, Week 5 + Week 7 resilience improvements
 * Week 8+: Enhanced with learned category distinction rules
 */

const axios = require('axios');
const logger = require('../utils/logger');
const retryHandler = require('../utils/retry');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const correctionValidator = require('../utils/correctionValidator');
const { costGovernor } = require('../middleware/costGovernor');
const categoryRulesManager = require('./categoryRulesManager');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

class OggyCategorizer {
    constructor() {
        // Use registry to get shared circuit breaker instances
        this.memoryCircuitBreaker = circuitBreakerRegistry.getOrCreate('memory-service', {
            failureThreshold: 5,
            timeout: 60000
        });

        this.openaiCircuitBreaker = circuitBreakerRegistry.getOrCreate('openai-api', {
            failureThreshold: 3,
            timeout: 30000
        });
    }
    /**
     * Suggest a category for an expense using Oggy (with memory retrieval)
     * @param {string} userId - User ID
     * @param {Object} expenseData - Expense details
     * @returns {Promise<Object>} Suggestion with trace_id for learning feedback
     */
    async suggestCategory(userId, expenseData, options = {}) {
        const startTime = Date.now();
        const degraded_reasons = [];
        let used_fallback = false;
        let memory_retrieval_failed = false;
        const { benchmark_mode = false, memory_mode = 'benchmark', speed_mode = 'normal' } = options;

        try {
            // Check budget before making expensive API calls
            await costGovernor.checkBudget(2000); // Estimate 2k tokens

            // Step 1: Build retrieval query
            const query = this._buildCategoryQuery(expenseData);

            // Step 2: Retrieve relevant memory cards from memory service (with circuit breaker)
            let retrieval;
            let memoryCards = [];
            let trace_id = null;

            const retrievalTopK = speed_mode === 'very_fast'
                ? 0
                : (speed_mode === 'fast'
                    ? (benchmark_mode ? 2 : 1)
                    : (benchmark_mode ? 5 : 5));
            const retrievalTagFilter = benchmark_mode
                ? (memory_mode === 'full'
                    ? ['payments', 'categorization']
                    : ['benchmark_learned', 'correction', 'payments', 'categorization'])
                : ['payments', 'categorization'];
            try {
                if (retrievalTopK > 0 && memory_mode !== 'none') {
                    retrieval = await this.memoryCircuitBreaker.execute(() =>
                        this._retrieveMemory(userId, query, retrievalTopK, retrievalTagFilter)
                    );
                    trace_id = retrieval.trace_id;
                    memoryCards = retrieval.selected || [];
                    if (benchmark_mode && memoryCards.length > retrievalTopK) {
                        memoryCards = memoryCards.slice(0, retrievalTopK);
                    }
                }

                logger.info('Memory retrieval successful', {
                    userId,
                    cardsRetrieved: memoryCards.length,
                    trace_id
                });
            } catch (error) {
                if (error.circuitBreakerOpen) {
                    degraded_reasons.push('memory_circuit_open');
                    logger.warn('Memory service circuit breaker open, using fallback');
                } else {
                    memory_retrieval_failed = true;
                    logger.warn('Memory retrieval failed, continuing without memory', {
                        error: error.message
                    });
                }
                // Continue without memory cards (graceful degradation)
            }

            // Step 2.5: Fetch learned category distinction rules (ALWAYS retrieved)
            let categoryRules = [];
            try {
                // Get all active rules - these bypass semantic retrieval
                categoryRules = await categoryRulesManager.getActiveRules(userId);
                if (categoryRules.length > 0) {
                    logger.debug('Loaded category distinction rules', {
                        count: categoryRules.length,
                        rules: categoryRules.map(r => `${r.category_a}↔${r.category_b}`)
                    });
                }
            } catch (error) {
                logger.warn('Failed to load category rules, continuing without', {
                    error: error.message
                });
            }

            // Step 3: Build prompt with memory context AND category rules
            const prompt = this._buildCategorizationPrompt(expenseData, memoryCards, categoryRules, {
                benchmark_mode,
                speed_mode
            });

            // Step 4: Call OpenAI (with circuit breaker and cost tracking)
            const suggestion = await this.openaiCircuitBreaker.execute(() =>
                this._callOpenAI(prompt, { benchmark_mode, speed_mode })
            );

            // Record actual token usage (estimate from response)
            const estimatedTokens = prompt.length / 4 + 200; // Rough estimate
            costGovernor.recordUsage(Math.ceil(estimatedTokens));

            const latency = Date.now() - startTime;
            logger.logMetric('categorization_latency', latency, 'ms');

            const breaker_states = {
                memory: this.memoryCircuitBreaker.getState(),
                openai: this.openaiCircuitBreaker.getState()
            };

            const breaker_not_closed =
                breaker_states.memory.state !== 'CLOSED' ||
                breaker_states.openai.state !== 'CLOSED';

            const learning_gate_open = breaker_not_closed || used_fallback;
            const learning_allowed = !learning_gate_open;

            // Step 5: Return suggestion with trace_id for feedback loop
            return {
                suggested_category: suggestion.category,
                confidence: suggestion.confidence,
                reasoning: suggestion.reasoning,
                trace_id,  // CRITICAL: for memory update when user gives feedback
                alternatives: suggestion.alternatives || [],
                latency_ms: latency,
                _meta: {
                    learning_allowed,
                    learning_gate_open,
                    breaker_states,
                    used_fallback,
                    memory_retrieval_failed,
                    degraded_reasons,
                    benchmark_mode,
                    memory_mode,
                    speed_mode
                }
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'suggestCategory',
                userId,
                merchant: expenseData.merchant
            });

            // Fallback to simple rule-based categorization
            logger.info('Using fallback categorization');
            used_fallback = true;
            degraded_reasons.push('fallback_categorization');

            const breaker_states = {
                memory: this.memoryCircuitBreaker.getState(),
                openai: this.openaiCircuitBreaker.getState()
            };

            const breaker_not_closed =
                breaker_states.memory.state !== 'CLOSED' ||
                breaker_states.openai.state !== 'CLOSED';

            const learning_gate_open = breaker_not_closed || used_fallback;
            const learning_allowed = !learning_gate_open;

            const fallback = this._fallbackCategorization(expenseData);
            return {
                ...fallback,
                _meta: {
                    learning_allowed,
                    learning_gate_open,
                    breaker_states,
                    used_fallback,
                    memory_retrieval_failed,
                    degraded_reasons,
                    benchmark_mode,
                    memory_mode,
                    speed_mode
                }
            };
        }
    }

    /**
     * Build query string for memory retrieval
     */
    _buildCategoryQuery(expenseData) {
        const { merchant, description, amount } = expenseData;
        return `Categorize expense: ${merchant || 'Unknown'} - ${description} ($${amount})`;
    }

    /**
     * Retrieve memory cards from memory service (with retry logic)
     */
    async _retrieveMemory(userId, query, topK = 5, tagFilter = ['payments', 'categorization']) {
        return await retryHandler.withRetry(
            async () => {
                const response = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    agent: 'oggy',
                    owner_type: 'user',
                    owner_id: userId,
                    query,
                    top_k: topK,
                    tier_scope: [1, 2, 3],  // working, short, long-term
                    tag_filter: tagFilter,
                    include_scores: true
                }, {
                    timeout: 5000,
                    headers: {
                        'x-api-key': process.env.INTERNAL_API_KEY || ''
                    }
                });

                return response.data;
            },
            {
                maxRetries: 3,
                baseDelay: 500,
                operationName: 'memory-retrieval',
                shouldRetry: retryHandler.constructor.retryableHttpErrors
            }
        );
    }

    /**
     * Build categorization prompt with memory context and category rules
     */
    _buildCategorizationPrompt(expenseData, memoryCards, categoryRules = [], options = {}) {
        const { merchant, description, amount, transaction_date } = expenseData;
        const { benchmark_mode = false, speed_mode = 'normal' } = options;

        // Extract relevant patterns from memory, formatting correction memories specially
        let contextStr = memoryCards.length > 0
            ? memoryCards.map((card, idx) => {
                const content = card.content || {};
                return `${idx + 1}. ${this._formatMemoryCard(content)}`;
            }).join('\n')
            : 'No previous patterns available.';

        const maxContext = speed_mode === 'very_fast' ? 150 : (speed_mode === 'fast' ? 300 : (benchmark_mode ? 800 : 2000));
        if (contextStr.length > maxContext) {
            contextStr = contextStr.slice(0, maxContext) + '...';
        }

        // Priority confusion rules (always inject unless very_fast)
        let rulesStr = '';
        if (speed_mode !== 'very_fast') {
            const priorityRules = [
                'business_meal vs dining: If business tasks (client, budget, project, proposal, meeting decisions) occur, choose business_meal; otherwise choose dining.',
                'shopping vs other: If specific retail goods are purchased (clothing, electronics, home goods), choose shopping; use other only when no category fits.',
                'health vs other: If a prescription, pharmacy visit, or medical service is mentioned, choose health; use other only when no category fits.'
            ];
            const priorityBlock = `# PRIORITY CONFUSION RULES\n` +
                priorityRules.map((r, i) => `${i + 1}. ${r}`).join('\n') +
                `\n\nIMPORTANT: Apply these PRIORITY rules before any other guidance.\n`;

            const rulesForPrompt = benchmark_mode ? categoryRules.slice(0, 6) : categoryRules;
            const learnedBlock = categoryRulesManager.formatRulesForPrompt(rulesForPrompt);
            rulesStr = `${priorityBlock}${learnedBlock}`;
        }

        return `You are a financial categorization assistant helping to categorize expenses.

# Expense Details
Merchant: ${merchant || 'Unknown'}
Description: ${description}
Amount: $${amount}
Date: ${transaction_date}

${rulesStr}

# Learned Patterns from Memory
${contextStr}

IMPORTANT: If any RULE or DISTINCTION above matches this expense, you MUST apply it.
IMPORTANT: Avoid using "other" if there are clear signals for any specific category. Use "other" only when none of the categories reasonably fit.

# Available Categories
- dining: Personal restaurant/cafe visits for pleasure, casual meals out, coffee shops (NOT work-related)
- groceries: Supermarkets, grocery stores, food shopping for home
- transportation: Gas, public transit, ride sharing, parking, car expenses
- utilities: Electric, gas, water, internet, phone bills
- entertainment: Movies, concerts, streaming services, hobbies, gaming
- business_meal: Client dinners, business lunches, team meals, work-related dining
- shopping: Retail stores, online shopping, clothing, electronics
- health: Pharmacy, medical, fitness, gym, wellness
- personal_care: Salon, spa, grooming
- other: Anything that doesn't fit above categories

# Key Distinctions
- **dining vs business_meal**: dining = personal/social meals; business_meal = work-related (client meetings, team events, conferences)
- **groceries vs shopping**: groceries = food for home; shopping = non-food retail items

# Instructions
Based on the expense details, learned distinctions, and past patterns, suggest the most appropriate category.
Respond in JSON format (no markdown, just raw JSON):
{
  "category": "<category_name>",
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation in 1-2 sentences>",
  "alternatives": [
    {"category": "<alt_category>", "confidence": <score>}
  ]
}`;
    }

    /**
     * Call OpenAI API for categorization (with retry logic)
     */
    async _callOpenAI(prompt, options = {}) {
        const { benchmark_mode = false, speed_mode = 'normal' } = options;
        if (!OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY not configured');
        }

        return await retryHandler.withRetry(
            async () => {
                const response = await axios.post(
                    'https://api.openai.com/v1/chat/completions',
                    {
                        model: OPENAI_MODEL,
                        messages: [
                            { role: 'system', content: 'You are a helpful financial assistant.' },
                            { role: 'user', content: prompt }
                        ],
                        temperature: 0.3,
                        max_tokens: speed_mode === 'very_fast' ? 200 : (speed_mode === 'fast' ? 250 : (benchmark_mode ? 300 : 400))
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${OPENAI_API_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 10000
                    }
                );

                const completion = response.data.choices[0].message.content.trim();

                // Parse JSON response
                // Remove markdown code blocks if present
                const jsonStr = completion.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
                try {
                    return JSON.parse(jsonStr);
                } catch (parseError) {
                    // Mark as retryable - the API is fine, just bad output
                    const retryableError = new Error(`JSON parse failed: ${parseError.message}`);
                    retryableError.retryable = true;
                    retryableError.jsonParseError = true;
                    throw retryableError;
                }
            },
            {
                maxRetries: 3,
                baseDelay: 2000,
                maxDelay: 10000,
                operationName: 'openai-categorization',
                shouldRetry: (error) => {
                    // JSON parse errors are retryable (bad model output, not service failure)
                    if (error.jsonParseError || error.retryable) return true;
                    return retryHandler.constructor.retryableOpenAIErrors(error);
                }
            }
        );
    }

    /**
     * Format memory card content for the prompt
     * Handles correction memories specially for clarity
     */
    _formatMemoryCard(content) {
        // Handle correction memories - format them as clear rules
        if (content.type === 'BENCHMARK_CORRECTION') {
            const distinction = correctionValidator.sanitizeKeyDistinction(
                content.key_distinction || '', content.correct_category
            );
            return `RULE: "${content.description}" should be "${content.correct_category}" (NOT ${content.wrong_prediction}).${distinction ? ' ' + distinction : ''}`;
        }

        // Handle pattern memories (confusion training stores data in content.pattern, not top-level)
        if (content.type === 'PATTERN') {
            if (content.text) {
                return content.text;
            }
            const p = content.pattern || {};
            const merchant = content.merchant || p.merchant || '';
            const category = content.category || p.category || '';
            return `PATTERN: ${merchant} → ${category}`;
        }

        // Handle text-based memories
        if (content.text) {
            return content.text;
        }

        // Handle other structured content
        if (content.merchant && content.category) {
            return `${content.merchant}: ${content.description || ''} → ${content.category}`;
        }

        // Fallback: stringify but keep it concise
        return JSON.stringify(content);
    }

    /**
     * Fallback categorization using simple rules
     */
    _fallbackCategorization(expenseData) {
        const { merchant, description, amount } = expenseData;
        const text = `${merchant} ${description}`.toLowerCase();

        let category = 'other';
        let confidence = 0.5;

        // Simple keyword matching
        if (text.match(/restaurant|cafe|coffee|pizza|burger|food|dine|lunch|dinner/)) {
            category = 'dining';
            confidence = 0.6;
        } else if (text.match(/grocery|supermarket|whole foods|trader|safeway/)) {
            category = 'groceries';
            confidence = 0.7;
        } else if (text.match(/gas|fuel|shell|chevron|uber|lyft|transit|parking/)) {
            category = 'transportation';
            confidence = 0.7;
        } else if (text.match(/electric|utility|internet|phone|comcast|att|verizon/)) {
            category = 'utilities';
            confidence = 0.8;
        } else if (text.match(/movie|theater|concert|netflix|spotify|hulu/)) {
            category = 'entertainment';
            confidence = 0.7;
        } else if (text.match(/client|business|meeting|conference/)) {
            category = 'business_meal';
            confidence = 0.6;
        }

        return {
            suggested_category: category,
            confidence,
            reasoning: `Fallback categorization based on keyword matching (no AI available)`,
            trace_id: null,  // No memory was used
            alternatives: []
        };
    }
}

module.exports = OggyCategorizer;
