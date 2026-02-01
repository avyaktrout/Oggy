-- Enable pgcrypto extension for UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Memory Cards Table
CREATE TABLE IF NOT EXISTS memory_cards (
    card_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ownership / Scope
    owner_type TEXT NOT NULL DEFAULT 'user',
    owner_id TEXT NOT NULL,

    -- Tiering (4-tier substrate)
    tier SMALLINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active',

    -- Payload
    kind TEXT NOT NULL DEFAULT 'fact',
    content JSONB NOT NULL,
    tags TEXT[] NOT NULL DEFAULT '{}',

    -- Scoring / Selection
    utility_weight DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    reliability DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    usage_count BIGINT NOT NULL DEFAULT 0,
    success_count BIGINT NOT NULL DEFAULT 0,
    failure_count BIGINT NOT NULL DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed_at TIMESTAMPTZ,

    -- Optimistic Concurrency
    version BIGINT NOT NULL DEFAULT 0
);

-- Memory Audit Events Table
CREATE TABLE IF NOT EXISTS memory_audit_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),

    agent TEXT NOT NULL,
    program TEXT NOT NULL,
    action TEXT NOT NULL,
    card_id UUID NOT NULL REFERENCES memory_cards(card_id),

    -- WHY this update occurred
    event_type TEXT NOT NULL,
    intent JSONB NOT NULL,
    reason_code TEXT NOT NULL,
    reason_text TEXT NOT NULL,

    -- Delta storage (only changed fields)
    before JSONB NOT NULL,
    after JSONB NOT NULL,

    -- Evidence pointers
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    delta_score DOUBLE PRECISION,
    rollback_of UUID NULL REFERENCES memory_audit_events(event_id)
);

-- Retrieval Traces Table
CREATE TABLE IF NOT EXISTS retrieval_traces (
    trace_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),

    agent TEXT NOT NULL,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,

    query TEXT,
    selected_card_ids UUID[] NOT NULL DEFAULT '{}',
    top_k SMALLINT NOT NULL DEFAULT 0,
    score_map JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Indexes for memory_cards
CREATE INDEX IF NOT EXISTS idx_memory_cards_owner_tier
    ON memory_cards (owner_type, owner_id, tier)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_cards_owner_utility
    ON memory_cards (owner_type, owner_id, utility_weight DESC)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_memory_cards_tags_gin
    ON memory_cards USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_memory_cards_content_gin
    ON memory_cards USING GIN (content);

-- Indexes for audit events
CREATE INDEX IF NOT EXISTS idx_audit_card_ts
    ON memory_audit_events (card_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_reason
    ON memory_audit_events (reason_code, ts DESC);

CREATE INDEX IF NOT EXISTS idx_audit_event_type
    ON memory_audit_events (event_type, ts DESC);

-- Indexes for retrieval traces
CREATE INDEX IF NOT EXISTS idx_trace_owner_ts
    ON retrieval_traces (owner_type, owner_id, ts DESC);

-- Insert a test memory card for Week 1 demo
INSERT INTO memory_cards (owner_type, owner_id, kind, content, tags)
VALUES (
    'user',
    'test-user-1',
    'fact',
    '{"text": "Initial test memory card", "domain": "system"}'::jsonb,
    ARRAY['test', 'system']
);
