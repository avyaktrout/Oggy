-- Observer Oggy (Federated Learning v0.1)
-- Cross-tenant learning with distilled rule packs

-- Tenant opt-in configuration
CREATE TABLE IF NOT EXISTS observer_tenant_config (
    user_id TEXT PRIMARY KEY,
    share_learning BOOLEAN NOT NULL DEFAULT FALSE,
    receive_observer_suggestions BOOLEAN NOT NULL DEFAULT FALSE,
    receive_merchant_packs BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Distilled rule packs (versioned)
CREATE TABLE IF NOT EXISTS observer_packs (
    pack_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version INTEGER NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    risk_level TEXT NOT NULL DEFAULT 'low',
    expected_lift NUMERIC(5,2) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available',
    categories_covered TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ,
    rolled_back_at TIMESTAMPTZ,
    CONSTRAINT valid_risk_level CHECK (risk_level IN ('low', 'medium', 'high')),
    CONSTRAINT valid_pack_status CHECK (status IN ('available', 'applied', 'rolled_back', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_observer_packs_status ON observer_packs (status);

-- Observer job log
CREATE TABLE IF NOT EXISTS observer_job_log (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'running',
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    packs_generated INTEGER DEFAULT 0,
    CONSTRAINT valid_job_status CHECK (status IN ('running', 'completed', 'failed'))
);

-- Pack application tracking
CREATE TABLE IF NOT EXISTS observer_pack_applications (
    application_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pack_id UUID NOT NULL REFERENCES observer_packs(pack_id),
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    rules_applied INTEGER DEFAULT 0,
    memory_cards_created TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_application_action CHECK (action IN ('apply', 'rollback'))
);

CREATE INDEX IF NOT EXISTS idx_pack_applications_user ON observer_pack_applications (user_id, pack_id);
