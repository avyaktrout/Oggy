-- BYO-Model: User provider secrets, model settings, provider registry, audit log

-- Encrypted API keys per user per provider
CREATE TABLE IF NOT EXISTS user_provider_secrets (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    key_hint TEXT,              -- last 4 chars for display
    is_valid BOOLEAN DEFAULT NULL,
    validated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, provider)
);

-- User's chosen model config for Oggy and Base
CREATE TABLE IF NOT EXISTS user_model_settings (
    user_id TEXT PRIMARY KEY,
    oggy_provider TEXT,
    oggy_model TEXT,
    base_provider TEXT,
    base_model TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Registry of available providers and models (seeded)
CREATE TABLE IF NOT EXISTS provider_model_registry (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_default BOOLEAN DEFAULT false,
    max_tokens INTEGER DEFAULT 4096,
    supports_system_prompt BOOLEAN DEFAULT true,
    UNIQUE (provider, model_id)
);

-- Audit log for model API requests
CREATE TABLE IF NOT EXISTS model_request_audit (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    role TEXT NOT NULL,            -- 'oggy' or 'base'
    service TEXT,                  -- which service made the call
    tokens_used INTEGER,
    latency_ms INTEGER,
    success BOOLEAN DEFAULT true,
    error_message TEXT,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_audit_user ON model_request_audit (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_provider_secrets_user ON user_provider_secrets (user_id);

-- Seed provider model registry
INSERT INTO provider_model_registry (provider, model_id, display_name, is_default, max_tokens) VALUES
    -- OpenAI
    ('openai', 'gpt-4o-mini', 'GPT-4o Mini', true, 4096),
    ('openai', 'gpt-4o', 'GPT-4o', false, 4096),
    ('openai', 'gpt-4-turbo', 'GPT-4 Turbo', false, 4096),
    ('openai', 'gpt-3.5-turbo', 'GPT-3.5 Turbo', false, 4096),
    -- Anthropic
    ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', true, 4096),
    ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', false, 4096),
    ('anthropic', 'claude-opus-4-6', 'Claude Opus 4.6', false, 4096),
    -- Google Gemini
    ('gemini', 'gemini-2.0-flash', 'Gemini 2.0 Flash', true, 4096),
    ('gemini', 'gemini-2.0-pro', 'Gemini 2.0 Pro', false, 4096),
    ('gemini', 'gemini-1.5-flash', 'Gemini 1.5 Flash', false, 4096),
    -- xAI Grok
    ('grok', 'grok-2', 'Grok 2', true, 4096),
    ('grok', 'grok-2-mini', 'Grok 2 Mini', false, 4096)
ON CONFLICT (provider, model_id) DO NOTHING;
