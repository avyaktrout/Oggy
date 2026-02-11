/**
 * V3: Diet Agent Service
 * Handles food/liquid/vitamin tracking, nutrition analysis, and diet chat.
 */

const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const { costGovernor } = require('../middleware/costGovernor');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');
const providerResolver = require('../providers/providerResolver');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory-service:3000';

class DietService {
    constructor() {
        this.memoryBreaker = circuitBreakerRegistry.getOrCreate('memory-service');
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
    }

    // --- Entry Management ---
    async addEntry(userId, entryData) {
        const { entry_type, description, quantity, unit, meal_type, entry_date, entry_time } = entryData;

        const result = await query(
            `INSERT INTO v3_diet_entries (user_id, entry_type, description, quantity, unit, meal_type, entry_date, entry_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [userId, entry_type, description, quantity, unit, meal_type, entry_date || new Date().toISOString().split('T')[0], entry_time]
        );

        const entry = result.rows[0];

        // Auto-analyze nutrition using AI
        try {
            const nutritionData = await this._analyzeNutrition(description, quantity, unit, userId);
            if (nutritionData) {
                await query(
                    `INSERT INTO v3_diet_items (entry_id, name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ai_estimated')`,
                    [entry.entry_id, description, nutritionData.calories, nutritionData.protein_g,
                     nutritionData.carbs_g, nutritionData.fat_g, nutritionData.fiber_g,
                     nutritionData.sugar_g, nutritionData.sodium_mg]
                );
            }
        } catch (err) {
            logger.debug('Nutrition auto-analysis failed', { error: err.message });
        }

        // Store to memory for learning
        try {
            await axios.post(`${MEMORY_SERVICE_URL}/cards`, {
                owner_type: 'user',
                owner_id: userId,
                tier: 1,
                kind: 'diet_entry',
                content: {
                    type: 'PATTERN',
                    text: `User ate/drank: ${description} (${entry_type}, ${meal_type || 'unspecified'})`,
                    entry_type,
                    description,
                    meal_type,
                    source: 'diet_tracking'
                },
                tags: ['diet', 'nutrition', entry_type],
                utility_weight: 0.6,
                reliability: 0.9
            }, {
                timeout: 5000,
                headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
            });
        } catch (err) {
            logger.debug('Failed to store diet memory', { error: err.message });
        }

        return entry;
    }

    async getEntries(userId, date, options = {}) {
        const { entry_type } = options;
        let sql = `SELECT e.*, json_agg(i.*) FILTER (WHERE i.item_id IS NOT NULL) as items
                    FROM v3_diet_entries e
                    LEFT JOIN v3_diet_items i ON e.entry_id = i.entry_id
                    WHERE e.user_id = $1 AND e.entry_date = $2`;
        const params = [userId, date || new Date().toISOString().split('T')[0]];

        if (entry_type) {
            sql += ` AND e.entry_type = $3`;
            params.push(entry_type);
        }

        sql += ` GROUP BY e.entry_id ORDER BY e.entry_time ASC NULLS LAST, e.created_at ASC`;

        const result = await query(sql, params);
        return result.rows;
    }

    async getNutritionSummary(userId, date) {
        const result = await query(`
            SELECT
                COUNT(DISTINCT e.entry_id) as total_entries,
                COALESCE(SUM(i.calories), 0) as total_calories,
                COALESCE(SUM(i.protein_g), 0) as total_protein,
                COALESCE(SUM(i.carbs_g), 0) as total_carbs,
                COALESCE(SUM(i.fat_g), 0) as total_fat,
                COALESCE(SUM(i.fiber_g), 0) as total_fiber,
                COALESCE(SUM(i.sugar_g), 0) as total_sugar,
                COALESCE(SUM(i.sodium_mg), 0) as total_sodium
            FROM v3_diet_entries e
            LEFT JOIN v3_diet_items i ON e.entry_id = i.entry_id
            WHERE e.user_id = $1 AND e.entry_date = $2
        `, [userId, date || new Date().toISOString().split('T')[0]]);

        return result.rows[0];
    }

    // --- Rules Management ---
    async addRule(userId, ruleData) {
        const { rule_type, description, target_nutrient, target_value, target_unit } = ruleData;
        const result = await query(
            `INSERT INTO v3_diet_rules (user_id, rule_type, description, target_nutrient, target_value, target_unit)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [userId, rule_type, description, target_nutrient, target_value, target_unit]
        );
        return result.rows[0];
    }

    async getRules(userId) {
        const result = await query(
            'SELECT * FROM v3_diet_rules WHERE user_id = $1 AND active = true ORDER BY created_at ASC',
            [userId]
        );
        return result.rows;
    }

    async deleteRule(userId, ruleId) {
        await query(
            'UPDATE v3_diet_rules SET active = false, updated_at = NOW() WHERE rule_id = $1 AND user_id = $2',
            [ruleId, userId]
        );
    }

    // --- Diet Chat ---
    async chat(userId, message, options = {}) {
        const { conversation_history = [], learn_from_chat = false } = options;
        const startTime = Date.now();

        // Get today's nutrition summary
        const today = new Date().toISOString().split('T')[0];
        let nutritionContext = '';
        try {
            const summary = await this.getNutritionSummary(userId, today);
            const entries = await this.getEntries(userId, today);
            const rules = await this.getRules(userId);

            nutritionContext = `\n# Today's Nutrition (${today})
Entries: ${summary.total_entries}
Calories: ${Math.round(summary.total_calories)} kcal
Protein: ${Math.round(summary.total_protein)}g | Carbs: ${Math.round(summary.total_carbs)}g | Fat: ${Math.round(summary.total_fat)}g
Fiber: ${Math.round(summary.total_fiber)}g | Sugar: ${Math.round(summary.total_sugar)}g | Sodium: ${Math.round(summary.total_sodium)}mg

Recent entries: ${entries.slice(-5).map(e => `${e.description} (${e.meal_type || e.entry_type})`).join(', ') || 'None yet'}

User's diet rules: ${rules.length > 0 ? rules.map(r => `${r.rule_type}: ${r.description}`).join('; ') : 'None set'}`;
        } catch (err) {
            logger.debug('Failed to build nutrition context', { error: err.message });
        }

        // Retrieve diet memory
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
                    tag_filter: ['diet', 'nutrition'],
                    include_scores: true
                }, {
                    timeout: 5000,
                    headers: { 'x-api-key': process.env.INTERNAL_API_KEY || '' }
                })
            );
            traceId = retrieval.data?.trace_id;
            memoryCards = retrieval.data?.selected || [];
        } catch (err) {
            logger.debug('Memory retrieval failed for diet chat', { error: err.message });
        }

        const memoryContext = memoryCards.length > 0
            ? memoryCards.map((c, i) => `${i + 1}. ${c.content?.text || JSON.stringify(c.content)}`).join('\n')
            : 'No previous diet patterns.';

        const systemPrompt = `You are Oggy, a diet and nutrition tracking assistant. You help users track their food, analyze nutrition, and provide diet advice based on their goals and history.
${nutritionContext}

# Learned Patterns
${memoryContext}

Be helpful, encourage healthy choices, and use the user's tracked data when relevant.`;

        await costGovernor.checkBudget(3000);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
        const oggyResult = await this.openaiBreaker.execute(() =>
            oggyResolved.adapter.chatCompletion({
                model: oggyResolved.model,
                messages,
                temperature: 0.7,
                max_tokens: 1000
            })
        );

        const oggyText = oggyResult.text;
        costGovernor.recordUsage(oggyResult.tokens_used || Math.ceil((systemPrompt.length + message.length + oggyText.length) / 4));
        providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'dietChat', oggyResult.tokens_used, oggyResult.latency_ms, true, null);

        // Store chat message
        try {
            await query(
                `INSERT INTO v3_diet_chat_messages (user_id, role, content, oggy_response, used_memory, trace_id)
                 VALUES ($1, 'user', $2, false, false, NULL), ($1, 'assistant', $3, true, $4, $5)`,
                [userId, message, oggyText, memoryCards.length > 0, traceId]
            );
        } catch (err) {
            logger.debug('Failed to store diet chat message', { error: err.message });
        }

        return {
            oggy_response: {
                text: oggyText,
                used_memory: memoryCards.length > 0
            },
            trace_id: traceId,
            latency_ms: Date.now() - startTime
        };
    }

    // --- Nutrition Analysis (AI) ---
    async _analyzeNutrition(description, quantity, unit, userId) {
        try {
            await costGovernor.checkBudget(1000);

            const prompt = `Estimate the nutritional content of: "${description}"${quantity ? ` (${quantity} ${unit || 'serving'})` : ''}.
Respond in JSON only (no markdown):
{"calories":0,"protein_g":0,"carbs_g":0,"fat_g":0,"fiber_g":0,"sugar_g":0,"sodium_mg":0}`;

            const resolved = userId
                ? await providerResolver.getAdapter(userId, 'oggy')
                : await providerResolver.getAdapter('system', 'oggy');

            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    { role: 'system', content: 'You are a nutrition expert. Estimate nutritional values accurately. Respond with JSON only.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                max_tokens: 150,
                timeout: 10000
            });

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            costGovernor.recordUsage(result.tokens_used || 200);
            return JSON.parse(jsonStr);
        } catch (err) {
            logger.debug('Nutrition analysis failed', { error: err.message });
            return null;
        }
    }
}

module.exports = new DietService();
