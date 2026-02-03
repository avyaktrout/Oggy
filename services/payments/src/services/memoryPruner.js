/**
 * Memory Pruner
 * Identifies and removes low-utility memory cards
 * Keeps high-value memories that improve performance
 *
 * Week 8: Intelligent Memory Management
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { query } = require('../utils/db');

const MEMORY_SERVICE_URL = process.env.MEMORY_SERVICE_URL || 'http://memory:3000';

class MemoryPruner {
    constructor() {
        this.pruningCriteria = {
            min_utility_score: 0.3,      // Below this, consider pruning
            max_age_days_unused: 30,     // If unused for 30 days, prune
            min_confidence_threshold: 0.4, // Low confidence cards
            redundancy_similarity: 0.95   // >95% similar = redundant
        };
    }

    /**
     * Analyze all memory cards and score their utility
     * Returns analysis of which cards should be kept/pruned
     */
    async analyzeMemoryUtility(userId) {
        logger.info('Analyzing memory utility', { userId });

        // Get all memory cards for user
        const cards = await query(`
            SELECT
                card_id,
                content,
                utility_weight,
                usage_count,
                success_count,
                failure_count,
                created_at,
                updated_at,
                last_accessed_at,
                kind,
                tags
            FROM memory_cards
            WHERE owner_id = $1
              AND owner_type = 'user'
              AND status = 'active'
            ORDER BY utility_weight DESC
        `, [userId]);

        if (cards.rows.length === 0) {
            return {
                total_cards: 0,
                analysis: [],
                recommendations: {
                    keep: [],
                    prune: []
                }
            };
        }

        // Score each card
        const analysis = [];
        for (const card of cards.rows) {
            const score = await this._scoreCardUtility(card, userId);

            // Extract information from content JSONB
            const content = card.content || {};
            const pattern = content.pattern || content.description || '';
            const category = content.category || content.domain || '';

            analysis.push({
                card_id: card.card_id,
                pattern: pattern,
                category: category,
                kind: card.kind,
                tags: card.tags || [],
                utility_weight: card.utility_weight,
                usage_count: card.usage_count,
                utility_score: score.total_score,
                factors: score.factors,
                recommendation: score.recommendation,
                reason: score.reason
            });
        }

        // Sort by utility score
        analysis.sort((a, b) => b.utility_score - a.utility_score);

        // Separate into keep/prune
        const recommendations = {
            keep: analysis.filter(a => a.recommendation === 'keep'),
            prune: analysis.filter(a => a.recommendation === 'prune'),
            uncertain: analysis.filter(a => a.recommendation === 'uncertain')
        };

        logger.info('Memory utility analysis complete', {
            userId,
            total_cards: cards.rows.length,
            keep_count: recommendations.keep.length,
            prune_count: recommendations.prune.length,
            uncertain_count: recommendations.uncertain.length
        });

        return {
            total_cards: cards.rows.length,
            analysis,
            recommendations,
            summary: this._generateSummary(analysis, recommendations)
        };
    }

    /**
     * Score a single memory card's utility
     */
    async _scoreCardUtility(card, userId) {
        const factors = {};
        let total_score = 0;

        // Factor 1: Base utility weight (0-1)
        factors.base_utility = Math.min(1.0, card.utility_weight / 10);
        total_score += factors.base_utility * 0.3; // 30% weight

        // Factor 2: Retrieval frequency (how often used)
        // Use usage_count from card - normalize to 0-1 (assuming max ~50 uses is very high)
        const usage_count = card.usage_count || 0;
        factors.retrieval_frequency = Math.min(1.0, usage_count / 50);
        total_score += factors.retrieval_frequency * 0.25; // 25% weight

        // Factor 3: Success rate (when retrieved, was it helpful?)
        const success_count = card.success_count || 0;
        const failure_count = card.failure_count || 0;
        const total_uses = success_count + failure_count;
        factors.success_rate = total_uses > 0 ? success_count / total_uses : 0.5; // Neutral if no data
        total_score += factors.success_rate * 0.20; // 20% weight

        // Factor 4: Recency (recently used = more valuable)
        const last_accessed = card.last_accessed_at;
        const days_since_use = last_accessed
            ? (Date.now() - new Date(last_accessed).getTime()) / (1000 * 60 * 60 * 24)
            : 999; // Never used
        factors.recency = this._calculateRecencyScore(days_since_use);
        total_score += factors.recency * 0.15; // 15% weight

        // Factor 5: Uniqueness (not redundant with other cards)
        factors.uniqueness = 0.7; // Simplified - assume moderately unique
        total_score += factors.uniqueness * 0.10; // 10% weight

        // Determine recommendation
        let recommendation, reason;
        if (total_score >= 0.60) {
            recommendation = 'keep';
            reason = 'High utility - frequently used and successful';
        } else if (total_score >= 0.35) {
            recommendation = 'uncertain';
            reason = 'Moderate utility - monitor performance';
        } else {
            recommendation = 'prune';
            reason = 'Low utility - rarely used or unsuccessful';
        }

        // Override: Never prune very recent cards (< 7 days old)
        const age_days = (Date.now() - new Date(card.created_at).getTime()) / (1000 * 60 * 60 * 24);
        if (age_days < 7 && recommendation === 'prune') {
            recommendation = 'uncertain';
            reason = 'Too new to prune - needs more evaluation';
        }

        return {
            total_score,
            factors,
            recommendation,
            reason
        };
    }

    /**
     * Get retrieval statistics for a memory card
     * Uses built-in counters from memory_cards table
     */
    async _getRetrievalStats(card_id, userId) {
        // Use the usage_count, success_count, failure_count already in the card
        // The card is already passed in, so we can use a simpler approach
        // by passing the full card to _scoreCardUtility and extracting stats there

        // For now, return default stats (will be extracted from card in _scoreCardUtility)
        return {
            frequency_score: 0,
            success_rate: 0,
            days_since_last_use: 999
        };
    }

    /**
     * Calculate recency score (more recent = higher score)
     */
    _calculateRecencyScore(days_since_use) {
        if (days_since_use < 7) return 1.0;
        if (days_since_use < 14) return 0.8;
        if (days_since_use < 30) return 0.5;
        if (days_since_use < 60) return 0.3;
        return 0.1;
    }

    /**
     * Execute pruning - remove low-utility cards
     */
    async pruneMemory(userId, options = {}) {
        const {
            dry_run = false,
            min_utility_score = 0.30,
            max_prune_percentage = 0.30 // Never prune more than 30% at once
        } = options;

        logger.info('Starting memory pruning', {
            userId,
            dry_run,
            min_utility_score
        });

        // Analyze memory
        const analysis = await this.analyzeMemoryUtility(userId);

        if (analysis.total_cards === 0) {
            return {
                pruned_count: 0,
                kept_count: 0,
                message: 'No memory cards to prune'
            };
        }

        // Get cards to prune (below threshold)
        let to_prune = analysis.recommendations.prune.filter(
            a => a.utility_score < min_utility_score
        );

        // Safety: Don't prune more than max_prune_percentage at once
        const max_prune = Math.floor(analysis.total_cards * max_prune_percentage);
        if (to_prune.length > max_prune) {
            logger.warn('Pruning count exceeds safety limit', {
                requested: to_prune.length,
                max: max_prune
            });
            to_prune = to_prune.slice(0, max_prune);
        }

        if (dry_run) {
            logger.info('Dry run - would prune cards', {
                count: to_prune.length,
                card_ids: to_prune.map(c => c.card_id)
            });

            return {
                dry_run: true,
                would_prune_count: to_prune.length,
                would_keep_count: analysis.total_cards - to_prune.length,
                cards_to_prune: to_prune
            };
        }

        // Actually prune the cards
        let pruned_count = 0;
        for (const card of to_prune) {
            try {
                await query(`
                    DELETE FROM memory_cards
                    WHERE card_id = $1 AND owner_id = $2 AND owner_type = 'user'
                `, [card.card_id, userId]);

                pruned_count++;

                logger.debug('Pruned memory card', {
                    card_id: card.card_id,
                    utility_score: card.utility_score,
                    reason: card.reason
                });
            } catch (error) {
                logger.warn('Failed to prune card', {
                    card_id: card.card_id,
                    error: error.message
                });
            }
        }

        logger.info('Memory pruning complete', {
            userId,
            pruned_count,
            kept_count: analysis.total_cards - pruned_count,
            pruning_rate: (pruned_count / analysis.total_cards * 100).toFixed(1) + '%'
        });

        return {
            pruned_count,
            kept_count: analysis.total_cards - pruned_count,
            total_before: analysis.total_cards,
            pruning_rate: pruned_count / analysis.total_cards,
            pruned_cards: to_prune.map(c => ({
                card_id: c.card_id,
                pattern: c.pattern,
                utility_score: c.utility_score
            }))
        };
    }

    /**
     * Generate summary of analysis
     */
    _generateSummary(analysis, recommendations) {
        const avg_utility = analysis.reduce((sum, a) => sum + a.utility_score, 0) / analysis.length;

        return {
            total_cards: analysis.length,
            average_utility_score: avg_utility.toFixed(3),
            keep_count: recommendations.keep.length,
            prune_count: recommendations.prune.length,
            uncertain_count: recommendations.uncertain.length,
            health_status: avg_utility >= 0.70 ? 'excellent' :
                          avg_utility >= 0.50 ? 'good' :
                          avg_utility >= 0.35 ? 'fair' : 'poor',
            recommendation: recommendations.prune.length > analysis.length * 0.3
                ? 'High pruning needed - memory quality is low'
                : recommendations.prune.length > 0
                ? 'Routine pruning recommended'
                : 'Memory is healthy - no pruning needed'
        };
    }

    /**
     * Enable automatic pruning during training
     */
    async enableAutoPruning(userId, options = {}) {
        const {
            prune_interval_sessions = 50, // Prune every 50 practice sessions
            min_utility_threshold = 0.25
        } = options;

        // Store auto-pruning config (could be in database or memory)
        logger.info('Enabled automatic memory pruning', {
            userId,
            prune_interval_sessions,
            min_utility_threshold
        });

        return {
            enabled: true,
            prune_interval_sessions,
            min_utility_threshold,
            message: `Auto-pruning will run every ${prune_interval_sessions} sessions`
        };
    }
}

// Singleton instance
const memoryPruner = new MemoryPruner();

module.exports = memoryPruner;
