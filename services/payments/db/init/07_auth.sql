-- Authentication & Authorization (Private Domain Hosting v0.1)
-- Magic link email login with invite-only allowlist

-- Allowed emails (invite list)
CREATE TABLE IF NOT EXISTS auth_allowed_emails (
    email TEXT PRIMARY KEY,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT valid_role CHECK (role IN ('user', 'admin'))
);

-- Magic link tokens
CREATE TABLE IF NOT EXISTS auth_magic_links (
    token_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '6 hours'),
    used_at TIMESTAMPTZ,
    ip_address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_hash ON auth_magic_links (token_hash);
CREATE INDEX IF NOT EXISTS idx_magic_links_email ON auth_magic_links (email);

-- Sessions
CREATE TABLE IF NOT EXISTS auth_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    session_token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    ip_address TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions (session_token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions (user_id);

-- Rate limiting
CREATE TABLE IF NOT EXISTS auth_rate_limits (
    id SERIAL PRIMARY KEY,
    email TEXT,
    ip_address TEXT,
    attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_email ON auth_rate_limits (email, attempt_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_ip ON auth_rate_limits (ip_address, attempt_at);

-- Seed admin email from env (handled in authService, not SQL)
-- INSERT INTO auth_allowed_emails (email, role) VALUES ('admin@example.com', 'admin') ON CONFLICT DO NOTHING;
