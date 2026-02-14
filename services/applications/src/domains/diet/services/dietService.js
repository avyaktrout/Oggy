/**
 * V3: Diet Agent Service
 * Handles food/liquid/vitamin tracking, nutrition analysis, and diet chat.
 */

const axios = require('axios');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const circuitBreakerRegistry = require('../../../shared/utils/circuitBreakerRegistry');
const providerResolver = require('../../../shared/providers/providerResolver');

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

    async updateNutrition(userId, entryId, nutritionData) {
        // Verify entry belongs to user
        const check = await query('SELECT entry_id FROM v3_diet_entries WHERE entry_id = $1 AND user_id = $2', [entryId, userId]);
        if (check.rows.length === 0) throw new Error('Entry not found');

        const { calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg } = nutritionData;
        const result = await query(
            `UPDATE v3_diet_items SET calories = $1, protein_g = $2, carbs_g = $3, fat_g = $4,
             fiber_g = $5, sugar_g = $6, sodium_mg = $7, source = 'user_corrected'
             WHERE entry_id = $8 RETURNING *`,
            [calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, entryId]
        );
        if (result.rowCount === 0) throw new Error('No nutrition item found for this entry');
        return result.rows[0];
    }

    async deleteEntry(userId, entryId) {
        // Delete items first (FK), then entry — scoped by user_id for safety
        await query(`DELETE FROM v3_diet_items WHERE entry_id = $1 AND entry_id IN (SELECT entry_id FROM v3_diet_entries WHERE user_id = $2)`, [entryId, userId]);
        const result = await query(`DELETE FROM v3_diet_entries WHERE entry_id = $1 AND user_id = $2`, [entryId, userId]);
        if (result.rowCount === 0) throw new Error('Entry not found');
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

        // Get today's nutrition summary (check today + yesterday to handle UTC vs local timezone)
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];
        let nutritionContext = '';
        try {
            let summary = await this.getNutritionSummary(userId, today);
            let entries = await this.getEntries(userId, today);
            let dateLabel = today;

            // If no entries for UTC today, check yesterday (user may be in an earlier timezone)
            if ((!entries || entries.length === 0) && yesterday !== today) {
                const ySummary = await this.getNutritionSummary(userId, yesterday);
                const yEntries = await this.getEntries(userId, yesterday);
                if (yEntries && yEntries.length > 0) {
                    summary = ySummary;
                    entries = yEntries;
                    dateLabel = yesterday;
                }
            }
            const rules = await this.getRules(userId);

            nutritionContext = `\n# Today's Nutrition (${dateLabel})
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

        await costGovernor.checkBudget(6000);

        const oggyMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const baseMessages = [
            { role: 'system', content: `You are a diet and nutrition assistant. Help users with food tracking and nutrition advice. Be concise and helpful.${nutritionContext}` },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        // Run Oggy and Base in parallel
        const [oggyResult, baseResult] = await Promise.all([
            (async () => {
                const oggyResolved = await providerResolver.getAdapter(userId, 'oggy');
                return this.openaiBreaker.execute(() =>
                    oggyResolved.adapter.chatCompletion({
                        model: oggyResolved.model,
                        messages: oggyMessages,
                        temperature: 0.7,
                        max_tokens: 1000
                    })
                ).then(r => {
                    costGovernor.recordUsage(r.tokens_used || 800);
                    providerResolver.logRequest(userId, oggyResolved.provider, oggyResolved.model, 'oggy', 'dietChat', r.tokens_used, r.latency_ms, true, null);
                    return { text: r.text, used_memory: memoryCards.length > 0 };
                });
            })(),
            (async () => {
                try {
                    const baseResolved = await providerResolver.getAdapter(userId, 'base');
                    const r = await baseResolved.adapter.chatCompletion({
                        model: baseResolved.model,
                        messages: baseMessages,
                        temperature: 0.7,
                        max_tokens: 1000
                    });
                    costGovernor.recordUsage(r.tokens_used || 800);
                    providerResolver.logRequest(userId, baseResolved.provider, baseResolved.model, 'base', 'dietChat', r.tokens_used, r.latency_ms, true, null);
                    return { text: r.text };
                } catch (err) {
                    logger.debug('Base diet chat failed', { error: err.message });
                    return { text: 'Sorry, I encountered an error. Please try again.' };
                }
            })()
        ]);

        // Store chat message
        try {
            await query(
                `INSERT INTO v3_diet_chat_messages (user_id, role, content, oggy_response, used_memory, trace_id)
                 VALUES ($1, 'user', $2, false, false, NULL), ($1, 'assistant', $3, true, $4, $5)`,
                [userId, message, oggyResult.text, memoryCards.length > 0, traceId]
            );
        } catch (err) {
            logger.debug('Failed to store diet chat message', { error: err.message });
        }

        return {
            oggy_response: oggyResult,
            base_response: baseResult,
            trace_id: traceId,
            latency_ms: Date.now() - startTime
        };
    }

    // --- Nutrition Analysis ---
    // Lookup chain: user-corrected → branded_foods (fuzzy) → OpenFoodFacts API → AI estimation
    async _analyzeNutrition(description, quantity, unit, userId) {
        try {
            // 1. Check for previous user-corrected entry with same description
            if (userId) {
                const prev = await query(
                    `SELECT i.calories, i.protein_g, i.carbs_g, i.fat_g, i.fiber_g, i.sugar_g, i.sodium_mg
                     FROM v3_diet_items i
                     JOIN v3_diet_entries e ON i.entry_id = e.entry_id
                     WHERE e.user_id = $1 AND i.source = 'user_corrected' AND LOWER(e.description) = LOWER($2)
                     ORDER BY e.created_at DESC LIMIT 1`,
                    [userId, description]
                );
                if (prev.rows.length > 0) {
                    logger.debug('Using user-corrected nutrition for: ' + description);
                    return prev.rows[0];
                }
            }

            // 2. Check branded foods database (fuzzy: match brand + any word overlap)
            const brandedResult = await this._lookupBrandedFoods(description);
            if (brandedResult) return brandedResult;

            // 3. Try OpenFoodFacts API (free, no key needed, massive product database)
            const offResult = await this._lookupOpenFoodFacts(description);
            if (offResult) {
                logger.debug('Using OpenFoodFacts data for: ' + description);
                return offResult;
            }

            // 4. Fall back to AI estimation
            return await this._aiNutritionEstimate(description, quantity, unit, userId);
        } catch (err) {
            logger.warn('Nutrition analysis failed', { error: err.message, description });
            return { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0 };
        }
    }

    /**
     * Fuzzy branded foods lookup — matches brand name + overlapping words in product name
     */
    async _lookupBrandedFoods(description) {
        try {
            // First try exact product match
            const exactMatch = await query(
                `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg
                 FROM branded_foods
                 WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%' AND LOWER($1) LIKE '%' || LOWER(product) || '%'
                 ORDER BY LENGTH(product) DESC LIMIT 1`,
                [description]
            );
            if (exactMatch.rows.length > 0) {
                logger.debug('Branded foods exact match for: ' + description);
                return exactMatch.rows[0];
            }

            // Fuzzy match: brand name + category keyword matching
            // Split description into words and match brand + any significant word
            const words = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const brandMatch = await query(
                `SELECT brand, product, category, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg,
                        similarity(LOWER(brand || ' ' || product), LOWER($1)) AS sim
                 FROM branded_foods
                 WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%'
                 ORDER BY sim DESC, LENGTH(product) DESC LIMIT 1`,
                [description]
            );

            // If similarity extension isn't available, fall back to simpler match
            if (brandMatch.rows.length > 0) {
                logger.debug('Branded foods brand match for: ' + description, { matched: brandMatch.rows[0].product });
                return brandMatch.rows[0];
            }
        } catch (err) {
            // pg_trgm similarity() may not be available — try simpler fallback
            try {
                const fallback = await query(
                    `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, brand, product, category
                     FROM branded_foods
                     WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%'
                     ORDER BY LENGTH(product) DESC LIMIT 3`,
                    [description]
                );
                if (fallback.rows.length > 0) {
                    // Pick best match: prefer same category (energy_drink for energy drinks)
                    const descLower = description.toLowerCase();
                    const best = fallback.rows.find(r =>
                        (descLower.includes('energy') && r.category === 'energy_drink') ||
                        (descLower.includes('protein') && r.category === 'protein_shake') ||
                        (descLower.includes('bar') && r.category === 'snack_bar')
                    ) || fallback.rows[0];
                    logger.debug('Branded foods category fallback for: ' + description, { matched: best.product });
                    return best;
                }
            } catch (innerErr) {
                logger.debug('Branded foods lookup failed', { error: innerErr.message });
            }
        }
        return null;
    }

    /**
     * Look up nutrition data from OpenFoodFacts API (free, no API key needed)
     */
    async _lookupOpenFoodFacts(description) {
        try {
            const searchTerms = encodeURIComponent(description);
            const response = await axios.get(
                `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${searchTerms}&json=1&page_size=5&fields=product_name,brands,nutriments`,
                { timeout: 5000, headers: { 'User-Agent': 'Oggy-Diet-Tracker/1.0' } }
            );

            const products = response.data?.products;
            if (!products || products.length === 0) return null;

            // Find best match — prefer products with complete nutrient data
            const descLower = description.toLowerCase();
            const scored = products
                .filter(p => p.nutriments && (p.nutriments['energy-kcal_100g'] || p.nutriments['energy-kcal_serving']))
                .map(p => {
                    const name = ((p.brands || '') + ' ' + (p.product_name || '')).toLowerCase();
                    // Simple word overlap scoring
                    const descWords = descLower.split(/\s+/).filter(w => w.length > 2);
                    const matchCount = descWords.filter(w => name.includes(w)).length;
                    return { product: p, score: matchCount };
                })
                .sort((a, b) => b.score - a.score);

            if (scored.length === 0 || scored[0].score < 2) return null;

            const best = scored[0].product;
            const n = best.nutriments;

            // OpenFoodFacts stores per-100g and per-serving. Prefer per-serving when available.
            const useServing = n['energy-kcal_serving'] != null;
            const suffix = useServing ? '_serving' : '_100g';

            const result = {
                calories: Math.round(n[`energy-kcal${suffix}`] || n['energy-kcal_100g'] || 0),
                protein_g: Math.round((n[`proteins${suffix}`] || n['proteins_100g'] || 0) * 10) / 10,
                carbs_g: Math.round((n[`carbohydrates${suffix}`] || n['carbohydrates_100g'] || 0) * 10) / 10,
                fat_g: Math.round((n[`fat${suffix}`] || n['fat_100g'] || 0) * 10) / 10,
                fiber_g: Math.round((n[`fiber${suffix}`] || n['fiber_100g'] || 0) * 10) / 10,
                sugar_g: Math.round((n[`sugars${suffix}`] || n['sugars_100g'] || 0) * 10) / 10,
                sodium_mg: Math.round((n[`sodium${suffix}`] || n['sodium_100g'] || 0) * 1000),
            };

            logger.info('OpenFoodFacts match', {
                query: description,
                matched: `${best.brands || '?'} ${best.product_name || '?'}`,
                calories: result.calories,
                perServing: useServing
            });

            return result;
        } catch (err) {
            logger.debug('OpenFoodFacts lookup failed', { error: err.message, description });
            return null;
        }
    }

    /**
     * AI-based nutrition estimation (final fallback)
     */
    async _aiNutritionEstimate(description, quantity, unit, userId) {
        await costGovernor.checkBudget(1000);

        const prompt = `Look up the exact nutritional content for: "${description}"${quantity ? ` (${quantity} ${unit || 'serving'})` : ''}.
This is a real, commercially available product. Provide the actual nutrition facts from the product label.
If you cannot identify the exact product, estimate based on similar products in the same category.
Respond in JSON only (no markdown), all numeric values must be filled in:
{"calories":___,"protein_g":___,"carbs_g":___,"fat_g":___,"fiber_g":___,"sugar_g":___,"sodium_mg":___}`;

        const resolved = userId
            ? await providerResolver.getAdapter(userId, 'oggy')
            : await providerResolver.getAdapter('system', 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                { role: 'system', content: 'You are a nutrition database expert with comprehensive knowledge of commercially available food and beverages. You know exact nutritional labels for energy drinks (Ghost, Monster, Celsius, Red Bull, Bang, Alani Nu, C4, Reign, ZOA), protein supplements (Ghost, Optimum Nutrition, Dymatize), fast food chains, packaged foods, and grocery items. Always provide realistic nutritional values. Never return all zeros unless the item truly has zero calories (water, black coffee, plain tea). For zero-calorie energy drinks, still include sodium and small carb amounts from flavoring. If unsure of exact values, estimate based on similar products. Respond with JSON only.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 150,
            timeout: 10000
        });

        const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        costGovernor.recordUsage(result.tokens_used || 200);

        // Parse JSON, trying to extract from markdown if needed
        let parsed;
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
        } else {
            parsed = JSON.parse(jsonStr);
        }

        if (parsed.calories === 0 && parsed.protein_g === 0 && parsed.carbs_g === 0 && parsed.fat_g === 0) {
            logger.warn('Nutrition AI returned all zeros — may be incorrect', { description });
        }

        return parsed;
    }
}

module.exports = new DietService();
