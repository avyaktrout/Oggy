/**
 * USDA FoodData Central API Client
 * Provides nutrition lookup for 380,000+ foods with lab-verified data.
 * Free API: 1,000 requests/hour.
 */

const axios = require('axios');
const { query } = require('../utils/db');
const logger = require('../utils/logger');
const circuitBreakerRegistry = require('../utils/circuitBreakerRegistry');

const BASE_URL = 'https://api.nal.usda.gov/fdc/v1';

// USDA nutrient IDs → our schema field names
const NUTRIENT_MAP = {
    1008: 'calories',        // Energy (kcal)
    1003: 'protein_g',       // Protein
    1004: 'fat_g',           // Total lipid (fat)
    1005: 'carbs_g',         // Carbohydrate
    1079: 'fiber_g',         // Fiber, total dietary
    2000: 'sugar_g',         // Sugars, total
    1093: 'sodium_mg',       // Sodium (already in mg)
    1057: 'caffeine_mg',     // Caffeine
    1258: 'saturated_fat_g', // Fatty acids, total saturated
};

class UsdaService {
    constructor() {
        this.apiKey = process.env.USDA_API_KEY;
        this.breaker = circuitBreakerRegistry.getOrCreate('usda-api', {
            failureThreshold: 3,
            timeout: 60000
        });
        // In-memory cache: query → { data, ts }
        this.cache = new Map();
        this.CACHE_MAX = 500;
        this.CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
    }

    /**
     * Look up nutrition for a food description.
     * Checks: in-memory cache → DB cache → USDA API
     * Returns nutrition object or null if no good match.
     */
    async lookup(description) {
        if (!this.apiKey) {
            logger.debug('USDA API key not configured, skipping');
            return null;
        }

        const cacheKey = description.toLowerCase().trim();

        // 1. In-memory cache
        const memCached = this.cache.get(cacheKey);
        if (memCached && (Date.now() - memCached.ts) < this.CACHE_TTL) {
            logger.debug('USDA in-memory cache hit: ' + description);
            return memCached.data;
        }

        // 2. DB cache
        try {
            const dbResult = await query(
                `SELECT calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg,
                        saturated_fat_g, unsaturated_fat_g, food_name, serving_size_g
                 FROM usda_nutrition_cache
                 WHERE query_key = $1 AND cached_at > NOW() - INTERVAL '30 days'`,
                [cacheKey]
            );
            if (dbResult.rows.length > 0) {
                const row = dbResult.rows[0];
                const foodName = row.food_name;
                // Restore _servingSizeG from DB cache
                if (row.serving_size_g) row._servingSizeG = row.serving_size_g;
                delete row.serving_size_g;
                delete row.food_name;
                logger.debug('USDA DB cache hit: ' + description, { matched: foodName });
                this._memCache(cacheKey, row);
                return row;
            }
        } catch (err) {
            // Table may not exist yet — ignore
            logger.debug('USDA DB cache check failed', { error: err.message });
        }

        // 3. USDA API
        return this._searchAndMatch(description, cacheKey);
    }

    async _searchAndMatch(description, cacheKey) {
        try {
            const foods = await this.breaker.execute(() => this._callApi(description));
            if (!foods || foods.length === 0) return null;

            const queryTerms = description.toLowerCase().split(/\s+/).filter(w => w.length > 2);
            const scored = foods
                .map(f => ({ food: f, score: this._scoreMatch(f, queryTerms) }))
                .sort((a, b) => b.score - a.score);

            // Require minimum score AND that at least half of query terms match
            const bestWordMatches = queryTerms.filter(term => (scored[0].food.description || '').toLowerCase().includes(term)).length;
            const minWordMatches = Math.ceil(queryTerms.length / 2);
            if (scored[0].score < 2 || bestWordMatches < minWordMatches) {
                logger.info('USDA no good match', { query: description, bestScore: scored[0].score, bestName: scored[0].food.description, wordMatches: bestWordMatches, required: minWordMatches });
                return null;
            }

            const best = scored[0].food;
            const nutrition = this._extractNutrition(best);

            logger.info('USDA match', {
                query: description,
                matched: best.description,
                dataType: best.dataType,
                score: scored[0].score,
                calories: nutrition.calories
            });

            // Cache result
            this._memCache(cacheKey, nutrition);
            this._dbCache(cacheKey, best.fdcId, best.description, nutrition);

            return nutrition;
        } catch (err) {
            logger.debug('USDA lookup failed', { error: err.message, description });
            return null;
        }
    }

    async _callApi(searchQuery) {
        const response = await axios.get(`${BASE_URL}/foods/search`, {
            params: {
                api_key: this.apiKey,
                query: searchQuery,
                pageSize: 5,
                dataType: ['Foundation', 'SR Legacy', 'Survey (FNDDS)', 'Branded'].join(','),
            },
            timeout: 5000,
            headers: { 'User-Agent': 'Oggy-Diet-Tracker/1.0' }
        });
        return response.data?.foods || [];
    }

    _extractNutrition(food) {
        const nutrients = {};
        for (const fn of (food.foodNutrients || [])) {
            const id = fn.nutrientId || fn.nutrient?.id;
            const field = NUTRIENT_MAP[id];
            if (field) {
                nutrients[field] = fn.value ?? fn.amount ?? 0;
            }
        }

        // Calculate calories from macros if not provided (common for Foundation foods)
        let calories = nutrients.calories || 0;
        if (!calories && (nutrients.protein_g || nutrients.carbs_g || nutrients.fat_g)) {
            calories = (nutrients.protein_g || 0) * 4 + (nutrients.carbs_g || 0) * 4 + (nutrients.fat_g || 0) * 9;
        }

        const result = {
            calories: Math.round(calories),
            protein_g: Math.round((nutrients.protein_g || 0) * 10) / 10,
            carbs_g: Math.round((nutrients.carbs_g || 0) * 10) / 10,
            fat_g: Math.round((nutrients.fat_g || 0) * 10) / 10,
            saturated_fat_g: Math.round((nutrients.saturated_fat_g || 0) * 10) / 10,
            unsaturated_fat_g: null,
            fiber_g: Math.round((nutrients.fiber_g || 0) * 10) / 10,
            sugar_g: Math.round((nutrients.sugar_g || 0) * 10) / 10,
            sodium_mg: Math.round(nutrients.sodium_mg || 0),
            caffeine_mg: Math.round(nutrients.caffeine_mg || 0),
        };

        // Calculate unsaturated fat
        if (result.fat_g > 0 && result.saturated_fat_g != null) {
            result.unsaturated_fat_g = Math.round(Math.max(0, result.fat_g - result.saturated_fat_g) * 10) / 10;
        }

        // Attach USDA serving size for scaling (available on Branded/Survey foods)
        if (food.servingSize && food.servingSize > 0) {
            const servUnit = (food.servingSizeUnit || '').toLowerCase();
            // Convert to grams
            if (servUnit === 'g' || servUnit === 'grams' || servUnit === 'gram' || !servUnit) {
                result._servingSizeG = food.servingSize;
            } else if (servUnit === 'ml' || servUnit === 'milliliter') {
                result._servingSizeG = food.servingSize; // ~1:1 for most beverages
            } else if (servUnit === 'oz') {
                result._servingSizeG = food.servingSize * 28.35;
            }
        }

        // Also capture household serving text (e.g. "1 cup", "1 medium")
        if (food.householdServingFullText) {
            result._householdServing = food.householdServingFullText;
        }

        return result;
    }

    _scoreMatch(food, queryTerms) {
        const foodDesc = (food.description || '').toLowerCase();
        const foodWords = foodDesc.split(/[\s,]+/).filter(w => w.length > 1);
        const queryStr = queryTerms.join(' ');

        // Word overlap score
        let score = queryTerms.filter(term => foodDesc.includes(term)).length;

        // Bonus for preferred data types (more reliable)
        if (food.dataType === 'Foundation') score += 1.5;
        else if (food.dataType === 'SR Legacy') score += 1;
        else if (food.dataType === 'Survey (FNDDS)') score += 0.5;

        // Penalty for missing calories (but not for Foundation foods — they often omit energy in search)
        const hasCals = (food.foodNutrients || []).some(n =>
            (n.nutrientId === 1008 || n.nutrient?.id === 1008) && (n.value || n.amount) > 0
        );
        const hasMacros = (food.foodNutrients || []).some(n =>
            (n.nutrientId === 1003 || n.nutrient?.id === 1003) && (n.value || n.amount) > 0
        );
        if (!hasCals && !hasMacros) score -= 2;

        // Penalty for processing qualifiers not in query (dehydrated, powder, dried, canned, frozen, etc.)
        const processedTerms = ['dehydrated', 'powder', 'dried', 'canned', 'frozen', 'concentrate', 'juice', 'pickled', 'smoked', 'fried', 'flakes'];
        for (const term of processedTerms) {
            if (foodDesc.includes(term) && !queryStr.includes(term)) {
                score -= 2;
            }
        }

        // Bonus for "raw" when query is a simple whole food (user likely means raw)
        if (foodDesc.includes('raw') && queryTerms.length <= 2 && !queryStr.includes('cooked')) {
            score += 1;
        }

        // Bonus for close length match (avoids overly generic results)
        const lengthRatio = Math.min(queryTerms.length, foodWords.length) / Math.max(queryTerms.length, foodWords.length);
        score += lengthRatio * 0.5;

        return score;
    }

    /**
     * Scale nutrition from per-100g to actual quantity.
     * Uses USDA serving size when available for non-weight units.
     */
    scaleByQuantity(nutrition, quantity, unit) {
        if (!quantity || !unit) {
            // No quantity/unit — use USDA serving size if available
            if (nutrition._servingSizeG && nutrition._servingSizeG > 0) {
                const factor = nutrition._servingSizeG / 100;
                logger.debug('Scaling by USDA serving size (no qty)', { servingSizeG: nutrition._servingSizeG });
                return this._applyFactor(nutrition, factor);
            }
            return nutrition;
        }

        let grams;
        const u = (unit || '').toLowerCase();
        if (u === 'g' || u === 'grams' || u === 'gram') {
            grams = quantity;
        } else if (u === 'oz' || u === 'ounce' || u === 'ounces') {
            grams = quantity * 28.35;
        } else if (u === 'lb' || u === 'lbs' || u === 'pound' || u === 'pounds') {
            grams = quantity * 453.6;
        } else if (u === 'kg' || u === 'kilogram' || u === 'kilograms') {
            grams = quantity * 1000;
        } else {
            // 'serving', 'piece', 'cup', etc. — use USDA serving size if available
            if (nutrition._servingSizeG && nutrition._servingSizeG > 0) {
                grams = nutrition._servingSizeG * quantity;
                logger.debug('Scaling by USDA serving size', { unit: u, quantity, servingSizeG: nutrition._servingSizeG, totalGrams: grams });
            } else {
                // No USDA serving size — return as-is (per 100g)
                return nutrition;
            }
        }

        const factor = grams / 100;
        return this._applyFactor(nutrition, factor);
    }

    _applyFactor(nutrition, factor) {
        return {
            calories: Math.round(nutrition.calories * factor),
            protein_g: Math.round(nutrition.protein_g * factor * 10) / 10,
            carbs_g: Math.round(nutrition.carbs_g * factor * 10) / 10,
            fat_g: Math.round(nutrition.fat_g * factor * 10) / 10,
            saturated_fat_g: nutrition.saturated_fat_g != null ? Math.round(nutrition.saturated_fat_g * factor * 10) / 10 : null,
            unsaturated_fat_g: nutrition.unsaturated_fat_g != null ? Math.round(nutrition.unsaturated_fat_g * factor * 10) / 10 : null,
            fiber_g: Math.round(nutrition.fiber_g * factor * 10) / 10,
            sugar_g: Math.round(nutrition.sugar_g * factor * 10) / 10,
            sodium_mg: Math.round(nutrition.sodium_mg * factor),
            caffeine_mg: Math.round(nutrition.caffeine_mg * factor),
        };
    }

    _memCache(key, data) {
        // Evict oldest if full
        if (this.cache.size >= this.CACHE_MAX) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, { data, ts: Date.now() });
    }

    /**
     * Lightweight search for autocomplete — returns top results with name + calories only.
     * Does NOT cache results (used for search suggestions, not nutrition analysis).
     */
    async search(searchQuery) {
        if (!this.apiKey) return [];
        try {
            const foods = await this.breaker.execute(() => this._callApi(searchQuery));
            if (!foods || foods.length === 0) return [];
            return foods.slice(0, 3).map(f => {
                const cals = (f.foodNutrients || []).find(n =>
                    (n.nutrientId === 1008 || n.nutrient?.id === 1008)
                );
                return {
                    description: f.description,
                    calories: Math.round((cals?.value ?? cals?.amount) || 0),
                    dataType: f.dataType
                };
            });
        } catch (err) {
            logger.debug('USDA search failed', { error: err.message });
            return [];
        }
    }

    async _dbCache(key, fdcId, foodName, nutrition) {
        try {
            await query(
                `INSERT INTO usda_nutrition_cache (query_key, fdc_id, food_name, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, caffeine_mg, saturated_fat_g, unsaturated_fat_g, serving_size_g)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 ON CONFLICT (query_key) DO UPDATE SET
                    fdc_id = EXCLUDED.fdc_id, food_name = EXCLUDED.food_name,
                    calories = EXCLUDED.calories, protein_g = EXCLUDED.protein_g,
                    carbs_g = EXCLUDED.carbs_g, fat_g = EXCLUDED.fat_g,
                    fiber_g = EXCLUDED.fiber_g, sugar_g = EXCLUDED.sugar_g,
                    sodium_mg = EXCLUDED.sodium_mg, caffeine_mg = EXCLUDED.caffeine_mg,
                    saturated_fat_g = EXCLUDED.saturated_fat_g, unsaturated_fat_g = EXCLUDED.unsaturated_fat_g,
                    serving_size_g = EXCLUDED.serving_size_g,
                    cached_at = NOW()`,
                [key, fdcId, foodName, nutrition.calories, nutrition.protein_g, nutrition.carbs_g,
                 nutrition.fat_g, nutrition.fiber_g, nutrition.sugar_g, nutrition.sodium_mg,
                 nutrition.caffeine_mg, nutrition.saturated_fat_g, nutrition.unsaturated_fat_g,
                 nutrition._servingSizeG || null]
            );
        } catch (err) {
            // Table may not exist yet — that's ok
            logger.debug('USDA DB cache write failed', { error: err.message });
        }
    }
}

module.exports = new UsdaService();
