-- =====================================================
-- Payments Application - Core Schema
-- Stage 0, Week 5: Payments App Minimal Surface
-- =====================================================

-- Enable UUID generation (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- Expenses Table: Core payment/expense tracking
-- =====================================================
CREATE TABLE IF NOT EXISTS expenses (
    expense_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Ownership
    user_id TEXT NOT NULL,

    -- Core expense data
    amount DECIMAL(12,2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    description TEXT NOT NULL,
    merchant TEXT,
    category TEXT,  -- initially nullable, can be AI-suggested or user-set

    -- Temporal
    transaction_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Metadata
    tags TEXT[] DEFAULT '{}',
    notes TEXT,

    -- Status tracking
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'deleted' | 'archived'
    version BIGINT NOT NULL DEFAULT 0,

    -- Constraints
    CONSTRAINT valid_amount CHECK (amount >= 0),
    CONSTRAINT valid_status CHECK (status IN ('active', 'deleted', 'archived'))
);

-- =====================================================
-- App Events Table: Training data pipeline source
-- Feeds both domain_knowledge and memory substrate
-- =====================================================
CREATE TABLE IF NOT EXISTS app_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Event classification
    event_type TEXT NOT NULL,  -- controlled vocabulary
    app_domain TEXT NOT NULL DEFAULT 'payments',

    -- Context
    user_id TEXT NOT NULL,
    session_id UUID,

    -- Payload
    entity_type TEXT NOT NULL,  -- 'expense' | 'category' | 'query'
    entity_id UUID,  -- references expenses.expense_id when applicable
    action TEXT NOT NULL,  -- 'create' | 'update' | 'delete' | 'query' | 'categorize'

    -- Event data (structured)
    event_data JSONB NOT NULL,

    -- Processing tracking
    processed_for_domain_knowledge BOOLEAN DEFAULT FALSE,
    processed_for_memory_substrate BOOLEAN DEFAULT FALSE,
    processing_errors JSONB,
    processed_at TIMESTAMPTZ,

    -- Constraints
    CONSTRAINT valid_entity_type CHECK (entity_type IN ('expense', 'category', 'query', 'pattern')),
    CONSTRAINT valid_action CHECK (action IN ('create', 'update', 'delete', 'query', 'categorize', 'suggest'))
);

-- =====================================================
-- Indexes for expenses table
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_expenses_user_date
    ON expenses (user_id, transaction_date DESC)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_expenses_user_category
    ON expenses (user_id, category)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_expenses_merchant
    ON expenses (merchant)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_expenses_created_at
    ON expenses (created_at DESC);

-- GIN index for tag searches
CREATE INDEX IF NOT EXISTS idx_expenses_tags_gin
    ON expenses USING GIN (tags);

-- =====================================================
-- Indexes for app_events table
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_app_events_user_ts
    ON app_events (user_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_app_events_type_processing
    ON app_events (event_type, processed_for_domain_knowledge, processed_for_memory_substrate)
    WHERE NOT processed_for_domain_knowledge OR NOT processed_for_memory_substrate;

CREATE INDEX IF NOT EXISTS idx_app_events_entity
    ON app_events (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_app_events_unprocessed
    ON app_events (ts ASC)
    WHERE NOT processed_for_domain_knowledge OR NOT processed_for_memory_substrate;

-- GIN index for event_data searches
CREATE INDEX IF NOT EXISTS idx_app_events_data_gin
    ON app_events USING GIN (event_data);

-- =====================================================
-- Comments for documentation
-- =====================================================
COMMENT ON TABLE expenses IS 'Core expenses/payments tracking for Stage 0 Payment Assistant';
COMMENT ON TABLE app_events IS 'Application events that feed training pipeline for continuous learning';
COMMENT ON COLUMN app_events.processed_for_domain_knowledge IS 'Has this event been processed into domain_knowledge table for Tessa';
COMMENT ON COLUMN app_events.processed_for_memory_substrate IS 'Has this event been processed into memory cards for Oggy';
