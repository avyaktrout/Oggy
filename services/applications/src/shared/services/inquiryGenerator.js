/**
 * Inquiry Generator - Generates proactive questions for users
 * Identifies areas of confusion and asks targeted questions
 *
 * Two types of inquiries:
 *   1. Clarifications (always on) - uncategorized expenses, ambiguous merchants
 *   2. AI Suggestions (opt-in) - LLM-generated questions and advice per domain
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { costGovernor } = require('../middleware/costGovernor');
const { suggestionGate } = require('./suggestionGate');
const OggyCategorizer = require('../../domains/payments/services/oggyCategorizer');
const providerResolver = require('../providers/providerResolver');
const intentService = require('./intentService');

const categorizer = new OggyCategorizer();
const HIGH_CONFIDENCE_THRESHOLD = 0.80;

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

// Intent → inquiry topic mapping: when user has focus intents, use these instead of generic DOMAIN_GUIDANCE
const INTENT_INQUIRY_TOPICS = {
    // Payments
    'payments.categorize_payment': ['merchant categorization preferences', 'spending category boundaries', 'how you mentally group purchases'],
    'payments.disambiguate_groceries_vs_shopping': ['grocery vs household shopping habits', 'where you buy non-food items mixed with groceries'],
    'payments.disambiguate_dining_vs_business_meal': ['business meal vs personal dining rules', 'when dining counts as work expense'],
    'payments.handle_mixed_cart_dominance': ['multi-category receipt handling', 'how you split combo purchases'],
    // Diet
    'diet.estimate_nutrition': ['portion size estimation habits', 'how you judge calories by sight', 'nutrition accuracy goals'],
    'diet.log_entry_from_text': ['food description conventions', 'how you describe meals', 'logging shorthand preferences'],
    'diet.verify_with_user': ['when you want Oggy to double-check nutrition', 'verification threshold preferences'],
    'diet.categorize_food_type': ['how you classify snacks vs meals', 'food type boundaries'],
    'diet.ask_clarifying_questions': ['what details help with nutrition accuracy', 'when Oggy should ask follow-ups'],
    'diet.explain_nutrition_assumptions': ['transparency preferences for estimates', 'when to show reasoning'],
    // General
    'general.preference_fit': ['communication style preferences', 'response tone and format', 'what makes a response feel right'],
    'general.explain_why_response': ['how much explanation you want', 'reasoning depth preferences'],
    'general.ask_clarifying_questions': ['when clarification helps vs slows you down', 'question style preferences'],
    'general.proactive_suggestions': ['what kinds of proactive tips are useful', 'suggestion frequency preferences'],
    'general.research_synthesis': ['research depth expectations', 'source preference and citation style'],
    'general.plan_generation': ['planning detail level', 'timeline and milestone preferences'],
    'general.comparison_recommendation': ['decision-making criteria', 'comparison format preferences'],
    'general.study_plan_generation': ['study habits and schedule', 'learning pace preferences'],
    // Harmony
    'harmony.compute_metrics': ['metric computation preferences', 'which indicators matter most to you'],
    'harmony.add_indicator': ['what new data sources you want tracked', 'indicator format preferences'],
    'harmony.explain_metric_change': ['how much context you want on score changes', 'explanation detail level'],
    'harmony.suggest_interventions': ['intervention style preferences', 'proactive vs reactive recommendations'],
};

// Domain-specific best-practices guidance for LLM prompts
const DOMAIN_GUIDANCE = {
    payments: {
        label: 'Personal Finance',
        topics: [
            '50/30/20 budgeting rule', 'emergency fund building', 'subscription auditing',
            'impulse spending triggers', 'cash flow planning', 'debt repayment strategies',
            'savings automation', 'meal prep vs eating out', 'coffee/beverage spending',
            'transportation cost reduction', 'negotiating recurring bills', 'financial goal setting',
            'tracking net worth', 'avoiding lifestyle inflation', 'reward programs and cashback'
        ]
    },
    diet: {
        label: 'Nutrition & Health',
        topics: [
            'macro balance (protein/carbs/fat)', 'daily hydration goals', 'meal timing and frequency',
            'whole foods vs processed', 'fiber intake optimization', 'sugar reduction strategies',
            'sodium awareness', 'portion control', 'meal prepping', 'reading nutrition labels',
            'mindful eating habits', 'snacking patterns', 'vitamin and mineral gaps',
            'caffeine management', 'protein sources variety'
        ]
    },
    general: {
        label: 'Learning & Productivity',
        topics: [
            'spaced repetition for retention', 'project decomposition', 'deep work scheduling',
            'active recall techniques', 'note-taking methods', 'learning goal prioritization',
            'managing multiple projects', 'knowledge organization systems', 'focus and distraction management',
            'skill gap identification', 'study schedule optimization', 'research methodology',
            'time management strategies', 'progress tracking habits', 'accountability systems'
        ]
    }
};

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
            return { user_id: userId, max_questions_per_day: 20, enabled: true };
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

    async generateIfNeeded(userId, domain = null) {
        const prefs = await this.getPreferences(userId);
        if (!prefs.enabled) return [];

        const pending = await this.getPendingInquiries(userId);
        // Filter pending by domain if specified
        const domainPending = domain
            ? pending.filter(inq => {
                const d = inq.context?.domain;
                if (!d) return domain === 'payments';
                return d === domain;
            })
            : pending;
        if (domainPending.length > 0) return domainPending;

        const todayCount = await this.getTodayCount(userId);
        if (todayCount >= prefs.max_questions_per_day) return [];

        const remaining = prefs.max_questions_per_day - todayCount;
        const toGenerate = Math.min(remaining, 2); // Generate at most 2 at a time

        // Clarification sources (payments-only: uncategorized, ambiguous)
        let clarificationSources = [];
        if (!domain || domain === 'payments') {
            clarificationSources = await this._findClarificationSources(userId);
        }

        const generated = [];

        // Generate from clarification sources first
        for (let i = 0; i < clarificationSources.length && generated.length < toGenerate; i++) {
            try {
                const inquiry = await this._generateInquiry(userId, clarificationSources[i]);
                if (inquiry) {
                    generated.push(inquiry);
                }
            } catch (err) {
                logger.warn('Failed to generate clarification inquiry', { error: err.message, source: clarificationSources[i].type });
            }
        }

        // If still need more AND suggestions are allowed, generate AI suggestion
        if (generated.length < toGenerate && domain) {
            const suggestCheck = await suggestionGate.canSuggest(userId);
            if (suggestCheck.allowed) {
                try {
                    const aiSuggestion = await this._generateAISuggestion(userId, domain);
                    if (aiSuggestion) {
                        const inserted = await this._insertAISuggestion(userId, aiSuggestion, domain);
                        if (inserted) {
                            generated.push(inserted);
                            await suggestionGate.recordSuggestion(userId);
                        }
                    }
                } catch (err) {
                    logger.warn('Failed to generate AI suggestion', { error: err.message, domain });
                }
            } else if (suggestCheck.reason !== 'suggestions_disabled') {
                await suggestionGate.recordSuppression(userId, suggestCheck.reason);
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
                   AND (category IS NULL OR category = '' OR category = 'uncategorized')
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

    // ── AI Suggestion System ──

    /**
     * Build domain-specific context from user data for LLM prompt.
     */
    async _buildDomainContext(userId, domain) {
        const context = { domain };

        if (domain === 'payments') {
            try {
                // Top spending categories (last 90 days)
                const topCats = await query(
                    `SELECT category, SUM(amount) as total, COUNT(*) as txn_count
                     FROM expenses
                     WHERE user_id = $1 AND status = 'active'
                       AND category IS NOT NULL AND category != '' AND category != 'uncategorized'
                       AND transaction_date >= CURRENT_DATE - INTERVAL '90 days'
                     GROUP BY category ORDER BY SUM(amount) DESC LIMIT 5`,
                    [userId]
                );
                context.top_categories = topCats.rows.map(r => ({
                    category: r.category,
                    total: parseFloat(r.total).toFixed(2),
                    transactions: parseInt(r.txn_count)
                }));

                // Monthly spending trend (last 3 months)
                const monthlyTrend = await query(
                    `SELECT TO_CHAR(transaction_date, 'YYYY-MM') as month, SUM(amount) as total
                     FROM expenses
                     WHERE user_id = $1 AND status = 'active'
                       AND transaction_date >= CURRENT_DATE - INTERVAL '3 months'
                     GROUP BY TO_CHAR(transaction_date, 'YYYY-MM')
                     ORDER BY month`,
                    [userId]
                );
                context.monthly_trend = monthlyTrend.rows.map(r => ({
                    month: r.month, total: parseFloat(r.total).toFixed(2)
                }));
            } catch (err) {
                logger.debug('Failed to build payments context', { error: err.message });
            }

            // Retrieve relevant memory cards (user goals, preferences)
            try {
                const memResp = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    owner_type: 'user', owner_id: userId,
                    tag_filter: ['payments', 'user_preference'],
                    limit: 5
                }, { timeout: 3000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } });
                context.user_goals = (memResp.data?.cards || []).map(c => c.content?.text).filter(Boolean);
            } catch (err) {
                logger.debug('Failed to retrieve payments memory cards', { error: err.message });
            }

        } else if (domain === 'diet') {
            try {
                // 7-day nutrition averages
                const nutrition = await query(
                    `SELECT COALESCE(SUM(i.calories), 0) as cal,
                            COALESCE(SUM(i.protein_g), 0) as protein,
                            COALESCE(SUM(i.carbs_g), 0) as carbs,
                            COALESCE(SUM(i.fat_g), 0) as fat,
                            COALESCE(SUM(i.sugar_g), 0) as sugar,
                            COALESCE(SUM(i.sodium_mg), 0) as sodium,
                            COALESCE(SUM(i.fiber_g), 0) as fiber,
                            COUNT(DISTINCT e.entry_date) as days
                     FROM v3_diet_entries e
                     JOIN v3_diet_items i ON e.entry_id = i.entry_id
                     WHERE e.user_id = $1 AND e.entry_date >= CURRENT_DATE - 7`,
                    [userId]
                );
                const r = nutrition.rows[0];
                const days = Math.max(parseInt(r.days) || 1, 1);
                context.daily_averages = {
                    calories: Math.round(parseFloat(r.cal) / days),
                    protein_g: Math.round(parseFloat(r.protein) / days),
                    carbs_g: Math.round(parseFloat(r.carbs) / days),
                    fat_g: Math.round(parseFloat(r.fat) / days),
                    sugar_g: Math.round(parseFloat(r.sugar) / days),
                    sodium_mg: Math.round(parseFloat(r.sodium) / days),
                    fiber_g: Math.round(parseFloat(r.fiber) / days),
                    days_tracked: parseInt(r.days) || 0
                };

                // Top foods logged
                const topFoods = await query(
                    `SELECT i.food_name, COUNT(*) as cnt
                     FROM v3_diet_entries e
                     JOIN v3_diet_items i ON e.entry_id = i.entry_id
                     WHERE e.user_id = $1 AND e.entry_date >= CURRENT_DATE - 14
                       AND i.food_name IS NOT NULL
                     GROUP BY i.food_name ORDER BY cnt DESC LIMIT 8`,
                    [userId]
                );
                context.top_foods = topFoods.rows.map(r => r.food_name);
            } catch (err) {
                logger.debug('Failed to build diet context', { error: err.message });
            }

            // Retrieve diet memory cards
            try {
                const memResp = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    owner_type: 'user', owner_id: userId,
                    tag_filter: ['diet', 'user_preference'],
                    limit: 5
                }, { timeout: 3000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } });
                context.user_goals = (memResp.data?.cards || []).map(c => c.content?.text).filter(Boolean);
            } catch (err) {
                logger.debug('Failed to retrieve diet memory cards', { error: err.message });
            }

        } else if (domain === 'general') {
            try {
                // Active projects
                const projects = await query(
                    `SELECT name, description FROM v2_projects
                     WHERE user_id = $1 AND status = 'active' LIMIT 5`,
                    [userId]
                );
                context.active_projects = projects.rows.map(p => ({
                    name: p.name, description: p.description || ''
                }));
            } catch (err) {
                logger.debug('Failed to build general context', { error: err.message });
            }

            // Retrieve general memory cards
            try {
                const memResp = await axios.post(`${MEMORY_SERVICE_URL}/retrieve`, {
                    owner_type: 'user', owner_id: userId,
                    tag_filter: ['general', 'user_preference'],
                    limit: 5
                }, { timeout: 3000, headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' } });
                context.user_goals = (memResp.data?.cards || []).map(c => c.content?.text).filter(Boolean);
            } catch (err) {
                logger.debug('Failed to retrieve general memory cards', { error: err.message });
            }
        }

        return context;
    }

    /**
     * Get topics already covered in the last 14 days for this domain.
     */
    async _getCoveredTopics(userId, domain) {
        try {
            const result = await query(
                `SELECT DISTINCT topic FROM oggy_inquiries
                 WHERE user_id = $1
                   AND question_type IN ('ai_question', 'ai_advice')
                   AND context->>'domain' = $2
                   AND created_at > now() - INTERVAL '14 days'
                   AND topic IS NOT NULL`,
                [userId, domain]
            );
            return result.rows.map(r => r.topic);
        } catch (err) {
            logger.debug('Failed to get covered topics', { error: err.message });
            return [];
        }
    }

    /**
     * Generate an AI-powered suggestion (question or advice) for a domain.
     * Returns { kind, topic, text, options } or null.
     */
    async _generateAISuggestion(userId, domain) {
        const guidance = DOMAIN_GUIDANCE[domain];
        if (!guidance) return null;

        await costGovernor.checkBudget(1000);

        const domainContext = await this._buildDomainContext(userId, domain);
        const coveredTopics = await this._getCoveredTopics(userId, domain);

        // Check if user has focus intents — if so, replace generic topics with intent-specific ones
        let topics = guidance.topics;
        let intentContext = '';
        let matchedIntentName = null;

        try {
            const prefs = await this.getPreferences(userId);
            const domainIntents = (prefs.focus_intents || []).filter(i => i.startsWith(domain + '.'));

            if (domainIntents.length > 0) {
                // Build intent-specific topics from mapping + fallback to catalog description
                const intentTopics = [];
                const intentDetails = [];

                for (const iName of domainIntents) {
                    const mapped = INTENT_INQUIRY_TOPICS[iName];
                    if (mapped) {
                        intentTopics.push(...mapped);
                    }

                    // Load catalog entry for richer context (also covers custom intents not in map)
                    try {
                        const intent = await intentService.getIntent(iName);
                        if (intent) {
                            intentDetails.push(`- ${intent.display_name}: ${intent.description || intent.success_criteria || ''}`);
                            // For custom intents not in INTENT_INQUIRY_TOPICS, derive topics from description
                            if (!mapped && intent.description) {
                                intentTopics.push(intent.description);
                            }
                        }
                    } catch (_) { /* non-blocking */ }
                }

                if (intentTopics.length > 0) {
                    topics = intentTopics;
                    matchedIntentName = domainIntents[0]; // primary intent for tagging
                }
                if (intentDetails.length > 0) {
                    intentContext = `\nThe user is focused on improving these skills:\n${intentDetails.join('\n')}\nGenerate suggestions that help the user improve in these specific areas.\n`;
                }
            }
        } catch (err) {
            logger.debug('Failed to load focus intents for inquiry', { error: err.message });
        }

        const systemPrompt = `You are Oggy, a friendly personal assistant. You need to generate ONE suggestion for the user in the "${guidance.label}" domain.

You can generate either:
- A "question" to better understand the user's goals, habits, or preferences (with 3-5 multiple choice options)
- An "advice" tip with actionable guidance based on what you know about the user
${intentContext}
Best-practice topics to draw from (pick ONE that hasn't been covered):
${topics.map(t => `- ${t}`).join('\n')}

Topics ALREADY covered (do NOT repeat these):
${coveredTopics.length > 0 ? coveredTopics.map(t => `- ${t}`).join('\n') : '(none yet)'}

User context:
${JSON.stringify(domainContext, null, 2)}

Rules:
- Pick a topic that is DIFFERENT from the covered topics
- If generating a question: provide 3-5 concise option labels and a clear question
- If generating advice: provide a specific, actionable 1-2 sentence tip
- The "topic" field should be a short kebab-case tag (e.g. "budget-rule", "meal-timing")
- Keep the tone friendly and conversational
- Base your suggestion on the user's actual data when available

Reply with ONLY valid JSON in this exact format:
{"kind":"question","topic":"short-tag","text":"Your question here?","options":["option1","option2","option3"]}
or
{"kind":"advice","topic":"short-tag","text":"Your actionable tip here."}`;

        try {
            const resolved = await providerResolver.getAdapter(userId, 'oggy');
            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Generate one ${guidance.label.toLowerCase()} suggestion for me.` }
                ],
                temperature: 0.8,
                max_tokens: 300,
                timeout: 15000
            });

            costGovernor.recordUsage(result.tokens_used || 600);

            // Parse JSON from response
            const text = result.text.trim();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                logger.warn('AI suggestion: no JSON found in response', { text: text.substring(0, 200) });
                return null;
            }

            const parsed = JSON.parse(jsonMatch[0]);

            // Validate structure
            if (!parsed.kind || !parsed.topic || !parsed.text) {
                logger.warn('AI suggestion: missing required fields', { parsed });
                return null;
            }
            if (parsed.kind === 'question' && (!Array.isArray(parsed.options) || parsed.options.length < 2)) {
                logger.warn('AI suggestion: question missing options', { parsed });
                return null;
            }
            if (!['question', 'advice'].includes(parsed.kind)) {
                logger.warn('AI suggestion: invalid kind', { kind: parsed.kind });
                return null;
            }

            // Check if this topic was already covered
            if (coveredTopics.includes(parsed.topic)) {
                logger.info('AI suggestion: topic already covered, skipping', { topic: parsed.topic });
                return null;
            }

            // Attach matched intent for context tagging
            if (matchedIntentName) {
                parsed.intent_name = matchedIntentName;
            }

            return parsed;
        } catch (err) {
            if (err.budgetExceeded) {
                logger.warn('AI suggestion skipped: budget exceeded');
            } else {
                logger.warn('AI suggestion LLM call failed', { error: err.message });
            }
            return null;
        }
    }

    /**
     * Insert an AI-generated suggestion into the database with topic-based dedup.
     */
    async _insertAISuggestion(userId, aiSuggestion, domain) {
        const { kind, topic, text, options, intent_name } = aiSuggestion;
        const questionType = kind === 'question' ? 'ai_question' : 'ai_advice';

        // Topic-based dedup (14-day window)
        const existing = await query(
            `SELECT 1 FROM oggy_inquiries
             WHERE user_id = $1 AND topic = $2
             AND context->>'domain' = $3
             AND status IN ('pending', 'answered')
             AND created_at > now() - INTERVAL '14 days'`,
            [userId, topic, domain]
        );
        if (existing.rows.length > 0) {
            logger.info('AI suggestion deduped by topic', { topic, domain });
            return null;
        }

        const inquiryId = uuidv4();
        const context = { domain, options: options || [] };
        if (intent_name) context.intent_name = intent_name;

        await query(
            `INSERT INTO oggy_inquiries (inquiry_id, user_id, question_text, question_type, context, response_type, topic, generation_date)
             VALUES ($1, $2, $3, $4, $5, 'suggestion', $6, CURRENT_DATE)`,
            [inquiryId, userId, text, questionType, JSON.stringify(context), topic]
        );

        logger.info('Generated AI suggestion', {
            inquiry_id: inquiryId, type: questionType, topic, domain,
            intent_name: intent_name || null
        });

        return {
            inquiry_id: inquiryId,
            question_text: text,
            question_type: questionType,
            response_type: 'suggestion',
            topic,
            context,
            created_at: new Date().toISOString()
        };
    }

    // ── Clarification inquiry generation (unchanged) ──

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
        } else {
            return null;
        }

        // Check for duplicate questions
        const dedupKey = source.merchant || source.category || questionType;
        const dedupStatuses = (questionType === 'uncategorized_expense' || questionType === 'high_confidence_confirmation')
            ? "('pending')"
            : "('pending', 'answered')";
        const existing = await query(
            `SELECT 1 FROM oggy_inquiries
             WHERE user_id = $1 AND question_type = $2
             AND (context->>'merchant' = $3 OR context->>'category' = $3 OR context->>'domain' = $3)
             AND status IN ${dedupStatuses} AND created_at > now() - INTERVAL '30 days'`,
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

        // Update expenses based on inquiry type
        if (merchant && (inquiry.question_type === 'uncategorized_expense' || inquiry.question_type === 'high_confidence_confirmation')) {
            try {
                const updated = await query(
                    `UPDATE expenses SET category = $1
                     WHERE user_id = $2 AND merchant = $3
                       AND (category IS NULL OR category = '' OR category = 'uncategorized')
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
        } else if (merchant && inquiry.question_type === 'ambiguous_merchant') {
            // User chose a single category for this merchant — update ALL expenses
            try {
                const updated = await query(
                    `UPDATE expenses SET category = $1
                     WHERE user_id = $2 AND merchant = $3 AND status = 'active'`,
                    [answer, userId, merchant]
                );
                if (updated.rowCount > 0) {
                    logger.info('Unified merchant category from inquiry', {
                        merchant, category: answer, count: updated.rowCount
                    });
                }
            } catch (updateErr) {
                logger.warn('Failed to update merchant expenses from inquiry', { error: updateErr.message });
            }
        }

        // Reset suggestion gate so next poll can generate a new suggestion
        if (inquiry.response_type === 'suggestion') {
            try {
                await suggestionGate.resetInterval(userId);
            } catch (err) {
                logger.debug('Failed to reset suggestion interval', { error: err.message });
            }
        }

        // Create memory card from the answer
        try {
            let cardContent, cardKind, cardTags, utilityWeight = 0.7;
            const qType = inquiry.question_type;
            const domain = inquiry.context?.domain || 'payments';
            const topic = inquiry.topic || qType;

            if (merchant && answer && (qType === 'uncategorized_expense' || qType === 'high_confidence_confirmation' || qType === 'ambiguous_merchant')) {
                // Payments: merchant categorization
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
                utilityWeight = 0.9;
            } else if (qType === 'ai_question') {
                // AI-generated question — save user's answer + detail as a goal/preference
                const detailSuffix = additionalContext ? ` — Detail: ${additionalContext}` : '';
                cardKind = 'user_preference';
                cardContent = {
                    type: 'USER_GOAL',
                    text: `USER RESPONDED to "${inquiry.question_text}": ${answer}${detailSuffix}`,
                    question_type: qType,
                    topic: topic,
                    answer: answer,
                    additional_context: additionalContext || null,
                    source: 'user_inquiry',
                    confidence: 1.0
                };
                cardTags = [domain, 'user_preference', topic];
                utilityWeight = 0.95;
            } else if (qType === 'ai_advice') {
                // AI advice — user chose to save the tip
                if (answer === 'saved') {
                    cardKind = 'user_preference';
                    cardContent = {
                        type: 'SAVED_TIP',
                        text: `SAVED TIP: ${inquiry.question_text}`,
                        question_type: qType,
                        topic: topic,
                        source: 'user_inquiry',
                        confidence: 0.9
                    };
                    cardTags = [domain, 'saved_tip', topic];
                    utilityWeight = 0.8;
                } else {
                    // User dismissed — no memory card needed
                    return;
                }
            } else {
                // Fallback for legacy types
                cardKind = 'user_preference';
                cardContent = {
                    type: 'PATTERN',
                    text: `USER RESPONDED to "${inquiry.question_text}": ${answer}`,
                    question_type: qType,
                    category: category || null,
                    answer: answer,
                    source: 'user_inquiry',
                    confidence: 0.9
                };
                cardTags = [domain, 'user_preference', qType];
                if (category) cardTags.push(category);
            }

            // Tag memory card with intent if this inquiry was intent-driven
            if (inquiry.context?.intent_name) {
                cardTags.push(inquiry.context.intent_name);
            }

            const cardResponse = await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                owner_type: 'user',
                owner_id: userId,
                tier: 2,
                kind: cardKind,
                content: cardContent,
                tags: cardTags,
                utility_weight: utilityWeight,
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
                question_type: qType, domain, topic
            });
        } catch (err) {
            logger.warn('Failed to create memory from inquiry', { error: err.message });
        }
    }

    async dismissInquiry(inquiryId, userId) {
        // Check if it's a suggestion before dismissing (to reset gate)
        const inqResult = await query(
            'SELECT response_type FROM oggy_inquiries WHERE inquiry_id = $1', [inquiryId]
        );

        await query(
            `UPDATE oggy_inquiries SET status = 'dismissed'
             WHERE inquiry_id = $1 AND user_id = $2`,
            [inquiryId, userId]
        );

        // Reset suggestion gate so next poll can generate a new suggestion
        if (inqResult.rows[0]?.response_type === 'suggestion') {
            try {
                await suggestionGate.resetInterval(userId);
            } catch (err) {
                logger.debug('Failed to reset suggestion interval on dismiss', { error: err.message });
            }
        }
    }
}

module.exports = new InquiryGenerator();
