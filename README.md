# Oggy

A continuously learning AI agent that improves from user feedback and benchmark-driven training. Oggy powers three domain agents — expense categorization, general conversation, and diet tracking — each with its own training pipeline, memory system, and performance analytics.

Live at **https://oggy-v1.com**

## Architecture

```
Browser --> Cloudflare Tunnel --> Gateway (:3001)
                                    |-- static files, auth, CORS
                                    |-- shared routes (preferences, settings, analytics)
                                    |-- proxy --> Payments Service (:3010)
                                    |-- proxy --> General Service  (:3011)
                                    |-- proxy --> Diet Service     (:3012)
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
- Oggy vs Base model comparison (side-by-side chat)
- Self-driven inquiries for ambiguous expenses
- Domain knowledge storage for categorization rules

**General Domain**
- Conversational AI with persistent memory
- Project-scoped conversations

**Diet Domain**
- Natural language meal logging
- Nutritional breakdown and daily tracking
- Custom dietary rules

**Platform**
- Magic link authentication (email-based, no passwords)
- BYO-Model settings (OpenAI, Anthropic, Google, xAI)
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
      index.js           # Monolith fallback (npm start)
      domains/
        payments/        # Payments routes + services
        general/         # General routes + services
        diet/            # Diet routes + services
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
