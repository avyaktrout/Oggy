-- =====================================================
-- Oggy Behavior System - Stage 0 Behavior Lock-In
-- Preference events, response audits, user profiles
-- =====================================================

-- Preference Events (append-only source of truth)
-- Records every preference signal from the user
CREATE TABLE IF NOT EXISTS preference_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    session_id TEXT,
    request_id TEXT,
    event_type TEXT NOT NULL DEFAULT 'feedback',
    intent TEXT NOT NULL,
    target TEXT NOT NULL,
    value TEXT NOT NULL,
    strength REAL NOT NULL DEFAULT 0.5,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_pointer JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_intent CHECK (intent IN ('like', 'dislike', 'correction', 'boundary')),
    CONSTRAINT valid_target CHECK (target IN ('tone', 'humor', 'verbosity', 'formatting', 'topics', 'safety', 'other')),
    CONSTRAINT valid_strength CHECK (strength >= 0 AND strength <= 1)
);

CREATE INDEX IF NOT EXISTS idx_pref_events_user ON preference_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pref_events_target ON preference_events (user_id, target);

-- User Preference Profiles (materialized snapshot, derived from events)
CREATE TABLE IF NOT EXISTS user_preference_profiles (
    user_id TEXT PRIMARY KEY,
    profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    humor_params JSONB NOT NULL DEFAULT '{
        "avoid_sarcasm": false,
        "prefer_light_teasing": false,
        "avoid_dark_humor": true,
        "keep_jokes_short": true,
        "no_jokes_in_serious_topics": true
    }'::jsonb,
    pinned_preferences JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_hydrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Response Audits (candidate scoring + winner selection)
CREATE TABLE IF NOT EXISTS response_audits (
    audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT,
    candidate_count INTEGER NOT NULL,
    candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
    winner_index INTEGER NOT NULL,
    winner_reason TEXT,
    humor_gate_active BOOLEAN NOT NULL DEFAULT FALSE,
    memory_card_ids TEXT[] DEFAULT '{}',
    scoring_axes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_response_audits_user ON response_audits (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_response_audits_request ON response_audits (request_id);
