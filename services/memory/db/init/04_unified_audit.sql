-- Week 4: Unified Audit System
-- Replaces fragmented audit tables with single unified log
-- See docs/AUDIT-ARCHITECTURE.md for architecture details

-- Create unified audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,     -- 'retrieval', 'card_create', 'card_update', 'card_delete', 'cir_violation'
  service VARCHAR(50) NOT NULL,        -- 'memory', 'learning'
  payload JSONB NOT NULL,              -- Event-specific data (flexible schema)
  correlation_id UUID,                 -- Links related events across services
  user_id VARCHAR(255),                -- Optional: for user-level queries
  session_id VARCHAR(255),             -- Optional: for session-level queries
  ts TIMESTAMP DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_audit_correlation_id ON audit_log(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_service_ts ON audit_log(service, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);

-- GIN index for JSONB payload searches (enables fast queries on payload contents)
CREATE INDEX IF NOT EXISTS idx_audit_payload ON audit_log USING GIN(payload);

-- Comments for documentation
COMMENT ON TABLE audit_log IS 'Unified audit log for all system events across services';
COMMENT ON COLUMN audit_log.event_type IS 'Type of event: retrieval, card_create, card_update, card_delete, cir_violation';
COMMENT ON COLUMN audit_log.service IS 'Service that generated the event: memory, learning';
COMMENT ON COLUMN audit_log.payload IS 'Event-specific data in flexible JSONB format';
COMMENT ON COLUMN audit_log.correlation_id IS 'Links related events across services (e.g., all events from one request)';
COMMENT ON COLUMN audit_log.user_id IS 'User who triggered the event, if applicable';
COMMENT ON COLUMN audit_log.session_id IS 'Session ID, if applicable';

-- Example payload structures for reference:
--
-- retrieval event:
-- {
--   "query": "text",
--   "agent": "oggy",
--   "owner_type": "user",
--   "owner_id": "user-123",
--   "selected_card_ids": ["uuid1", "uuid2"],
--   "top_k": 5,
--   "scores": {"uuid1": 0.89, "uuid2": 0.75}
-- }
--
-- card_update event:
-- {
--   "card_id": "uuid",
--   "action": "update_utility",
--   "evidence": {...},
--   "reason_code": "positive_feedback",
--   "old_utility": 0,
--   "new_utility": 0.16
-- }
--
-- cir_violation event:
-- {
--   "gate_type": "request" | "response",
--   "user_input": "text",
--   "agent_response": "text",
--   "blocked": true,
--   "pattern": "regex",
--   "reason": "Ignore instructions attempt",
--   "category": "prompt_injection",
--   "context": {...}
-- }
