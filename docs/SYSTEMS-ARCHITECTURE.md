# Oggy Systems Architecture Document

**Version:** 0.4.0
**Last Updated:** March 2026

---

## 1. Technology Stack Overview

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | Vanilla HTML/CSS/JS | Server-rendered pages with client-side interactivity |
| **API Gateway** | Node.js 20 + Express.js | Auth, CORS, static files, request proxying |
| **Domain Services** | Node.js 20 + Express.js | Business logic per domain (FinSense, GenExplorer, HealthAssist, Harmony) |
| **Memory Service** | Node.js 20 + Express.js | Persistent memory CRUD, semantic retrieval, audit |
| **Learning Service** | Python 3.11 + FastAPI | CIR gates, scoring, self-driven learning agents |
| **Database** | PostgreSQL 15 | Primary data store, 30+ tables |
| **Cache** | Redis 7 | Session cache, preference profiles, USDA results |
| **LLM Providers** | OpenAI, Anthropic, Google, Grok | Chat, scoring, vision, embeddings |
| **External APIs** | USDA FoodData Central | Lab-verified nutrition data (380K+ foods) |
| **Email** | Nodemailer + Gmail SMTP | Magic link auth, training reports |
| **Containerization** | Docker + Docker Compose | Multi-service orchestration |
| **Hosting** | AWS EC2 (t3.small) | Production deployment |
| **Tunnel** | Cloudflare Tunnel | HTTPS termination, DDoS protection |
| **Observability** | OpenTelemetry + Winston | Distributed tracing, structured logging |
| **Security** | AES-256-GCM | API key encryption at rest |

---

## 2. Service Architecture

### 2.1 Services Inventory

Oggy runs as 9 containers from a single Docker Compose file:

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Compose                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ Gateway  │  │ FinSense │  │GenExplorer│  │HealthAs│ │
│  │  :3001   │  │  :3010   │  │  :3011   │  │  :3012  │ │
│  │ 128MB    │  │  256MB   │  │  128MB   │  │  128MB  │ │
│  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Harmony  │  │ Memory   │  │ Learning │              │
│  │  :3013   │  │  :3000   │  │  :8000   │              │
│  │  128MB   │  │  128MB   │  │  128MB   │              │
│  └──────────┘  └──────────┘  └──────────┘              │
│                                                          │
│  ┌──────────┐  ┌──────────┐                             │
│  │PostgreSQL│  │  Redis   │                             │
│  │  :5432   │  │  :6379   │                             │
│  │  256MB   │  │   64MB   │                             │
│  └──────────┘  └──────────┘                             │
└─────────────────────────────────────────────────────────┘
```

**Key design choice**: Gateway + 4 domain services share the same Docker image (`oggy-app:latest`), differentiated only by CMD. This simplifies builds while maintaining service isolation.

### 2.2 Inter-Service Communication

All service-to-service communication uses REST over HTTP within the Docker network:

```
Browser → Cloudflare → Gateway (:3001)
                          │
                          ├──▶ FinSense    (:3010)  ──▶ Memory (:3000)
                          ├──▶ GenExplorer (:3011)  ──▶ Memory (:3000)
                          ├──▶ HealthAssist(:3012)  ──▶ Memory (:3000)
                          ├──▶ Harmony     (:3013)  ──▶ Memory (:3000)
                          └──▶ Learning (:8000)
```

**Trust model**: Gateway authenticates users and injects `X-User-Id` header. Domain services trust this header from internal Docker network. Memory and Learning services use `X-API-Key` for internal auth.

---

## 3. Database Architecture

### 3.1 PostgreSQL Schema

PostgreSQL 15 hosts all application data across 30+ tables. The migration system auto-discovers and applies SQL files sorted by numeric prefix.

**Core Tables by Function:**

#### Authentication & Users
| Table | Purpose |
|-------|---------|
| `auth_allowed_emails` | Invite-only email allowlist with roles (user/admin) |
| `auth_magic_links` | One-time login tokens (6-hour expiry, IP tracking) |
| `auth_sessions` | Session tokens (7-day expiry, CSRF tokens) |
| `auth_rate_limits` | Rate limiting by email and IP |

#### Memory Substrate
| Table | Purpose |
|-------|---------|
| `memory_cards` | 4-tier memory with utility scoring, embeddings, usage counters |
| `memory_audit_events` | Every memory change with intent, reason, before/after delta |
| `retrieval_traces` | When and how memories are retrieved (query, scores, selected cards) |
| `audit_log` | Unified audit across all services (centralized event tracking) |

#### Learning & Training
| Table | Purpose |
|-------|---------|
| `training_metrics` | Cycle-by-cycle learning outcomes (Oggy vs Base comparison) |
| `sdl_plans` | Self-driven learning plans (trigger: uncertainty/drift/novelty/coverage) |
| `cir_violations` | Core Integrity Rules gate violations (request/response security) |

#### FinSense (Payments) Domain
| Table | Purpose |
|-------|---------|
| `expenses` | Transaction records with category, merchant, amount, tags |
| `app_events` | Application events for domain knowledge extraction pipeline |
| `domain_knowledge` | Curated knowledge corpus for assessment generation |
| `knowledge_promotions` | Audit trail for knowledge → memory promotion |

#### HealthAssist (Diet) Domain
| Table | Purpose |
|-------|---------|
| `v3_diet_entries` | Food/liquid/vitamin/supplement entries by meal type |
| `v3_diet_items` | Nutrition facts per entry item (calories, macros, micros) |
| `v3_diet_rules` | User rules (goals, limits, allergies, avoid-lists) |
| `v3_diet_chat_messages` | Diet chat history |
| `usda_nutrition_cache` | USDA API result cache (30-day TTL) |

#### Harmony Domain
| Table | Purpose |
|-------|---------|
| `harmony_nodes` | Geographic hierarchy (city → state → country → world) |
| `harmony_indicators` | Measurable metrics (crime, safety, wellness) |
| `harmony_indicator_values` | Raw data per node per time window |
| `harmony_scores` | Computed E/S/H dimension scores with computation hash |
| `harmony_weights` | Versioned weight configs for indicator aggregation |

#### Benchmarks & Evaluation
| Table | Purpose |
|-------|---------|
| `sealed_benchmarks` | Immutable test set definitions |
| `sealed_benchmark_scenarios` | Individual test cases with correct answers |
| `sealed_benchmark_results` | Historical Oggy vs Base comparison results |

#### Behavior & Preferences
| Table | Purpose |
|-------|---------|
| `preference_events` | Append-only user preference signals (like/dislike/correction/boundary) |
| `user_preference_profiles` | Materialized profiles (tone, humor, verbosity, topics) |
| `response_audits` | Candidate scoring and winner selection records |

#### Observer (Federated Learning)
| Table | Purpose |
|-------|---------|
| `observer_tenant_config` | Per-user opt-in settings |
| `observer_packs` | Versioned rule packs with intent_tags and risk levels |
| `observer_job_log` | Pack generation job metadata |
| `observer_pack_applications` | Apply/rollback tracking per user |

#### Inquiries
| Table | Purpose |
|-------|---------|
| `oggy_inquiries` | Proactive questions with 13 question types |
| `oggy_inquiry_preferences` | Per-user inquiry settings and suggestion preferences |
| `suggestion_telemetry` | Suggestion delivery tracking |

#### Intent Framework
| Table | Purpose |
|-------|---------|
| `intent_catalog` | 26 built-in intents + user clones (format: domain.snake_case) |
| `intent_performance` | Per-intent benchmark results with source tracking (explicit/inferred) |

### 3.2 Migration System

```
services/applications/db/init/          # Shared & gateway migrations
services/applications/src/domains/
  payments/db/                          # FinSense-specific
  general/db/                           # GenExplorer-specific
  diet/db/                              # HealthAssist-specific
  harmony/db/                           # Harmony-specific
services/memory/db/init/                # Memory service migrations
```

The migration runner (`migrationRunner.js`) discovers all SQL files, sorts globally by numeric prefix, and executes in order. All migrations use `CREATE TABLE IF NOT EXISTS` and `ON CONFLICT DO NOTHING` for idempotency.

### 3.3 Indexing Strategy

Key indexes for performance:
- `idx_intent_performance_domain_ts` — Composite: (user_id, domain, intent_id, tested_at DESC)
- `idx_observer_packs_intent_tags` — GIN index for array overlap (`&&`) queries
- `idx_sealed_scenarios_intent` — Partial index where intent_id IS NOT NULL
- `idx_intent_catalog_domain` — Domain-based intent lookup
- Standard B-tree indexes on all FK relationships and user_id columns

---

## 4. LLM Provider Architecture

### 4.1 Multi-Provider Support

Oggy supports 4 LLM providers with a unified adapter pattern:

```
┌─────────────────────────────────────────────┐
│              Provider Resolver               │
│  (Resolves user config → adapter + model)    │
└──────────────────┬──────────────────────────┘
                   │
    ┌──────────────┼──────────────┬────────────┐
    ▼              ▼              ▼             ▼
┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ OpenAI │  │ Anthropic│  │  Gemini  │  │   Grok   │
│ Adapter│  │ Adapter  │  │  Adapter │  │  Adapter │
└────────┘  └──────────┘  └──────────┘  └──────────┘
```

| Provider | Default Model | Features |
|----------|--------------|----------|
| **OpenAI** | gpt-4o-mini | Chat, embeddings, vision, scoring |
| **Anthropic** | claude-sonnet-4-5 | Chat, vision (system prompt separation) |
| **Google Gemini** | gemini-2.0-flash | Chat, vision |
| **Grok/XAI** | grok-2 | Chat |

### 4.2 Provider Resolution Order

1. Check user's `user_model_settings` table for chosen provider/model
2. Try user's API key from `user_provider_secrets` (AES-256-GCM encrypted)
3. Fall back to system API key from environment
4. Fall back to default provider (OpenAI) with system key
5. Cache resolved settings for 5 minutes

### 4.3 Bring-Your-Own-Key (BYOK)

Users can supply their own API keys per provider:
- Keys encrypted with AES-256-GCM before storage
- Users can configure separate models for Oggy and Base
- Key validation endpoint tests connectivity before saving

### 4.4 Embeddings

Memory retrieval uses OpenAI's `text-embedding-3-small` model for vector embeddings:
- Embeddings generated on card creation
- Stored as JSONB in `memory_cards.embedding`
- Similarity scoring: 70% semantic + 30% utility weight

---

## 5. Frontend Architecture

### 5.1 Technology Choices

The frontend uses **vanilla HTML, CSS, and JavaScript** — no framework, no build step, no bundler:

| Component | File | Size |
|-----------|------|------|
| Global styles | `css/style.css` | ~2,150 lines |
| Shared UI shell | `js/app.js` | Topbar, sidebar, auth, navigation |
| Agent shell | `js/agent-shell.js` | Chat, training, observer, inquiry UI |
| Inquiry system | `js/inquiries.js` | Polling, banners, answer handling |
| Settings | `js/settings.js` | Provider config, model selection |

### 5.2 Pages by Domain

| Domain | Pages |
|--------|-------|
| **Core** | index.html (dashboard), login.html, settings.html, admin.html |
| **FinSense** | payments.html, chat.html, analytics.html |
| **HealthAssist** | diet-enter.html, diet-nutrition.html, diet-chat.html, diet-analytics.html |
| **GenExplorer** | general-chat.html, general-projects.html, general-project-detail.html, general-analytics.html |
| **Harmony** | harmony-map.html, harmony-chat.html, harmony-scenarios.html, harmony-data.html, harmony-analytics.html |

### 5.3 AgentShell Pattern

All chat pages share the `AgentShell` class, which provides:
- Dual-model chat (Oggy vs Base side-by-side)
- Training panel (duration, email reports, intent targeting)
- Observer panel (packs, config, job status, intent filter)
- Inquiry settings (toggle, daily limit, suggestion frequency)
- Performance audit panel (LLM-powered Q&A about accuracy)
- Saved tips panel (persistent advice)

Each domain provides a config object specifying endpoints, capabilities, and welcome messages.

### 5.4 Chart Library

Analytics pages use **Chart.js** for visualization:
- Accuracy over time (line chart)
- Win/Tie/Loss distribution (doughnut chart)
- Per-category accuracy (horizontal bar chart)
- Per-intent performance (horizontal bar chart with 80% pass line)
- Weakness heatmaps (confusion matrix style)

---

## 6. Authentication & Security Architecture

### 6.1 Auth Flow

Two authentication paths are supported:

**Path A: Demo Login (Username/Password)**
```
┌──────┐   POST /v0/auth/demo-login           ┌─────────┐
│Client│ ──────────────────────────────────▶   │ Gateway │
└──────┘   { username, password }              └────┬────┘
                                                    │
                                          Validate credentials
                                          Auto-provision user
                                          Create session
                                                    │
┌──────┐   ◀── Set-Cookie: oggy_session       ┌────▼────┐
│Client│ ◀─────────────────────────────────    │ Gateway │
└──────┘   Redirect to /                       └─────────┘
```

A single demo account (`Demo_Oggy` / `welcomeToOggy`) provides instant access. On first login, the demo user is auto-added to `auth_allowed_emails` and a session is created. No email verification required.

**Path B: Magic Link Login (Email)**
```
┌──────┐   POST /v0/auth/request-magic-link   ┌─────────┐
│Client│ ──────────────────────────────────▶   │ Gateway │
└──────┘                                       └────┬────┘
                                                    │
                                               Send email
                                                    │
                                                    ▼
                                              ┌──────────┐
                                              │  Gmail   │
                                              │  SMTP    │
                                              └────┬─────┘
                                                   │
                                              Magic link
                                                   │
                                                   ▼
┌──────┐   POST /v0/auth/verify (token)       ┌─────────┐
│Client│ ──────────────────────────────────▶   │ Gateway │
└──────┘   ◀── Set-Cookie: oggy_session       └─────────┘

┌──────┐   GET /v0/auth/me                    ┌─────────┐
│Client│ ──────────────────────────────────▶   │ Gateway │
└──────┘   ◀── { csrf_token, user }           └─────────┘
```

Quick login optimization: if the email was verified within the past 6 hours, a new session is created instantly without re-sending an email.

### 6.2 Security Measures

| Measure | Implementation |
|---------|---------------|
| **Authentication** | Demo login (username/password) + Magic link email (6-hour token expiry) |
| **Sessions** | 7-day secure cookies |
| **CSRF Protection** | Token per session, validated on every mutation |
| **Rate Limiting** | Per-email and per-IP on magic link requests |
| **API Key Storage** | AES-256-GCM encryption at rest |
| **Internal Auth** | X-User-Id header trust on Docker network only |
| **Invite-Only** | Email allowlist (admin-managed) + shared demo account |
| **HTTPS** | Cloudflare Tunnel (TLS termination) |
| **CORS** | Configurable origin allowlist |

---

## 7. Caching Architecture

### 7.1 Redis Usage

| Use Case | TTL | Pattern |
|----------|-----|---------|
| User preference profiles | 5 min | Cache-aside (read-through) |
| Provider resolution | 5 min | Cache-aside |
| USDA nutrition results | In-memory 24h | Write-through |
| Session state | 7 days | Direct storage |

### 7.2 USDA 3-Tier Cache

```
Request → In-Memory Map (24h TTL)
              │ miss
              ▼
         PostgreSQL Cache (30-day TTL)
              │ miss
              ▼
         USDA API (1,000 req/hour limit)
              │
              ▼
         Write to both caches
```

---

## 8. Observability Architecture

### 8.1 Logging

**Winston** (Node.js services):
- Structured JSON logging
- Log levels: error, warn, info, debug
- Request ID propagation via `X-Request-Id` header
- Operation context on all log entries

**Python logging** (Learning service):
- Standard library + uvicorn access logs

### 8.2 Distributed Tracing

**OpenTelemetry** instrumentation across all services:

```
┌────────┐    ┌────────┐    ┌────────┐
│Gateway │───▶│ Domain │───▶│ Memory │
│  span  │    │  span  │    │  span  │
└────────┘    └────────┘    └────────┘
     │             │             │
     └─────────────┼─────────────┘
                   ▼
          ┌────────────────┐
          │ OTLP Collector │
          └────────────────┘
```

- OTLP HTTP exporter (port 4318)
- Trace correlation via `X-Request-Id`
- Metrics: request duration, status codes, error rates

### 8.3 Audit Trail

Three-level audit system:
1. **Memory Audit Events** — Every card create/update/delete with before/after
2. **Retrieval Traces** — Every memory retrieval with query, candidates, scores
3. **Unified Audit Log** — Cross-service event log with correlation IDs

---

## 9. Resilience Patterns

### 9.1 Circuit Breakers

```javascript
// Registry: one breaker per external dependency
{
    openai:     { threshold: 3, timeout: 60s },
    anthropic:  { threshold: 3, timeout: 60s },
    usda:       { threshold: 3, timeout: 60s },
    memory:     { threshold: 3, timeout: 30s }
}
```

States: CLOSED → OPEN (after threshold failures) → HALF_OPEN (after timeout) → CLOSED
Only 5xx and network errors trip breakers (4xx responses are normal application errors).

### 9.2 Cost Governance

```
┌──────────┐    ┌──────────────┐    ┌──────────┐
│ Request  │───▶│Cost Governor │───▶│ LLM API  │
└──────────┘    │ Check budget │    └──────────┘
                │ Log usage    │
                │ Track tokens │
                └──────────────┘
```

- Daily token budget per user (default: 20M)
- Non-blocking audit to `model_request_audit` table
- Budget enforcement before expensive operations (chat, benchmarks)

### 9.3 Retry with Backoff

External API calls use exponential backoff:
- Initial delay: 1 second
- Max retries: 3
- Backoff factor: 2×
- Jitter: random 0-500ms

### 9.4 Graceful Degradation

| Service Down | Behavior |
|-------------|----------|
| Memory Service | Oggy operates without memory (base mode) |
| USDA API | Falls back to cached results, then AI estimation |
| Redis | Continues without caching (slightly slower) |
| Domain Service | Gateway reports partial health; other domains unaffected |
| LLM Provider | Circuit breaker opens; falls back to alternative provider |

---

## 10. Deployment Architecture

### 10.1 Production Environment

| Resource | Spec |
|----------|------|
| **Instance** | AWS EC2 t3.small (2 vCPU, 2GB RAM) |
| **OS** | Ubuntu |
| **Domain** | oggy-v1.com |
| **IP** | Elastic IP: 3.151.106.23 |
| **Tunnel** | Cloudflare Tunnel (runs natively, not in Docker) |
| **Docker** | Docker Compose with resource limits |

### 10.2 Deployment Process

```
Local:   tar -czf oggy-deploy.tar.gz (exclude node_modules, .git, .env)
         scp oggy-deploy.tar.gz → EC2:/tmp/

EC2:     cd /opt/oggy
         tar -xzf /tmp/oggy-deploy.tar.gz
         docker compose -f docker-compose.staging.yml up -d --build

Verify:  curl http://localhost:3001/health
         → { ok: true, checks: { database, memoryService, finSense, genExplorer, healthAssist, harmony } }
```

### 10.3 Resource Allocation

| Container | Memory Limit | CPU Shares |
|-----------|-------------|------------|
| Gateway | 128MB | Default |
| FinSense | 256MB | Default |
| GenExplorer | 128MB | Default |
| HealthAssist | 128MB | Default |
| Harmony | 128MB | Default |
| Memory | 128MB | Default |
| Learning | 128MB | Default |
| PostgreSQL | 256MB | Default |
| Redis | 64MB | Default |
| **Total** | ~1.3GB | Fits t3.small (2GB) |

### 10.4 Backup Strategy

- `deploy/backup-postgres.sh` — PostgreSQL dump to local file
- `deploy/restore-postgres.sh` — Restore from dump
- S3 backup bucket configured (`S3_BACKUP_BUCKET`)

---

## 11. API Surface

### 11.1 Endpoint Count by Service

| Service | Endpoints | Key Features |
|---------|-----------|--------------|
| **Gateway** | ~50 | Auth (10 — incl. demo-login), Preferences (7), Settings (6), Health (12), Analytics (7), Migration (2), Pruning (3), Intents (7) |
| **FinSense** | ~20 | Expenses (5), Categorization (2), Chat (1), Query (4), Training (3), Benchmarks (6) |
| **GenExplorer** | ~25 | Chat (1), Projects (8), Domain Learning (16), Analytics (1) |
| **HealthAssist** | ~20 | Entries (4), Nutrition (1), Rules (3), Goals (2), Search (2), Barcode (1), Meals (5), Chat (1) |
| **Harmony** | ~35 | Nodes (6), Compute (2), Scenarios (5), Datasets (2), Audit (2), Alerts (2), Chat (2), Suggestions (10), Observer (12) |
| **Memory** | ~8 | Cards (3), Retrieval (1), Audit (4), Utility (1) |

**Total: ~160 REST endpoints**

### 11.2 Middleware Stack

Applied in order on every authenticated request:

```
1. CORS validation
2. JSON body parsing (50MB limit)
3. Request ID injection (UUID)
4. Request logging (method, path, status, duration)
5. Auth: requireAuth (session cookie)
6. Auth: requireCSRF (token header)
7. Auth: injectUserId (from session)
8. [Route-specific] Cost Governor (on LLM-intensive endpoints)
```

---

## 12. External Dependencies

### 12.1 Runtime Dependencies (Node.js)

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4.18 | HTTP framework |
| pg | ^8.11 | PostgreSQL client |
| redis | ^4.6 | Redis client |
| axios | ^1.6 | HTTP client (inter-service, USDA) |
| cors | ^2.8 | CORS middleware |
| nodemailer | ^6.9 | Email (magic links, reports) |
| winston | ^3.19 | Structured logging |
| uuid | ^9.0 | Request ID generation |
| @opentelemetry/* | ^1.30 | Distributed tracing and metrics |

### 12.2 Runtime Dependencies (Python)

| Package | Version | Purpose |
|---------|---------|---------|
| fastapi | 0.109 | HTTP framework |
| uvicorn | 0.27 | ASGI server |
| openai | 1.51 | LLM scoring and evaluation |
| asyncpg | 0.29 | Async PostgreSQL |
| APScheduler | 3.10 | Background task scheduling |
| numpy | 1.26 | Numerical operations |
| redis | 5.0 | Redis client |
| opentelemetry-* | 1.22 | Tracing |

### 12.3 External APIs

| API | Purpose | Rate Limit | Caching |
|-----|---------|-----------|---------|
| OpenAI | Chat, embeddings, vision, scoring | Token-based billing | None (per-request) |
| Anthropic | Chat, vision | Token-based billing | None |
| Google Gemini | Chat, vision | Token-based billing | None |
| USDA FoodData Central | Nutrition lookup | 1,000 req/hour (free) | 3-tier: memory → DB → API |
| Gmail SMTP | Magic links, training reports | Standard Gmail limits | None |

---

## 13. Configuration

### 13.1 Environment Variables

**Database:**
- `DATABASE_URL` — PostgreSQL connection string
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

**Redis:**
- `REDIS_HOST`, `REDIS_PORT`

**Service URLs (Docker networking):**
- `MEMORY_SERVICE_URL` (http://memory-service:3000)
- `PAYMENTS_SERVICE_URL` (http://payments-service:3010)
- `GENERAL_SERVICE_URL` (http://general-service:3011)
- `DIET_SERVICE_URL` (http://diet-service:3012)
- `HARMONY_SERVICE_URL` (http://harmony-service:3013)

**API Keys:**
- `OPENAI_API_KEY` — Required (embeddings + default LLM)
- `ANTHROPIC_API_KEY` — Optional (Claude models)

**Auth & Email:**
- `ADMIN_EMAIL` — Admin user email
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

**Production:**
- `NODE_ENV` — production
- `CORS_ORIGIN` — https://oggy-v1.com
- `INTERNAL_API_KEY` — Service-to-service auth

**Observability:**
- `OTEL_EXPORTER_OTLP_ENDPOINT` — OpenTelemetry collector URL
- `OTEL_SERVICE_NAME` — Service identifier for traces

---

## 14. Directory Structure

```
oggy/
├── deploy/                          # Deployment scripts
│   ├── deploy.sh                    # Main deploy script
│   ├── backup-postgres.sh           # DB backup
│   ├── restore-postgres.sh          # DB restore
│   ├── ec2-setup.sh                 # EC2 initialization
│   ├── setup-cron.sh                # Cron jobs
│   └── setup-tunnel.sh              # Cloudflare Tunnel
│
├── docs/                            # Documentation
│   ├── SYSTEMS-DESIGN.md            # High-level design
│   ├── SYSTEMS-ARCHITECTURE.md      # This document
│   ├── AUDIT-ARCHITECTURE.md        # Audit system design
│   ├── ENVIRONMENT-SETUP.md         # Dev environment guide
│   └── contracts.md                 # API contracts
│
├── services/
│   ├── applications/                # Main app (gateway + domains)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── db/init/                 # Shared SQL migrations
│   │   ├── public/                  # Frontend (HTML, CSS, JS)
│   │   │   ├── css/style.css
│   │   │   ├── js/                  # 22 JavaScript files
│   │   │   └── *.html               # 20 HTML pages
│   │   └── src/
│   │       ├── gateway.js           # API gateway entry
│   │       ├── payments-entry.js    # FinSense service entry
│   │       ├── general-entry.js     # GenExplorer service entry
│   │       ├── diet-entry.js        # HealthAssist service entry
│   │       ├── harmony-entry.js     # Harmony service entry
│   │       ├── index.js             # Monolith fallback
│   │       ├── shared/
│   │       │   ├── middleware/      # auth, costGovernor, internalService
│   │       │   ├── providers/       # LLM adapters (4 providers)
│   │       │   ├── routes/          # 18 shared route files
│   │       │   ├── services/        # 24 shared service files
│   │       │   ├── utils/           # 14 utility modules
│   │       │   └── DomainAdapter.js # Domain registry
│   │       └── domains/
│   │           ├── payments/         # FinSense domain
│   │           │   ├── routes/      # 4 route files
│   │           │   ├── services/    # 9 service files
│   │           │   └── db/          # 2 migration files
│   │           ├── general/         # GenExplorer domain
│   │           │   ├── routes/      # 2 route files
│   │           │   ├── services/    # 6 service files
│   │           │   └── db/          # 3 migration files
│   │           ├── diet/            # HealthAssist domain
│   │           │   ├── routes/      # 1 route file
│   │           │   ├── services/    # 5 service files
│   │           │   └── db/          # 4 migration files
│   │           └── harmony/         # Harmony domain
│   │               ├── routes/      # 2 route files
│   │               ├── services/    # 10 service files
│   │               └── db/          # 5 migration files
│   │
│   ├── memory/                      # Memory service
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── db/init/                 # 5 migration files
│   │   └── src/
│   │       ├── index.js
│   │       ├── middleware/auth.js
│   │       ├── routes/              # cards, retrieval, audit, utility
│   │       └── utils/embeddings.js
│   │
│   └── learning/                    # Learning service (Python)
│       ├── Dockerfile
│       ├── requirements.txt
│       ├── main.py                  # FastAPI entry
│       ├── scoring.py
│       ├── agents/                  # base_agent, oggy_agent
│       ├── cir/                     # Core Integrity Rules
│       ├── evaluation/              # Evaluation runner
│       └── loop/                    # Learning loop orchestration
│
├── docker-compose.yml               # Development
├── docker-compose.staging.yml       # Production (EC2)
├── docker-compose.prod.yml          # Alternate production
└── .env.example                     # Environment template
```

---

## 15. Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **No frontend framework** | Vanilla JS | Zero build step, fast iteration, small bundle size, no framework churn |
| **Single Docker image, multiple containers** | oggy-app:latest | Simplifies CI, one build for 5 services |
| **PostgreSQL for vectors** | JSONB embeddings | Avoids pgvector dependency; sufficient for current scale |
| **REST over gRPC** | Express.js REST | Simpler debugging, browser-compatible, adequate for current traffic |
| **Magic links over passwords** | Nodemailer + tokens | Zero password management, invite-only access control |
| **Python for learning service** | FastAPI | Better ML ecosystem, async PostgreSQL, scheduled jobs |
| **Sealed benchmarks** | Immutable test sets | Scientific measurement prevents overfitting |
| **Circuit breakers** | Custom implementation | Lightweight, no external dependency, 5xx-only trips |
| **Cloudflare Tunnel** | Native (not Docker) | Avoids Docker networking issues, reliable HTTPS |
| **Observer federated learning** | PII-stripped packs | Privacy-preserving cross-tenant learning |
