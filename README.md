# Oggy

A continuously learning AI agent that improves from user feedback and benchmark-driven training. Oggy powers four domain agents — expense categorization, general conversation, diet tracking, and harmony mapping — each with its own training pipeline, memory system, and performance analytics.

Live at **https://oggy-v1.com**

## Architecture

```
Browser --> Cloudflare Tunnel --> Gateway (:3001)
                                    |-- static files, auth, CORS
                                    |-- shared routes (preferences, settings, analytics)
                                    |-- proxy --> Payments Service (:3010)
                                    |-- proxy --> General Service  (:3011)
                                    |-- proxy --> Diet Service     (:3012)
                                    |-- proxy --> Harmony Service  (:3013)
                                    |
                                 Memory Service (:3000)
                                    |
                              +-----+-----+
                              |           |
                          PostgreSQL    Redis
                            :5432      :6379

                         Learning Service (:8000)
                            (Python/FastAPI)
```

All application services share a single Docker image (`oggy-app`) with different entry points. The gateway validates auth and proxies requests to domain services via `X-User-Id` headers.

## Services

| Service | Port | Stack | Role |
|---------|------|-------|------|
| Gateway | 3001 | Node.js/Express | Auth, static files, CORS, proxy |
| Payments | 3010 | Node.js/Express | Expense categorization, chat, training, benchmarks |
| General | 3011 | Node.js/Express | General conversation, projects |
| Diet | 3012 | Node.js/Express | Diet tracking, nutrition, meal logging |
| Harmony | 3013 | Node.js/Express | Harmony Map, city scores, indicators, scenarios |
| Memory | 3000 | Node.js/Express | Vector memory CRUD, semantic retrieval, utility updates |
| Learning | 8000 | Python/FastAPI | Agent orchestration, scoring, training loops |
| PostgreSQL | 5432 | Postgres 15 | Persistent storage |
| Redis | 6379 | Redis 7 | Cache, working memory, session state |

## Features

**Learning System**
- Memory-augmented responses using retrieved context
- Continuous training with auto-generated benchmarks (Tessa)
- Difficulty scaling across 5 levels (S1-S5) with 3 sub-levels each
- Benchmark-driven targeted learning from weakness analysis
- Federated learning via Observer (cross-tenant knowledge packs)

**Payments Domain**
- Expense entry with AI categorization suggestions
- Receipt scanning via vision LLM (images + PDF)
- Diet transfer toggle — suggest diet entries for food/drink purchases
- Oggy vs Base model comparison (side-by-side chat)
- Self-driven inquiries for ambiguous expenses
- Domain knowledge storage for categorization rules

**General Domain**
- Conversational AI with persistent memory
- Project-scoped conversations

**Diet Domain**
- Natural language meal logging
- Receipt scanning — extract food items from receipts and bulk-add to diet log
- Nutritional breakdown and daily tracking (calories, protein, carbs, fat, fiber, sugar, sodium, caffeine)
- Inline nutrition editing per entry
- Custom dietary rules

**Harmony Domain**

The Harmony Map is an interactive city well-being dashboard. It measures how well a city is doing across multiple real-world metrics — things like crime rates, employment, education, healthcare access, and civic engagement — and distills them into a single **Harmony score (H)** per city.

*How it works:*

Every city on the map is evaluated using **indicators** — measurable data points like "violent crime rate per 100k" or "high school graduation rate (%)". Each indicator belongs to one of **6 dimensions**:

| Dimension | What it measures | Example indicators |
|-----------|-----------------|-------------------|
| **Balance (B)** | Safety and economic stability | Violent crime rate, income inequality, homelessness rate |
| **Flow (F)** | Mobility and employment | Unemployment rate, commute time, transit access |
| **Compassion** | Health and welfare | Uninsured rate, food insecurity, mental health providers |
| **Discernment** | Education and civic engagement | Graduation rates, voter turnout, library access |
| **Awareness (A)** | Community and transparency | Civic engagement index, government transparency |
| **Expression (X)** | Culture and freedom | Arts organizations per capita, protest freedom |

These 6 dimensions roll up into **3 top-level scores** using geometric aggregation:

```
Care (C)        = Compassion × Discernment
Economic (E)    = cube_root(Balance × Flow × Care)
Social (S)      = sqrt(Awareness × Expression)
Harmony (H)     = sqrt(E × S)
```

All indicator values are **normalized to 0–1** using min-max bounds (e.g., violent crime ranges from 100 to 2,500 per 100k). Indicators where lower is better (like crime) are inverted so a low raw value produces a high score. Each indicator also has a **weight** (default 1.0) that controls its influence within its dimension.

*Key features:*

- **Data catalog** — Browse every indicator for a city with its raw value, normalized score, bounds, weight, and dimension. See what's driving scores up or dragging them down.
- **AI-generated suggestions** — Oggy can suggest new indicators, new data points, weight adjustments, model updates, or entirely new cities. Each suggestion goes through a **specificity guard** that rejects vague or overly broad metrics.
- **Suggestion acceptance triggers score recomputation** — When you accept a new indicator or weight change, all affected city scores are recalculated automatically.
- **What-if scenarios** — Create sandbox scenarios to project how changing an indicator value or weight would affect a city's scores, without persisting any changes.
- **Federated learning via Observer** — Users can opt-in to share accepted suggestions. The Observer aggregates them into versioned "Harmony Packs" that other users can import.
- **Daily score snapshots** — Scores are snapshotted daily for progression charts and trend analysis.
- **NEW indicator badges** — Redis-backed badges highlight recently added indicators so you can see what changed.
- **Recent actions panel** — Expandable cards showing what each accepted suggestion actually changed (indicator details, weight values, model update rationale).

**Platform**
- Magic link authentication (email-based, no passwords)
- BYO-Model settings (OpenAI, Anthropic, Google, xAI) with vision support
- Training email reports with configurable intervals
- Performance analytics dashboard per domain
- Full audit trail with evidence requirements

## Prerequisites

- Docker & Docker Compose
- OpenAI API key
- Anthropic API key (optional)
- SMTP credentials for email features (optional)

## Quick Start

### 1. Configure environment

```bash
cp .env.example .env
# Fill in: OPENAI_API_KEY, POSTGRES_PASSWORD, and optionally ANTHROPIC_API_KEY, SMTP_*
```

### 2. Start all services

```bash
docker compose up --build
```

### 3. Verify

```bash
curl http://localhost:3001/health   # Gateway (aggregated)
curl http://localhost:3000/health   # Memory Service
curl http://localhost:8000/health   # Learning Service
```

### 4. Access the app

Open `http://localhost:3001` and sign in with the email set in `ADMIN_EMAIL`.

## Development

**Run the monolith** (all domains in one process, no proxy):
```bash
cd services/applications && npm install && npm run dev
```

**Run microservices locally:**
```bash
docker compose up  # Uses volume mounts for hot reload
```

**Run only infrastructure:**
```bash
docker compose up postgres redis
```

## Production Deployment (EC2)

Hosted on a t3.small via Cloudflare Tunnel. Resource limits tuned for 2GB RAM.

```bash
# First-time setup
./deploy/ec2-setup.sh        # Docker, UFW, swap, cloudflared
./deploy/setup-tunnel.sh     # Cloudflare Tunnel as systemd service
./deploy/setup-cron.sh       # Nightly backups, weekly Docker prune

# Deploy
./deploy/deploy.sh           # Pull, backup, build, deploy, health check

# Database
./deploy/backup-postgres.sh  # Manual backup to S3
./deploy/restore-postgres.sh # Restore from S3 (--list to see available)
```

## API Overview

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/auth/request-magic-link` | Send login email |
| GET | `/v0/auth/verify?token=` | Verify magic link |
| GET | `/v0/auth/me` | Current user info + CSRF token |

### Payments
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/expenses` | Add expense |
| POST | `/v0/categorization/suggest` | AI categorization |
| POST | `/v0/chat` | Chat with Oggy (Oggy + Base responses) |
| POST | `/v0/continuous-learning/start` | Start training session |
| POST | `/v0/sealed-benchmark/create` | Create fixed benchmark |
| POST | `/v0/sealed-benchmark/test` | Run Oggy vs Base |

### General
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/general/chat` | Chat with general assistant |
| GET | `/v0/general/projects` | List projects |

### Diet
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/diet/chat` | Chat with diet agent |
| POST | `/v0/diet/entries` | Log a meal |
| GET | `/v0/diet/nutrition` | Nutrition summary |
| GET | `/v0/diet/rules` | Dietary rules |

### Harmony
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v0/harmony/nodes` | List all city nodes with scores |
| GET | `/v0/harmony/node/:id/explain` | Indicator explainability + recent actions |
| POST | `/v0/harmony/compute/:id` | Recompute scores for a node |
| POST | `/v0/harmony/compute-all` | Recompute all city scores |
| POST | `/v0/harmony/generate-suggestions` | AI-generate suggestions for a node |
| POST | `/v0/harmony/suggestions/:id/accept` | Accept a suggestion (triggers recompute) |
| POST | `/v0/harmony/scenario` | Create what-if scenario |
| GET | `/v0/harmony/scenario/:id/compare` | Compare scenario projections |
| POST | `/v0/harmony/chat` | Chat with harmony agent |

### Receipt Analysis
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/receipt/analyze` | Extract items from receipt image/PDF via vision LLM |

### Shared
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v0/service-health/circuit-breakers` | Circuit breaker status |
| GET | `/v0/benchmark-analytics` | Training analytics |
| POST | `/v0/preferences/feedback` | Submit response feedback |
| GET | `/v0/settings` | BYO-Model configuration |

## Project Structure

```
services/
  applications/          # All Node.js services (shared image)
    src/
      gateway.js         # API Gateway entry point
      payments-entry.js  # Payments domain entry point
      general-entry.js   # General domain entry point
      diet-entry.js      # Diet domain entry point
      harmony-entry.js   # Harmony domain entry point
      index.js           # Monolith fallback (npm start)
      domains/
        payments/        # Payments routes + services
        general/         # General routes + services
        diet/            # Diet routes + services
        harmony/         # Harmony Map routes, services, DB migrations
      shared/
        middleware/       # Auth, CSRF, cost governor, internal service
        routes/           # Shared routes (training, evaluation, settings, etc.)
        services/         # Chat handler, training reporter, observer, etc.
        utils/            # DB, Redis, logger, telemetry, migrations
    public/              # Frontend (HTML, CSS, JS)
  memory/                # Memory Service (separate image)
  learning/              # Learning Service (Python, separate image)
deploy/                  # EC2 deployment scripts
data/                    # Practice packs, sealed benchmarks
```

## License

Proprietary - All rights reserved
