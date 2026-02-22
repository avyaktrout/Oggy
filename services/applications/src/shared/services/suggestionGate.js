/**
 * Suggestion Gate - Controls when Oggy can proactively suggest (vs clarify)
 * Behavior Design Doc v0.2
 *
 * Clarifications (uncategorized_expense, ambiguous_merchant) always pass through.
 * Suggestions (cost_cutting, spending_pattern) require opt-in + interval gate.
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');

class SuggestionGate {
    constructor(redisClient = null) {
        this.redis = redisClient;
    }

    setRedisClient(client) {
        this.redis = client;
    }

    /**
     * Check if a suggestion can be sent to the user right now.
     * Returns { allowed: true } or { allowed: false, reason: string }
     */
    async canSuggest(userId) {
        const settings = await this.getSettings(userId);

        if (!settings.receive_suggestions) {
            return { allowed: false, reason: 'suggestions_disabled' };
        }

        const lastAt = settings.last_suggestion_at;
        if (lastAt) {
            const elapsedMs = Date.now() - new Date(lastAt).getTime();
            const intervalMs = settings.suggestion_interval_seconds * 1000;
            if (elapsedMs < intervalMs) {
                const waitSec = Math.ceil((intervalMs - elapsedMs) / 1000);
                return { allowed: false, reason: 'interval_not_elapsed', wait_seconds: waitSec };
            }
        }

        return { allowed: true };
    }

    /**
     * Record that a suggestion was just emitted.
     */
    async recordSuggestion(userId) {
        const now = new Date().toISOString();

        await query(
            `INSERT INTO oggy_inquiry_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
            [userId]
        );
        await query(
            `UPDATE oggy_inquiry_preferences SET last_suggestion_at = $1 WHERE user_id = $2`,
            [now, userId]
        );

        if (this.redis) {
            try {
                const key = `suggest:${userId}:last`;
                await this.redis.set(key, now, { EX: 86400 });
            } catch (err) {
                logger.warn('Redis suggestion record failed', { error: err.message });
            }
        }

        await this._recordTelemetry(userId, 'suggestion_emitted', {});
    }

    /**
     * Reset the interval gate so next poll can generate immediately.
     * Called when user answers or dismisses a suggestion.
     */
    async resetInterval(userId) {
        await query(
            `UPDATE oggy_inquiry_preferences SET last_suggestion_at = NULL WHERE user_id = $1`,
            [userId]
        );

        if (this.redis) {
            try {
                await this.redis.del(`suggest:${userId}:last`);
                await this.redis.del(`suggest:${userId}:settings`);
            } catch (err) {
                logger.warn('Redis suggestion interval reset failed', { error: err.message });
            }
        }
    }

    /**
     * Record that a suggestion was suppressed (for analytics).
     */
    async recordSuppression(userId, reason) {
        await this._recordTelemetry(userId, 'suggestion_suppressed', { reason });
    }

    /**
     * Get suggestion settings for a user.
     */
    async getSettings(userId) {
        // Try Redis first
        if (this.redis) {
            try {
                const cached = await this.redis.get(`suggest:${userId}:settings`);
                if (cached) return JSON.parse(cached);
            } catch (err) {
                logger.warn('Redis suggestion settings read failed', { error: err.message });
            }
        }

        // Postgres fallback
        const result = await query(
            `SELECT receive_suggestions, suggestion_interval_seconds, last_suggestion_at
             FROM oggy_inquiry_preferences WHERE user_id = $1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return {
                receive_suggestions: true,
                suggestion_interval_seconds: 900,
                last_suggestion_at: null
            };
        }

        const settings = result.rows[0];

        // Cache in Redis
        if (this.redis) {
            try {
                await this.redis.set(
                    `suggest:${userId}:settings`,
                    JSON.stringify(settings),
                    { EX: 300 }
                );
            } catch (err) {
                logger.warn('Redis suggestion settings cache failed', { error: err.message });
            }
        }

        return settings;
    }

    /**
     * Update suggestion settings.
     */
    async updateSettings(userId, { receive_suggestions, suggestion_interval_seconds }) {
        // Ensure row exists
        await query(
            `INSERT INTO oggy_inquiry_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
            [userId]
        );

        await query(
            `UPDATE oggy_inquiry_preferences
             SET receive_suggestions = COALESCE($1, receive_suggestions),
                 suggestion_interval_seconds = COALESCE($2, suggestion_interval_seconds),
                 updated_at = now()
             WHERE user_id = $3`,
            [receive_suggestions, suggestion_interval_seconds, userId]
        );

        // Invalidate Redis cache
        if (this.redis) {
            try {
                await this.redis.del(`suggest:${userId}:settings`);
            } catch (err) {
                logger.warn('Redis suggestion settings invalidation failed', { error: err.message });
            }
        }

        await this._recordTelemetry(userId, 'settings_changed', {
            receive_suggestions, suggestion_interval_seconds
        });

        return this.getSettings(userId);
    }

    async _recordTelemetry(userId, eventType, metadata) {
        try {
            await query(
                `INSERT INTO suggestion_telemetry (user_id, event_type, metadata)
                 VALUES ($1, $2, $3::jsonb)`,
                [userId, eventType, JSON.stringify(metadata)]
            );
        } catch (err) {
            logger.warn('Suggestion telemetry write failed', { error: err.message });
        }
    }
}

const suggestionGate = new SuggestionGate();
module.exports = { suggestionGate, SuggestionGate };
