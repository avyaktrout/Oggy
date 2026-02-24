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
const usdaService = require('../../../shared/services/usdaService');

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
                const customNutrients = {};
                if (nutritionData.saturated_fat_g != null) customNutrients.saturated_fat_g = nutritionData.saturated_fat_g;
                if (nutritionData.unsaturated_fat_g != null) customNutrients.unsaturated_fat_g = nutritionData.unsaturated_fat_g;
                const source = nutritionData._source || 'ai_estimated';
                await query(
                    `INSERT INTO v3_diet_items (entry_id, name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg, custom_nutrients, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                    [entry.entry_id, description, nutritionData.calories, nutritionData.protein_g,
                     nutritionData.carbs_g, nutritionData.fat_g, nutritionData.fiber_g,
                     nutritionData.sugar_g, nutritionData.sodium_mg, nutritionData.caffeine_mg || 0,
                     JSON.stringify(customNutrients), source]
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
                COALESCE(SUM((i.custom_nutrients->>'saturated_fat_g')::real), 0) as total_saturated_fat,
                COALESCE(SUM((i.custom_nutrients->>'unsaturated_fat_g')::real), 0) as total_unsaturated_fat,
                COALESCE(SUM(i.fiber_g), 0) as total_fiber,
                COALESCE(SUM(i.sugar_g), 0) as total_sugar,
                COALESCE(SUM(i.sodium_mg), 0) as total_sodium,
                COALESCE(SUM(i.caffeine_mg), 0) as total_caffeine
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

        const { calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg, saturated_fat_g, unsaturated_fat_g } = nutritionData;
        const customNutrients = {};
        if (saturated_fat_g != null) customNutrients.saturated_fat_g = saturated_fat_g;
        if (unsaturated_fat_g != null) customNutrients.unsaturated_fat_g = unsaturated_fat_g;
        const result = await query(
            `UPDATE v3_diet_items SET calories = $1, protein_g = $2, carbs_g = $3, fat_g = $4,
             fiber_g = $5, sugar_g = $6, sodium_mg = $7, caffeine_mg = $8,
             custom_nutrients = COALESCE(custom_nutrients, '{}'::jsonb) || $9::jsonb,
             source = 'user_corrected'
             WHERE entry_id = $10 RETURNING *`,
            [calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg || 0, JSON.stringify(customNutrients), entryId]
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

        // Build nutrition context for today + recent days so AI can answer about any recent date
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        let nutritionContext = '';
        try {
            const rules = await this.getRules(userId);

            // Load last 3 days of data so the AI can answer about today, yesterday, etc.
            const days = [];
            for (let i = 0; i < 3; i++) {
                const d = new Date(now.getTime() - i * 86400000).toISOString().split('T')[0];
                const [summary, entries] = await Promise.all([
                    this.getNutritionSummary(userId, d),
                    this.getEntries(userId, d)
                ]);
                if (entries && entries.length > 0) {
                    const label = i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d;
                    days.push(`## ${label} (${d})
Entries: ${summary.total_entries} | Calories: ${Math.round(summary.total_calories)} kcal | Protein: ${Math.round(summary.total_protein)}g | Carbs: ${Math.round(summary.total_carbs)}g | Fat: ${Math.round(summary.total_fat)}g
Foods: ${entries.map(e => `${e.description} (${e.meal_type || e.entry_type})`).join(', ')}`);
                }
            }

            nutritionContext = `\n# Nutrition Data
${days.length > 0 ? days.join('\n\n') : 'No entries in the last 3 days.'}

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

        const todayFormatted = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const systemPrompt = `You are Oggy, a diet and nutrition tracking assistant. You help users track their food, analyze nutrition, and provide diet advice based on their goals and history.
Today is ${todayFormatted} (${today}).
${nutritionContext}

# Learned Patterns
${memoryContext}

IMPORTANT: The Nutrition Data above contains the user's ACTUAL food entries for each date. When answering questions about what the user ate, ONLY use entries from the correct date section. "Yesterday" means the day before today (${today}). Do NOT confuse entries from different dates.
Be helpful, encourage healthy choices, and use the user's tracked data when relevant.`;

        await costGovernor.checkBudget(6000);

        const oggyMessages = [
            { role: 'system', content: systemPrompt },
            ...conversation_history.slice(-10),
            { role: 'user', content: message }
        ];

        const baseMessages = [
            { role: 'system', content: `You are a diet and nutrition assistant. Help users with food tracking and nutrition advice. Be concise and helpful.\nToday is ${todayFormatted} (${today}).\n${nutritionContext}\nIMPORTANT: The Nutrition Data above contains the user's ACTUAL food entries for each date. When answering about what the user ate, ONLY reference entries from the correct date. "Yesterday" means the day before today (${today}). Do NOT confuse entries from different dates.` },
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
    // Lookup chain: user-corrected → branded_foods → USDA (with LLM decomposition) → OpenFoodFacts → AI estimation
    async _analyzeNutrition(description, quantity, unit, userId) {
        try {
            let result = null;
            let alreadyScaled = false;

            // 1. Check for previous user-corrected entry with same description
            if (userId) {
                const prev = await query(
                    `SELECT i.calories, i.protein_g, i.carbs_g, i.fat_g, i.fiber_g, i.sugar_g, i.sodium_mg, i.caffeine_mg,
                            (i.custom_nutrients->>'saturated_fat_g')::real AS saturated_fat_g,
                            (i.custom_nutrients->>'unsaturated_fat_g')::real AS unsaturated_fat_g
                     FROM v3_diet_items i
                     JOIN v3_diet_entries e ON i.entry_id = e.entry_id
                     WHERE e.user_id = $1 AND i.source = 'user_corrected' AND LOWER(e.description) = LOWER($2)
                     ORDER BY e.created_at DESC LIMIT 1`,
                    [userId, description]
                );
                if (prev.rows.length > 0) {
                    logger.debug('Using user-corrected nutrition for: ' + description);
                    result = prev.rows[0];
                }
            }

            // 2. Check branded foods database (fuzzy: match brand + any word overlap)
            if (!result) {
                const brandedResult = await this._lookupBrandedFoods(description);
                if (brandedResult) { brandedResult._source = 'branded_db'; result = brandedResult; }
            }

            // 3. USDA FoodData Central (with LLM decomposition for complex foods)
            if (!result) {
                const usdaResult = await this._lookupUSDA(description, quantity, unit, userId);
                if (usdaResult) { result = usdaResult; alreadyScaled = true; }
            }

            // 4. Try OpenFoodFacts API (free, no key needed, massive product database)
            if (!result) {
                const offResult = await this._lookupOpenFoodFacts(description);
                if (offResult) {
                    logger.debug('Using OpenFoodFacts data for: ' + description);
                    offResult._source = 'openfoodfacts';
                    result = offResult;
                }
            }

            // 5. Fall back to AI estimation (already includes quantity in prompt)
            if (!result) {
                result = await this._aiNutritionEstimate(description, quantity, unit, userId);
                alreadyScaled = true;
            }

            // Apply quantity multiplier if the lookup returned per-single-item data
            // USDA and AI already handle quantity internally; branded/OFF/user-corrected do not
            if (result && !alreadyScaled && quantity && quantity > 1) {
                const fields = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg', 'caffeine_mg', 'saturated_fat_g', 'unsaturated_fat_g'];
                for (const f of fields) {
                    if (result[f] != null) result[f] = Math.round(result[f] * quantity * 100) / 100;
                }
                logger.debug(`Applied quantity multiplier ×${quantity} to nutrition for: ${description}`);
            }

            return result || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0, caffeine_mg: 0 };
        } catch (err) {
            logger.warn('Nutrition analysis failed', { error: err.message, description });
            return { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0, caffeine_mg: 0 };
        }
    }

    /**
     * USDA lookup with LLM decomposition for complex foods.
     * Simple foods ("banana") → direct USDA search.
     * Complex foods ("chicken burrito with rice and beans") → LLM breaks into items → USDA each → sum.
     */
    async _lookupUSDA(description, quantity, unit, userId) {
        try {
            const words = description.trim().split(/\s+/);
            // Only decompose genuinely complex multi-component foods, NOT "X at Y" patterns
            const strippedLocation = description.replace(/\b(at|from|by)\s+\w+(\s+\w+)*/i, '').trim();
            const isComplex = (
                /\b(with|and|plus|also)\b/i.test(description) ||
                description.includes(',') ||
                (words.length >= 5 && !/\b(at|from)\b/i.test(description))
            );

            if (isComplex) {
                const decomposed = await this._decomposeFood(description, userId);
                if (decomposed && decomposed.length > 0) {
                    const results = await Promise.all(
                        decomposed.map(async (item) => {
                            const nutrition = await usdaService.lookup(item.item);
                            if (!nutrition) return null;
                            return usdaService.scaleByQuantity(nutrition, item.grams, 'g');
                        })
                    );

                    const valid = results.filter(r => r !== null);
                    if (valid.length > 0 && valid.length >= decomposed.length * 0.5) {
                        // Sum all components (this is per-single-serving of the composed food)
                        const summed = {
                            calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
                            saturated_fat_g: 0, unsaturated_fat_g: 0,
                            fiber_g: 0, sugar_g: 0, sodium_mg: 0, caffeine_mg: 0
                        };
                        for (const r of valid) {
                            summed.calories += r.calories || 0;
                            summed.protein_g += r.protein_g || 0;
                            summed.carbs_g += r.carbs_g || 0;
                            summed.fat_g += r.fat_g || 0;
                            summed.saturated_fat_g += r.saturated_fat_g || 0;
                            summed.unsaturated_fat_g += (r.unsaturated_fat_g || 0);
                            summed.fiber_g += r.fiber_g || 0;
                            summed.sugar_g += r.sugar_g || 0;
                            summed.sodium_mg += r.sodium_mg || 0;
                            summed.caffeine_mg += r.caffeine_mg || 0;
                        }

                        // Apply quantity multiplier (decomposition gives 1 serving worth)
                        const qty = (quantity && quantity > 0) ? quantity : 1;
                        summed.calories = Math.round(summed.calories * qty);
                        summed.protein_g = Math.round(summed.protein_g * qty * 10) / 10;
                        summed.carbs_g = Math.round(summed.carbs_g * qty * 10) / 10;
                        summed.fat_g = Math.round(summed.fat_g * qty * 10) / 10;
                        summed.saturated_fat_g = Math.round(summed.saturated_fat_g * qty * 10) / 10;
                        summed.unsaturated_fat_g = Math.round(summed.unsaturated_fat_g * qty * 10) / 10;
                        summed.fiber_g = Math.round(summed.fiber_g * qty * 10) / 10;
                        summed.sugar_g = Math.round(summed.sugar_g * qty * 10) / 10;
                        summed.sodium_mg = Math.round(summed.sodium_mg * qty);
                        summed.caffeine_mg = Math.round(summed.caffeine_mg * qty);

                        logger.info('USDA decomposed lookup', {
                            description,
                            components: decomposed.length,
                            matched: valid.length,
                            quantity: qty,
                            totalCalories: summed.calories
                        });
                        summed._source = 'usda';
                        return summed;
                    }
                }
            }

            // Simple food or decomposition failed — try direct USDA search
            const nutrition = await usdaService.lookup(description);
            if (!nutrition) return null;

            // Scale by quantity if provided
            let scaled = usdaService.scaleByQuantity(nutrition, quantity, unit);

            // If still per-100g (no USDA serving size, unit was 'serving'/unrecognized),
            // estimate a typical serving size via LLM
            const isUnscaled = scaled.calories === nutrition.calories && !nutrition._servingSizeG;
            const needsServing = !unit || ['serving', 'piece', 'cup', 'bowl', 'plate', 'glass', 'bottle', 'can', 'slice'].includes((unit || '').toLowerCase());
            if (isUnscaled && needsServing) {
                const estimatedG = await this._estimateServingSize(description, userId);
                if (estimatedG > 0) {
                    scaled = usdaService.scaleByQuantity({ ...nutrition, _servingSizeG: estimatedG }, quantity || 1, unit || 'serving');
                    logger.info('USDA serving size estimated by LLM', { description, estimatedG, scaledCalories: scaled.calories });
                }
            }

            scaled._source = 'usda';
            return scaled;
        } catch (err) {
            logger.debug('USDA lookup failed', { error: err.message, description });
            return null;
        }
    }

    /**
     * Use LLM to decompose a complex food description into individual USDA-searchable items.
     * Returns: [{ item: "chicken breast", grams: 170 }, { item: "white rice", grams: 200 }]
     */
    async _decomposeFood(description, userId) {
        try {
            await costGovernor.checkBudget(500);

            const resolved = userId
                ? await providerResolver.getAdapter(userId, 'oggy')
                : await providerResolver.getAdapter('system', 'oggy');

            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    { role: 'system', content: 'Break down composite food descriptions into individual ingredients with estimated gram weights for nutritional database lookup. Return ONLY a JSON array. Each item should be a simple, common food name that would appear in USDA FoodData Central (e.g. "chicken breast cooked" not "grilled herb-crusted chicken"). Estimate realistic portion sizes in grams. For restaurant meals, use generous portions.' },
                    { role: 'user', content: `Break this into individual items with gram weights:\n"${description}"\n\nReturn JSON array only: [{"item":"...","grams":...}]` }
                ],
                temperature: 0,
                max_tokens: 200,
                timeout: 5000
            });

            costGovernor.recordUsage(result.tokens_used || 150);

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const match = jsonStr.match(/\[[\s\S]*\]/);
            if (!match) return null;

            const items = JSON.parse(match[0]);
            if (!Array.isArray(items) || items.length === 0) return null;

            // Validate structure
            const valid = items.filter(i => i.item && typeof i.item === 'string' && i.grams > 0);
            logger.debug('Food decomposition', { description, items: valid });
            return valid.length > 0 ? valid : null;
        } catch (err) {
            logger.debug('Food decomposition failed', { error: err.message, description });
            return null;
        }
    }

    /**
     * Estimate typical serving size in grams for a food item via LLM.
     * Used when USDA returns per-100g data but no serving size, and user said "1 serving".
     * Returns grams (number) or 0 on failure.
     */
    async _estimateServingSize(description, userId) {
        try {
            await costGovernor.checkBudget(200);

            const resolved = userId
                ? await providerResolver.getAdapter(userId, 'oggy')
                : await providerResolver.getAdapter('system', 'oggy');

            const result = await resolved.adapter.chatCompletion({
                model: resolved.model,
                messages: [
                    { role: 'system', content: 'Estimate the typical serving size in grams for a food or drink item. Consider standard restaurant/commercial portions. For drinks, use ml (≈ grams). Return ONLY a JSON object: {"grams": <number>}' },
                    { role: 'user', content: `What is one typical serving of "${description}" in grams?\nReturn JSON only: {"grams": <number>}` }
                ],
                temperature: 0,
                max_tokens: 50,
                timeout: 5000
            });

            costGovernor.recordUsage(result.tokens_used || 80);

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const match = jsonStr.match(/\{[\s\S]*\}/);
            if (!match) return 0;

            const parsed = JSON.parse(match[0]);
            const grams = parsed.grams || parsed.g || 0;
            if (grams > 0 && grams < 5000) {
                logger.debug('Serving size estimated', { description, grams });
                return grams;
            }
            return 0;
        } catch (err) {
            logger.debug('Serving size estimation failed', { error: err.message, description });
            return 0;
        }
    }

    /**
     * Fuzzy branded foods lookup — matches brand name + overlapping words in product name
     */
    async _lookupBrandedFoods(description) {
        try {
            // First try exact product match (description contains both brand AND product)
            const exactMatch = await query(
                `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg
                 FROM branded_foods
                 WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%' AND LOWER($1) LIKE '%' || LOWER(product) || '%'
                 ORDER BY LENGTH(product) DESC LIMIT 1`,
                [description]
            );
            if (exactMatch.rows.length > 0) {
                logger.debug('Branded foods exact match for: ' + description);
                return exactMatch.rows[0];
            }

            // Try product-name match (user might not include brand, e.g. "Buldak Carbonara Ramen")
            const descWords = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            if (descWords.length > 0) {
                const minHits = Math.ceil(descWords.length / 2);
                const wordCases = descWords.map((_, i) => `CASE WHEN LOWER(product) LIKE '%' || $${i + 1} || '%' THEN 1 ELSE 0 END`).join(' + ');
                const productMatch = await query(
                    `SELECT brand, product, category, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg,
                            (${wordCases}) AS word_hits
                     FROM branded_foods
                     WHERE (${wordCases}) >= ${minHits}
                     ORDER BY word_hits DESC, LENGTH(product) DESC LIMIT 1`,
                    descWords
                );
                if (productMatch.rows.length > 0) {
                    logger.debug('Branded foods product-name match for: ' + description, { matched: productMatch.rows[0].product, hits: productMatch.rows[0].word_hits });
                    return productMatch.rows[0];
                }
            }

            // Fuzzy match: brand name + similarity scoring
            const brandMatch = await query(
                `SELECT brand, product, category, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg,
                        similarity(LOWER(brand || ' ' || product), LOWER($1)) AS sim
                 FROM branded_foods
                 WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%'
                 ORDER BY sim DESC, LENGTH(product) DESC LIMIT 1`,
                [description]
            );

            if (brandMatch.rows.length > 0) {
                logger.debug('Branded foods brand match for: ' + description, { matched: brandMatch.rows[0].product });
                return brandMatch.rows[0];
            }
        } catch (err) {
            // pg_trgm similarity() may not be available — try simpler fallback
            try {
                const fallback = await query(
                    `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg, brand, product, category
                     FROM branded_foods
                     WHERE LOWER($1) LIKE '%' || LOWER(brand) || '%'
                        OR LOWER(product) ILIKE $2
                     ORDER BY LENGTH(product) DESC LIMIT 3`,
                    [description, '%' + description.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%']
                );
                if (fallback.rows.length > 0) {
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

            const satFat = n[`saturated-fat${suffix}`] ?? n['saturated-fat_100g'];
            const unsatFat = (satFat != null && (n[`fat${suffix}`] || n['fat_100g']))
                ? Math.max(0, (n[`fat${suffix}`] || n['fat_100g']) - satFat)
                : null;
            const result = {
                calories: Math.round(n[`energy-kcal${suffix}`] || n['energy-kcal_100g'] || 0),
                protein_g: Math.round((n[`proteins${suffix}`] || n['proteins_100g'] || 0) * 10) / 10,
                carbs_g: Math.round((n[`carbohydrates${suffix}`] || n['carbohydrates_100g'] || 0) * 10) / 10,
                fat_g: Math.round((n[`fat${suffix}`] || n['fat_100g'] || 0) * 10) / 10,
                saturated_fat_g: satFat != null ? Math.round(satFat * 10) / 10 : null,
                unsaturated_fat_g: unsatFat != null ? Math.round(unsatFat * 10) / 10 : null,
                fiber_g: Math.round((n[`fiber${suffix}`] || n['fiber_100g'] || 0) * 10) / 10,
                sugar_g: Math.round((n[`sugars${suffix}`] || n['sugars_100g'] || 0) * 10) / 10,
                sodium_mg: Math.round((n[`sodium${suffix}`] || n['sodium_100g'] || 0) * 1000),
                caffeine_mg: Math.round((n[`caffeine${suffix}`] || n['caffeine_100g'] || 0) * (useServing ? 1000 : 10)),
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

        const qtyStr = quantity ? ` (${quantity} ${unit || 'serving'})` : '';
        const prompt = `Estimate the TOTAL nutritional content for: "${description}"${qtyStr}.
IMPORTANT RULES:
- If a quantity is given (e.g. "2 piece"), multiply ALL values by that quantity. The response must reflect the TOTAL for all items combined.
- If this mentions a store/restaurant/brand (e.g. Costco, McDonald's, Chipotle), use that brand's actual known portion sizes, NOT generic USDA values. A Costco hot dog is a 1/4 lb all-beef frank (~550 kcal each), NOT a generic 45g hot dog.
- For restaurant meals with multiple items, SUM all components (meats, sides, sauces, rice).
- Restaurant portions are large (300-500g+). A typical combo plate is 1000-1500+ cal.
- Do NOT underestimate — if unsure, estimate on the higher side.
Respond in JSON only (no markdown), all numeric values must be filled in:
{"calories":___,"protein_g":___,"carbs_g":___,"fat_g":___,"saturated_fat_g":___,"unsaturated_fat_g":___,"fiber_g":___,"sugar_g":___,"sodium_mg":___,"caffeine_mg":___}`;

        const resolved = userId
            ? await providerResolver.getAdapter(userId, 'oggy')
            : await providerResolver.getAdapter('system', 'oggy');

        const result = await resolved.adapter.chatCompletion({
            model: resolved.model,
            messages: [
                { role: 'system', content: 'You are a nutrition database expert with comprehensive knowledge of food and beverages. You know exact nutritional labels for energy drinks (Ghost, Monster, Celsius, Red Bull, Bang, Alani Nu, C4, Reign, ZOA), protein supplements (Ghost, Optimum Nutrition, Dymatize), fast food chains, restaurant menus, packaged foods, and grocery items. For restaurant combo plates/mix plates with multiple items, SUM the nutrition of ALL components (each meat, each side, rice, sauce, salad). Restaurant portions are large — a typical Hawaiian BBQ plate is 1200-1500 cal, a Chipotle burrito is 1000-1200 cal, etc. NEVER underestimate restaurant meals. Always provide realistic nutritional values. Never return all zeros unless the item truly has zero calories (water, black coffee, plain tea). For zero-calorie energy drinks, still include sodium and small carb amounts from flavoring. Respond with JSON only.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 250,
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

    // ─── Goals ──────────────────────────────────────────
    async getGoals(userId) {
        const result = await query(
            `SELECT rule_id, target_nutrient, target_value, target_unit, rule_type
             FROM v3_diet_rules
             WHERE user_id = $1 AND rule_type IN ('goal','limit')
               AND target_nutrient IS NOT NULL AND active = true
             ORDER BY created_at`,
            [userId]
        );
        return result.rows;
    }

    async upsertGoal(userId, nutrient, value) {
        const result = await query(
            `INSERT INTO v3_diet_rules (rule_id, user_id, rule_type, description, target_nutrient, target_value, target_unit, active)
             VALUES (gen_random_uuid(), $1, 'goal', $2, $3, $4, $5, true)
             ON CONFLICT (user_id, target_nutrient, rule_type) WHERE active = true AND target_nutrient IS NOT NULL
             DO UPDATE SET target_value = EXCLUDED.target_value, updated_at = NOW()
             RETURNING *`,
            [userId, nutrient + ' daily goal: ' + value, nutrient, value, nutrient.endsWith('_mg') ? 'mg' : (nutrient === 'calories' ? 'kcal' : 'g')]
        );
        return result.rows[0];
    }

    // ─── Food Search ────────────────────────────────────
    async searchFoods(userId, q) {
        const results = [];
        const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');

        // 1. User's recent entries
        const recentResult = await query(
            `SELECT sub.description, sub.entry_type, sub.quantity, sub.unit, sub.meal_type,
                    sub.calories, sub.protein_g
             FROM (
                 SELECT DISTINCT ON (e.description) e.description, e.entry_type, e.quantity, e.unit, e.meal_type,
                        i.calories, i.protein_g, e.entry_date
                 FROM v3_diet_entries e LEFT JOIN v3_diet_items i ON i.entry_id = e.entry_id
                 WHERE e.user_id = $1 AND e.description ILIKE $2
                 ORDER BY e.description, e.entry_date DESC
             ) sub ORDER BY sub.entry_date DESC LIMIT 5`,
            [userId, '%' + escaped + '%']
        );
        for (const r of recentResult.rows) {
            results.push({ source: 'recent', description: r.description, calories: Math.round(r.calories || 0), protein_g: Math.round(r.protein_g || 0), entry_type: r.entry_type, quantity: r.quantity, unit: r.unit, meal_type: r.meal_type });
        }

        // 2. Branded foods
        const brandedResult = await query(
            `SELECT brand, product, calories, protein_g, serving_size
             FROM branded_foods WHERE (brand || ' ' || product) ILIKE $1 LIMIT 5`,
            ['%' + escaped + '%']
        );
        for (const r of brandedResult.rows) {
            results.push({ source: 'branded', description: r.brand + ' ' + r.product, brand: r.brand, calories: Math.round(r.calories || 0), protein_g: Math.round(r.protein_g || 0), serving_size: r.serving_size });
        }

        // 3. USDA (only for 3+ chars)
        if (q.length >= 3) {
            try {
                const usdaResults = await usdaService.search(q);
                for (const r of usdaResults) {
                    results.push({ source: 'usda', description: r.description, calories: r.calories });
                }
            } catch (_) {}
        }

        return results;
    }

    // ─── Recent Foods ───────────────────────────────────
    async getRecentFoods(userId, limit = 10) {
        const result = await query(
            `SELECT sub.* FROM (
                SELECT DISTINCT ON (e.description) e.description, e.entry_type, e.quantity, e.unit, e.meal_type,
                       i.calories, i.protein_g, e.entry_date
                FROM v3_diet_entries e LEFT JOIN v3_diet_items i ON i.entry_id = e.entry_id
                WHERE e.user_id = $1 AND e.entry_date >= CURRENT_DATE - INTERVAL '30 days'
                ORDER BY e.description, e.entry_date DESC
            ) sub ORDER BY sub.entry_date DESC LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }

    // ─── Barcode Lookup ─────────────────────────────────
    async lookupBarcode(userId, barcode) {
        // 1. Check local cache
        const cached = await query(
            `SELECT brand, product, serving_size, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg
             FROM branded_foods WHERE barcode = $1 LIMIT 1`,
            [barcode]
        );
        if (cached.rows.length > 0) {
            const r = cached.rows[0];
            return { name: r.product, brand: r.brand, serving_size: r.serving_size, calories: r.calories, protein_g: r.protein_g, carbs_g: r.carbs_g, fat_g: r.fat_g, fiber_g: r.fiber_g, sugar_g: r.sugar_g, sodium_mg: r.sodium_mg, caffeine_mg: r.caffeine_mg, barcode, source: 'cache' };
        }

        // 2. OpenFoodFacts barcode API
        try {
            const resp = await axios.get(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, { timeout: 8000 });
            if (resp.data?.status !== 1 || !resp.data?.product) {
                return { error: 'Product not found', barcode };
            }
            const p = resp.data.product;
            const n = p.nutriments || {};

            // Determine scaling: prefer per-serving values scaled to full product
            // OpenFoodFacts often sets serving_size = "100 ml" even for 500ml cans
            const servingQty = parseFloat(p.serving_quantity) || 0;
            const productQty = parseFloat(p.product_quantity) || parseFloat(p.quantity) || 0;
            // If serving < product, scale _serving values up to full product
            // If serving == product or no product_quantity, use _serving as-is
            // Fall back to _100g scaled by product_quantity/100 if no _serving
            let scale = 1;
            let useServing = !!(n['energy-kcal_serving'] || n.proteins_serving || n.carbohydrates_serving);
            if (useServing && servingQty > 0 && productQty > 0 && productQty > servingQty * 1.5) {
                // serving is smaller than full product (e.g. 100ml serving for 500ml can)
                scale = productQty / servingQty;
            } else if (!useServing && productQty > 0) {
                // No _serving data, scale _100g to full product
                scale = productQty / 100;
            }

            const kcalRaw = useServing ? (n['energy-kcal_serving'] || 0) : (n['energy-kcal_100g'] || 0);
            const proteinRaw = useServing ? (n.proteins_serving || 0) : (n.proteins_100g || 0);
            const carbsRaw = useServing ? (n.carbohydrates_serving || 0) : (n.carbohydrates_100g || 0);
            const fatRaw = useServing ? (n.fat_serving || 0) : (n.fat_100g || 0);
            const fiberRaw = useServing ? (n.fiber_serving || 0) : (n.fiber_100g || 0);
            const sugarRaw = useServing ? (n.sugars_serving || 0) : (n.sugars_100g || 0);
            const sodiumRaw = useServing ? (n.sodium_serving || 0) : (n.sodium_100g || 0);
            const caffRaw = useServing ? (n.caffeine_serving || 0) : (n.caffeine_100g || 0);

            const servingLabel = (productQty > 0 && scale > 1.5)
                ? `${productQty}${p.product_quantity_unit || 'ml'}`
                : (p.serving_size || '');

            const result = {
                name: p.product_name || p.product_name_en || 'Unknown',
                brand: p.brands || '',
                serving_size: servingLabel,
                calories: Math.round(kcalRaw * scale),
                protein_g: Math.round(proteinRaw * scale * 10) / 10,
                carbs_g: Math.round(carbsRaw * scale * 10) / 10,
                fat_g: Math.round(fatRaw * scale * 10) / 10,
                fiber_g: Math.round(fiberRaw * scale * 10) / 10,
                sugar_g: Math.round(sugarRaw * scale * 10) / 10,
                sodium_mg: Math.round(sodiumRaw * scale * 1000),
                caffeine_mg: Math.round(caffRaw * scale),
                barcode,
                source: 'openfoodfacts'
            };

            // Cache in branded_foods
            try {
                await query(
                    `INSERT INTO branded_foods (brand, product, serving_size, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg, barcode, category)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'scanned')
                     ON CONFLICT (brand, product) DO UPDATE SET barcode = EXCLUDED.barcode`,
                    [result.brand || 'Unknown', result.name, result.serving_size, result.calories, result.protein_g, result.carbs_g, result.fat_g, result.fiber_g, result.sugar_g, result.sodium_mg, result.caffeine_mg, barcode]
                );
            } catch (_) {}

            return result;
        } catch (err) {
            logger.warn('Barcode lookup failed', { barcode, error: err.message });
            return { error: 'Barcode lookup failed', barcode };
        }
    }

    // ─── Saved Meals ────────────────────────────────────
    async getSavedMeals(userId) {
        const result = await query(
            `SELECT meal_id, name, meal_type, items, total_calories, total_protein, usage_count, last_used, created_at
             FROM v3_saved_meals WHERE user_id = $1 ORDER BY usage_count DESC, created_at DESC`,
            [userId]
        );
        return result.rows;
    }

    async saveMeal(userId, { name, meal_type, items }) {
        let totalCal = 0, totalPro = 0;
        for (const item of items) {
            totalCal += Math.round(item.calories || 0);
            totalPro += Math.round((item.protein_g || 0) * 10) / 10;
        }
        const result = await query(
            `INSERT INTO v3_saved_meals (user_id, name, meal_type, items, total_calories, total_protein)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [userId, name, meal_type || null, JSON.stringify(items), totalCal, totalPro]
        );
        return result.rows[0];
    }

    async logSavedMeal(userId, mealId, date) {
        const meal = await query(`SELECT * FROM v3_saved_meals WHERE meal_id = $1 AND user_id = $2`, [mealId, userId]);
        if (meal.rows.length === 0) throw new Error('Saved meal not found');

        const items = meal.rows[0].items;
        const entries = [];
        for (const item of items) {
            const entry = await this.addEntry(userId, {
                entry_type: item.entry_type || 'food',
                description: item.description,
                quantity: item.quantity || null,
                unit: item.unit || null,
                meal_type: item.meal_type || meal.rows[0].meal_type || 'other',
                entry_date: date || new Date().toISOString().split('T')[0]
            });
            entries.push(entry);
        }

        await query(
            `UPDATE v3_saved_meals SET usage_count = usage_count + 1, last_used = NOW() WHERE meal_id = $1`,
            [mealId]
        );

        return { logged: entries.length, meal_name: meal.rows[0].name };
    }

    async deleteSavedMeal(userId, mealId) {
        await query(`DELETE FROM v3_saved_meals WHERE meal_id = $1 AND user_id = $2`, [mealId, userId]);
    }

    async saveCurrentMeal(userId, name, mealType, date) {
        const targetDate = date || new Date().toISOString().split('T')[0];
        const entriesResult = await query(
            `SELECT e.description, e.entry_type, e.quantity, e.unit, e.meal_type,
                    i.calories, i.protein_g
             FROM v3_diet_entries e LEFT JOIN v3_diet_items i ON i.entry_id = e.entry_id
             WHERE e.user_id = $1 AND e.entry_date = $2 AND e.meal_type = $3`,
            [userId, targetDate, mealType]
        );
        if (entriesResult.rows.length === 0) throw new Error('No entries found for ' + mealType + ' on ' + targetDate);

        const items = entriesResult.rows.map(r => ({
            description: r.description,
            entry_type: r.entry_type,
            quantity: r.quantity,
            unit: r.unit,
            meal_type: r.meal_type,
            calories: r.calories || 0,
            protein_g: r.protein_g || 0
        }));

        return this.saveMeal(userId, { name, meal_type: mealType, items });
    }
}

module.exports = new DietService();
