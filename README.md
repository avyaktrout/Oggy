# Oggy - Stage 0

A continuously learning AI agent system with full auditability. Oggy learns from user feedback and benchmark-driven training to improve expense categorization accuracy over time.

## Timeline

**Stage 0**: 8 weeks (Feb 2 – Mar 29, 2026)

**Current Progress**: Week 6 - "Base vs Oggy Head-to-Head"

## Project Progress

### Week 1 - "The Spine Runs" ✓
- Memory Service (Node.js) with Postgres + Redis
- Learning Service skeleton (Python)
- Full audit trail with evidence requirements
- Docker Compose orchestration

### Week 2 - "Contracts + Evaluation Bundle" ✓
- Finalized reason_codes, context schema, error codes
- Evaluation bundle format
- Basic scoring framework

### Week 3 - "Tessa v1" ✓
- Tessa agent prototype with GPT-4o-mini
- Generates practice assessments (trainable)
- Generates sealed benchmarks (held out)
- Difficulty tiers (warmup, standard, challenge, expert)
- Domain knowledge storage for generated scenarios

### Week 4 - "Continuous Learning Loop v1" ✓
- Oggy categorizer with memory retrieval
- Memory validation utility with reason_code + evidence_pointer
- Memory-augmented prompts for personalized categorization

### Week 5 - "Payments App Minimal Surface" ✓
- Payments application: add/edit expense, categorize expense, query expenses
- Training data pipeline: app events feed domain_knowledge + memory substrate

### Week 6 - "Base vs Oggy Head-to-Head" ← CURRENT
- Automated benchmark runs comparing Base vs Oggy
- Comparison report with delta %, confidence, verdict
- Benchmark-driven targeted learning based on weakness analysis

**Results Achieved:**
| Metric | Before Training | After Training |
|--------|-----------------|----------------|
| Oggy | 92.5% | **97.5%** |
| Base | 92.5% | 92.5% |
| Verdict | TIE | **OGGY_BETTER** |

**Key Fixes:**
1. Fixed correction memory formatting - memories now render as clear rules in prompts
2. Added skip logic for inherently ambiguous category pairs (dining/business_meal)
3. Improved benchmark generation prompts to create unambiguous test scenarios
4. Deleted problematic correction memories that were teaching wrong patterns

### Week 7 - "Hardening + Failure Modes" (Upcoming)
- Retry policies, rate limiting / cost caps
- Safe fallback when memory service is down
- Audit completeness checker
- makefile/scripts for common runs
- CI checks: lint + unit tests for core utilities

### Week 8 - "Stage 0 Demo Ready" (Upcoming)
- Demo flow: enter expense → Oggy trains → Tessa evaluates → report shows movement vs base
- Audit log explains why memory changes happened
- Lightweight pitch artifact: 1–2 page summary + charts from real runs

## Prerequisites

- Docker & Docker Compose
- Node.js 20+ (for local development)
- Python 3.11+ (for local development)
- OpenAI API key
- Anthropic API key (optional, for OOD benchmarks)

## Quick Start

### 1. Copy environment file

```bash
cp .env.example .env
# Add your OPENAI_API_KEY and optionally ANTHROPIC_API_KEY
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
- **Learning Service** (port 8000) - Training loops and agents
- **Payments Service** (port 3001) - Oggy categorizer, benchmarks, training

### 3. Verify services are running

```bash
curl http://localhost:3000/health  # Memory Service
curl http://localhost:8000/health  # Learning Service
curl http://localhost:3001/health  # Payments Service
```

## Benchmark-Driven Training (Week 8)

### Create a Sealed Benchmark

```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my_benchmark_v1",
    "count": 50,
    "use_ood": false,
    "difficulty_mix": "balanced"
  }'
```

### Test on Sealed Benchmark

```bash
curl -X POST http://localhost:3001/v0/sealed-benchmark/test \
  -H "Content-Type: application/json" \
  -d '{
    "benchmark_name": "my_benchmark_v1",
    "user_id": "test"
  }'
```

### Run Benchmark-Driven Training

```bash
curl -X POST http://localhost:3001/v0/training/benchmark-driven \
  -H "Content-Type: application/json" \
  -d '{
    "result_id": "<result_id from test>",
    "user_id": "test",
    "duration_minutes": 3,
    "items_per_category": 50,
    "auto_retest": true
  }'
```

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│  Learning Service   │     │  Payments Service   │
│  Port 8000          │     │  Port 3001          │
│  (Python/FastAPI)   │     │  (Node.js/Express)  │
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           │         HTTP              │
           └───────────┬───────────────┘
                       ▼
           ┌─────────────────────┐
           │  Memory Service     │
           │  Port 3000          │
           │  (Node.js/Express)  │
           └──────────┬──────────┘
                      │
                 ┌────┴────┐
                 │         │
                 ▼         ▼
             ┌────────┐  ┌────────┐
             │Postgres│  │ Redis  │
             │  5432  │  │  6379  │
             └────────┘  └────────┘
```

## Key Services

### Payments Service (port 3001)

**Oggy Categorizer** - Expense categorization with memory augmentation
- Retrieves relevant memories before categorization
- Formats correction memories as clear rules
- Falls back gracefully when services unavailable

**Sealed Benchmark System**
- `POST /v0/sealed-benchmark/create` - Create fixed test sets
- `POST /v0/sealed-benchmark/test` - Test Oggy vs Base
- `GET /v0/sealed-benchmark/list` - List all benchmarks

**Benchmark-Driven Training**
- `POST /v0/training/benchmark-driven` - Run targeted training
- `GET /v0/training/benchmark-driven/status` - Check training status
- `POST /v0/training/benchmark-driven/stop` - Stop training early

**Tessa Assessment Generator**
- Generates novel practice scenarios via GPT-4o-mini
- Supports difficulty tiers and confusion-targeted generation
- Stores generated scenarios in domain knowledge

### Memory Service (port 3000)

- Memory card CRUD operations
- Semantic retrieval with tag filtering
- Utility weight updates with audit trail
- Tiered memory system (working, short-term, long-term, archive)

### Learning Service (port 8000)

- Agent orchestration
- Scoring framework
- Training loop management

## Core Integrity Rules

**Evidence Requirement (CRITICAL):**
- NO memory update without evidence pointer
- Evidence: `trace_id`, `assessment_id`, `benchmark_id`, `user_event_id`
- Updates rejected at validation gate if evidence missing

**Audit Trail:**
- Every update creates an immutable audit event
- Includes: `event_type`, `intent`, `reason_code`, `evidence`
- Only delta stored, not full card

## Expense Categories

| Category | Description |
|----------|-------------|
| dining | Personal restaurant/cafe visits (friends, family, dates) |
| business_meal | Work-related dining (client meetings, business lunches) |
| groceries | Supermarkets, grocery stores |
| transportation | Gas, rideshare, parking, public transit |
| utilities | Electric, water, internet, phone |
| entertainment | Movies, concerts, streaming, hobbies |
| health | Gym, pharmacy, doctor visits |
| shopping | Retail, clothing, electronics |

## Development

**Start only infrastructure:**
```bash
docker-compose up postgres redis otel-collector
```

**Run services locally:**
```bash
# Memory Service
cd services/memory && npm install && npm run dev

# Learning Service
cd services/learning && pip install -r requirements.txt && uvicorn main:app --reload

# Payments Service
cd services/payments && npm install && npm run dev
```

## License

Proprietary - All rights reserved
