/**
 * Adaptive Difficulty Scaler
 * 5-tiered difficulty system that scales with Oggy's performance
 *
 * The difficulty tiers are RELATIVE to Oggy's current skill level:
 * - As Oggy improves, the entire scale shifts upward
 * - If Oggy achieves 100% accuracy, system automatically scales harder
 * - Ensures continuous challenge and growth
 *
 * Week 8: Dynamic Difficulty Scaling
 */

const logger = require('../utils/logger');
const { query } = require('../utils/db');

/**
 * 5-Tier Difficulty System (Relative to Oggy's current level)
 */
const DIFFICULTY_TIERS = {
    TIER_1_WARMUP: {
        name: 'warmup',
        description: 'Comfort zone - reinforcement of mastered patterns',
        target_accuracy: 0.85,  // Expect 85%+ accuracy
        tier_level: 1
    },
    TIER_2_STANDARD: {
        name: 'standard',
        description: 'Learning zone - at current skill level',
        target_accuracy: 0.70,  // Expect 70-85% accuracy
        tier_level: 2
    },
    TIER_3_CHALLENGE: {
        name: 'challenge',
        description: 'Challenge zone - slightly above current level',
        target_accuracy: 0.55,  // Expect 55-70% accuracy
        tier_level: 3
    },
    TIER_4_EXPERT: {
        name: 'expert',
        description: 'Expert zone - significantly above current level',
        target_accuracy: 0.40,  // Expect 40-55% accuracy
        tier_level: 4
    },
    TIER_5_EXTREME: {
        name: 'extreme',
        description: 'Extreme zone - edge cases and highly ambiguous scenarios',
        target_accuracy: 0.25,  // Expect 25-40% accuracy
        tier_level: 5
    }
};

class AdaptiveDifficultyScaler {
    constructor() {
        // Global difficulty scale (0-100, default 50)
        this.baselineDifficultyScale = 50;

        // Performance tracking for scaling decisions
        this.performanceWindow = []; // Last 100 attempts
        this.lastScaleAdjustment = Date.now();

        // Scaling thresholds
        this.SCALE_UP_THRESHOLD = 0.92;      // If avg > 92%, increase baseline
        this.SCALE_DOWN_THRESHOLD = 0.50;    // If avg < 50%, decrease baseline
        this.MIN_SAMPLES_FOR_SCALING = 50;   // Need 50+ attempts before scaling
        this.SCALE_COOLDOWN_MS = 60000;      // Wait 1 min between scale adjustments
    }

    /**
     * Load baseline scale for a user from persistent state
     */
    async loadBaselineScale(userId) {
        if (!userId) {
            return this.baselineDifficultyScale;
        }

        try {
            await this._ensureStateTable();
            const result = await query(`
                SELECT baseline_scale
                FROM continuous_learning_state
                WHERE user_id = $1 AND domain = 'payments'
            `, [userId]);

            if (result.rows.length > 0 && result.rows[0].baseline_scale !== null) {
                const loaded = parseInt(result.rows[0].baseline_scale, 10);
                this.setBaselineScale(loaded);
            }
        } catch (error) {
            logger.debug('Failed to load baseline scale', { user_id: userId, error: error.message });
        }

        return this.baselineDifficultyScale;
    }

    /**
     * Set baseline scale with clamping
     */
    setBaselineScale(value) {
        const clamped = Math.max(0, Math.min(100, value));
        this.baselineDifficultyScale = clamped;
    }

    /**
     * Get current baseline scale
     */
    getBaselineScale() {
        return this.baselineDifficultyScale;
    }

    /**
     * Bump baseline scale for benchmark-driven upgrades
     */
    async bumpBaselineScale(userId, options = {}) {
        const {
            amount = 10,
            reason = 'benchmark'
        } = options;

        const oldScale = this.baselineDifficultyScale;
        const newScale = Math.max(0, Math.min(100, oldScale + amount));

        if (newScale === oldScale) {
            return this.baselineDifficultyScale;
        }

        this.baselineDifficultyScale = newScale;

        if (userId) {
            await this._saveBaselineScale(userId, newScale);
        }

        logger.info('Baseline difficulty scale increased', {
            user_id: userId,
            old_scale: oldScale,
            new_scale: newScale,
            reason
        });

        return this.baselineDifficultyScale;
    }

    /**
     * Get current difficulty tier based on Oggy's recent performance
     * Returns appropriate tier that will challenge but not frustrate
     */
    async selectDifficultyTier(recentAccuracy = [], userId = null) {
        // Update baseline scale if needed
        await this._updateBaselineScale(recentAccuracy, userId);

        // Calculate current performance level
        const avgAccuracy = this._calculateAverageAccuracy(recentAccuracy);

        logger.debug('Adaptive difficulty tier selection', {
            recent_accuracy: avgAccuracy,
            baseline_scale: this.baselineDifficultyScale,
            sample_size: recentAccuracy.length
        });

        // Select tier based on performance
        if (avgAccuracy >= 0.95) {
            // Crushing it - jump to extreme challenges
            return this._weightedTierSelection([
                { tier: DIFFICULTY_TIERS.TIER_4_EXPERT, weight: 0.3 },
                { tier: DIFFICULTY_TIERS.TIER_5_EXTREME, weight: 0.7 }
            ]);
        } else if (avgAccuracy >= 0.85) {
            // Doing very well - focus on expert/extreme
            return this._weightedTierSelection([
                { tier: DIFFICULTY_TIERS.TIER_3_CHALLENGE, weight: 0.2 },
                { tier: DIFFICULTY_TIERS.TIER_4_EXPERT, weight: 0.5 },
                { tier: DIFFICULTY_TIERS.TIER_5_EXTREME, weight: 0.3 }
            ]);
        } else if (avgAccuracy >= 0.70) {
            // Solid performance - progressive challenge
            return this._weightedTierSelection([
                { tier: DIFFICULTY_TIERS.TIER_2_STANDARD, weight: 0.2 },
                { tier: DIFFICULTY_TIERS.TIER_3_CHALLENGE, weight: 0.5 },
                { tier: DIFFICULTY_TIERS.TIER_4_EXPERT, weight: 0.3 }
            ]);
        } else if (avgAccuracy >= 0.55) {
            // Moderate performance - balanced mix
            return this._weightedTierSelection([
                { tier: DIFFICULTY_TIERS.TIER_1_WARMUP, weight: 0.2 },
                { tier: DIFFICULTY_TIERS.TIER_2_STANDARD, weight: 0.5 },
                { tier: DIFFICULTY_TIERS.TIER_3_CHALLENGE, weight: 0.3 }
            ]);
        } else {
            // Struggling - focus on fundamentals
            return this._weightedTierSelection([
                { tier: DIFFICULTY_TIERS.TIER_1_WARMUP, weight: 0.6 },
                { tier: DIFFICULTY_TIERS.TIER_2_STANDARD, weight: 0.4 }
            ]);
        }
    }

    /**
     * Get Tessa generation parameters for a given tier
     * These parameters scale with the baseline difficulty
     */
    getTessaParameters(tier) {
        const scale = this.baselineDifficultyScale;

        // Base complexity increases with scale
        const baseComplexity = Math.floor(scale / 20); // 0-5 range

        switch (tier.name) {
            case 'warmup':
                return {
                    complexity: Math.max(1, baseComplexity - 1),
                    ambiguity_level: 0.1 + (scale / 500), // 0.1-0.3
                    edge_case_probability: 0.05,
                    require_reasoning_depth: 'simple',
                    merchant_uniqueness: 'common',
                    description: 'Clear, obvious categorization with typical merchants'
                };

            case 'standard':
                return {
                    complexity: baseComplexity,
                    ambiguity_level: 0.2 + (scale / 250), // 0.2-0.4
                    edge_case_probability: 0.15,
                    require_reasoning_depth: 'moderate',
                    merchant_uniqueness: 'varied',
                    description: 'Realistic scenarios requiring standard categorization logic'
                };

            case 'challenge':
                return {
                    complexity: baseComplexity + 1,
                    ambiguity_level: 0.4 + (scale / 200), // 0.4-0.65
                    edge_case_probability: 0.35,
                    require_reasoning_depth: 'detailed',
                    merchant_uniqueness: 'diverse',
                    description: 'Ambiguous cases requiring careful reasoning and context'
                };

            case 'expert':
                return {
                    complexity: baseComplexity + 2,
                    ambiguity_level: 0.6 + (scale / 167), // 0.6-0.9
                    edge_case_probability: 0.60,
                    require_reasoning_depth: 'expert',
                    merchant_uniqueness: 'unusual',
                    description: 'Edge cases with high ambiguity, multiple valid interpretations'
                };

            case 'extreme':
                return {
                    complexity: Math.min(5, baseComplexity + 3),
                    ambiguity_level: 0.8 + (scale / 500), // 0.8-1.0
                    edge_case_probability: 0.85,
                    require_reasoning_depth: 'extreme',
                    merchant_uniqueness: 'highly_unusual',
                    description: 'Extremely difficult edge cases, highly ambiguous, requires expert judgment and deep reasoning'
                };

            default:
                return this.getTessaParameters(DIFFICULTY_TIERS.TIER_2_STANDARD);
        }
    }

    /**
     * Build enhanced Tessa prompt with tier-specific instructions
     */
    buildTessaPrompt(category, tier) {
        const params = this.getTessaParameters(tier);

        const complexityInstructions = {
            1: 'very straightforward and obvious',
            2: 'realistic with some nuance',
            3: 'moderately complex requiring careful thought',
            4: 'highly complex with multiple considerations',
            5: 'extremely complex edge case'
        };

        const ambiguityInstructions = params.ambiguity_level > 0.7
            ? '\n- Make this HIGHLY ambiguous - it could reasonably fit 2-3 categories, but one is most defensible with careful reasoning.'
            : params.ambiguity_level > 0.4
            ? '\n- Include some ambiguity - it might fit another category, but one is clearly better.'
            : '\n- Make the categorization relatively clear, though context still matters.';

        const edgeCaseNote = params.edge_case_probability > 0.5
            ? '\n- This should be an EDGE CASE - unusual merchant, atypical amount, or uncommon scenario.'
            : '';

        return `You are Tessa, an expert at generating expense categorization training scenarios of varying difficulty.

Generate a **${tier.description}** expense scenario that should be categorized as "${category}".

DIFFICULTY TIER: ${tier.name.toUpperCase()} (Level ${tier.tier_level}/5)
Current Difficulty Scale: ${this.baselineDifficultyScale}/100

Requirements:
- Complexity: ${complexityInstructions[params.complexity]} (${params.complexity}/5)
- Target accuracy: ${(tier.target_accuracy * 100).toFixed(0)}% (this should be challenging!)
- Merchant type: ${params.merchant_uniqueness}
- Reasoning depth: ${params.require_reasoning_depth}${ambiguityInstructions}${edgeCaseNote}
- Use realistic merchant name, amount, and description
- The expense MUST ultimately belong to category "${category}" when analyzed carefully
- For ${tier.name} tier, ${params.description}

Categories:
- business_meal: Client dinners, team lunches, work-related meals
- groceries: Supermarkets, food shopping for home
- transportation: Gas, Uber, parking, car expenses
- utilities: Electric, water, internet, phone bills
- entertainment: Movies, streaming, concerts, hobbies
- health: Gym, pharmacy, doctor, medical
- dining: Restaurants, cafes (personal, not business)
- shopping: Retail, online shopping, household items

Return ONLY a JSON object:
{
  "merchant": "Merchant Name",
  "amount": 45.50,
  "description": "Detailed transaction description",
  "category": "${category}",
  "reasoning": "Why this belongs in ${category} (${params.require_reasoning_depth} level explanation)",
  "difficulty_tier": "${tier.name}",
  "ambiguity_notes": "What makes this scenario challenging at tier ${tier.tier_level}"
}`;
    }

    /**
     * Update baseline difficulty scale based on long-term performance
     * This is the KEY to scaling difficulty as Oggy improves
     */
    async _updateBaselineScale(recentAccuracy, userId) {
        // Add recent attempts to performance window
        this.performanceWindow.push(...recentAccuracy);

        // Keep only last 100 attempts
        if (this.performanceWindow.length > 100) {
            this.performanceWindow = this.performanceWindow.slice(-100);
        }

        // Need enough samples and cooldown period passed
        if (this.performanceWindow.length < this.MIN_SAMPLES_FOR_SCALING) {
            return; // Not enough data yet
        }

        const timeSinceLastAdjustment = Date.now() - this.lastScaleAdjustment;
        if (timeSinceLastAdjustment < this.SCALE_COOLDOWN_MS) {
            return; // Too soon to adjust again
        }

        // Calculate long-term performance
        const longTermAccuracy = this._calculateAverageAccuracy(this.performanceWindow);

        logger.info('Evaluating baseline difficulty scale adjustment', {
            current_scale: this.baselineDifficultyScale,
            long_term_accuracy: longTermAccuracy,
            sample_size: this.performanceWindow.length
        });

        // Scale UP if performing exceptionally well
        if (longTermAccuracy >= this.SCALE_UP_THRESHOLD) {
            const oldScale = this.baselineDifficultyScale;
            this.baselineDifficultyScale = Math.min(100, this.baselineDifficultyScale + 10);
            this.lastScaleAdjustment = Date.now();

            logger.warn('🔥 SCALING UP DIFFICULTY - Oggy is dominating!', {
                old_scale: oldScale,
                new_scale: this.baselineDifficultyScale,
                long_term_accuracy: longTermAccuracy,
                reason: 'Sustained high performance detected'
            });

            // Record scaling event
            if (userId) {
                await this._recordScalingEvent(userId, 'scale_up', oldScale, this.baselineDifficultyScale, longTermAccuracy);
                await this._saveBaselineScale(userId, this.baselineDifficultyScale);
            }

            // Clear window to measure new baseline
            this.performanceWindow = [];
        }
        // Scale DOWN if struggling consistently
        else if (longTermAccuracy <= this.SCALE_DOWN_THRESHOLD) {
            const oldScale = this.baselineDifficultyScale;
            this.baselineDifficultyScale = Math.max(0, this.baselineDifficultyScale - 10);
            this.lastScaleAdjustment = Date.now();

            logger.warn('⚠️ SCALING DOWN DIFFICULTY - Oggy is struggling', {
                old_scale: oldScale,
                new_scale: this.baselineDifficultyScale,
                long_term_accuracy: longTermAccuracy,
                reason: 'Sustained low performance detected'
            });

            // Record scaling event
            if (userId) {
                await this._recordScalingEvent(userId, 'scale_down', oldScale, this.baselineDifficultyScale, longTermAccuracy);
                await this._saveBaselineScale(userId, this.baselineDifficultyScale);
            }

            // Clear window to measure new baseline
            this.performanceWindow = [];
        }
    }

    /**
     * Record difficulty scaling events for analysis
     */
    async _recordScalingEvent(userId, scalingAction, oldScale, newScale, triggerAccuracy) {
        try {
            await query(`
                INSERT INTO app_events (
                    event_id,
                    user_id,
                    event_type,
                    entity_type,
                    action,
                    event_data,
                    processed_for_domain_knowledge,
                    processed_for_memory_substrate
                ) VALUES (
                    gen_random_uuid(),
                    $1,
                    'DIFFICULTY_SCALE_ADJUSTED',
                    'pattern',
                    'update',
                    $2,
                    FALSE,
                    FALSE
                )
            `, [
                userId,
                JSON.stringify({
                    scaling_action: scalingAction,
                    old_scale: oldScale,
                    new_scale: newScale,
                    trigger_accuracy: triggerAccuracy,
                    timestamp: new Date().toISOString()
                })
            ]);
        } catch (error) {
            logger.warn('Failed to record scaling event', { error: error.message });
        }
    }

    async _saveBaselineScale(userId, baselineScale) {
        try {
            await this._ensureStateTable();
            await query(`
                INSERT INTO continuous_learning_state (user_id, domain, scale, difficulty_level, baseline_scale, updated_at)
                VALUES ($1, 'payments', 1, 3, $2, NOW())
                ON CONFLICT (user_id, domain)
                DO UPDATE SET baseline_scale = $2, updated_at = NOW()
            `, [userId, baselineScale]);
        } catch (error) {
            logger.debug('Failed to save baseline scale', { user_id: userId, error: error.message });
        }
    }

    async _ensureStateTable() {
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS continuous_learning_state (
                    user_id VARCHAR(255) NOT NULL,
                    domain TEXT NOT NULL DEFAULT 'payments',
                    scale INTEGER DEFAULT 1,
                    difficulty_level INTEGER DEFAULT 3,
                    baseline_scale INTEGER DEFAULT 50,
                    updated_at TIMESTAMP DEFAULT NOW(),
                    PRIMARY KEY (user_id, domain)
                )
            `);

            await query(`ALTER TABLE continuous_learning_state ADD COLUMN IF NOT EXISTS scale INTEGER DEFAULT 1`);
            await query(`ALTER TABLE continuous_learning_state ADD COLUMN IF NOT EXISTS difficulty_level INTEGER DEFAULT 3`);
            await query(`ALTER TABLE continuous_learning_state ADD COLUMN IF NOT EXISTS baseline_scale INTEGER DEFAULT 50`);
            await query(`ALTER TABLE continuous_learning_state ADD COLUMN IF NOT EXISTS domain TEXT DEFAULT 'payments'`);
        } catch (error) {
            logger.debug('Failed to ensure continuous_learning_state table', { error: error.message });
        }
    }

    /**
     * Weighted random tier selection
     */
    _weightedTierSelection(options) {
        const totalWeight = options.reduce((sum, opt) => sum + opt.weight, 0);
        let random = Math.random() * totalWeight;

        for (const option of options) {
            random -= option.weight;
            if (random <= 0) {
                return option.tier;
            }
        }

        // Fallback
        return options[0].tier;
    }

    /**
     * Calculate average accuracy from recent attempts
     */
    _calculateAverageAccuracy(recentAccuracy) {
        if (recentAccuracy.length === 0) return 0.5; // Default to 50%

        const sum = recentAccuracy.reduce((a, b) => a + b, 0);
        return sum / recentAccuracy.length;
    }

    /**
     * Get current difficulty scale info for monitoring
     */
    getScaleInfo() {
        return {
            baseline_scale: this.baselineDifficultyScale,
            performance_window_size: this.performanceWindow.length,
            long_term_accuracy: this._calculateAverageAccuracy(this.performanceWindow),
            time_since_last_adjustment: Date.now() - this.lastScaleAdjustment,
            scale_status: this.baselineDifficultyScale >= 75 ? 'extreme' :
                         this.baselineDifficultyScale >= 50 ? 'challenging' :
                         this.baselineDifficultyScale >= 25 ? 'moderate' : 'gentle'
        };
    }
}

// Per-user instance registry (replaces singleton for tenant isolation)
const instances = new Map();

function getInstance(userId) {
    if (!instances.has(userId)) {
        instances.set(userId, new AdaptiveDifficultyScaler());
    }
    return instances.get(userId);
}

module.exports = {
    getInstance,
    AdaptiveDifficultyScaler,
    DIFFICULTY_TIERS
};
