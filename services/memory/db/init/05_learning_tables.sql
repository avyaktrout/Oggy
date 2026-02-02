-- Week 4: Training Metrics and Self-Driven Learning Tables
-- Migration: 05_learning_tables.sql

-- Training Metrics Table
-- Tracks each learning cycle's outcomes for Oggy vs Base agent comparison
CREATE TABLE IF NOT EXISTS training_metrics (
    cycle_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Agent identifier
    agent TEXT NOT NULL CHECK (agent IN ('oggy', 'base')),

    -- Cycle statistics
    items_processed INT NOT NULL DEFAULT 0,
    updates_attempted INT NOT NULL DEFAULT 0,
    updates_applied INT NOT NULL DEFAULT 0,
    updates_rejected INT NOT NULL DEFAULT 0,

    -- Performance metrics
    avg_score DOUBLE PRECISION,
    benchmark_delta DOUBLE PRECISION,  -- Delta vs base agent

    -- Gate state at time of cycle
    gate_state TEXT NOT NULL,

    -- Flexible metadata for additional info
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Self-Driven Learning Plans Table
-- Stores autonomous learning plans created by Oggy when gaps detected
CREATE TABLE IF NOT EXISTS sdl_plans (
    plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Plan lifecycle
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed')),
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('UNCERTAINTY', 'DRIFT', 'NOVELTY', 'COVERAGE')),

    -- Plan details
    goal TEXT NOT NULL,
    scope JSONB NOT NULL DEFAULT '{}'::jsonb,          -- Domain, constraints, target areas
    resources JSONB NOT NULL DEFAULT '{}'::jsonb,      -- References to knowledge items
    rehearsal JSONB NOT NULL DEFAULT '{}'::jsonb,      -- Practice plan (count, type, difficulty)
    success_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Target metrics
    budget JSONB NOT NULL DEFAULT '{}'::jsonb,         -- Max tokens, max time

    -- Execution tracking
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    outcomes JSONB NOT NULL DEFAULT '{}'::jsonb        -- Results after execution
);

-- Indexes for training_metrics
CREATE INDEX IF NOT EXISTS idx_training_metrics_ts
    ON training_metrics (ts DESC);

CREATE INDEX IF NOT EXISTS idx_training_metrics_agent_ts
    ON training_metrics (agent, ts DESC);

CREATE INDEX IF NOT EXISTS idx_training_metrics_gate_state
    ON training_metrics (gate_state, ts DESC);

-- Indexes for sdl_plans
CREATE INDEX IF NOT EXISTS idx_sdl_plans_status_created
    ON sdl_plans (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sdl_plans_trigger_created
    ON sdl_plans (trigger_type, created_at DESC);

-- Comments for documentation
COMMENT ON TABLE training_metrics IS 'Records learning cycle outcomes for benchmark tracking and Oggy vs Base agent comparison';
COMMENT ON TABLE sdl_plans IS 'Self-driven learning plans created autonomously when Oggy detects knowledge gaps';

COMMENT ON COLUMN training_metrics.benchmark_delta IS 'Performance delta vs base agent on sealed benchmarks';
COMMENT ON COLUMN sdl_plans.trigger_type IS 'Gap detection trigger: UNCERTAINTY, DRIFT, NOVELTY, or COVERAGE';
COMMENT ON COLUMN sdl_plans.budget IS 'Resource limits: max_tokens, max_time_seconds, etc.';
