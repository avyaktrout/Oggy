# Oggy - Stage 0

A continuously learning AI agent system with full auditability.

## Week 1 - "The Spine Runs"

This is the initial setup for Week 1 deliverables:
- Memory Service (Node.js) with Postgres + Redis
- Learning Service skeleton (Python)
- Full audit trail with evidence requirements
- Docker Compose orchestration

## Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development)
- Python 3.11+ (for local development)

## Quick Start

### 1. Copy environment file

```bash
cp .env.example .env
```

### 2. Start all services

```bash
docker-compose up --build
```

This will start:
- **PostgreSQL** (port 5432) - Memory persistence
- **Redis** (port 6379) - Working memory/cache
- **OpenTelemetry Collector** (ports 4317, 4318, 8888) - Observability
- **Memory Service** (port 3000) - Memory CRUD + retrieval + utility updates
- **Learning Service** (port 8000) - Toy training loop

### 3. Verify services are running

**Memory Service:**
```bash
curl http://localhost:3000/health
```

**Learning Service:**
```bash
curl http://localhost:8000/health
```

## Week 1 Exit Criteria Demo

Run the toy training loop to watch a memory update happen with a valid audit trail:

```bash
curl -X POST http://localhost:8000/training/toy-loop \
  -H "Content-Type: application/json" \
  -d '{
    "owner_type": "user",
    "owner_id": "test-user-1",
    "agent": "oggy"
  }'
```

This will:
1. Retrieve memory cards from the memory service
2. Simulate a successful outcome
3. Update the card's utility_weight with proper evidence pointers
4. Create an audit event with `intent` + `event_type` + `reason_code`
5. Return metrics: `updates_attempted`, `updates_applied`, `updates_rejected`

## API Endpoints

### Memory Service (port 3000)

**Create Card:**
```bash
POST /cards
{
  "owner_type": "user",
  "owner_id": "user-123",
  "kind": "fact",
  "content": {"text": "Sample memory"},
  "tags": ["test"]
}
```

**Retrieve Cards:**
```bash
POST /retrieve
{
  "agent": "oggy",
  "owner_type": "user",
  "owner_id": "user-123",
  "top_k": 10
}
```

**Update Card (with evidence):**
```bash
POST /utility/update
{
  "card_id": "<uuid>",
  "context": {
    "agent": "oggy",
    "program": "learning_loop",
    "action": "UPDATE_CARD",
    "evidence": {
      "trace_id": "<uuid>",
      "assessment_id": "<uuid>"
    },
    "intent": {
      "event_type": "outcome",
      "outcome": "success"
    }
  },
  "patch": {
    "utility_delta": 0.1
  }
}
```

**Get Audit History:**
```bash
GET /cards/<card_id>/audits?limit=50
```

### Learning Service (port 8000)

**Get Metrics:**
```bash
GET /metrics
```

**Run Toy Training Loop:**
```bash
POST /training/toy-loop
{
  "owner_type": "user",
  "owner_id": "test-user-1",
  "agent": "oggy"
}
```

## Architecture

```
┌─────────────────────┐
│  Learning Service   │  (Python/FastAPI)
│  Port 8000          │
└──────────┬──────────┘
           │
           │ HTTP
           ▼
┌─────────────────────┐
│  Memory Service     │  (Node.js/Express)
│  Port 3000          │
└──────────┬──────────┘
           │
      ┌────┴────┐
      │         │
      ▼         ▼
  ┌────────┐  ┌────────┐
  │Postgres│  │ Redis  │
  │  5432  │  │  6379  │
  └────────┘  └────────┘

  ┌────────────────────┐
  │ OTel Collector     │
  │ 4317, 4318, 8888   │
  └────────────────────┘
```

## Core Integrity Rules

**Evidence Requirement (CRITICAL):**
- **NO memory update without ≥1 evidence pointer**
- Evidence pointers: `trace_id`, `assessment_id`, `benchmark_id`, `user_event_id`
- Updates rejected at validation gate if evidence missing

**Audit Trail:**
- Every update creates an immutable audit event
- Includes: `event_type`, `intent`, `reason_code`, `evidence`
- Only delta (changed fields) stored, not full card

**Reason Codes (Stage 0):**
- RETRIEVED_USED / RETRIEVED_NOT_USED
- OUTCOME_SUCCESS / OUTCOME_FAILURE
- USER_CONFIRMED / USER_CORRECTED
- BENCHMARK_DELTA_POS / BENCHMARK_DELTA_NEG
- DEDUP_MERGE / PRUNE_LOW_UTILITY

## Database Schema

**memory_cards:**
- Memory substrate with 4-tier system
- Utility weights, reliability scores
- Timestamps, version control

**memory_audit_events:**
- Immutable audit log
- event_type + intent (JSONB) + reason_code
- Evidence pointers (JSONB)
- Delta before/after

**retrieval_traces:**
- Every retrieval creates a trace
- Links retrievals to updates via trace_id

## Development

**Start only infrastructure:**
```bash
docker-compose up postgres redis otel-collector
```

**Run Memory Service locally:**
```bash
cd services/memory
npm install
npm run dev
```

**Run Learning Service locally:**
```bash
cd services/learning
pip install -r requirements.txt
uvicorn main:app --reload
```

## Next Steps (Week 2)

- [ ] Contract freeze (reason_codes, context schema, error codes)
- [ ] Evaluation bundle format
- [ ] Basic scoring framework
- [ ] Domain "micro tasks" (10-30 items)

## License

Proprietary - All rights reserved
