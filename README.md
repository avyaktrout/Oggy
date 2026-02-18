# Oggy

A continuously learning AI agent that improves from user feedback and benchmark-driven training. Oggy powers four domain agents — **Payments**, **General Assistant**, **Diet Tracker**, and **Harmony Map** — each with its own training pipeline, memory system, and performance analytics.

Every interaction makes Oggy smarter. Ask it to categorize an expense, track a meal, or analyze a city — then watch it learn from corrections, discover patterns, and outperform a baseline model that has no memory at all.

Live at **https://oggy-v1.com**

---

## Table of Contents

- [How Oggy Learns](#how-oggy-learns)
- [Getting Started](#getting-started)
- [Payments Domain](#payments-domain)
- [General Assistant](#general-assistant)
- [Diet Tracker](#diet-tracker)
- [Harmony Map](#harmony-map)
- [Training & Benchmarks](#training--benchmarks)
- [Settings & Configuration](#settings--configuration)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Development](#development)
- [Production Deployment](#production-deployment)
- [Project Structure](#project-structure)

---

## How Oggy Learns

Oggy uses a **dual-model architecture** visible in every chat interface. Two columns appear side by side:

| Column | What it is |
|--------|-----------|
| **Oggy (with memory)** | The full agent — retrieves relevant memories, applies learned preferences, and uses domain knowledge from past interactions |
| **Base Model (no memory)** | The same underlying LLM with zero augmentation — no memories, no learned patterns, no domain context |

This side-by-side design lets you see exactly how much value the learning system adds. Over time, Oggy's responses become more personalized and accurate while the Base Model stays generic.

### Memory System

Oggy's memory is powered by a **vector-based semantic retrieval** system. When you interact with Oggy:

1. **Automatic extraction** — Oggy detects learnable patterns from your conversations (spending habits, food preferences, communication style) and stores them as tagged memory cards
2. **Explicit storage** — Say "remember that Costco is always groceries" and Oggy stores it as a high-confidence memory card, then retroactively updates matching records
3. **Semantic retrieval** — When you ask a question, Oggy searches its memory for the most relevant cards using vector similarity, so past context surfaces naturally

### Continuous Learning Pipeline

Each domain has its own training pipeline:

1. **Benchmark generation** — The system creates domain-specific test scenarios (expense categorizations, conversation assessments, nutrition questions, harmony indicator evaluations)
2. **Dual evaluation** — Both Oggy (with memory) and the Base Model answer each benchmark independently
3. **Scoring** — Answers are graded by an LLM judge (or domain-specific evaluator like Tessa for payments)
4. **Weakness analysis** — The system identifies categories, topics, or patterns where Oggy struggles
5. **Targeted practice** — Future training rounds focus on weak areas with adaptive difficulty
6. **Level progression** — Oggy advances through 10 scales (S1–S10) with 5 difficulty levels each, totaling 50 tiers

---

## Getting Started

### Signing In

Oggy uses **magic link authentication** — no passwords to remember.

1. Enter your email address on the login page
2. Check your inbox for a login link
3. Click the link to sign in — a session cookie is created automatically
4. You stay signed in until the session expires or you sign out

### Navigation

The sidebar organizes everything into four domains plus settings:

| Section | Pages |
|---------|-------|
| **Payments** | Enter Payment, View Payments, Chat & Training, Analytics |
| **General** | Chat & Training, Projects, Analytics |
| **Diet** | Enter Food, View Nutrition, Chat & Training, Analytics |
| **Harmony** | Map, Scenarios, Data Catalog, Analytics, Chat & Training |
| **Settings** | Model configuration, API keys |
| **Admin** | User management (admin-only) |

On mobile, the sidebar collapses into a hamburger menu.

---

## Payments Domain

The Payments domain helps you track expenses, categorize spending, and understand your financial patterns. Oggy learns your specific categorization preferences over time.

### Enter Payment

Add an expense with:
- **Amount** and **currency** (defaults to USD)
- **Transaction date**
- **Merchant name** and **description**
- **Category** — Choose manually or let Oggy suggest one
- **Tags** for custom grouping
- **Notes** for additional context

**AI Categorization**: When you add a payment, Oggy can auto-suggest a category with a confidence score and reasoning. You can accept the suggestion or pick a different category — either way, Oggy learns from your choice.

**Receipt Scanning**: Upload a photo or PDF of a receipt. Oggy's vision model extracts:
- Merchant name and location
- Individual line items with prices
- Total amount

Extracted items appear in a review panel where you can check/uncheck items, edit descriptions, and adjust amounts before adding them.

**Diet Transfer**: Toggle "Transfer food/drink info to Diet Agent?" when entering a food-related purchase. Oggy detects food items and suggests adding them to your diet log with meal type, quantity, and unit. If the quantity or measurement is unclear, Oggy asks for clarification before transferring.

### View Payments

Browse and manage your expense history:
- **Filter** by date range, category, or merchant name (fuzzy search)
- **Edit** any field inline — amount, date, merchant, category, tags, notes
- **Delete** expenses (soft-delete preserves history)
- **Bulk operations** for managing multiple expenses at once
- **Pagination** with "Load More" for large histories

### Payments Chat & Training

The chat interface has two panels:

**Chat Panel** (left side):
- Ask Oggy about your spending: "How much did I spend on dining this week?", "What were my biggest expenses yesterday?"
- Oggy has access to your last 3 days of expenses in context, so questions about "yesterday" or "today" resolve correctly
- Ask Oggy to remember things: "Remember that Amazon purchases under $20 are usually personal care"
- Toggle **Learn from chat** to let Oggy extract spending patterns from the conversation
- **Self-driven inquiries**: Oggy proactively asks clarification questions about ambiguous expenses (configurable daily limit: 0–15)

**Training Panel** (right side):
- Start a training session with configurable duration (5 min to 24 hours, or indefinite)
- Watch live stats: current level, accuracy, questions answered, benchmarks completed
- Oggy trains on expense categorization scenarios, focusing on your weak categories
- 3 concurrent practice exercises per round for faster training

**Performance Audit**: A collapsible panel where you can ask Oggy about its own performance — accuracy trends, weak categories, confusion pairs, and improvement suggestions. Oggy answers using real benchmark data, not hallucinations.

**Observer**: Opt-in to federated learning. Share your anonymized categorization rules and receive suggestion packs from other users, including merchant-specific rules.

### Payments Analytics

Dashboard with:
- **Current level** (S1–S10 scale with 5 levels each)
- **Win rate** — How often Oggy beats the Base Model
- **Accuracy comparison** — Oggy vs Base average accuracy
- **Category accuracy chart** — Per-category performance breakdown
- **Top confusion pairs** — Which categories Oggy most often confuses
- **Accuracy trend** — Line chart over time
- **Range selectors** — Last 5, 15, 30 benchmarks or all time

---

## General Assistant

The General Assistant is a conversational AI with project-scoped memory and two learning systems.

### Chat & Training

**Chat Panel**:
- General-purpose conversation with persistent memory across sessions
- Oggy remembers facts, preferences, and patterns from past conversations
- Ask it to remember things explicitly or let it learn automatically
- Project-scoped: conversations belong to specific projects for organized context

**Training Panel**:
- Train Oggy on conversation quality with dual-mode benchmarks testing:
  - **Behavior**: Does Oggy retain context and adhere to your preferences?
  - **Domain knowledge**: Can Oggy recall and apply domain-specific information?
- Parallelized sessions (3 concurrent exercises per round)
- LLM-as-judge evaluation for nuanced quality scoring

### Projects

Organize conversations into projects:
- **Create** projects with a name and optional description
- **Switch** between projects — each has its own conversation history and learning settings
- **Learning settings** per project:
  - **Behavior Learning** (toggle) — Automatically extracts preferences, tone, and workflow patterns from your chats
  - **Domain Learning** (toggle) — Enable AI-suggested domain expertise

### Domain Learning System

A manual knowledge injection system that makes Oggy an expert in specific topics:

1. **Domain Tag Suggestions**: Oggy analyzes your project's conversation history and suggests relevant domain tags (e.g., "machine-learning", "web-development", "cooking")

2. **Knowledge Packs**: For each enabled tag, Oggy builds a pack of 10–20 expert-level knowledge cards covering key concepts, best practices, common pitfalls, and terminology

3. **Pack Lifecycle**:
   - **Build** — Generate a knowledge pack for a domain tag
   - **Review** — View all cards in the pack, compare versions with a diff viewer
   - **Apply** — Inject the pack's cards into Oggy's memory for this project
   - **Rollback** — Remove all cards from an applied pack if the knowledge isn't helpful

4. **Study Plans**: LLM-generated structured learning plans with:
   - Topics organized by priority with estimated hours
   - Validated resource links (broken URLs are rejected)
   - Save plans per project for reference
   - Refine plans based on your feedback

### General Analytics

- Total conversations and daily activity (14-day chart)
- Memory cards count and behavior learning signals
- Domain learning stats: enabled tags, active packs, total knowledge cards
- Latest benchmark level, accuracy, and date

---

## Diet Tracker

A comprehensive nutrition tracking system that competes with apps like MyFitnessPal. Oggy learns your eating patterns and provides personalized nutrition advice.

### Enter Food

Multiple ways to log what you eat:

**Manual Entry**:
- Type what you ate in natural language (e.g., "2 scrambled eggs with toast")
- Select meal type: Breakfast, Lunch, Dinner, Snack
- Choose entry type: Food, Liquid, Vitamin, Supplement
- Specify quantity and unit (serving, piece, cup, oz, g, ml, slice, bottle, can, tbsp, tsp)
- Oggy automatically looks up nutrition data through a 5-tier lookup chain:
  1. **User-corrected values** — Your previous edits take highest priority
  2. **Branded foods database** — Pre-seeded products (energy drinks, protein bars, instant ramen, etc.)
  3. **USDA FoodData Central** — Government nutrition database with 300,000+ foods
  4. **OpenFoodFacts** — Community-sourced nutrition data
  5. **AI estimation** — LLM-based nutrition estimate as a last resort

**Food Search Autocomplete**:
- Start typing and get instant suggestions from three sources:
  - **Recent** — Foods you've logged before
  - **Branded** — Known branded products with accurate nutrition
  - **USDA** — Results from the USDA food database
- Select a suggestion to auto-fill the description, or keep typing for custom entries
- Keyboard navigation supported (arrow keys, Enter, Escape)

**Quick Add Recent Foods**:
- Horizontal chip bar showing your last 10 unique foods with calorie counts
- Tap the "+" button to instantly re-log a food with the same quantity and meal type

**Receipt Scanning**:
- Upload a photo or PDF of a food receipt
- Oggy extracts food items with estimated calories and confidence scores
- Review extracted items — edit descriptions, adjust quantities, change meal types
- Bulk-add all checked items to your diet log

**Barcode Scanning**:
- Open the in-browser camera scanner
- Scan any food barcode (EAN-13, UPC-A, EAN-8)
- Oggy looks up the product via OpenFoodFacts and shows full nutrition info
- One tap to add the scanned product to your log
- Scanned products are cached locally for instant lookup next time

**Saved Meals**:
- Save a combination of foods as a named meal (e.g., "My Usual Breakfast")
- Re-log an entire saved meal with one tap — all items are added individually
- Usage count tracks how often you use each saved meal
- Save directly from today's entries or create custom meal templates

### View Nutrition

**Daily Summary Cards**:
- Calories, Protein, Carbs, Fat (with saturated/unsaturated breakdown), Fiber, Sugar, Sodium, Caffeine
- Entry count for the day
- Date picker to view any date's nutrition

**Daily Goals**:
- Set target values for Calories, Protein, Carbs, and Fat
- Goals appear as colored progress bars under each nutrition card:
  - **Green** (< 80% of goal) — On track
  - **Amber** (80–100%) — Approaching goal
  - **Red** (> 100%) — Goal exceeded

**Diet Rules & Preferences**:
- Create custom dietary rules (e.g., "Limit sodium to 2000mg", "No dairy after 6pm")
- Rules are included in Oggy's chat context for personalized advice

**Inline Nutrition Editing**:
- Click the edit icon on any entry to override nutrition values
- Edit calories, protein, carbs, fat, saturated fat, unsaturated fat, fiber, sugar, sodium, caffeine
- Your corrections take highest priority in future lookups

### Diet Chat & Training

**Chat Panel**:
- Ask about your nutrition: "What do you think about what I had yesterday?", "Am I hitting my protein goal?"
- Oggy has your last 3 days of food entries in context — no date confusion
- Get meal suggestions based on your goals and dietary rules
- Toggle **Learn from chat** for pattern extraction

**Training Panel**:
- Train on nutrition knowledge and personalized advice quality
- LLM-as-judge evaluation

### Diet Analytics

- 14-day nutrition trend charts
- Weekly averages for all nutrients
- Goal attainment tracking
- Meal type distribution

---

## Harmony Map

An interactive city well-being dashboard that measures how well cities are doing across real-world metrics and distills them into a single **Harmony score (H)**.

### How Scoring Works

Every city is evaluated using **indicators** — measurable data points like "violent crime rate per 100k" or "high school graduation rate (%)". Each indicator belongs to one of **6 dimensions**:

| Dimension | What it measures | Example indicators |
|-----------|-----------------|-------------------|
| **Balance (B)** | Safety and economic stability | Violent crime rate, income inequality (Gini), homelessness rate |
| **Flow (F)** | Mobility and employment | Unemployment rate, average commute time, transit access score |
| **Compassion** | Health and welfare | Uninsured rate, food insecurity rate, mental health providers per 100k |
| **Discernment** | Education and civic engagement | High school graduation rate, voter turnout, library access |
| **Awareness (A)** | Community and transparency | Civic engagement index, government transparency score |
| **Expression (X)** | Culture and freedom | Arts organizations per capita, protest freedom index |

These 6 dimensions roll up into **3 top-level scores** using geometric aggregation:

```
Care (C)        = Compassion * Discernment
Economic (E)    = cube_root(Balance * Flow * Care)
Social (S)      = sqrt(Awareness * Expression)
Harmony (H)     = sqrt(E * S)
```

All indicator values are **normalized to 0–1** using min-max bounds. Indicators where lower is better (like crime) are automatically inverted. Each indicator has a **weight** (default 1.0) controlling its influence within its dimension.

### Map View

The interactive map shows all cities with their Harmony scores. Click any city to see:

- **Score breakdown**: Harmony, Economic, Social, Care scores
- **Dimension scores**: All 6 dimensions with individual values
- **Indicator detail**: Every indicator with its raw value, normalized score, bounds, weight, and dimension assignment
- **What's driving scores**: See which indicators are pulling scores up or down
- **Alerts**: Warning (yellow) for values approaching bounds, Critical (red) for extreme values or data quality issues
- **Recent actions**: Expandable cards showing what each accepted suggestion changed — indicator details, weight values, model update rationale
- **NEW badges**: Redis-backed badges highlight recently added indicators

### AI-Powered Suggestions

Ask Oggy to analyze a city and suggest improvements:

- **New indicators** — Additional metrics that could improve measurement accuracy
- **Weight adjustments** — Change how much influence an indicator has within its dimension
- **Model updates** — Formula or methodology changes with rationale
- **New data points** — Additional cities or data sources to include

Each suggestion passes through a **specificity guard** that rejects vague or overly broad metrics. When you accept a suggestion, scores are automatically recomputed for all affected cities with a full audit trail.

### What-If Scenarios

Create sandbox scenarios to explore hypothetical changes:

1. **Clone a city** as a baseline
2. **Adjust indicator values or weights** — What if unemployment dropped by 2%? What if we weighted education more heavily?
3. **Compare projections** — Side-by-side view showing deltas (positive/negative/neutral) with impact assessment (low/medium/high)
4. No changes are persisted until you explicitly approve a scenario

### Data Catalog

Browse every dataset that powers the Harmony Map:
- Dataset name, description, and license
- Update cadence (how often the data refreshes)
- Field mappings showing which data columns feed which indicators
- Source URLs and attribution

### Federated Learning (Observer)

Users can opt-in to share accepted suggestions anonymously:
- **Share**: Your accepted indicator additions and weight changes are aggregated
- **Receive**: Import versioned "Harmony Packs" containing crowd-sourced improvements
- **Auto-run**: The Observer job activates when 2+ users opt-in to sharing

### Harmony Analytics

- Top improved cities in the last 30 days
- Indicators with the largest variance across cities
- Score distribution histograms
- Dimension comparison radar charts
- Recent actions timeline

### Harmony Chat & Training

Same dual-model chat with training pipeline. Ask Oggy about cities, indicators, scoring methodology, or how to improve specific dimension scores.

---

## Training & Benchmarks

Every domain shares a common training infrastructure with domain-specific customizations.

### Starting a Training Session

1. Open any domain's **Chat & Training** page
2. Click the training panel on the right
3. Configure:
   - **Duration**: 5 min, 15 min, 30 min, 1 hour, 2 hours, 24 hours, or indefinite
   - **Email** (optional): Receive training reports
   - **Report interval**: After session, after each benchmark, or time-based (5–60 min intervals)
4. Click **Start Training**

### How Training Works

Each training round:
1. **3 practice exercises** are generated in parallel, targeting weak areas
2. Both Oggy and the Base Model answer each exercise independently
3. An evaluator scores both responses:
   - **Payments**: Tessa (specialized expense categorization evaluator)
   - **General/Diet/Harmony**: LLM-as-judge with domain-specific rubrics
4. Results feed into weakness analysis and confusion pair detection
5. When enough practice rounds complete, a **sealed benchmark** runs — a fixed evaluation that determines level advancement

### Adaptive Difficulty

- **10 scales** (S1–S10), each with **5 difficulty levels** = 50 total tiers
- S1 L1 = Beginner with simple scenarios
- S10 L5 = Expert with highly nuanced edge cases
- Oggy advances when benchmark accuracy meets the threshold for the current level
- Difficulty increases focus on the specific areas where Oggy struggles

### Email Reports

Training reports include:
- Current level and accuracy
- Progress during this session (levels gained, accuracy change)
- Weak categories or topics identified
- Per-scenario performance breakdown
- Recommendations for further training

---

## Settings & Configuration

### BYO-Model (Bring Your Own Model)

Configure which LLM providers power Oggy:

| Setting | What it controls |
|---------|-----------------|
| **Oggy Model** | The memory-augmented agent (default: system-provided) |
| **Base Model** | The comparison model with no memory (default: system-provided) |

**Supported providers**: OpenAI, Anthropic, Google, xAI

Each provider requires an API key. Keys are encrypted using **AES-256-GCM** with a unique random IV per key. Only the last 4 characters are displayed for verification. System fallback keys are available if you don't provide your own.

**Vision support**: Some providers support vision models for receipt scanning and image analysis. The settings page indicates which providers have vision capability.

### Admin Panel

Available to admin accounts only:
- **Add users** with email and display name
- **Assign roles** (user or admin)
- **Edit** display names and roles
- **View** all users with creation dates

---

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

All application services share a single Docker image (`oggy-app`) with different entry points. The gateway validates auth and proxies requests to domain services via `X-User-Id` headers on an internal Docker network.

### Services

| Service | Port | Stack | Role |
|---------|------|-------|------|
| Gateway | 3001 | Node.js/Express | Auth, static files, CORS, proxy routing |
| Payments | 3010 | Node.js/Express | Expense categorization, chat, training, benchmarks, observer |
| General | 3011 | Node.js/Express | Conversation, projects, domain learning, study plans |
| Diet | 3012 | Node.js/Express | Meal logging, nutrition lookup, goals, saved meals, barcode scanning |
| Harmony | 3013 | Node.js/Express | City scores, indicators, scenarios, suggestions, observer |
| Memory | 3000 | Node.js/Express | Vector memory CRUD, semantic retrieval, utility scoring |
| Learning | 8000 | Python/FastAPI | Agent orchestration, scoring pipelines, training loops |
| PostgreSQL | 5432 | Postgres 15 | All persistent storage |
| Redis | 6379 | Redis 7 | Cache, session state, working memory, freshness badges |

### Key Design Decisions

- **Same image, different entry points**: One Docker build produces 5 containers (gateway + 4 domain services), keeping deployment simple while allowing independent scaling
- **Gateway-authenticated proxying**: Domain services trust the `X-User-Id` header from the gateway, eliminating per-service auth
- **5-tier nutrition lookup**: User corrections > branded foods > USDA > OpenFoodFacts > AI estimation ensures accuracy while handling unknown foods gracefully
- **Geometric score aggregation**: The Harmony Map uses geometric means (cube root, square root) so a zero in any dimension drags the overall score down — you can't compensate for terrible safety with great arts funding
- **Circuit breakers**: All external API calls (OpenAI, USDA, OpenFoodFacts) use circuit breakers that only trip on 5xx/network errors, not 4xx or JSON parse errors

---

## API Reference

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/auth/request-magic-link` | Send login email |
| GET | `/v0/auth/verify?token=` | Verify magic link and create session |
| GET | `/v0/auth/me` | Current user info + CSRF token |

### Payments
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/expenses` | Add expense |
| GET | `/v0/expenses` | List expenses (with filters) |
| PUT | `/v0/expenses/:id` | Update expense |
| DELETE | `/v0/expenses/:id` | Soft-delete expense |
| POST | `/v0/categorization/suggest` | AI categorization suggestion |
| POST | `/v0/categorization/batch-suggest` | Batch AI categorization |
| POST | `/v0/query` | Advanced expense query with filters |
| POST | `/v0/chat` | Chat with payments assistant (dual-model) |
| POST | `/v0/training/start` | Start training session |
| POST | `/v0/sealed-benchmark/create` | Create sealed benchmark |
| POST | `/v0/sealed-benchmark/test` | Run benchmark (Oggy vs Base) |
| POST | `/v0/observer/run` | Run observer job |
| GET | `/v0/observer/packs` | List available observer packs |

### General
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/general/chat` | Chat with general assistant (dual-model) |
| GET | `/v0/general/projects` | List projects |
| POST | `/v0/general/projects` | Create project |
| GET | `/v0/general/projects/:id` | Get project details |
| PUT | `/v0/general/projects/:id` | Update project |
| DELETE | `/v0/general/projects/:id` | Delete project |
| GET | `/v0/general/projects/:id/messages` | Get conversation history |
| GET | `/v0/general/projects/:id/learning-settings` | Get learning toggles |
| PUT | `/v0/general/projects/:id/learning-settings` | Update learning toggles |
| POST | `/v0/general/domain-tags/suggest` | AI-suggest domain tags |
| POST | `/v0/general/domain-tags/enable` | Enable a domain tag |
| POST | `/v0/general/domain-tags/decline` | Decline a suggested tag |
| POST | `/v0/general/domain-learning/build-pack` | Build knowledge pack |
| GET | `/v0/general/domain-learning/packs` | List packs for a tag |
| POST | `/v0/general/domain-learning/packs/:id/apply` | Apply knowledge pack |
| POST | `/v0/general/domain-learning/rollback` | Rollback applied pack |
| GET | `/v0/general/domain-learning/pack-diff` | Compare pack versions |
| POST | `/v0/general/domain-learning/study-plan` | Generate study plan |
| POST | `/v0/general/domain-learning/study-plan/refine` | Refine study plan |
| POST | `/v0/general/domain-learning/study-plan/save` | Save study plan |
| GET | `/v0/general/domain-learning/study-plans` | List saved study plans |

### Diet
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/diet/chat` | Chat with diet assistant (dual-model) |
| POST | `/v0/diet/entries` | Log a meal |
| GET | `/v0/diet/entries` | Get entries for a date |
| PUT | `/v0/diet/entries/:id/nutrition` | Update nutrition values |
| DELETE | `/v0/diet/entries/:id` | Delete entry |
| GET | `/v0/diet/nutrition` | Daily nutrition summary |
| GET | `/v0/diet/search` | Food search autocomplete |
| GET | `/v0/diet/recent` | Recent foods for quick-add |
| GET | `/v0/diet/barcode/:code` | Barcode nutrition lookup |
| GET | `/v0/diet/goals` | Get nutrition goals |
| POST | `/v0/diet/goals` | Set/update nutrition goals |
| GET | `/v0/diet/rules` | List dietary rules |
| POST | `/v0/diet/rules` | Add dietary rule |
| DELETE | `/v0/diet/rules/:id` | Delete dietary rule |
| GET | `/v0/diet/meals` | List saved meals |
| POST | `/v0/diet/meals` | Create saved meal |
| POST | `/v0/diet/meals/save-current` | Save current day's entries as meal |
| POST | `/v0/diet/meals/:id/log` | Log a saved meal |
| DELETE | `/v0/diet/meals/:id` | Delete saved meal |

### Harmony
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v0/harmony/scopes` | List geographic scopes with counts |
| GET | `/v0/harmony/nodes` | List nodes (filter by scope, parent) |
| GET | `/v0/harmony/node/:id` | Full node detail with scores |
| GET | `/v0/harmony/node/:id/explain` | Indicator explainability + recent actions |
| POST | `/v0/harmony/compute/:id` | Recompute scores for a node |
| POST | `/v0/harmony/compute-all` | Recompute all nodes in a scope |
| GET | `/v0/harmony/datasets` | Browse data catalog |
| POST | `/v0/harmony/generate-suggestions` | AI-generate suggestions for a node |
| POST | `/v0/harmony/suggestions/:id/accept` | Accept suggestion (triggers recompute) |
| POST | `/v0/harmony/scenario` | Create what-if scenario |
| GET | `/v0/harmony/scenarios` | List user's scenarios |
| GET | `/v0/harmony/scenario/:id/compare` | Compare scenario vs baseline |
| DELETE | `/v0/harmony/scenario/:id` | Delete scenario |
| POST | `/v0/harmony/chat` | Chat with harmony assistant (dual-model) |

### Receipt Analysis
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v0/receipt/analyze` | Extract items from receipt image/PDF via vision LLM |

### Shared
| Method | Path | Description |
|--------|------|-------------|
| GET | `/v0/service-health/circuit-breakers` | Circuit breaker status |
| GET | `/v0/benchmark-analytics` | Training analytics dashboard data |
| POST | `/v0/preferences/feedback` | Submit response feedback (thumbs up/down) |
| GET | `/v0/settings` | Get BYO-Model configuration |
| PUT | `/v0/settings` | Update model/API key settings |
| POST | `/v0/audit/events` | Query audit trail |

---

## Development

### Prerequisites

- Docker & Docker Compose
- Node.js 18+ (for local development without Docker)
- OpenAI API key
- Anthropic API key (optional)
- SMTP credentials for email features (optional)

### Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# Fill in: OPENAI_API_KEY, POSTGRES_PASSWORD, and optionally ANTHROPIC_API_KEY, SMTP_*

# 2. Start all services
docker compose up --build

# 3. Verify
curl http://localhost:3001/health   # Gateway
curl http://localhost:3000/health   # Memory Service
curl http://localhost:8000/health   # Learning Service

# 4. Open the app
# Navigate to http://localhost:3001 and sign in with the email set in ADMIN_EMAIL
```

### Run Modes

**Monolith** (all domains in one process, no proxy):
```bash
cd services/applications && npm install && npm run dev
```

**Microservices** (full Docker stack with hot reload):
```bash
docker compose up
```

**Infrastructure only** (run app code locally, databases in Docker):
```bash
docker compose up postgres redis memory-service
cd services/applications && npm run dev
```

---

## Production Deployment

Hosted on an AWS EC2 t3.small (2GB RAM) via Cloudflare Tunnel. Resource limits are tuned per service:

| Service | Memory Limit |
|---------|-------------|
| Gateway | 128 MB |
| Payments | 256 MB |
| General | 128 MB |
| Diet | 128 MB |
| Harmony | 128 MB |

### Setup Scripts

```bash
# First-time EC2 setup
./deploy/ec2-setup.sh        # Docker, UFW, swap, cloudflared
./deploy/setup-tunnel.sh     # Cloudflare Tunnel as systemd service
./deploy/setup-cron.sh       # Nightly backups, weekly Docker prune

# Deploy updates
./deploy/deploy.sh           # Pull, backup, build, deploy, health check

# Database management
./deploy/backup-postgres.sh  # Manual backup to S3
./deploy/restore-postgres.sh # Restore from S3 (--list to see available)
```

### Fast Deploy (tar + SCP)

For quick iterations without git:
```bash
# Package locally
tar -czf deploy.tar.gz --exclude=node_modules --exclude=.git -C services/applications .

# Upload and extract on EC2
scp deploy.tar.gz ubuntu@<ec2-ip>:/opt/oggy/services/applications/
ssh ubuntu@<ec2-ip> "cd /opt/oggy/services/applications && tar -xzf deploy.tar.gz"

# Rebuild
ssh ubuntu@<ec2-ip> "cd /opt/oggy && docker compose -f docker-compose.staging.yml up -d --build"
```

---

## Project Structure

```
services/
  applications/              # All Node.js services (shared Docker image)
    src/
      gateway.js             # API Gateway entry point
      payments-entry.js      # Payments domain entry point
      general-entry.js       # General domain entry point
      diet-entry.js          # Diet domain entry point
      harmony-entry.js       # Harmony domain entry point
      index.js               # Monolith fallback (npm start)
      domains/
        payments/
          routes/             # Expense, categorization, chat routes
          services/           # Categorizer, evaluator, chat, benchmarks
          db/                 # Database migrations
        general/
          routes/             # Chat, projects, domain learning routes
          services/           # Chat service, learning, assessment generators
          db/                 # Database migrations
        diet/
          routes/             # Entries, nutrition, meals, goals, rules, chat
          services/           # Diet service (nutrition lookup, goals, meals)
          db/                 # Database migrations
        harmony/
          routes/             # Nodes, scores, scenarios, suggestions, chat
          services/           # Harmony engine, suggestion service, observer
          db/                 # Database migrations
      shared/
        middleware/           # Auth, CSRF, cost governor, internal service auth
        routes/               # Training, evaluation, settings, observer, audit
        services/             # Chat handler, receipt analyzer, USDA service,
                              # training reporter, behavior engine, observer
        providers/            # LLM provider adapters (OpenAI, Anthropic, Google, xAI)
        utils/                # Database, Redis, logger, circuit breakers, migrations
    public/                   # Frontend (HTML, CSS, vanilla JS)
      css/style.css           # Global stylesheet with CSS variables
      js/                     # Page-specific JavaScript modules
      *.html                  # 22 HTML pages across all domains
  memory/                     # Memory Service (separate Docker image)
  learning/                   # Learning Service (Python/FastAPI, separate image)
deploy/                       # EC2 deployment and backup scripts
data/                         # Practice packs, sealed benchmark templates
docker-compose.yml            # Development compose
docker-compose.staging.yml    # Production compose with resource limits
```

---

## License

Proprietary — All rights reserved
