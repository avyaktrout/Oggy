/**
 * Preference Manager - Store Signals, Not Just Outcomes
 * Behavior Design Doc Sections 4, 5, 7
 *
 * Handles:
 * - Recording preference events (append-only)
 * - Computing preference profiles from events
 * - Time decay for weak signals (Section 7)
 * - Pinned preferences from explicit statements
 * - Redis hydration for fast scoring access
 */

const { query } = require('../utils/db');
const logger = require('../utils/logger');

const DECAY_HALF_LIFE_DAYS = 60; // Section 7: 30-90 day half-life
const PIN_KEYWORDS = ['always', 'never', 'from now on', 'don\'t ever', 'stop'];

class PreferenceManager {
    constructor(redisClient = null) {
        this.redis = redisClient;
    }

    /**
     * Record a preference event (Section 4.1)
     * Events are the immutable source of truth
     */
    async recordEvent(userId, { intent, target, value, strength = 0.5, sessionId = null, requestId = null, evidencePointer = {} }) {
        const pinned = this._detectPin(value);
        if (pinned) strength = 1.0;

        const result = await query(
            `INSERT INTO preference_events (user_id, session_id, request_id, intent, target, value, strength, pinned, evidence_pointer)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             RETURNING event_id, created_at`,
            [userId, sessionId, requestId, intent, target, value, strength, pinned, JSON.stringify(evidencePointer)]
        );

        logger.info('Preference event recorded', {
            event_id: result.rows[0].event_id,
            user_id: userId,
            intent, target, value, strength, pinned
        });

        // Update profile after recording event
        await this._updateProfile(userId);

        return result.rows[0];
    }

    /**
     * Get the current preference profile (Section 4.2)
     * Computes from events with time decay applied
     */
    async getProfile(userId) {
        // Try Redis first for fast access
        if (this.redis) {
            try {
                const cached = await this.redis.get(`pref:${userId}:profile`);
                if (cached) return JSON.parse(cached);
            } catch (err) {
                logger.warn('Redis preference read failed', { error: err.message });
            }
        }

        // Fall back to computing from Postgres
        return this._computeProfile(userId);
    }

    /**
     * Hydrate Redis from Postgres (Section 5)
     * Called at session start or after profile update
     */
    async hydrateRedis(userId) {
        if (!this.redis) return;

        try {
            const profile = await this._computeProfile(userId);
            await this.redis.set(`pref:${userId}:profile`, JSON.stringify(profile), { EX: 3600 });

            // Store recent event IDs
            const recent = await query(
                `SELECT event_id FROM preference_events
                 WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
                [userId]
            );
            const eventIds = recent.rows.map(r => r.event_id);
            await this.redis.set(`pref:${userId}:recent_events`, JSON.stringify(eventIds), { EX: 3600 });

            logger.info('Redis preference hydration complete', { user_id: userId });
        } catch (err) {
            logger.warn('Redis hydration failed', { error: err.message });
        }
    }

    /**
     * Reset non-pinned preferences (Section 7)
     * Clears weak signals while keeping explicit boundaries
     */
    async resetPreferences(userId) {
        // Mark non-pinned events as superseded (don't delete — append-only)
        const result = await query(
            `UPDATE preference_events
             SET strength = 0
             WHERE user_id = $1 AND pinned = FALSE AND strength > 0
             RETURNING event_id`,
            [userId]
        );

        logger.info('Preferences reset', {
            user_id: userId,
            events_zeroed: result.rows.length
        });

        await this._updateProfile(userId);
        return { reset_count: result.rows.length };
    }

    /**
     * Get all preference events for a user (for audit)
     */
    async getEvents(userId, limit = 50) {
        const result = await query(
            `SELECT * FROM preference_events
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [userId, limit]
        );
        return result.rows;
    }

    /**
     * Compute profile from events with time decay (Section 4.2 + 7)
     */
    async _computeProfile(userId) {
        const events = await query(
            `SELECT * FROM preference_events
             WHERE user_id = $1 AND strength > 0
             ORDER BY created_at DESC`,
            [userId]
        );

        const profile = {
            tone: {},
            humor: {},
            verbosity: {},
            formatting: {},
            topics: {},
            safety: {},
            other: {}
        };

        const humorParams = {
            avoid_sarcasm: false,
            prefer_light_teasing: false,
            avoid_dark_humor: true,
            keep_jokes_short: true,
            no_jokes_in_serious_topics: true
        };

        const pinnedPrefs = [];
        const now = Date.now();

        for (const event of events.rows) {
            const ageMs = now - new Date(event.created_at).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);

            // Apply time decay for non-pinned signals (Section 7)
            let effectiveStrength = event.strength;
            if (!event.pinned) {
                effectiveStrength *= Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
                if (effectiveStrength < 0.01) continue; // Skip negligible signals
            }

            const key = event.value;
            const target = event.target;

            if (!profile[target]) profile[target] = {};

            // Merge signals: like increases weight, dislike decreases
            const direction = (event.intent === 'like' || event.intent === 'correction') ? 1 : -1;
            const existing = profile[target][key] || 0;
            profile[target][key] = Math.max(-1, Math.min(1, existing + (direction * effectiveStrength)));

            // Update humor params from humor-targeted events
            if (target === 'humor') {
                this._updateHumorParam(humorParams, event.intent, key);
            }

            if (event.pinned) {
                pinnedPrefs.push({
                    target, value: key, intent: event.intent,
                    created_at: event.created_at
                });
            }
        }

        const fullProfile = { preferences: profile, humor_params: humorParams, pinned: pinnedPrefs };

        // Persist snapshot to Postgres
        await query(
            `INSERT INTO user_preference_profiles (user_id, profile, humor_params, pinned_preferences, updated_at)
             VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, now())
             ON CONFLICT (user_id) DO UPDATE SET
                 profile = $2::jsonb,
                 humor_params = $3::jsonb,
                 pinned_preferences = $4::jsonb,
                 updated_at = now()`,
            [userId, JSON.stringify(profile), JSON.stringify(humorParams), JSON.stringify(pinnedPrefs)]
        );

        return fullProfile;
    }

    async _updateProfile(userId) {
        const profile = await this._computeProfile(userId);
        if (this.redis) {
            try {
                await this.redis.set(`pref:${userId}:profile`, JSON.stringify(profile), { EX: 3600 });
            } catch (err) {
                logger.warn('Redis profile update failed', { error: err.message });
            }
        }
        return profile;
    }

    _updateHumorParam(params, intent, value) {
        const lower = value.toLowerCase();
        if (lower.includes('sarcasm') || lower.includes('sarcastic')) {
            params.avoid_sarcasm = (intent === 'dislike' || intent === 'boundary');
        }
        if (lower.includes('teas')) {
            params.prefer_light_teasing = (intent === 'like');
        }
        if (lower.includes('dark humor') || lower.includes('dark joke')) {
            params.avoid_dark_humor = (intent === 'dislike' || intent === 'boundary');
        }
        if (lower.includes('short') || lower.includes('brief')) {
            params.keep_jokes_short = (intent === 'like');
        }
    }

    /**
     * Detect if user is pinning a preference (Section 7)
     * "always", "never", "from now on" create permanent preferences
     */
    _detectPin(value) {
        const lower = value.toLowerCase();
        return PIN_KEYWORDS.some(kw => lower.includes(kw));
    }
}

module.exports = PreferenceManager;
