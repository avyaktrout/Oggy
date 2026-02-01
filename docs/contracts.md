# Oggy Stage 0 - Contracts (FROZEN)

**Version:** 1.0.0
**Status:** FROZEN as of Week 2
**Breaking changes require major version bump**

This document defines the core contracts for Oggy Stage 0. Once frozen, these interfaces should not change without careful consideration and versioning.

---

## 1. Reason Codes (Canonical List)

Reason codes are inferred from structured `intent` objects and represent **why** a memory update occurred.

### Retrieval Events
- `RETRIEVED_USED` - Memory was retrieved and actively used in response generation
- `RETRIEVED_NOT_USED` - Memory was retrieved but not incorporated into final response

### Outcome Events
- `OUTCOME_SUCCESS` - Action/response led to successful outcome
- `OUTCOME_FAILURE` - Action/response led to failure or error

### User Feedback Events
- `USER_CONFIRMED` - User explicitly confirmed information was correct/helpful
- `USER_CORRECTED` - User corrected information, indicating memory was wrong/outdated

### Benchmark Events
- `BENCHMARK_DELTA_POS` - Performance improved on benchmark evaluation
- `BENCHMARK_DELTA_NEG` - Performance degraded on benchmark evaluation

### Hygiene Events
- `DEDUP_MERGE` - Card merged with duplicate during deduplication
- `PRUNE_LOW_UTILITY` - Card pruned due to low utility score
- `TIER_PROMOTION` - Card promoted to higher tier (e.g., short → long)
- `TIER_DEMOTION` - Card demoted to lower tier (e.g., long → short)

### Inference Rules

The system infers reason codes from `context.intent` structure:

```javascript
function inferReasonCode(context) {
  const intent = context.intent || {};
  const event_type = intent.event_type;

  if (event_type === 'retrieval') {
    if (intent.used === true) return 'RETRIEVED_USED';
    if (intent.used === false) return 'RETRIEVED_NOT_USED';
  }

  if (event_type === 'outcome') {
    if (intent.outcome === 'success') return 'OUTCOME_SUCCESS';
    if (intent.outcome === 'failure') return 'OUTCOME_FAILURE';
  }

  if (event_type === 'user_feedback') {
    if (intent.feedback === 'confirmed') return 'USER_CONFIRMED';
    if (intent.feedback === 'corrected') return 'USER_CORRECTED';
  }

  if (event_type === 'benchmark') {
    if (intent.delta > 0) return 'BENCHMARK_DELTA_POS';
    if (intent.delta < 0) return 'BENCHMARK_DELTA_NEG';
  }

  if (event_type === 'hygiene') {
    if (intent.action === 'dedup') return 'DEDUP_MERGE';
    if (intent.action === 'prune') return 'PRUNE_LOW_UTILITY';
    if (intent.action === 'promote') return 'TIER_PROMOTION';
    if (intent.action === 'demote') return 'TIER_DEMOTION';
  }

  return 'UNKNOWN';
}
```

---

## 2. Context Schema

The `context` object is passed to all memory update operations. It provides auditability and enables reason code inference.

### Required Fields

```typescript
interface Context {
  // Agent performing the action
  agent: string;              // e.g., "oggy", "base", "tessa"

  // Program/component initiating the update
  program: string;            // e.g., "learning_loop", "retrieval_service", "hygiene_job"

  // Action being performed
  action: string;             // e.g., "UPDATE_CARD", "CREATE_CARD", "PRUNE_CARD"

  // Evidence pointers (AT LEAST ONE REQUIRED)
  evidence: {
    trace_id?: string;        // Links to retrieval_traces table
    assessment_id?: string;   // Links to assessment/evaluation run
    benchmark_id?: string;    // Links to benchmark evaluation
    user_event_id?: string;   // Links to user interaction event
  };

  // Structured intent (used for reason code inference)
  intent: {
    event_type: 'retrieval' | 'outcome' | 'user_feedback' | 'benchmark' | 'hygiene';
    [key: string]: any;       // Event-type specific fields
  };
}
```

### Optional Fields

```typescript
interface ContextOptional {
  // Session or conversation ID
  session_id?: string;

  // Timestamp (auto-generated if not provided)
  timestamp?: string;         // ISO 8601 format

  // Additional metadata
  metadata?: Record<string, any>;
}
```

### Validation Rules

1. **Evidence Requirement**: At least ONE evidence pointer must be non-null
   - Valid: `{ trace_id: "abc123" }`
   - Invalid: `{ trace_id: null, assessment_id: null }`

2. **Intent Structure**: Must include `event_type` field
   - Valid: `{ event_type: "outcome", outcome: "success" }`
   - Invalid: `{ outcome: "success" }` (missing event_type)

3. **Agent Format**: Must be alphanumeric lowercase with hyphens/underscores
   - Valid: `"oggy"`, `"base-v2"`, `"tessa_1"`
   - Invalid: `"Oggy!"`, `"base v2"`

### Example Context Objects

**Outcome Event:**
```json
{
  "agent": "oggy",
  "program": "learning_loop",
  "action": "UPDATE_CARD",
  "evidence": {
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "assessment_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
  },
  "intent": {
    "event_type": "outcome",
    "outcome": "success"
  }
}
```

**User Feedback Event:**
```json
{
  "agent": "oggy",
  "program": "chat_interface",
  "action": "UPDATE_CARD",
  "evidence": {
    "user_event_id": "user-feedback-12345"
  },
  "intent": {
    "event_type": "user_feedback",
    "feedback": "corrected",
    "correction": "User provided updated information"
  }
}
```

---

## 3. Error Codes

Standardized error codes for all API responses.

### Format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}  // Optional additional context
  }
}
```

### Error Code List

#### Validation Errors (400)
- `MISSING_EVIDENCE` - No evidence pointers provided in context
- `INVALID_CARD_ID` - Card ID format is invalid or card doesn't exist
- `INVALID_CONTEXT` - Context object missing required fields
- `INVALID_INTENT` - Intent object missing event_type or malformed
- `INVALID_PATCH` - Patch object contains invalid fields or values

#### Authorization Errors (403)
- `INSUFFICIENT_PERMISSIONS` - Agent lacks permission for this operation
- `OWNER_MISMATCH` - Attempting to modify card owned by different owner

#### Resource Errors (404)
- `CARD_NOT_FOUND` - Card ID does not exist
- `TRACE_NOT_FOUND` - Trace ID does not exist
- `AUDIT_NOT_FOUND` - Audit event not found

#### Conflict Errors (409)
- `VERSION_CONFLICT` - Card version mismatch (optimistic locking)
- `DUPLICATE_CARD` - Card with identical content already exists

#### Server Errors (500)
- `DATABASE_ERROR` - Database operation failed
- `INTERNAL_ERROR` - Unexpected server error

### Example Error Response

```json
{
  "error": {
    "code": "MISSING_EVIDENCE",
    "message": "Memory updates require at least one evidence pointer (trace_id, assessment_id, benchmark_id, or user_event_id)",
    "details": {
      "provided_evidence": {
        "trace_id": null,
        "assessment_id": null,
        "benchmark_id": null,
        "user_event_id": null
      }
    }
  }
}
```

---

## 4. Memory Card Schema

The core memory card structure (reference for Week 3+ development).

```typescript
interface MemoryCard {
  // Identity
  card_id: string;              // UUID
  owner_type: 'user' | 'agent' | 'system';
  owner_id: string;

  // Memory tier
  tier: 'working' | 'short' | 'long' | 'archive';

  // Card type and content
  kind: 'fact' | 'preference' | 'pattern' | 'procedure';
  content: Record<string, any>;  // Flexible JSONB content
  tags: string[];

  // Utility metrics
  utility_weight: number;        // 0.0 to 1.0
  reliability: number;           // 0.0 to 1.0

  // Timestamps
  created_at: string;            // ISO 8601
  last_accessed_at: string;      // ISO 8601
  last_updated_at: string;       // ISO 8601

  // Versioning
  version: number;               // Increments on each update
}
```

---

## 5. Audit Event Schema

Immutable audit trail for all memory updates.

```typescript
interface AuditEvent {
  // Identity
  event_id: string;              // UUID
  card_id: string;               // References memory_cards.card_id

  // Context
  event_type: string;            // From context.intent.event_type
  intent: Record<string, any>;   // Full intent object (JSONB)
  reason_code: string;           // Inferred from intent

  // Evidence
  evidence: Record<string, any>; // Evidence pointers (JSONB)

  // Actor
  agent: string;
  program: string;
  action: string;

  // Changes (delta only)
  before_state: Record<string, any>;  // Only changed fields
  after_state: Record<string, any>;   // Only changed fields

  // Metadata
  created_at: string;            // ISO 8601
  session_id?: string;
}
```

---

## Contract Version History

- **v1.0.0** (Week 2) - Initial contract freeze
  - 12 canonical reason codes
  - Context schema with evidence requirement
  - 11 standard error codes
  - Memory card and audit event schemas

---

## Breaking Change Policy

**Minor changes allowed:**
- Adding new reason codes (append only)
- Adding optional fields to schemas
- Adding new error codes

**Major changes require version bump:**
- Removing or renaming reason codes
- Changing required fields in context schema
- Changing inference rules
- Modifying error code meanings

All breaking changes must be discussed and approved before implementation.
