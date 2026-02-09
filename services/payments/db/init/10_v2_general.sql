-- V2: General Conversation Assistant tables

CREATE TABLE IF NOT EXISTS v2_projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'completed')),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v2_project_messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES v2_projects(project_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    oggy_response BOOLEAN DEFAULT false,
    used_memory BOOLEAN DEFAULT false,
    trace_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v2_preference_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    preference_type TEXT NOT NULL,
    preference_key TEXT NOT NULL,
    preference_value TEXT,
    confidence REAL DEFAULT 0.5,
    source TEXT DEFAULT 'inferred',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS v2_benchmark_scenarios (
    scenario_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    benchmark_id UUID NOT NULL,
    user_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    expected_style TEXT,
    expected_context JSONB DEFAULT '{}',
    order_index INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_v2_projects_user ON v2_projects(user_id);
CREATE INDEX IF NOT EXISTS idx_v2_messages_project ON v2_project_messages(project_id);
CREATE INDEX IF NOT EXISTS idx_v2_messages_user ON v2_project_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_v2_prefs_user ON v2_preference_events(user_id);
