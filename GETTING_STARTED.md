# Getting Started with Oggy

How to set up a local Oggy, train it, and migrate it to the hosted instance at `oggy-v1.com`.

## Prerequisites

- **Docker Desktop** installed and running
- **Git** to clone the repository
- An **OpenAI API key** (required for categorization and training)
- An **Anthropic API key** (optional, used for benchmark generation)

## Step 1: Clone and configure

```bash
git clone <repo-url> Oggy
cd Oggy
```

Create a `.env` file in the project root with the following values:

```env
# Required
OPENAI_API_KEY=sk-proj-your-openai-key-here

# Optional (improves benchmark diversity)
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key-here

# Database (defaults work out of the box)
POSTGRES_USER=oggy
POSTGRES_PASSWORD=oggy_dev_password
POSTGRES_DB=oggy_db

# Services
NODE_ENV=development
MEMORY_SERVICE_PORT=3000

# Leave email settings empty for local dev (reports will be logged, not emailed)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
ADMIN_EMAIL=admin@oggy.local
```

Only `OPENAI_API_KEY` is strictly required. Everything else has working defaults.

## Step 2: Start the services

```bash
docker compose up -d
```

This starts 5 containers:
- `oggy-postgres` — PostgreSQL database (port 5432)
- `oggy-redis` — Redis cache (port 6379)
- `oggy-otel-collector` — OpenTelemetry collector
- `oggy-memory-service` — Memory/embedding service (port 3000)
- `oggy-payments-service` — Main Oggy service (port 3001)

Wait about 15 seconds for startup, then verify:

```bash
curl http://localhost:3001/health
```

You should see `{"ok":true, ...}`.

## Step 3: Use Oggy locally

Open `http://localhost:3001` in your browser. In development mode, auth is relaxed — you'll be automatically logged in.

**Chat page**: Talk to Oggy, categorize expenses, ask spending questions.

**Train Oggy**: On the chat page, use the training panel at the top. Select a duration (e.g. 10 minutes) and click "Start Training". Oggy will practice categorizing expenses, run benchmarks, and learn from mistakes.

**Analytics**: Visit `http://localhost:3001/analytics.html` to see benchmark performance charts and category accuracy.

## Step 4: Export your trained Oggy

Once you've trained Oggy and are happy with its performance, export the bundle:

```bash
curl -s "http://localhost:3001/v0/migration/export?user_id=oggy" -o oggy-bundle.json
```

Check the export stats:

```bash
# Linux/Mac
python3 -c "import sys,json; d=json.load(open('oggy-bundle.json')); print(json.dumps(d['stats'], indent=2))"

# Windows PowerShell
Get-Content oggy-bundle.json | python -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['stats'], indent=2))"
```

You should see counts for `domain_knowledge_count`, `expenses_count`, and `memory_cards_count`.

## Step 5: Get access to the hosted instance

Ask the admin (the person who runs `oggy-v1.com`) to add your email to the allowlist. They'll do this from the admin panel or via API.

## Step 6: Log in to the hosted instance

1. **Request a magic link:**
```bash
curl -X POST https://oggy-v1.com/v0/auth/request-magic-link \
  -H "Content-Type: application/json" \
  -d '{"email": "your-email@example.com"}'
```

2. **Check your email** and click the magic link. This opens `oggy-v1.com` in your browser and sets your session cookie.

3. **Get your CSRF token** (needed for the import). In the browser console (F12 > Console):
```javascript
fetch('/v0/auth/me').then(r => r.json()).then(d => console.log('CSRF:', d.csrf_token))
```

Or extract the session cookie from your browser and use curl:
```bash
curl -s -b "oggy_session=YOUR_SESSION_COOKIE" https://oggy-v1.com/v0/auth/me
```

## Step 7: Import your Oggy bundle

Upload the exported bundle to the hosted instance:

```bash
# Linux/Mac:
curl -X POST https://oggy-v1.com/v0/migration/import \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: YOUR_CSRF_TOKEN" \
  -b "oggy_session=YOUR_SESSION_COOKIE" \
  -d "{\"bundle\": $(cat oggy-bundle.json)}"
```

```powershell
# Windows PowerShell:
$bundle = Get-Content oggy-bundle.json -Raw
$body = '{"bundle": ' + $bundle + '}'
Invoke-RestMethod -Uri "https://oggy-v1.com/v0/migration/import" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-csrf-token"="YOUR_CSRF_TOKEN" } `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -WebSession $session
```

The response shows what was imported:
```json
{
  "success": true,
  "imported": {
    "domain_knowledge": 10557,
    "expenses": 5,
    "memory_cards": 1102,
    "learning_state": true,
    "errors": []
  }
}
```

## Step 8: Verify on the hosted instance

Visit `https://oggy-v1.com` in your browser. You should see your Oggy's level displayed. Try categorizing an expense to confirm your trained knowledge transferred.

---

## .env Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | — | OpenAI API key for categorization and chat |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key for benchmark generation |
| `POSTGRES_USER` | No | `oggy` | PostgreSQL username |
| `POSTGRES_PASSWORD` | No | `oggy_dev_password` | PostgreSQL password |
| `POSTGRES_DB` | No | `oggy_db` | PostgreSQL database name |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `ADMIN_EMAIL` | No | `admin@oggy.local` | Admin email for auth allowlist |
| `SMTP_HOST` | No | — | SMTP server for email reports |
| `SMTP_PORT` | No | `587` | SMTP port |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password (use app password for Gmail) |
| `SMTP_FROM` | No | — | Sender email address |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin (set to your domain in production) |
| `DAILY_TOKEN_BUDGET` | No | `20000000` | Daily OpenAI token budget |

## Rebuilding after code changes

```bash
docker compose up -d --build payments-service
```

## Architecture

```
localhost:3001  ─── payments-service (Node.js)
                     ├── Chat + Categorization (OpenAI)
                     ├── Training loop + Benchmarks
                     ├── Analytics dashboard
                     └── Auth (magic link)
localhost:3000  ─── memory-service (Node.js)
                     └── Embeddings + Memory cards
localhost:5432  ─── PostgreSQL
localhost:6379  ─── Redis
```

## Common Commands

```bash
# Start everything
docker compose up -d

# Check health
curl http://localhost:3001/health

# View logs
docker logs oggy-payments-service --tail 50

# Restart after code changes
docker compose up -d --build payments-service

# Stop everything
docker compose down

# Stop and remove data (fresh start)
docker compose down -v
```
