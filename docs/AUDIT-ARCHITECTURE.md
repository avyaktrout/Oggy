# Audit Architecture

## Current State (Week 3)

### Audit Tables

1. **memory_audit_events** (PostgreSQL)
   - Owner: Memory Service
   - Writer: services/memory/src/routes/utility.js
   - Purpose: Memory card lifecycle events (create, update, delete)
   - Schema: event_id, card_id, event_type, context, reason_code, old_state, new_state, ts

2. **retrieval_traces** (PostgreSQL)
   - Owner: Memory Service
   - Writer: services/memory/src/routes/retrieval.js
   - Purpose: Memory retrieval request audit trail
   - Schema: trace_id, agent, owner_type, owner_id, query, selected_card_ids, top_k, score_map, ts

3. **cir_violations** (PostgreSQL)
   - Owner: Learning Service
   - Writer: services/learning/cir/violation_logger.py
   - Purpose: CIR (Core Integrity Rules) violation audit trail
   - Schema: violation_id, gate_type, pattern, reason, user_input, agent_response, blocked, metadata, created_at

### Current Architecture

```
┌─────────────────┐          ┌──────────────┐
│ Memory Service  │          │   Database   │
│   (Node.js)     │─────────▶│  PostgreSQL  │
│                 │   Direct │              │
│ - utility.js    │   Write  │ memory_audit_│
│ - retrieval.js  │◀─────────│   events     │
└─────────────────┘          │              │
                             │ retrieval_   │
┌─────────────────┐          │   traces     │
│Learning Service │          │              │
│   (Python)      │─────────▶│ cir_         │
│                 │   Direct │   violations │
│ - violation_    │   Write  │              │
│   logger.py     │◀─────────│              │
└─────────────────┘          └──────────────┘
```

### Known Issues

**Problem: Split-Brain Database Writes**
- Memory service writes to `memory_audit_events` and `retrieval_traces` directly
- Learning service writes to `cir_violations` directly via Python asyncpg
- Two different database drivers (pg for Node.js, asyncpg for Python)
- Bypasses service boundaries - learning service should call memory service API

**Impact:**
- Audit reconstruction requires joining across 3+ tables
- No unified audit API for querying full request lifecycle
- Potential consistency issues with multiple writers
- Harder to maintain single source of truth

**Example Reconstruction Problem:**
To trace a full request flow:
1. Query `retrieval_traces` for trace_id (memory service)
2. Query `memory_audit_events` for card updates (memory service)
3. Query `cir_violations` for validation checks (learning service)
4. Manually correlate via timestamps and context

### Future Work (Week 4+)

**Goal: Unified Audit System**

Consolidate into a single audit log with clear ownership:

```
┌─────────────────┐          ┌──────────────┐
│Learning Service │          │Memory Service│
│                 │   HTTP   │              │
│                 │─────────▶│ Audit API    │
└─────────────────┘          │              │
                             │      │       │
                             │      ▼       │
                         ┌───┴──────────────┴───┐
                         │     Database         │
                         │                      │
                         │  audit_log (unified) │
                         │   - envelope format  │
                         │   - all events       │
                         └──────────────────────┘
```

**Proposed Changes:**
1. **Single audit_log table** with envelope format:
   ```sql
   CREATE TABLE audit_log (
     log_id UUID PRIMARY KEY,
     event_type VARCHAR(50),  -- 'retrieval', 'update', 'cir_violation', etc.
     service VARCHAR(50),     -- 'memory', 'learning'
     payload JSONB,           -- Event-specific data
     correlation_id UUID,     -- Link related events
     ts TIMESTAMP
   );
   ```

2. **Memory service becomes single DB writer**
   - Add POST /audit/log endpoint
   - Learning service calls this endpoint instead of writing directly

3. **Unified audit reconstruction API**
   - GET /audit/trace/{correlation_id} returns full request lifecycle
   - Joins all related events from single table

4. **Migration path**
   - Keep existing tables for backward compatibility
   - New code writes to unified audit_log
   - Background job migrates old events
   - Deprecate old tables in Week 5

### Current Workaround

For now, manual correlation via:
- `trace_id` from retrieval_traces
- `context.evidence.trace_id` from memory_audit_events
- `metadata.trace_id` from cir_violations (if we add it)

**Recommendation:** When logging CIR violations, include trace_id in metadata:
```python
await log_violation(
    gate_type="request",
    user_input=user_input,
    context={"trace_id": trace_id, ...}
)
```

This allows basic correlation until unified system is built.

---

## References

- Memory audit: `services/memory/db/init/01_init.sql` (lines 37-76)
- CIR violations: `services/memory/db/init/03_cir_violations.sql`
- Retrieval traces: `services/memory/src/routes/retrieval.js` (lines 149-164)
- Utility updates: `services/memory/src/routes/utility.js` (lines 256-278)
- CIR logger: `services/learning/cir/violation_logger.py`
