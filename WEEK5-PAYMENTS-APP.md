# Week 5: Payments App Minimal Surface

## Overview

Week 5 deliverables implement a minimal payments application that integrates with the memory substrate and enables continuous learning for Oggy.

### Components Implemented

1. **Payments Service** (`services/payments/`)
   - Express.js REST API
   - CRUD operations for expenses
   - Query and analysis endpoints
   - Oggy-powered categorization service

2. **Database Schema**
   - `expenses`: Core expense tracking
   - `app_events`: Training data pipeline source
   - `domain_knowledge`: Knowledge corpus for Tessa assessment generation
   - `knowledge_promotions`: Audit trail for knowledge → memory promotions

3. **Training Pipeline**
   - Event emission on all user actions
   - Background event processor
   - Feeds to domain_knowledge (for Tessa)
   - Feeds to memory substrate (for Oggy learning)

4. **Oggy Integration**
   - Memory retrieval for context
   - AI-powered category suggestions
   - Feedback loop (user accepts/rejects → memory updates)

## Architecture

```
┌─────────────┐
│   User/App  │
└──────┬──────┘
       │
       ▼
┌──────────────────┐       ┌─────────────────┐
│ Payments Service │◄─────►│ Memory Service  │
│  (Port 3001)     │       │  (Port 3000)    │
└────────┬─────────┘       └─────────────────┘
         │
         │ writes
         ▼
┌──────────────────┐
│    PostgreSQL    │
│  - expenses      │
│  - app_events    │
│  - domain_know...│
└────────┬─────────┘
         │
         │ reads
         ▼
┌──────────────────┐       ┌─────────────────┐
│  Event Processor │──────►│ Memory Substrate│
│  (Background)    │       │   (via Memory   │
└──────────────────┘       │    Service)     │
                           └─────────────────┘
```

## Setup & Installation

### 1. Start Services

```bash
# Start all services
docker-compose up -d

# Check service health
docker-compose ps
```

### 2. Initialize Payments Database

```bash
# Run initialization script
./scripts/init-payments-db.sh
```

Or manually:

```bash
# Connect to postgres container
docker exec -it oggy-postgres psql -U oggy -d oggy_db

# Apply schemas
\i /path/to/services/payments/db/init/01_payments_init.sql
\i /path/to/services/payments/db/init/02_domain_knowledge.sql
\i /path/to/services/payments/db/init/03_seed_and_views.sql
```

### 3. Verify Setup

```bash
# Check payments service health
curl http://localhost:3001/health

# Check memory service health
curl http://localhost:3000/health

# Check database tables
docker exec -it oggy-postgres psql -U oggy -d oggy_db -c "\dt"
```

Expected tables:
- expenses
- app_events
- domain_knowledge
- knowledge_promotions
- memory_cards (from memory service)
- retrieval_traces (from memory service)

## API Endpoints

### Expenses API

**Base URL:** `http://localhost:3001/v0/expenses`

#### Create Expense
```bash
curl -X POST http://localhost:3001/v0/expenses \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user_1",
    "amount": 45.50,
    "currency": "USD",
    "description": "Lunch at Pizza Place",
    "merchant": "Pizza Place",
    "transaction_date": "2026-03-05",
    "category": "dining",
    "tags": ["lunch", "work"]
  }'
```

#### Get Expense
```bash
curl http://localhost:3001/v0/expenses/{expense_id}
```

#### Update Expense
```bash
curl -X PUT http://localhost:3001/v0/expenses/{expense_id} \
  -H "Content-Type: application/json" \
  -d '{
    "category": "business_meal",
    "notes": "Client lunch meeting"
  }'
```

#### Categorize Expense
```bash
curl -X POST http://localhost:3001/v0/expenses/{expense_id}/categorize \
  -H "Content-Type: application/json" \
  -d '{
    "category": "dining",
    "source": "user"
  }'
```

### Query API

**Base URL:** `http://localhost:3001/v0/query`

#### Query Expenses
```bash
curl -X POST http://localhost:3001/v0/query \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user_1",
    "start_date": "2026-03-01",
    "end_date": "2026-03-31",
    "category": "dining",
    "limit": 50
  }'
```

#### Get Categories
```bash
curl "http://localhost:3001/v0/query/categories?user_id=test_user_1"
```

#### Get Merchants
```bash
curl "http://localhost:3001/v0/query/merchants?user_id=test_user_1"
```

#### Get Summary
```bash
curl "http://localhost:3001/v0/query/summary?user_id=test_user_1"
```

### Categorization API (Oggy)

**Base URL:** `http://localhost:3001/v0/categorization`

#### Suggest Category
```bash
curl -X POST http://localhost:3001/v0/categorization/suggest \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user_1",
    "expense_id": "uuid-here",
    "amount": 45.00,
    "merchant": "Italian Bistro",
    "description": "Client dinner",
    "transaction_date": "2026-03-05"
  }'
```

Response includes:
- `suggested_category`: AI suggestion
- `confidence`: 0.0-1.0
- `reasoning`: Explanation
- `trace_id`: Memory retrieval trace (for feedback loop)
- `alternatives`: Other possible categories

## Testing the Learning Pipeline

### Test Scenario 1: User Accepts Oggy's Suggestion

```bash
# Step 1: Create an expense without category
EXPENSE=$(curl -s -X POST http://localhost:3001/v0/expenses \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "test_user_1",
    "amount": 45.00,
    "merchant": "Italian Bistro",
    "description": "Dinner with client",
    "transaction_date": "2026-03-05"
  }')

EXPENSE_ID=$(echo $EXPENSE | jq -r '.expense_id')
echo "Created expense: $EXPENSE_ID"

# Step 2: Get Oggy's suggestion
SUGGESTION=$(curl -s -X POST http://localhost:3001/v0/categorization/suggest \
  -H "Content-Type: application/json" \
  -d "{
    \"user_id\": \"test_user_1\",
    \"expense_id\": \"$EXPENSE_ID\",
    \"amount\": 45.00,
    \"merchant\": \"Italian Bistro\",
    \"description\": \"Dinner with client\",
    \"transaction_date\": \"2026-03-05\"
  }")

echo "Suggestion: $SUGGESTION"
CATEGORY=$(echo $SUGGESTION | jq -r '.suggested_category')
TRACE_ID=$(echo $SUGGESTION | jq -r '.trace_id')
CONFIDENCE=$(echo $SUGGESTION | jq -r '.confidence')

# Step 3: User accepts suggestion
curl -X POST http://localhost:3001/v0/expenses/$EXPENSE_ID/categorize \
  -H "Content-Type: application/json" \
  -d "{
    \"category\": \"$CATEGORY\",
    \"source\": \"oggy_accepted\",
    \"suggestion_data\": {
      \"suggested_category\": \"$CATEGORY\",
      \"trace_id\": \"$TRACE_ID\",
      \"confidence\": $CONFIDENCE
    }
  }"

# This creates EXPENSE_CATEGORIZED_BY_OGGY event
# Event processor will update memory cards with positive feedback
```

### Test Scenario 2: User Rejects Oggy's Suggestion

```bash
# Follow steps 1-2 from above, then:

# Step 3: User rejects and chooses different category
curl -X POST http://localhost:3001/v0/expenses/$EXPENSE_ID/categorize \
  -H "Content-Type: application/json" \
  -d "{
    \"category\": \"business_meal\",
    \"source\": \"oggy_rejected\",
    \"suggestion_data\": {
      \"suggested_category\": \"$CATEGORY\",
      \"trace_id\": \"$TRACE_ID\",
      \"confidence\": $CONFIDENCE
    }
  }"

# This creates CATEGORY_SUGGESTION_REJECTED event
# Event processor will update memory cards with negative feedback (demote)
```

### Test Scenario 3: Verify Event Processing

```bash
# Check unprocessed events
docker exec -it oggy-postgres psql -U oggy -d oggy_db -c \
  "SELECT event_id, event_type, processed_for_domain_knowledge, processed_for_memory_substrate
   FROM app_events
   ORDER BY ts DESC
   LIMIT 10;"

# Trigger manual event processing
curl -X POST http://localhost:3001/v0/process-events \
  -H "Content-Type: application/json" \
  -d '{"limit": 100}'

# Check domain knowledge entries
docker exec -it oggy-postgres psql -U oggy -d oggy_db -c \
  "SELECT knowledge_id, topic, subtopic, visibility
   FROM domain_knowledge
   ORDER BY created_at DESC
   LIMIT 5;"

# Check memory audit log (memory service)
curl http://localhost:3000/v0/audit?limit=10
```

## Verification: Exit Criteria

**Week 5 Exit Criteria:** "You can enter expenses, and Oggy can train/evaluate on that data."

### ✅ Checklist

1. **Create Expenses**
   ```bash
   # User can create expenses via API
   curl -X POST http://localhost:3001/v0/expenses -d '...'
   ```

2. **Oggy Suggests Categories**
   ```bash
   # Oggy uses memory retrieval to suggest categories
   curl -X POST http://localhost:3001/v0/categorization/suggest -d '...'
   # Returns trace_id proving memory was used
   ```

3. **User Feedback Creates Events**
   ```bash
   # User accepts/rejects → generates app_event
   # Check: SELECT * FROM app_events;
   ```

4. **Events Feed Domain Knowledge**
   ```bash
   # Events are processed into domain_knowledge
   # Check: SELECT * FROM domain_knowledge;
   ```

5. **Events Feed Memory Substrate**
   ```bash
   # Events update memory cards with feedback
   # Check: SELECT * FROM memory_audit_events;
   ```

6. **Background Processing Works**
   ```bash
   # Event processor runs every minute
   # Check logs: docker logs oggy-payments-service
   ```

## Monitoring & Debugging

### Check Service Logs

```bash
# Payments service
docker logs -f oggy-payments-service

# Memory service
docker logs -f oggy-memory-service

# Postgres
docker logs oggy-postgres
```

### Database Queries

```bash
# Connect to database
docker exec -it oggy-postgres psql -U oggy -d oggy_db
```

```sql
-- Check expenses
SELECT * FROM expenses WHERE user_id = 'test_user_1' ORDER BY created_at DESC;

-- Check app events
SELECT event_id, event_type, processed_for_domain_knowledge, processed_for_memory_substrate
FROM app_events
ORDER BY ts DESC
LIMIT 20;

-- Check domain knowledge
SELECT knowledge_id, topic, subtopic, content_text, visibility
FROM domain_knowledge
ORDER BY created_at DESC;

-- Check unprocessed events
SELECT * FROM unprocessed_domain_knowledge_events LIMIT 10;

-- Check spending summary
SELECT * FROM user_spending_summary WHERE user_id = 'test_user_1';

-- Check category stats
SELECT * FROM user_category_stats WHERE user_id = 'test_user_1';
```

### Verify Memory Integration

```bash
# Check memory cards
curl http://localhost:3000/v0/cards?owner_id=test_user_1

# Check retrieval traces
curl http://localhost:3000/v0/traces?owner_id=test_user_1

# Check audit log
curl http://localhost:3000/v0/audit?limit=20
```

## Troubleshooting

### Payments service won't start

```bash
# Check if port 3001 is available
lsof -i :3001

# Check environment variables
docker exec oggy-payments-service env | grep -E 'POSTGRES|MEMORY|OPENAI'

# Rebuild service
docker-compose build payments-service
docker-compose up -d payments-service
```

### Schema not initialized

```bash
# Manually apply schemas
docker exec -it oggy-postgres psql -U oggy -d oggy_db

\i /docker-entrypoint-initdb.d/01_init.sql
-- Then manually run payments init scripts
```

### Events not processing

```bash
# Check event processor is running
docker logs oggy-payments-service | grep EventProcessor

# Manually trigger processing
curl -X POST http://localhost:3001/v0/process-events

# Check for processing errors
docker exec -it oggy-postgres psql -U oggy -d oggy_db -c \
  "SELECT event_id, processing_errors FROM app_events WHERE processing_errors IS NOT NULL;"
```

### Memory service not responding

```bash
# Check memory service health
curl http://localhost:3000/health

# Check memory service logs
docker logs oggy-memory-service

# Restart memory service
docker-compose restart memory-service
```

## Next Steps (Week 6)

After verifying Week 5 is complete:

1. **Base vs Oggy Comparison**: Implement automated runs comparing base model vs Oggy
2. **Tessa Integration**: Integrate with Tessa for sealed benchmark evaluation
3. **Anti-Overfitting Protocol**: Implement benchmark rotation and sanity checks
4. **Metrics Dashboard**: Visualize learning progress and performance deltas

## Files Created

```
services/payments/
├── db/init/
│   ├── 01_payments_init.sql         # Expenses + app_events tables
│   ├── 02_domain_knowledge.sql      # Domain knowledge store
│   └── 03_seed_and_views.sql        # Helper views + seed data
├── src/
│   ├── routes/
│   │   ├── expenses.js              # CRUD endpoints
│   │   ├── query.js                 # Query & analysis
│   │   └── categorization.js        # Oggy integration
│   ├── services/
│   │   ├── oggyCategorizer.js       # AI categorization service
│   │   └── eventProcessor.js        # Training pipeline processor
│   ├── utils/
│   │   ├── db.js                    # Database client
│   │   ├── eventTypes.js            # Event type definitions
│   │   └── eventEmitter.js          # Event emission utilities
│   └── index.js                     # Main entry point
├── Dockerfile                        # Container definition
└── package.json                      # Dependencies

scripts/
└── init-payments-db.sh               # Database initialization script

docker-compose.yml                    # Updated with payments service
```

---

**Status: Week 5 Implementation Complete** ✅

All deliverables have been implemented. The system is ready for end-to-end testing.
