/**
 * Oggy Categorization Service
 * Uses memory retrieval to suggest expense categories
 * Stage 0, Week 5 + Week 7 resilience improvements
 */

const axios = require('axios');
const logger = require('../utils/logger');
const retryHandler = require('../utils/retry');
const CircuitBreaker = require('../utils/circuitBreaker');
const { costGovernor } = require('../middleware/costGovernor');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

class OggyCategorizer {
    constructor() {
        this.memoryCircuitBreaker = new CircuitBreaker({
            name: 'memory-service',
            failureThreshold: 5,
            timeout: 60000
        });

        this.openaiCircuitBreaker = new CircuitBreaker({
            name: 'openai-api',
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
    async suggestCategory(userId, expenseData) {
        const startTime = Date.now();

        try {
            // Check budget before making expensive API calls
            await costGovernor.checkBudget(2000); // Estimate 2k tokens

            // Step 1: Build retrieval query
            const query = this._buildCategoryQuery(expenseData);

            // Step 2: Retrieve relevant memory cards from memory service (with circuit breaker)
            let retrieval;
            let memoryCards = [];
            let trace_id = null;

            try {
                retrieval = await this.memoryCircuitBreaker.execute(() =>
                    this._retrieveMemory(userId, query)
                );
                trace_id = retrieval.trace_id;
                memoryCards = retrieval.selected || [];

                logger.info('Memory retrieval successful', {
                    userId,
                    cardsRetrieved: memoryCards.length,
                    trace_id
                });
            } catch (error) {
                if (error.circuitBreakerOpen) {
                    logger.warn('Memory service circuit breaker open, using fallback');
                } else {
                    logger.warn('Memory retrieval failed, continuing without memory', {
                        error: error.message
                    });
                }
                // Continue without memory cards (graceful degradation)
            }

            // Step 3: Build prompt with memory context
            const prompt = this._buildCategorizationPrompt(expenseData, memoryCards);

            // Step 4: Call OpenAI (with circuit breaker and cost tracking)
            const suggestion = await this.openaiCircuitBreaker.execute(() =>
                this._callOpenAI(prompt)
            );

            // Record actual token usage (estimate from response)
            const estimatedTokens = prompt.length / 4 + 200; // Rough estimate
            costGovernor.recordUsage(Math.ceil(estimatedTokens));

            const latency = Date.now() - startTime;
            logger.logMetric('categorization_latency', latency, 'ms');

            // Step 5: Return suggestion with trace_id for feedback loop
            return {
                suggested_category: suggestion.category,
                confidence: suggestion.confidence,
                reasoning: suggestion.reasoning,
                trace_id,  // CRITICAL: for memory update when user gives feedback
                alternatives: suggestion.alternatives || [],
                latency_ms: latency
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'suggestCategory',
                userId,
                merchant: expenseData.merchant
            });

            // Fallback to simple rule-based categorization
            logger.info('Using fallback categorization');
            return this._fallbackCategorization(expenseData);
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
    async _retrieveMemory(userId, query) {
        return await retryHandler.withRetry(
            async () => {
                const response = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    agent: 'oggy',
                    owner_type: 'user',
                    owner_id: userId,
                    query,
                    top_k: 5,
                    tier_scope: [1, 2, 3],  // working, short, long-term
                    tag_filter: ['payments', 'categorization'],
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
     * Build categorization prompt with memory context
     */
    _buildCategorizationPrompt(expenseData, memoryCards) {
        const { merchant, description, amount, transaction_date } = expenseData;

        // Extract relevant patterns from memory
        const contextStr = memoryCards.length > 0
            ? memoryCards.map((card, idx) => {
                const content = card.content || {};
                return `${idx + 1}. ${content.text || JSON.stringify(content)}`;
            }).join('\n')
            : 'No previous patterns available.';

        return `You are a financial categorization assistant helping to categorize expenses.

# Expense Details
Merchant: ${merchant || 'Unknown'}
Description: ${description}
Amount: $${amount}
Date: ${transaction_date}

# Relevant Past Patterns and Rules
${contextStr}

# Available Categories
- dining: Restaurants, cafes, food delivery
- groceries: Supermarkets, grocery stores
- transportation: Gas, public transit, ride sharing, parking
- utilities: Electric, gas, water, internet, phone
- entertainment: Movies, concerts, streaming services
- business_meal: Client dinners, business lunches
- shopping: Retail stores, online shopping
- health: Pharmacy, medical, fitness
- personal_care: Salon, spa, grooming
- other: Anything that doesn't fit above categories

# Instructions
Based on the expense details and past patterns, suggest the most appropriate category.
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
    async _callOpenAI(prompt) {
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
                        max_tokens: 300
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
                return JSON.parse(jsonStr);
            },
            {
                maxRetries: 3,
                baseDelay: 2000,
                maxDelay: 10000,
                operationName: 'openai-categorization',
                shouldRetry: retryHandler.constructor.retryableOpenAIErrors
            }
        );
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
