/**
 * Weakness Analyzer
 * Analyzes Oggy's performance to identify weak categories
 * Enables self-directed, targeted learning
 *
 * Week 8: Self-Directed Weakness-Based Learning
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');

class WeaknessAnalyzer {
    constructor() {
        this.categories = [
            'business_meal',
            'groceries',
            'transportation',
            'utilities',
            'entertainment',
            'health',
            'dining',
            'shopping'
        ];

        // Actionable distinctions between commonly confused category pairs
        this.categoryDistinctions = {
            'dining:business_meal': {
                actual_indicators: 'dining = personal meals, social outings, dates, catching up with friends, casual meals with no work context',
                confused_indicators: 'business_meal = mentions client, meeting, team, conference, work lunch, networking, professional context',
                key_rule: 'If NO business/work/client/meeting context is mentioned, classify as dining. Only use business_meal when there is EXPLICIT work-related context.'
            },
            'business_meal:dining': {
                actual_indicators: 'business_meal = client dinners, team lunches, networking events, conference meals, meetings over food',
                confused_indicators: 'dining = personal meals, social occasions, dates, family dinners, casual eating out',
                key_rule: 'Look for keywords: client, meeting, team, work, conference, networking. Without these, use dining.'
            },
            'groceries:shopping': {
                actual_indicators: 'groceries = food items for home, supermarkets, grocery stores, produce, household consumables',
                confused_indicators: 'shopping = non-food retail, clothing, electronics, home goods, general merchandise',
                key_rule: 'If the purchase is primarily FOOD for home consumption, use groceries. Non-food items = shopping.'
            },
            'shopping:groceries': {
                actual_indicators: 'shopping = retail stores, clothing, electronics, non-food items, general merchandise',
                confused_indicators: 'groceries = food stores, supermarkets, food items for home',
                key_rule: 'Food from grocery stores = groceries. Everything else from retail = shopping.'
            },
            'entertainment:dining': {
                actual_indicators: 'entertainment = movies, concerts, streaming, gaming, sports events, leisure activities',
                confused_indicators: 'dining = restaurants, cafes, food service establishments',
                key_rule: 'Food service = dining. Non-food leisure activities = entertainment.'
            },
            'dining:entertainment': {
                actual_indicators: 'dining = restaurants, cafes, bars (food focus), coffee shops',
                confused_indicators: 'entertainment = venues where food is secondary (theaters, concerts, sports)',
                key_rule: 'Primary purpose eating/drinking = dining. Primary purpose activity with incidental food = entertainment.'
            },
            'transportation:utilities': {
                actual_indicators: 'transportation = gas, parking, tolls, rideshare, public transit, car-related',
                confused_indicators: 'utilities = monthly bills, home services, internet, phone, electric, water',
                key_rule: 'Travel/vehicle costs = transportation. Monthly home/phone bills = utilities.'
            },
            'health:personal_care': {
                actual_indicators: 'health = pharmacy, medical, doctor, gym, fitness, wellness treatments',
                confused_indicators: 'personal_care = salon, spa, haircut, grooming, cosmetic services',
                key_rule: 'Medical/fitness = health. Beauty/grooming services = personal_care.'
            }
        };
    }

    /**
     * Analyze performance from recent benchmark or sealed benchmark results
     * Identify which categories Oggy struggles with
     */
    async analyzeWeaknesses(options) {
        const {
            user_id,
            benchmark_id = null,
            result_id = null,
            lookback_hours = 24
        } = options;

        logger.info('Analyzing weaknesses', { user_id, benchmark_id, result_id });

        let detailed_results;

        if (result_id) {
            // Analyze specific sealed benchmark result
            detailed_results = await this._getSealedBenchmarkResults(result_id);
        } else if (benchmark_id) {
            // Analyze most recent test of this benchmark
            detailed_results = await this._getLatestBenchmarkResults(benchmark_id, user_id);
        } else {
            // Analyze recent practice sessions
            detailed_results = await this._getRecentPracticeResults(user_id, lookback_hours);
        }

        if (!detailed_results || detailed_results.length === 0) {
            return {
                weaknesses: [],
                message: 'No recent results to analyze',
                recommendation: 'Run a benchmark or practice session first'
            };
        }

        // Calculate per-category performance
        const category_performance = this._calculateCategoryPerformance(detailed_results);

        // Identify weaknesses (categories with <60% accuracy)
        const weaknesses = this._identifyWeaknesses(category_performance);

        // Generate learning recommendations
        const recommendations = this._generateRecommendations(weaknesses, category_performance);

        // Build confusion matrix to identify specific confusion patterns
        const confusion_matrix = this._buildConfusionMatrix(detailed_results);
        const confusion_patterns = this._identifyConfusionPatterns(confusion_matrix, weaknesses);

        logger.info('Weakness analysis complete', {
            user_id,
            weak_categories: weaknesses.map(w => w.category),
            confusion_patterns: confusion_patterns.map(p => `${p.actual}→${p.predicted}`),
            total_categories_analyzed: Object.keys(category_performance).length
        });

        return {
            category_performance,
            weaknesses,
            confusion_matrix,
            confusion_patterns,
            recommendations,
            analysis_summary: this._generateSummary(category_performance, weaknesses)
        };
    }

    /**
     * Get results from sealed benchmark test
     */
    async _getSealedBenchmarkResults(result_id) {
        const result = await query(`
            SELECT detailed_results
            FROM sealed_benchmark_results
            WHERE result_id = $1
        `, [result_id]);

        if (result.rows.length === 0) {
            return null;
        }

        const detailed = result.rows[0].detailed_results;
        return detailed.oggy || [];
    }

    /**
     * Get latest results for a specific benchmark
     */
    async _getLatestBenchmarkResults(benchmark_id, user_id) {
        const result = await query(`
            SELECT detailed_results
            FROM sealed_benchmark_results
            WHERE benchmark_id = $1 AND user_id = $2
            ORDER BY tested_at DESC
            LIMIT 1
        `, [benchmark_id, user_id]);

        if (result.rows.length === 0) {
            return null;
        }

        const detailed = result.rows[0].detailed_results;
        return detailed.oggy || [];
    }

    /**
     * Get recent practice session results
     */
    async _getRecentPracticeResults(user_id, lookback_hours) {
        // Get from app_events where Oggy practiced
        const result = await query(`
            SELECT event_data
            FROM app_events
            WHERE user_id = $1
              AND event_type = 'OGGY_SELF_PRACTICE'
              AND event_data->>'correct' IS NOT NULL
              AND event_data->>'expected_category' IS NOT NULL
              AND ts > NOW() - INTERVAL '${lookback_hours} hours'
            ORDER BY ts DESC
            LIMIT 500
        `, [user_id]);

        return result.rows.map(row => ({
            correct_category: row.event_data.expected_category,
            predicted_category: row.event_data.predicted_category,
            correct: row.event_data.correct
        }));
    }

    /**
     * Calculate per-category performance
     */
    _calculateCategoryPerformance(results) {
        const performance = {};

        for (const category of this.categories) {
            const category_results = results.filter(r => r.correct_category === category);

            if (category_results.length === 0) {
                continue;
            }

            const correct = category_results.filter(r => r.correct).length;
            const total = category_results.length;
            const accuracy = correct / total;

            performance[category] = {
                correct,
                total,
                accuracy,
                percentage: (accuracy * 100).toFixed(1)
            };
        }

        return performance;
    }

    /**
     * Identify weak categories (accuracy < 60%)
     */
    _identifyWeaknesses(category_performance) {
        const WEAKNESS_THRESHOLD = 0.60; // 60% accuracy

        const weaknesses = [];

        for (const [category, perf] of Object.entries(category_performance)) {
            if (perf.accuracy < WEAKNESS_THRESHOLD) {
                weaknesses.push({
                    category,
                    accuracy: perf.accuracy,
                    correct: perf.correct,
                    total: perf.total,
                    gap: WEAKNESS_THRESHOLD - perf.accuracy,
                    severity: this._calculateSeverity(perf.accuracy)
                });
            }
        }

        // Sort by severity (lowest accuracy first)
        weaknesses.sort((a, b) => a.accuracy - b.accuracy);

        return weaknesses;
    }

    /**
     * Calculate severity of weakness
     */
    _calculateSeverity(accuracy) {
        if (accuracy < 0.30) return 'critical';
        if (accuracy < 0.45) return 'severe';
        if (accuracy < 0.60) return 'moderate';
        return 'mild';
    }

    /**
     * Build confusion matrix from results
     * Shows which categories are being confused with which
     */
    _buildConfusionMatrix(results) {
        const matrix = {};

        // Initialize matrix
        for (const actual of this.categories) {
            matrix[actual] = {};
            for (const predicted of this.categories) {
                matrix[actual][predicted] = 0;
            }
        }

        // Populate matrix
        for (const result of results) {
            const actual = result.correct_category;
            const predicted = result.predicted_category;
            if (matrix[actual] && matrix[actual][predicted] !== undefined) {
                matrix[actual][predicted]++;
            }
        }

        return matrix;
    }

    /**
     * Identify specific confusion patterns from the matrix
     * Returns pairs of categories that are frequently confused
     */
    _identifyConfusionPatterns(confusion_matrix, weaknesses) {
        const patterns = [];
        const weak_categories = new Set(weaknesses.map(w => w.category));

        for (const actual of this.categories) {
            // Only analyze weak categories or categories with errors
            const row = confusion_matrix[actual];
            const total = Object.values(row).reduce((sum, v) => sum + v, 0);

            if (total === 0) continue;

            for (const predicted of this.categories) {
                if (actual === predicted) continue; // Skip correct predictions

                const confusion_count = row[predicted];
                if (confusion_count === 0) continue;

                const confusion_rate = confusion_count / total;

                // Include if significant confusion (>10% of that category)
                if (confusion_rate >= 0.10 || (weak_categories.has(actual) && confusion_count > 0)) {
                    // Get actionable distinction for this category pair
                    const distinction = this._getActionableDistinction(actual, predicted);

                    patterns.push({
                        actual,
                        predicted,
                        count: confusion_count,
                        total,
                        confusion_rate,
                        percentage: (confusion_rate * 100).toFixed(1),
                        severity: this._calculateConfusionSeverity(confusion_rate),
                        description: `${actual} misclassified as ${predicted}`,
                        training_focus: distinction.key_rule,
                        actual_indicators: distinction.actual_indicators,
                        confused_indicators: distinction.confused_indicators
                    });
                }
            }
        }

        // Sort by confusion count (most confused first)
        patterns.sort((a, b) => b.count - a.count);

        return patterns;
    }

    /**
     * Calculate severity of a confusion pattern
     */
    _calculateConfusionSeverity(confusion_rate) {
        if (confusion_rate >= 0.50) return 'critical';
        if (confusion_rate >= 0.30) return 'severe';
        if (confusion_rate >= 0.15) return 'moderate';
        return 'mild';
    }

    /**
     * Get actionable distinction for a category pair
     * Returns specific guidance on how to differentiate the categories
     */
    _getActionableDistinction(actual, predicted) {
        const key = `${actual}:${predicted}`;

        // Check if we have a predefined distinction
        if (this.categoryDistinctions[key]) {
            return this.categoryDistinctions[key];
        }

        // Generate a reasonable default
        return {
            actual_indicators: `${actual} = typical ${actual} transactions`,
            confused_indicators: `${predicted} = typical ${predicted} transactions`,
            key_rule: `When distinguishing ${actual} from ${predicted}: Look for specific context clues. ` +
                `${actual} should have clear ${actual}-related indicators. ` +
                `If the expense seems ambiguous, consider the PRIMARY purpose of the transaction.`
        };
    }

    /**
     * Generate learning recommendations
     */
    _generateRecommendations(weaknesses, category_performance) {
        if (weaknesses.length === 0) {
            return {
                priority: 'maintenance',
                message: 'No significant weaknesses detected. Continue balanced training.',
                focus_categories: [],
                training_mix: this._generateBalancedMix()
            };
        }

        // Focus on top 3 weakest categories
        const focus_categories = weaknesses.slice(0, 3).map(w => w.category);

        // Generate training mix weighted toward weak categories
        const training_mix = this._generateTargetedMix(weaknesses);

        return {
            priority: 'targeted',
            message: `Focus training on ${focus_categories.length} weak categories`,
            focus_categories,
            weaknesses,
            training_mix,
            estimated_improvement: this._estimateImprovement(weaknesses)
        };
    }

    /**
     * Generate balanced training mix (when no weaknesses)
     */
    _generateBalancedMix() {
        const mix = {};
        for (const category of this.categories) {
            mix[category] = 1 / this.categories.length; // Equal weight
        }
        return mix;
    }

    /**
     * Generate targeted training mix (focus on weaknesses)
     */
    _generateTargetedMix(weaknesses) {
        const mix = {};

        // Initialize all categories with small base weight
        for (const category of this.categories) {
            mix[category] = 0.05; // 5% minimum
        }

        // Distribute remaining 60% among weak categories
        const weak_categories = weaknesses.map(w => w.category);
        const weak_weight = 0.60 / weak_categories.length;

        for (const category of weak_categories) {
            mix[category] += weak_weight;
        }

        // Distribute remaining 35% evenly among all categories
        const remaining = 0.35 / this.categories.length;
        for (const category of this.categories) {
            mix[category] += remaining;
        }

        return mix;
    }

    /**
     * Estimate potential improvement from targeted training
     */
    _estimateImprovement(weaknesses) {
        if (weaknesses.length === 0) return null;

        const avg_weakness_accuracy = weaknesses.reduce((sum, w) => sum + w.accuracy, 0) / weaknesses.length;
        const potential_gain = (0.75 - avg_weakness_accuracy) * 100; // Target 75% accuracy

        return {
            current_avg_accuracy: (avg_weakness_accuracy * 100).toFixed(1) + '%',
            target_accuracy: '75.0%',
            potential_gain: potential_gain.toFixed(1) + ' percentage points',
            estimated_sessions: Math.ceil(potential_gain / 5) // ~5% gain per focused session
        };
    }

    /**
     * Generate human-readable summary
     */
    _generateSummary(category_performance, weaknesses) {
        const total_categories = Object.keys(category_performance).length;
        const avg_accuracy = Object.values(category_performance)
            .reduce((sum, p) => sum + p.accuracy, 0) / total_categories;

        return {
            total_categories_tested: total_categories,
            overall_accuracy: (avg_accuracy * 100).toFixed(1) + '%',
            weak_categories_count: weaknesses.length,
            strong_categories_count: total_categories - weaknesses.length,
            needs_focused_training: weaknesses.length > 0
        };
    }

    /**
     * Create targeted training plan based on weaknesses
     */
    async createTargetedTrainingPlan(analysis) {
        const { weaknesses, recommendations } = analysis;

        if (!recommendations || recommendations.priority === 'maintenance') {
            return {
                plan_type: 'balanced',
                message: 'No focused training needed - continue balanced practice',
                training_mix: recommendations.training_mix,
                sessions_recommended: 0
            };
        }

        const plan = {
            plan_type: 'targeted',
            focus_categories: recommendations.focus_categories,
            training_mix: recommendations.training_mix,
            sessions_recommended: recommendations.estimated_improvement?.estimated_sessions || 5,
            session_config: {
                interval: 10000, // 10 seconds
                practice_count: 10,
                use_targeted_generation: true,
                category_weights: recommendations.training_mix
            },
            expected_outcome: recommendations.estimated_improvement
        };

        logger.info('Created targeted training plan', {
            plan_type: plan.plan_type,
            focus_categories: plan.focus_categories,
            sessions: plan.sessions_recommended
        });

        return plan;
    }
}

// Singleton instance
const weaknessAnalyzer = new WeaknessAnalyzer();

module.exports = weaknessAnalyzer;
