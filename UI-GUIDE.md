# Oggy Payments UI Guide

## Prerequisites

- Docker Desktop running
- All services up: `docker compose up -d`
- Health check passing: `curl http://localhost:3001/health`

## Opening the UI

The UI is served directly from the payments service on port 3001. No build step required.

| Page | URL | Purpose |
|------|-----|---------|
| Enter Payment | http://localhost:3001/ | Submit new expenses |
| View Payments | http://localhost:3001/payments.html | Browse and filter expenses |
| Chat & Training | http://localhost:3001/chat.html | Chat with Oggy/Base, start training |

## Page Guide

### Enter Payment (index.html)

1. Fill in the form fields: amount, merchant, description, date
2. Choose a category from the dropdown, or select **"Let Oggy decide"** to get an AI suggestion
3. Click **Submit**
4. If Oggy suggests a category, you'll see a suggestion box — click **Accept** or **Reject** (and pick your own)
5. A toast notification confirms the expense was saved

### View Payments (payments.html)

1. On load, the page queries your recent expenses
2. Use the filter bar to narrow by:
   - Date range (start/end)
   - Category dropdown
   - Merchant name (text search)
   - Amount range (min/max)
3. Click **Apply Filters** to refresh results
4. The summary bar shows total count and total amount

### Chat & Training (chat.html)

**Chat (bottom section):**
1. Type a question in the input box (e.g., "How much did I spend on food?")
2. Press Enter or click Send
3. Both **Oggy** (left column, with memory) and **Base** (right column, without memory) respond
4. Oggy's responses show a memory badge when memory cards were used

**Training Controls (top panel):**
1. Select a duration from the dropdown: 5, 10, 15, 30, or 60 minutes
2. Click **Start Training** to begin a continuous learning session
3. The status panel updates every 5 seconds showing:
   - Current level (e.g., S2 L2)
   - Training accuracy
   - Questions answered
   - Benchmark results
   - Time remaining
4. Click **Stop Training** to end the session early
5. If training is already running when you load the page, the panel auto-detects it

**Inquiry Notifications (all pages):**
- A badge appears in the nav bar when Oggy has questions for you
- Click the notification to expand the inquiry banner
- Answer or dismiss each question

## Testing the Full Flow

### 1. Enter a few test expenses

```bash
# Food expense
curl -s -X POST http://localhost:3001/v0/expenses \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","amount":42.50,"merchant":"Chipotle","description":"Lunch burrito bowl","transaction_date":"2026-02-07","category":"food_dining","tags":["lunch"]}'

# Shopping expense
curl -s -X POST http://localhost:3001/v0/expenses \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","amount":129.99,"merchant":"Amazon","description":"Wireless headphones","transaction_date":"2026-02-06","category":"shopping","tags":["electronics"]}'

# Transportation expense
curl -s -X POST http://localhost:3001/v0/expenses \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","amount":65.00,"merchant":"Shell","description":"Gas fill up","transaction_date":"2026-02-05","category":"transportation","tags":["gas"]}'
```

### 2. Verify expenses show up

```bash
curl -s -X POST http://localhost:3001/v0/query \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","limit":10}'
```

Or open http://localhost:3001/payments.html in your browser.

### 3. Test Oggy categorization

```bash
curl -s -X POST http://localhost:3001/v0/categorization/suggest \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","merchant":"Starbucks","amount":5.75,"description":"Morning coffee"}'
```

### 4. Test chat

```bash
curl -s -X POST http://localhost:3001/v0/chat \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","message":"How much did I spend on food this week?"}'
```

### 5. Start a training session

```bash
# Start 10-minute training
curl -s -X POST http://localhost:3001/v0/continuous-learning/start \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","duration_minutes":10,"run_benchmarks":true}'

# Check status
curl -s http://localhost:3001/v0/continuous-learning/status?user_id=oggy

# Stop training
curl -s -X POST http://localhost:3001/v0/continuous-learning/stop \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy"}'
```

### 6. Test inquiry system

```bash
# Check pending inquiries (triggers lazy generation if none exist)
curl -s http://localhost:3001/v0/inquiries/pending?user_id=oggy

# Check/update preferences
curl -s http://localhost:3001/v0/inquiries/preferences?user_id=oggy

# Change max questions per day
curl -s -X PUT http://localhost:3001/v0/inquiries/preferences \
  -H "Content-Type: application/json" \
  -d '{"user_id":"oggy","max_questions_per_day":3}'
```

## Checking Logs

### Live payments service logs

```bash
# Follow logs in real time
docker logs -f oggy-payments-service

# Last 50 lines
docker logs oggy-payments-service --tail 50

# Filter for errors only (Windows)
docker logs oggy-payments-service 2>&1 | findstr "error"

# Filter for errors only (Mac/Linux)
docker logs oggy-payments-service 2>&1 | grep -i "error"
```

### Memory service logs

```bash
docker logs -f oggy-memory-service
```

### Database queries

```bash
# Connect to Postgres
docker exec -it oggy-postgres psql -U oggy -d oggy_db

# Useful queries:
# List all expenses
SELECT expense_id, merchant, amount, category, transaction_date FROM expenses ORDER BY created_at DESC;

# Check Oggy's training level
SELECT * FROM continuous_learning_state WHERE user_id = 'oggy';

# View recent app events
SELECT event_id, event_type, user_id, ts FROM app_events ORDER BY ts DESC LIMIT 20;

# Check inquiry tables
SELECT * FROM oggy_inquiries WHERE user_id = 'oggy' ORDER BY created_at DESC;
SELECT * FROM oggy_inquiry_preferences;

# Count memory cards
SELECT COUNT(*) FROM memory_cards;
```

### Service health

```bash
# Full health check
curl -s http://localhost:3001/health | python -m json.tool

# Circuit breaker status
curl -s http://localhost:3001/v0/service-health/circuit-breakers

# Token budget status (included in health check output)
curl -s http://localhost:3001/health | python -m json.tool
```

### Common log patterns to watch for

| Log Pattern | Meaning |
|-------------|---------|
| `Daily token budget exceeded` | 20M token budget hit — training will use fallback categorizer |
| `Circuit breaker OPEN` | Too many failures to a dependency — auto-recovers after cooldown |
| `memory retrieval failed` | Memory service returned no cards — normal for new users |
| `Benchmark.*PASSED` | Oggy beat or matched Base on a sealed benchmark |
| `Promoted to S*` | Oggy advanced to a new difficulty level |

## Rebuilding After Code Changes

```bash
# Rebuild and restart payments service only
docker compose up -d --build payments-service

# Rebuild everything
docker compose up -d --build

# Full reset (destroys data)
docker compose down -v && docker compose up -d --build
```

## Configuration

Key environment variables in `docker-compose.yml`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DAILY_TOKEN_BUDGET` | 20000000 | Max OpenAI tokens per day |
| `OPENAI_MODEL` | gpt-4o-mini | Model for categorization and chat |
| `PORT` | 3001 | Payments service port |
