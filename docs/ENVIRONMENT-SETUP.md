# Environment Setup Guide

## Quick Start

1. **Copy the example environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Update required variables in `.env`:**
   - `OPENAI_API_KEY` - Get from https://platform.openai.com/api-keys

3. **Optional variables** (defaults work for local dev):
   - `INTERNAL_API_KEY` - Set for production auth
   - Database/Redis settings if not using Docker defaults

4. **Start the services:**
   ```bash
   docker-compose up --build
   ```

---

## Docker vs Local Development

### Docker Compose (Recommended)

When using `docker-compose up`, service hostnames automatically change:
- `POSTGRES_HOST=postgres` (not localhost)
- `REDIS_HOST=redis` (not localhost)
- `MEMORY_SERVICE_URL=http://memory-service:3000`
- `DATABASE_URL=postgresql://oggy:oggy_password@postgres:5432/oggy_db`

These are automatically set in `docker-compose.yml` and override `.env` values.

**Advantages:**
- All dependencies (PostgreSQL, Redis, OTel) included
- Consistent environment across team members
- Automatic database migrations on startup
- No local installation required

### Local Development

If running services outside Docker:

1. **Install dependencies:**
   - PostgreSQL 13+ running on localhost:5432
   - Redis running on localhost:6379
   - Node.js 20+
   - Python 3.11+

2. **Use localhost for all hosts:**
   ```bash
   POSTGRES_HOST=localhost
   POSTGRES_PORT=5432
   REDIS_HOST=localhost
   REDIS_PORT=6379
   MEMORY_SERVICE_URL=http://localhost:3000
   ```

3. **Start services manually:**
   ```bash
   # Memory service
   cd services/memory
   npm install
   npm run dev

   # Learning service
   cd services/learning
   pip install -r requirements.txt
   uvicorn main:app --reload
   ```

---

## Required Variables

| Variable | Required | Purpose | Example |
|----------|----------|---------|---------|
| `OPENAI_API_KEY` | **YES** | Embeddings & LLM scoring | `sk-proj-abc123...` |
| `POSTGRES_USER` | **YES** | Database username | `oggy` |
| `POSTGRES_PASSWORD` | **YES** | Database password | `oggy_dev_password` |
| `POSTGRES_DB` | **YES** | Database name | `oggy_db` |
| `POSTGRES_HOST` | No | Database host | `localhost` (default) |
| `POSTGRES_PORT` | No | Database port | `5432` (default) |
| `REDIS_HOST` | No | Redis host | `localhost` (default) |
| `REDIS_PORT` | No | Redis port | `6379` (default) |
| `DATABASE_URL` | No* | Full DB connection string | See .env.example |
| `MEMORY_SERVICE_URL` | No | Memory service URL | `http://localhost:3000` |
| `INTERNAL_API_KEY` | Production only | Service auth | `your-secret-key` |

\* `DATABASE_URL` is required for learning service if running outside Docker. Docker sets this automatically.

---

## Environment Variables Explained

### Database Configuration

**Individual variables (used by memory service):**
```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=oggy
POSTGRES_PASSWORD=oggy_dev_password
POSTGRES_DB=oggy_db
```

**Connection string (used by learning service):**
```bash
DATABASE_URL=postgresql://oggy:oggy_dev_password@localhost:5432/oggy_db
```

Both formats point to the same database. Memory service uses pg (Node.js), learning service uses asyncpg (Python).

### Service URLs

**MEMORY_SERVICE_URL:**
- Learning service uses this to call memory service API
- Docker: `http://memory-service:3000` (internal Docker network)
- Local: `http://localhost:3000`

### Authentication

**INTERNAL_API_KEY:**
- Optional in development (auth disabled if not set)
- **Required in production**
- Used for service-to-service authentication
- Pass via `x-api-key` header:
  ```bash
  curl -H "x-api-key: your-secret" http://localhost:3000/cards
  ```

### OpenAI API

**OPENAI_API_KEY:**
- Get from: https://platform.openai.com/api-keys
- Used for:
  - Generating embeddings (text-embedding-3-small)
  - LLM-as-judge scoring (gpt-4o)
  - Agent responses (gpt-4o, gpt-4o-mini)
- Format: `sk-proj-...` or `sk-...`

---

## Verification

### 1. Check Services are Running

```bash
# Memory service health
curl http://localhost:3000/health
```

Expected response:
```json
{
  "ok": true,
  "service": "memory-service",
  "version": "0.1.0",
  "postgres": "connected",
  "redis": "connected",
  "timestamp": "2026-02-01T..."
}
```

```bash
# Learning service health
curl http://localhost:8000/health
```

Expected response:
```json
{
  "ok": true,
  "service": "learning-service",
  "version": "0.1.0",
  "memory_service": "http://memory-service:3000"
}
```

### 2. Check Database Connection

```bash
docker exec oggy-postgres psql -U oggy -d oggy_db -c "SELECT version();"
```

### 3. Check Redis Connection

```bash
docker exec oggy-redis redis-cli ping
```

Expected: `PONG`

### 4. Verify Environment Variables Loaded

**Memory service:**
```bash
docker exec oggy-memory-service env | grep POSTGRES
docker exec oggy-memory-service env | grep REDIS
```

**Learning service:**
```bash
docker exec oggy-learning-service env | grep DATABASE_URL
docker exec oggy-learning-service env | grep OPENAI_API_KEY
```

---

## Common Issues

### Issue: "OPENAI_API_KEY not set"

**Symptom:** Learning service fails to start or embedding generation fails

**Fix:** Add your OpenAI API key to `.env`:
```bash
OPENAI_API_KEY=sk-your-actual-key-here
```

Restart services:
```bash
docker-compose down
docker-compose up --build
```

### Issue: "database 'oggy_db' does not exist"

**Symptom:** Memory service can't connect to database

**Fix:** Database should be auto-created by Docker. If not:
```bash
docker-compose down
docker volume rm oggy_postgres_data
docker-compose up --build
```

### Issue: "port already in use"

**Symptom:** Docker fails to start with port conflict

**Fix:** Check what's using the port:
```bash
# Windows
netstat -ano | findstr :3000
netstat -ano | findstr :8000

# Kill the process or change ports in docker-compose.yml
```

### Issue: "auth disabled" warning

**Symptom:** See "WARNING: INTERNAL_API_KEY not set - auth disabled"

**Fix:** This is normal for development. In production, add to `.env`:
```bash
INTERNAL_API_KEY=your-secure-random-key-here
```

---

## Production Checklist

Before deploying to production:

- [ ] Set `INTERNAL_API_KEY` to a secure random value
- [ ] Change all default passwords (POSTGRES_PASSWORD, REDIS, etc.)
- [ ] Set `NODE_ENV=production`
- [ ] Use managed PostgreSQL (not Docker volume)
- [ ] Use managed Redis (not Docker volume)
- [ ] Set up proper secrets management (not .env file)
- [ ] Configure OTEL_EXPORTER_OTLP_ENDPOINT for your observability platform
- [ ] Review and restrict network access (firewall rules)
- [ ] Enable SSL/TLS for database connections
- [ ] Set up automated backups for PostgreSQL

---

## Environment File Template

Minimal `.env` for development:

```bash
# Required
OPENAI_API_KEY=sk-your-key-here

# Optional (defaults work)
# POSTGRES_HOST=localhost
# POSTGRES_PORT=5432
# POSTGRES_USER=oggy
# POSTGRES_PASSWORD=oggy_dev_password
# POSTGRES_DB=oggy_db
# REDIS_HOST=localhost
# REDIS_PORT=6379
```

Full `.env` for production:

```bash
# Database
POSTGRES_HOST=prod-db.example.com
POSTGRES_PORT=5432
POSTGRES_USER=oggy_prod
POSTGRES_PASSWORD=<strong-random-password>
POSTGRES_DB=oggy_production
DATABASE_URL=postgresql://oggy_prod:<password>@prod-db.example.com:5432/oggy_production

# Redis
REDIS_HOST=prod-redis.example.com
REDIS_PORT=6379

# Services
NODE_ENV=production
MEMORY_SERVICE_URL=http://memory-service:3000
INTERNAL_API_KEY=<strong-random-key>

# OpenAI
OPENAI_API_KEY=sk-your-production-key

# Observability
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-otel-collector.example.com:4318
OTEL_SERVICE_NAME=oggy-production
```

---

## Next Steps

After verifying your environment setup:

1. **Create some test data:**
   - [Week 3 Testing Guide](../WEEK3-COMPLETE.md#testing)

2. **Run the evaluation bundle:**
   - [Evaluation Runner Documentation](../WEEK3-COMPLETE.md#test-evaluation-runner)

3. **Test CIR gates:**
   - [CIR Testing Guide](../WEEK3-COMPLETE.md#test-cir-gates)

4. **Compare Base vs Oggy agents:**
   - [Agent Testing](../WEEK3-COMPLETE.md#test-base-vs-oggy-agents)
