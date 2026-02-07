/**
 * Inquiry Generator - Generates proactive questions for users
 * Identifies areas of confusion and asks targeted questions
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { costGovernor } = require('../middleware/costGovernor');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

        const sources = await this._findQuestionSources(userId);
        const generated = [];

        for (let i = 0; i < Math.min(toGenerate, sources.length); i++) {
            try {
                const inquiry = await this._generateInquiry(userId, sources[i]);
                if (inquiry) generated.push(inquiry);
            } catch (err) {
                logger.warn('Failed to generate inquiry', { error: err.message, source: sources[i].type });
            }
        }

        return generated.length > 0 ? generated : [];
    }

    async _findQuestionSources(userId) {
        const sources = [];

        // Priority 1: Uncategorized expenses (most actionable — user needs to assign categories)
        try {
            const uncategorized = await query(
                `SELECT DISTINCT merchant, description
                 FROM expenses
                 WHERE user_id = $1 AND status = 'active'
                   AND (category IS NULL OR category = 'uncategorized')
                   AND merchant IS NOT NULL
                 LIMIT 5`,
                [userId]
            );
            for (const row of uncategorized.rows) {
                sources.push({
                    type: 'uncategorized_expense',
                    merchant: row.merchant,
                    description: row.description
                });
            }
        } catch (err) {
            logger.warn('Inquiry: uncategorized query failed', { error: err.message });
        }

        // Priority 2: Ambiguous merchants (same merchant, multiple categories)
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

    async _generateInquiry(userId, source) {
        let questionText, questionType, context;

        if (source.type === 'ambiguous_merchant') {
            questionType = 'ambiguous_merchant';
            context = { merchant: source.merchant, options: source.categories };

            try {
                await costGovernor.checkBudget(500);
                const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                    model: OPENAI_MODEL,
                    messages: [{
                        role: 'system',
                        content: 'Generate a short, friendly question asking the user how they typically categorize expenses at a specific merchant. Reply with ONLY the question text, nothing else.'
                    }, {
                        role: 'user',
                        content: `Merchant: "${source.merchant}". Categories used before: ${source.categories.join(', ')}. Ask which category they prefer for this merchant.`
                    }],
                    temperature: 0.7,
                    max_tokens: 100
                }, {
                    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
                    timeout: 10000
                });
                questionText = response.data.choices[0].message.content.trim();
                costGovernor.recordUsage(300);
            } catch (err) {
                questionText = `How do you usually categorize purchases at ${source.merchant}? (${source.categories.join(' or ')})`;
            }
        } else if (source.type === 'uncategorized_expense') {
            questionType = 'uncategorized_expense';
            context = { merchant: source.merchant, description: source.description, options: ['dining', 'groceries', 'transportation', 'utilities', 'entertainment', 'business_meal', 'shopping', 'health', 'personal_care', 'other'] };
            const desc = source.description ? ` ("${source.description}")` : '';
            questionText = `What category should "${source.merchant}"${desc} expenses go under?`;
        } else {
            questionType = 'spending_pattern';
            context = { merchant: source.merchant, options: ['dining', 'groceries', 'shopping', 'entertainment', 'other'] };
            questionText = `What category should "${source.merchant}" expenses go under?`;
        }

        // Check for duplicate questions
        const existing = await query(
            `SELECT 1 FROM oggy_inquiries
             WHERE user_id = $1 AND question_type = $2 AND context->>'merchant' = $3
             AND status IN ('pending', 'answered') AND created_at > now() - INTERVAL '30 days'`,
            [userId, questionType, source.merchant]
        );
        if (existing.rows.length > 0) return null;

        const inquiryId = uuidv4();
        await query(
            `INSERT INTO oggy_inquiries (inquiry_id, user_id, question_text, question_type, context, generation_date)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
            [inquiryId, userId, questionText, questionType, JSON.stringify(context)]
        );

        logger.info('Generated inquiry', { inquiry_id: inquiryId, type: questionType, merchant: source.merchant });

        return {
            inquiry_id: inquiryId,
            question_text: questionText,
            question_type: questionType,
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

        // Create memory card from the answer
        if (merchant && answer) {
            try {
                const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';
                const cardResponse = await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                    owner_type: 'user',
                    owner_id: userId,
                    tier: 2,
                    kind: 'expense_category_correction',
                    content: {
                        type: 'BENCHMARK_CORRECTION',
                        text: `USER STATED: ${merchant} should be categorized as ${answer}`,
                        merchant: merchant,
                        preferred_category: answer,
                        source: 'user_inquiry',
                        question: inquiry.question_text,
                        confidence: 1.0
                    },
                    tags: ['payments', 'categorization', 'user_preference', answer, merchant.toLowerCase()],
                    utility_weight: 0.9,
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
                    inquiry_id: inquiryId, merchant, category: answer, card_id: cardId
                });

                // Also update uncategorized expenses for this merchant
                if (inquiry.question_type === 'uncategorized_expense') {
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
