/**
 * Inquiry Generator - Generates proactive questions for users
 * Identifies areas of confusion and asks targeted questions
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { costGovernor } = require('../middleware/costGovernor');
const { suggestionGate } = require('./suggestionGate');
const OggyCategorizer = require('../../domains/payments/services/oggyCategorizer');
const providerResolver = require('../providers/providerResolver');

const categorizer = new OggyCategorizer();
const HIGH_CONFIDENCE_THRESHOLD = 0.80;

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

class InquiryGenerator {
    async getPreferences(userId) {
        const result = await query(
            'SELECT * FROM oggy_inquiry_preferences WHERE user_id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            // Create default preferences
            await query(
                'INSERT INTO oggy_inquiry_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
                [userId]
            );
            return { user_id: userId, max_questions_per_day: 5, enabled: true };
        }
        return result.rows[0];
    }

    async updatePreferences(userId, updates) {
        const { max_questions_per_day, enabled } = updates;
        await query(
            `INSERT INTO oggy_inquiry_preferences (user_id, max_questions_per_day, enabled, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (user_id) DO UPDATE SET
                max_questions_per_day = COALESCE($2, oggy_inquiry_preferences.max_questions_per_day),
                enabled = COALESCE($3, oggy_inquiry_preferences.enabled),
                updated_at = now()`,
            [userId, max_questions_per_day, enabled]
        );
    }

    async getPendingInquiries(userId) {
        // Expire old inquiries
        await query(
            `UPDATE oggy_inquiries SET status = 'expired'
             WHERE user_id = $1 AND status = 'pending' AND expires_at < now()`,
            [userId]
        );

        const result = await query(
            `SELECT * FROM oggy_inquiries
             WHERE user_id = $1 AND status = 'pending'
             ORDER BY created_at ASC`,
            [userId]
        );
        return result.rows;
    }

    async getTodayCount(userId) {
        const result = await query(
            `SELECT COUNT(*) as count FROM oggy_inquiries
             WHERE user_id = $1 AND generation_date = CURRENT_DATE`,
            [userId]
        );
        return parseInt(result.rows[0].count);
    }

    async generateIfNeeded(userId) {
        const prefs = await this.getPreferences(userId);
        if (!prefs.enabled) return [];

        const pending = await this.getPendingInquiries(userId);
        if (pending.length > 0) return pending;

        const todayCount = await this.getTodayCount(userId);
        if (todayCount >= prefs.max_questions_per_day) return [];

        const remaining = prefs.max_questions_per_day - todayCount;
        const toGenerate = Math.min(remaining, 2); // Generate at most 2 at a time

        // Clarification sources always available
        const clarificationSources = await this._findClarificationSources(userId);

        // Suggestion sources gated by opt-in + interval
        let suggestionSources = [];
        const suggestCheck = await suggestionGate.canSuggest(userId);
        if (suggestCheck.allowed) {
            suggestionSources = await this._findSuggestionSources(userId);
        } else if (suggestCheck.reason !== 'suggestions_disabled') {
            await suggestionGate.recordSuppression(userId, suggestCheck.reason);
        }

        const sources = [...clarificationSources, ...suggestionSources];
        const generated = [];

        for (let i = 0; i < Math.min(toGenerate, sources.length); i++) {
            try {
                const inquiry = await this._generateInquiry(userId, sources[i]);
                if (inquiry) {
                    generated.push(inquiry);
                    // Record suggestion emission for rate limiting
                    if (sources[i].response_type === 'suggestion') {
                        await suggestionGate.recordSuggestion(userId);
                    }
                }
            } catch (err) {
                logger.warn('Failed to generate inquiry', { error: err.message, source: sources[i].type });
            }
        }

        return generated.length > 0 ? generated : [];
    }

    /**
     * Clarification sources — always available (uncategorized, ambiguous).
     * High-confidence uncategorized expenses get a "Is this correct?" confirmation
     * instead of an open-ended category question.
     */
    async _findClarificationSources(userId) {
        const sources = [];

        // Priority 1: Uncategorized expenses
        try {
            const uncategorized = await query(
                `SELECT DISTINCT merchant, description, amount
                 FROM expenses
                 WHERE user_id = $1 AND status = 'active'
                   AND (category IS NULL OR category = 'uncategorized')
                   AND merchant IS NOT NULL
                 LIMIT 5`,
                [userId]
            );
            for (const row of uncategorized.rows) {
                // Try to categorize first — if high confidence, use confirmation prompt
                let suggestion = null;
                try {
                    suggestion = await categorizer.suggestCategory(userId, {
                        merchant: row.merchant,
                        description: row.description || '',
                        amount: row.amount || 0
                    });
                } catch (err) {
                    logger.debug('Categorizer unavailable for inquiry pre-check', { error: err.message });
                }

                if (suggestion && suggestion.confidence >= HIGH_CONFIDENCE_THRESHOLD && suggestion.suggested_category !== 'other') {
                    sources.push({
                        type: 'high_confidence_confirmation',
                        response_type: 'clarification',
                        merchant: row.merchant,
                        description: row.description,
                        suggested_category: suggestion.suggested_category,
                        confidence: suggestion.confidence,
                        reasoning: suggestion.reasoning
                    });
                } else {
                    sources.push({
                        type: 'uncategorized_expense',
                        response_type: 'clarification',
                        merchant: row.merchant,
                        description: row.description
                    });
                }
            }
        } catch (err) {
            logger.warn('Inquiry: uncategorized query failed', { error: err.message });
        }

        // Priority 2: Ambiguous merchants
        try {
            const ambiguous = await query(
                `SELECT merchant, array_agg(DISTINCT category) as categories, COUNT(*) as count
                 FROM expenses
                 WHERE user_id = $1 AND status = 'active' AND category IS NOT NULL AND merchant IS NOT NULL
                 GROUP BY merchant
                 HAVING COUNT(DISTINCT category) > 1
                 ORDER BY COUNT(*) DESC LIMIT 5`,
                [userId]
            );
            for (const row of ambiguous.rows) {
                sources.push({
                    type: 'ambiguous_merchant',
                    response_type: 'clarification',
                    merchant: row.merchant,
                    categories: row.categories,
                    count: parseInt(row.count)
                });
            }
        } catch (err) {
            logger.warn('Inquiry: ambiguous merchant query failed', { error: err.message });
        }

        return sources;
    }

    /**
     * Suggestion sources — only available when opted in (cost-cutting tips).
     */
    async _findSuggestionSources(userId) {
        const sources = [];

        // Cost-cutting: top spending categories in the last 90 days over $100 total
        try {
            const topSpending = await query(
                `SELECT category, SUM(amount) as total, COUNT(*) as txn_count,
                        AVG(amount) as avg_amount
                 FROM expenses
                 WHERE user_id = $1 AND status = 'active'
                   AND category IS NOT NULL AND category != 'uncategorized'
                   AND transaction_date >= CURRENT_DATE - INTERVAL '90 days'
                 GROUP BY category
                 HAVING SUM(amount) > 100
                 ORDER BY SUM(amount) DESC
                 LIMIT 3`,
                [userId]
            );
            for (const row of topSpending.rows) {
                sources.push({
                    type: 'cost_cutting',
                    response_type: 'suggestion',
                    category: row.category,
                    total: parseFloat(row.total),
                    txn_count: parseInt(row.txn_count),
                    avg_amount: parseFloat(row.avg_amount)
                });
            }
        } catch (err) {
            logger.warn('Inquiry: cost-cutting query failed', { error: err.message });
        }

        return sources;
    }

    async _generateInquiry(userId, source) {
        let questionText, questionType, context;
        const responseType = source.response_type || 'clarification';

        if (source.type === 'high_confidence_confirmation') {
            questionType = 'high_confidence_confirmation';
            const cat = source.suggested_category.replace(/_/g, ' ');
            context = {
                merchant: source.merchant,
                description: source.description,
                suggested_category: source.suggested_category,
                confidence: source.confidence,
                reasoning: source.reasoning,
                options: [source.suggested_category]
            };
            questionText = `I'm fairly confident "${source.merchant}" should be categorized as "${cat}". Is this correct?`;
        } else if (source.type === 'ambiguous_merchant') {
            questionType = 'ambiguous_merchant';
            context = { merchant: source.merchant, options: source.categories };

            try {
                await costGovernor.checkBudget(500);
                const resolved = await providerResolver.getAdapter(userId, 'oggy');
                const result = await resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [{
                        role: 'system',
                        content: 'Generate a short, friendly question asking the user how they typically categorize expenses at a specific merchant. Reply with ONLY the question text, nothing else.'
                    }, {
                        role: 'user',
                        content: `Merchant: "${source.merchant}". Categories used before: ${source.categories.join(', ')}. Ask which category they prefer for this merchant.`
                    }],
                    temperature: 0.7,
                    max_tokens: 100,
                    timeout: 10000
                });
                questionText = result.text;
                costGovernor.recordUsage(result.tokens_used || 300);
            } catch (err) {
                questionText = `How do you usually categorize purchases at ${source.merchant}? (${source.categories.join(' or ')})`;
            }
        } else if (source.type === 'uncategorized_expense') {
            questionType = 'uncategorized_expense';
            context = { merchant: source.merchant, description: source.description, options: ['dining', 'groceries', 'transportation', 'utilities', 'entertainment', 'business_meal', 'shopping', 'health', 'personal_care', 'other'] };
            const desc = source.description ? ` ("${source.description}")` : '';
            questionText = `What category should "${source.merchant}"${desc} expenses go under?`;
        } else if (source.type === 'cost_cutting') {
            questionType = 'cost_cutting';
            const total = source.total.toFixed(2);
            const avg = source.avg_amount.toFixed(2);
            context = {
                category: source.category,
                total: source.total,
                txn_count: source.txn_count,
                avg_amount: source.avg_amount,
                options: ['yes, show tips', 'no thanks', 'remind me later']
            };

            try {
                await costGovernor.checkBudget(500);
                const resolved = await providerResolver.getAdapter(userId, 'oggy');
                const result = await resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [{
                        role: 'system',
                        content: 'Generate a short, friendly cost-cutting suggestion for someone who spends a lot in a particular expense category. Include the dollar amount. Reply with ONLY the suggestion text, nothing else. Keep it to 1-2 sentences.'
                    }, {
                        role: 'user',
                        content: `Category: "${source.category}". Total spent last 90 days: $${total} across ${source.txn_count} transactions (avg $${avg} each). Suggest ways to reduce spending in this category.`
                    }],
                    temperature: 0.7,
                    max_tokens: 150,
                    timeout: 10000
                });
                questionText = result.text;
                costGovernor.recordUsage(result.tokens_used || 300);
            } catch (err) {
                questionText = `You've spent $${total} on ${source.category.replace(/_/g, ' ')} in the last 90 days (${source.txn_count} transactions, avg $${avg}). Would you like tips to reduce this spending?`;
            }
        } else {
            questionType = 'spending_pattern';
            context = { merchant: source.merchant, options: ['dining', 'groceries', 'shopping', 'entertainment', 'other'] };
            questionText = `What category should "${source.merchant}" expenses go under?`;
        }

        // Check for duplicate questions (use merchant or category as dedup key)
        const dedupKey = source.merchant || source.category || questionType;
        const existing = await query(
            `SELECT 1 FROM oggy_inquiries
             WHERE user_id = $1 AND question_type = $2
             AND (context->>'merchant' = $3 OR context->>'category' = $3)
             AND status IN ('pending', 'answered') AND created_at > now() - INTERVAL '30 days'`,
            [userId, questionType, dedupKey]
        );
        if (existing.rows.length > 0) return null;

        const inquiryId = uuidv4();
        await query(
            `INSERT INTO oggy_inquiries (inquiry_id, user_id, question_text, question_type, context, response_type, generation_date)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE)`,
            [inquiryId, userId, questionText, questionType, JSON.stringify(context), responseType]
        );

        logger.info('Generated inquiry', {
            inquiry_id: inquiryId, type: questionType,
            response_type: responseType,
            key: dedupKey
        });

        return {
            inquiry_id: inquiryId,
            question_text: questionText,
            question_type: questionType,
            response_type: responseType,
            context,
            created_at: new Date().toISOString()
        };
    }

    async answerInquiry(inquiryId, userId, answer, additionalContext) {
        // Update inquiry
        await query(
            `UPDATE oggy_inquiries SET status = 'answered', user_answer = $1, answered_at = now()
             WHERE inquiry_id = $2 AND user_id = $3`,
            [answer, inquiryId, userId]
        );

        // Get inquiry details
        const result = await query('SELECT * FROM oggy_inquiries WHERE inquiry_id = $1', [inquiryId]);
        if (result.rows.length === 0) return;

        const inquiry = result.rows[0];
        const merchant = inquiry.context?.merchant;
        const category = inquiry.context?.category;

        // Always create memory card from the answer
        try {
            let cardContent, cardKind, cardTags;

            if (merchant && answer) {
                // Merchant-specific memory (categorization preference)
                cardKind = 'expense_category_correction';
                cardContent = {
                    type: 'BENCHMARK_CORRECTION',
                    text: `USER STATED: ${merchant} should be categorized as ${answer}`,
                    merchant: merchant,
                    preferred_category: answer,
                    source: 'user_inquiry',
                    question: inquiry.question_text,
                    confidence: 1.0
                };
                cardTags = ['payments', 'categorization', 'user_preference', answer, merchant.toLowerCase()];
            } else {
                // General preference memory (cost-cutting, spending patterns, etc.)
                cardKind = 'user_preference';
                cardContent = {
                    type: 'PATTERN',
                    text: `USER RESPONDED to "${inquiry.question_text}": ${answer}`,
                    question_type: inquiry.question_type,
                    category: category || null,
                    answer: answer,
                    source: 'user_inquiry',
                    confidence: 0.9
                };
                cardTags = ['payments', 'categorization', inquiry.question_type];
                if (category) cardTags.push(category);
            }

            const cardResponse = await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                owner_type: 'user',
                owner_id: userId,
                tier: 2,
                kind: cardKind,
                content: cardContent,
                tags: cardTags,
                utility_weight: merchant ? 0.9 : 0.7,
                reliability: 0.95
            }, {
                timeout: 5000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });

            const cardId = cardResponse.data?.card_id;
            if (cardId) {
                await query(
                    'UPDATE oggy_inquiries SET applied_to_memory = true, memory_card_id = $1 WHERE inquiry_id = $2',
                    [cardId, inquiryId]
                );
            }

            logger.info('Inquiry answer applied to memory', {
                inquiry_id: inquiryId, merchant, category, answer, card_id: cardId,
                question_type: inquiry.question_type
            });

            // Also update uncategorized expenses for this merchant
            if (merchant && (inquiry.question_type === 'uncategorized_expense' || inquiry.question_type === 'high_confidence_confirmation')) {
                try {
                    const updated = await query(
                        `UPDATE expenses SET category = $1
                         WHERE user_id = $2 AND merchant = $3
                           AND (category IS NULL OR category = 'uncategorized')
                           AND status = 'active'`,
                        [answer, userId, merchant]
                    );
                    if (updated.rowCount > 0) {
                        logger.info('Updated uncategorized expenses from inquiry', {
                            merchant, category: answer, count: updated.rowCount
                        });
                    }
                } catch (updateErr) {
                    logger.warn('Failed to update expenses from inquiry', { error: updateErr.message });
                }
            }
        } catch (err) {
            logger.warn('Failed to create memory from inquiry', { error: err.message });
        }
    }

    async dismissInquiry(inquiryId, userId) {
        await query(
            `UPDATE oggy_inquiries SET status = 'dismissed'
             WHERE inquiry_id = $1 AND user_id = $2`,
            [inquiryId, userId]
        );
    }
}

module.exports = new InquiryGenerator();
