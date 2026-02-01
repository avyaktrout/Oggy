-- Week 3: Add CIR violations table for audit trail
-- Migration: 03_cir_violations.sql

CREATE TABLE IF NOT EXISTS cir_violations (
    violation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    gate_type VARCHAR(20) NOT NULL CHECK (gate_type IN ('request', 'response')),
    pattern VARCHAR(500),
    reason TEXT,
    user_input TEXT NOT NULL,
    agent_response TEXT,
    blocked BOOLEAN DEFAULT TRUE,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for querying by gate type
CREATE INDEX IF NOT EXISTS idx_cir_violations_gate_type
ON cir_violations (gate_type);

-- Index for querying blocked violations
CREATE INDEX IF NOT EXISTS idx_cir_violations_blocked
ON cir_violations (blocked, created_at DESC);

-- Index for pattern analysis
CREATE INDEX IF NOT EXISTS idx_cir_violations_pattern
ON cir_violations (pattern)
WHERE pattern IS NOT NULL;

-- Index for time-based queries
CREATE INDEX IF NOT EXISTS idx_cir_violations_created_at
ON cir_violations (created_at DESC);

-- Index for metadata JSONB queries
CREATE INDEX IF NOT EXISTS idx_cir_violations_metadata
ON cir_violations USING GIN (metadata);

COMMENT ON TABLE cir_violations IS 'Audit trail for CIR (Core Integrity Rules) violations';
COMMENT ON COLUMN cir_violations.gate_type IS 'Type of gate: request or response';
COMMENT ON COLUMN cir_violations.pattern IS 'Pattern that triggered the violation';
COMMENT ON COLUMN cir_violations.reason IS 'Human-readable reason for violation';
COMMENT ON COLUMN cir_violations.user_input IS 'User input that triggered violation';
COMMENT ON COLUMN cir_violations.agent_response IS 'Agent response (for response gate violations)';
COMMENT ON COLUMN cir_violations.blocked IS 'Whether the request/response was blocked';
COMMENT ON COLUMN cir_violations.metadata IS 'Additional context (category, agent, session, etc.)';
