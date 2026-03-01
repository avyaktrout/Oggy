/**
 * Diet Assessment Generator
 * Generates nutrition estimation practice questions for Oggy's diet training.
 * Sources questions from user diet entries, branded foods, and AI generation.
 *
 * Diet Training System
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../../shared/utils/db');
const logger = require('../../../shared/utils/logger');
const circuitBreakerRegistry = require('../../../shared/utils/circuitBreakerRegistry');
const { costGovernor } = require('../../../shared/middleware/costGovernor');
const providerResolver = require('../../../shared/providers/providerResolver');

// Configurable question source mix (percentages)
const SOURCE_MIX = {
    user_entries: 0.40,
    branded_foods: 0.30,
    ai_generated: 0.30
};

// Tolerance thresholds for evaluating answers
const TOLERANCE = {
    calories: 0.15,   // 15%
    protein_g: 0.20,  // 20%
    carbs_g: 0.25,    // 25%
    fat_g: 0.25       // 25%
};

// Intent → generator type mapping for focus-biased selection
const INTENT_GENERATOR_MAP = {
    'diet.estimate_nutrition': ['branded_foods', 'ai_generated'],
    'diet.log_entry_from_text': ['user_entries', 'ai_generated'],
    'diet.verify_with_user': ['user_entries'],
    'diet.categorize_food_type': ['branded_foods', 'ai_generated'],
    'diet.ask_clarifying_questions': ['ai_generated'],
    'diet.explain_nutrition_assumptions': ['ai_generated'],
};

class DietAssessmentGenerator {
    constructor() {
        this.openaiBreaker = circuitBreakerRegistry.getOrCreate('openai-api');
        this._focusSourceMix = null;
    }

    /**
     * Set focus intents to bias which generator types are used
     * @param {string[]} intentNames - e.g. ['diet.estimate_nutrition']
     * @param {object} [intentFocus] - Optional focus levels: { intent_name: 'low'|'medium'|'high' }
     */
    setFocusIntents(intentNames, intentFocus) {
        if (!intentNames || intentNames.length === 0) {
            this._focusSourceMix = null;
            return;
        }

        // Focus level weights: how much of the mix goes to preferred types
        const FOCUS_WEIGHTS = { low: 0.50, medium: 0.70, high: 0.90 };

        // Collect preferred generator types from intents, weighted by focus level
        const typeWeights = {};
        for (const name of intentNames) {
            const types = INTENT_GENERATOR_MAP[name];
            if (!types) continue;
            const focusLevel = (intentFocus && intentFocus[name]) || 'medium';
            const weight = FOCUS_WEIGHTS[focusLevel] || FOCUS_WEIGHTS.medium;
            for (const t of types) {
                typeWeights[t] = Math.max(typeWeights[t] || 0, weight);
            }
        }

        const preferred = Object.keys(typeWeights);
        if (preferred.length === 0) {
            this._focusSourceMix = null;
            return;
        }

        // Compute average focus weight across preferred types
        const avgWeight = preferred.reduce((sum, t) => sum + typeWeights[t], 0) / preferred.length;
        const remainderShare = 1 - avgWeight;

        // Build biased source mix
        const allTypes = ['user_entries', 'branded_foods', 'ai_generated'];
        const nonPreferred = allTypes.filter(t => !preferred.includes(t));
        const mix = {};
        const preferredShare = avgWeight / preferred.length;
        const otherShare = nonPreferred.length > 0 ? remainderShare / nonPreferred.length : 0;
        for (const t of preferred) mix[t] = preferredShare;
        for (const t of nonPreferred) mix[t] = otherShare;

        this._focusSourceMix = mix;
        logger.info('Diet generator focus mix set', { intents: intentNames, intentFocus, mix });
    }

    /**
     * Generate a single nutrition estimation practice question
     * @param {string} userId - User ID for personalized questions
     * @param {number} difficulty - Difficulty level 1-5
     * @returns {object} Practice question with expected nutrition
     */
    async generateQuestion(userId, difficulty = 3) {
        const rand = Math.random();
        let question = null;
        const mix = this._focusSourceMix || SOURCE_MIX;

        try {
            if (rand < mix.user_entries) {
                question = await this._generateFromUserEntries(userId, difficulty);
            } else if (rand < mix.user_entries + mix.branded_foods) {
                question = await this._generateFromBrandedFoods(difficulty);
            }

            // AI-generated fallback or primary
            if (!question) {
                question = await this._generateFromAI(userId, difficulty);
            }
        } catch (error) {
            logger.logError(error, {
                operation: 'dietAssessmentGenerator.generateQuestion',
                userId,
                difficulty
            });

            // Try AI generation as last resort
            if (!question) {
                try {
                    question = await this._generateFromAI(userId, difficulty);
                } catch (aiError) {
                    logger.logError(aiError, {
                        operation: 'dietAssessmentGenerator.generateQuestion.aiFallback',
                        userId
                    });
                    return null;
                }
            }
        }

        return question;
    }

    /**
     * Evaluate Oggy's nutrition estimate against the ground truth
     * @param {object} question - The practice question with expected_nutrition
     * @param {object} oggyAnswer - Oggy's estimated nutrition values
     * @returns {object} Evaluation result with correctness and per-nutrient errors
     */
    evaluateAnswer(question, oggyAnswer) {
        if (!question || !question.expected_nutrition || !oggyAnswer) {
            return { correct: false, errors: {}, reason: 'missing_data' };
        }

        const expected = question.expected_nutrition;

        const calError = this._percentError(oggyAnswer.calories, expected.calories);
        const proError = this._percentError(oggyAnswer.protein_g, expected.protein_g);
        const carbError = this._percentError(oggyAnswer.carbs_g, expected.carbs_g);
        const fatError = this._percentError(oggyAnswer.fat_g, expected.fat_g);

        const correct = (
            calError <= TOLERANCE.calories &&
            proError <= TOLERANCE.protein_g &&
            carbError <= TOLERANCE.carbs_g &&
            fatError <= TOLERANCE.fat_g
        );

        return {
            correct,
            errors: {
                cal_pct: Math.round(calError * 100),
                pro_pct: Math.round(proError * 100),
                carb_pct: Math.round(carbError * 100),
                fat_pct: Math.round(fatError * 100)
            }
        };
    }

    /**
     * Generate question from user's own diet entries
     * Prioritizes user-corrected entries for ground truth accuracy
     */
    async _generateFromUserEntries(userId, difficulty) {
        try {
            // Prioritize user_corrected source for better ground truth
            const result = await query(`
                SELECT i.name, i.calories, i.protein_g, i.carbs_g, i.fat_g,
                       i.fiber_g, i.sugar_g, i.sodium_mg, i.source,
                       e.description, e.quantity, e.unit
                FROM v3_diet_items i
                JOIN v3_diet_entries e ON i.entry_id = e.entry_id
                WHERE e.user_id = $1
                  AND i.calories IS NOT NULL
                  AND i.calories > 0
                ORDER BY
                    CASE WHEN i.source = 'user_corrected' THEN 0 ELSE 1 END,
                    RANDOM()
                LIMIT 1
            `, [userId]);

            if (result.rows.length === 0) {
                logger.debug('No user diet entries found, falling through', { userId });
                return null;
            }

            const row = result.rows[0];
            const foodDesc = row.description || row.name;

            return {
                question_id: uuidv4(),
                food_description: foodDesc,
                expected_nutrition: {
                    calories: parseFloat(row.calories) || 0,
                    protein_g: parseFloat(row.protein_g) || 0,
                    carbs_g: parseFloat(row.carbs_g) || 0,
                    fat_g: parseFloat(row.fat_g) || 0,
                    fiber_g: parseFloat(row.fiber_g) || 0,
                    sugar_g: parseFloat(row.sugar_g) || 0,
                    sodium_mg: parseFloat(row.sodium_mg) || 0
                },
                source: 'user_entry',
                difficulty
            };
        } catch (error) {
            logger.warn('Failed to generate from user entries', {
                userId,
                error: error.message
            });
            return null;
        }
    }

    /**
     * Generate question from the branded_foods table
     * These have definitive ground truth from nutritional labels
     */
    async _generateFromBrandedFoods(difficulty) {
        try {
            const result = await query(`
                SELECT brand, product, serving_size,
                       calories, protein_g, carbs_g, fat_g,
                       fiber_g, sugar_g, sodium_mg
                FROM branded_foods
                WHERE calories IS NOT NULL AND calories > 0
                ORDER BY RANDOM()
                LIMIT 1
            `);

            if (result.rows.length === 0) {
                logger.debug('No branded foods found, falling through');
                return null;
            }

            const row = result.rows[0];
            const servingInfo = row.serving_size
                ? ` (${row.serving_size})`
                : '';
            const foodDesc = `${row.brand} ${row.product}${servingInfo}`;

            return {
                question_id: uuidv4(),
                food_description: foodDesc,
                expected_nutrition: {
                    calories: parseFloat(row.calories) || 0,
                    protein_g: parseFloat(row.protein_g) || 0,
                    carbs_g: parseFloat(row.carbs_g) || 0,
                    fat_g: parseFloat(row.fat_g) || 0,
                    fiber_g: parseFloat(row.fiber_g) || 0,
                    sugar_g: parseFloat(row.sugar_g) || 0,
                    sodium_mg: parseFloat(row.sodium_mg) || 0
                },
                source: 'branded_foods',
                difficulty
            };
        } catch (error) {
            logger.warn('Failed to generate from branded foods', {
                error: error.message
            });
            return null;
        }
    }

    /**
     * Generate a novel food + nutrition question via AI
     * Uses providerResolver to call the model
     */
    async _generateFromAI(userId, difficulty) {
        const difficultyDescriptions = {
            1: 'Simple single food item (e.g., 1 medium banana, 1 large egg)',
            2: 'Common prepared food with clear portions (e.g., 6oz grilled chicken breast, 1 cup cooked white rice)',
            3: 'Multi-ingredient meal (e.g., chicken Caesar salad, turkey sandwich with cheese)',
            4: 'Restaurant-style meal with preparation variance (e.g., Olive Garden chicken alfredo, Chipotle burrito bowl)',
            5: 'Ambiguous description requiring estimation (e.g., "a big plate of pasta", "some fried chicken with sides")'
        };

        const difficultyDesc = difficultyDescriptions[Math.min(Math.max(difficulty, 1), 5)] || difficultyDescriptions[3];

        const prompt = `Generate a realistic food item or meal for nutrition estimation practice.

Difficulty level: ${difficulty}/5 - ${difficultyDesc}

Create ONE food item/meal with accurate nutritional values.

CRITICAL: Return ONLY valid JSON, no markdown, no explanation:
{
  "food_description": "detailed food description with portion size",
  "calories": <number>,
  "protein_g": <number>,
  "carbs_g": <number>,
  "fat_g": <number>,
  "fiber_g": <number>,
  "sugar_g": <number>,
  "sodium_mg": <number>,
  "reasoning": "brief note on why these values are accurate"
}`;

        try {
            await costGovernor.checkBudget(500);

            const resolved = await providerResolver.getAdapter(userId, 'oggy');

            const result = await this.openaiBreaker.execute(() =>
                resolved.adapter.chatCompletion({
                    model: resolved.model,
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a certified nutritionist. Generate realistic food items with accurate nutritional data based on USDA/branded food databases. Return JSON only.'
                        },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.8,
                    max_tokens: 400
                })
            );

            costGovernor.recordUsage(result.tokens_used || 300);

            const jsonStr = result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            const parsed = JSON.parse(jsonStr);

            return {
                question_id: uuidv4(),
                food_description: parsed.food_description,
                expected_nutrition: {
                    calories: parseFloat(parsed.calories) || 0,
                    protein_g: parseFloat(parsed.protein_g) || 0,
                    carbs_g: parseFloat(parsed.carbs_g) || 0,
                    fat_g: parseFloat(parsed.fat_g) || 0,
                    fiber_g: parseFloat(parsed.fiber_g) || 0,
                    sugar_g: parseFloat(parsed.sugar_g) || 0,
                    sodium_mg: parseFloat(parsed.sodium_mg) || 0
                },
                source: 'ai_generated',
                difficulty
            };
        } catch (error) {
            logger.logError(error, {
                operation: 'dietAssessmentGenerator._generateFromAI',
                userId,
                difficulty
            });
            return null;
        }
    }

    /**
     * Calculate percent error between estimated and actual values
     * Returns 0 if both are zero, handles division by zero gracefully
     */
    _percentError(estimated, actual) {
        const est = parseFloat(estimated) || 0;
        const act = parseFloat(actual) || 0;

        if (act === 0 && est === 0) return 0;
        if (act === 0) return est > 5 ? 1.0 : 0; // small tolerance for near-zero actuals

        return Math.abs(est - act) / act;
    }
}

// Per-user instance registry
const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new DietAssessmentGenerator());
    }
    return instances.get(userId);
}

module.exports = { getInstance, DietAssessmentGenerator };
