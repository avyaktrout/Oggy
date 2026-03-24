# Oggy Systems Design Document

**Version:** 0.4.0
**Last Updated:** March 2026

---

## 1. Overview

Oggy is an AI personal assistant that **learns and improves from every interaction**. Unlike static AI wrappers that produce the same quality output regardless of usage history, Oggy maintains a persistent memory substrate, continuously trains against sealed benchmarks, and scientifically measures its own improvement over time.

Oggy operates across four domains:
- **FinSense** (Payments) — Expense categorization, spending analysis, merchant disambiguation
- **HealthAssist** (Diet) — Food logging, nutrition estimation, dietary rule enforcement
- **GenExplorer** (General) — Research synthesis, plan generation, study plans, recommendations
- **Harmony** — Geographic wellness scoring, scenario planning, intervention suggestions

Each domain shares the same learning infrastructure: memory retrieval, benchmark evaluation, self-driven training loops, observer-based federated learning, and per-intent performance tracking.

---

## 2. Core Design Principles

### 2.1 Scientific Measurement Over Claims
Every improvement Oggy makes is provable. Sealed benchmarks (immutable test sets never used for training) provide unbiased accuracy measurements. Every training session produces a before/after comparison: Oggy with memory vs. a base model without memory, tested on the same scenarios.

### 2.2 Memory as a First-Class Citizen
Oggy's memory is not a chat history dump. It's a structured 4-tier substrate with utility scoring, reliability tracking, and usage counters. Low-value memories are pruned. High-value ones are promoted. Every memory access is audited.

### 2.3 Domain Isolation with Shared Infrastructure
Each domain (FinSense, HealthAssist, GenExplorer, Harmony) runs as an independent service with its own routes, services, and database tables. But all domains share the same learning pipeline: continuous learning loops, benchmark evaluation, observer packs, intent tracking, and the memory service.

### 2.4 Dual-Model Comparison
Every chat interaction runs two models in parallel: Oggy (with memory retrieval) and a base model (without memory). Users see both responses side by side, making the value of learning directly visible.

---

## 3. High-Level Architecture

```
                    ┌──────────────────────────────────┐
                    │           Cloudflare Tunnel       │
                    │         (oggy-v1.com → EC2)       │
                    └──────────────┬───────────────────┘
                                   │
                    ┌──────────────▼───────────────────┐
                    │        API Gateway (:3001)        │
                    │  Auth · CORS · Static · Proxy     │
                    │  Shared routes (prefs, settings,  │
                    │  analytics, intents, migration)   │
                    └───┬──────┬──────┬──────┬─────────┘
                        │      │      │      │
           ┌────────────▼┐  ┌──▼────────┐ ┌▼──────────┐ ┌▼───────┐
           │  FinSense   │  │GenExplorer│ │HealthAssist│ │Harmony │
           │   (:3010)   │  │  (:3011)  │ │  (:3012)   │ │(:3013) │
           │  expenses   │  │  chat     │ │  entries   │ │ map    │
           │  chat       │  │  projects │ │  nutrition │ │ scores │
           │  benchmarks │  │  learning │ │  rules     │ │scenarios│
           │  observer   │  │           │ │  USDA      │ │suggest │
           └──────┬──────┘  └──┬────────┘ └──┬────────┘ └──┬─────┘
                  │            │        │       │
           ┌──────▼────────────▼────────▼───────▼──────┐
           │              Memory Service (:3000)        │
           │   Cards · Retrieval · Audit · Embeddings   │
           └──────────────────┬────────────────────────┘
                              │
           ┌──────────────────▼────────────────────────┐
           │            Learning Service (:8000)        │
           │  CIR Gates · Scoring · SDL · Agents        │
           └──────────────────┬────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐
        │ PostgreSQL │  │   Redis   │  │  LLM APIs   │
        │   (:5432)  │  │  (:6379)  │  │ OpenAI etc. │
        └───────────┘  └───────────┘  └─────────────┘
```

### 3.1 Request Flow

1. User accesses `oggy-v1.com` via browser
2. Cloudflare Tunnel routes to EC2 instance
3. Gateway authenticates via session cookie + CSRF token
4. Gateway proxies domain-specific requests to the appropriate service
5. Domain service processes the request, calling Memory Service for retrieval
6. Memory Service returns ranked cards based on semantic similarity + utility weight
7. Domain service constructs an LLM prompt with retrieved memories included
8. LLM response is returned to user; if learning is enabled, corrections are stored as new memory cards

---

## 4. Learning Pipeline

The learning pipeline is Oggy's core differentiator. It operates at three levels:

### 4.1 Passive Learning (Chat Corrections)
When a user corrects Oggy during chat ("No, that's groceries not shopping"), the correction is captured as a memory card with high utility weight. Next time a similar query arises, the memory service retrieves the correction and Oggy gets it right.

### 4.2 Active Training (Continuous Learning Loop)
Users can start a timed training session (5 minutes to 24 hours, or indefinite). The loop:

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  Generate   │───▶│  Practice    │───▶│  Benchmark  │
│  Scenarios  │    │  (Learn)     │    │  (Measure)  │
└─────────────┘    └──────────────┘    └──────┬──────┘
       ▲                                       │
       │           ┌──────────────┐            │
       └───────────│  Analyze     │◀───────────┘
                   │  Weaknesses  │
                   └──────────────┘
```

1. **Generate** — Create domain-appropriate scenarios at the current difficulty level
2. **Practice** — Oggy answers practice questions; wrong answers become correction cards in memory
3. **Benchmark** — Run a sealed benchmark (immutable test set, never trained on) to measure real accuracy
4. **Analyze** — Identify weak categories, confusion pairs, and per-intent failures
5. **Repeat** — Focus next round on weaknesses; scale difficulty up if accuracy exceeds threshold

### 4.3 Adaptive Difficulty (SCALE System)
Training difficulty auto-adjusts based on performance:

| Scale | Description | Scenarios |
|-------|------------|-----------|
| S1 | Beginner | Clear merchants, obvious categories |
| S2 | Intermediate | Ambiguous descriptions, mixed-cart transactions |
| S3 | Advanced | Context-dependent, multi-category, edge cases |

Each scale has 5 levels. Passing level 5 advances to the next scale at level 3. This prevents both boredom (too easy) and frustration (too hard).

### 4.4 Sealed Benchmarks
Sealed benchmarks are fixed, immutable test sets used exclusively for measurement — never for training. This prevents overfitting and ensures accuracy numbers reflect genuine learning.

Each benchmark test runs both Oggy and the base model on identical scenarios, with timing tracked separately. Oggy gets generous time limits (base duration × 1.5 + buffer) since it makes additional memory retrieval calls.

---

## 5. Memory System

### 5.1 Memory Substrate Architecture

```
┌─────────────────────────────────────────────────┐
│                 Memory Service                   │
│                                                  │
│  ┌─────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Cards  │  │ Retrieval│  │    Audit      │  │
│  │  CRUD   │  │ Semantic │  │    Trail      │  │
│  │         │  │ + Utility│  │               │  │
│  └────┬────┘  └────┬─────┘  └───────────────┘  │
│       │            │                             │
│  ┌────▼────────────▼─────┐                      │
│  │    PostgreSQL + Redis  │                      │
│  │  Embeddings · Vectors  │                      │
│  └────────────────────────┘                      │
└─────────────────────────────────────────────────┘
```

### 5.2 Card Structure
Each memory card has:
- **Tier** (1-4): Priority level for retrieval
- **Kind**: Type of knowledge (correction, rule, fact, preference)
- **Content**: Structured JSONB payload
- **Tags**: Categorical labels for filtering
- **Utility Weight**: How useful this card has been (0.0-1.0)
- **Reliability**: How trustworthy the source (0.0-1.0)
- **Usage Counters**: Times accessed, times it helped, times it didn't

### 5.3 Retrieval Algorithm
When Oggy needs to answer a question:
1. Generate embedding for the query
2. Fetch 3× more candidates than needed (top_k × 3)
3. Score each candidate: 70% semantic similarity + 30% utility weight
4. Filter by tier scope and tag relevance
5. Return top_k ranked results with metadata

### 5.4 Memory Lifecycle
- **Creation**: From user corrections, training practice, observer packs, or inquiry answers
- **Usage**: Retrieved during chat and categorization; success/failure tracked
- **Pruning**: Cards with low utility, high failure rate, or no recent access are candidates for removal
- **Promotion**: High-performing domain knowledge can be promoted to memory cards with audit trail

---

## 6. Observer System (Federated Learning)

The Observer enables knowledge sharing across opt-in users without exposing personal data.

```
┌────────┐  ┌────────┐  ┌────────┐
│ User A │  │ User B │  │ User C │
│ (opt-in)│  │(opt-in)│  │(opt-in)│
└───┬────┘  └───┬────┘  └───┬────┘
    │           │           │
    ▼           ▼           ▼
┌────────────────────────────────┐
│     Export Weaknesses          │
│  (PII-stripped confusion data) │
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│       Observer Job             │
│  Deduplicate · Aggregate ·    │
│  Generate Rule Packs          │
└───────────────┬────────────────┘
                │
                ▼
┌────────────────────────────────┐
│     Knowledge Packs            │
│  Rules + Risk Level + Intent   │
│  Tags + Expected Lift          │
└───────────────┬────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
 Apply?      Apply?      Apply?
(per user)  (per user)  (per user)
```

Each pack includes:
- **Rules**: Categorization corrections (e.g., "Trader Joe's is always groceries")
- **Risk Level**: low/medium/high based on consensus strength
- **Intent Tags**: Which capabilities the pack targets (1-3 intents)
- **Expected Lift**: Predicted accuracy improvement
- **Verified Badge**: Shown only when the user's local eval is passing for the pack's target intents

Users can apply packs (creates memory cards) or rollback them (zeros out the cards).

---

## 7. Intent Framework

Intents are routing metadata that enable per-capability measurement and targeting.

### 7.1 Intent Catalog
26 built-in intents across 4 domains:

| Domain | Intents | Examples |
|--------|---------|----------|
| FinSense | 6 | categorize_payment, disambiguate_groceries_vs_shopping |
| HealthAssist | 6 | log_entry_from_text, estimate_nutrition |
| GenExplorer | 8 | plan_generation, research_synthesis, preference_fit |
| Harmony | 6 | compute_metrics, suggest_interventions |

### 7.2 Intent Resolution
After every benchmark evaluation, each scenario is mapped to 1-3 intents:
- **Explicit**: Scenario has `intent_id` metadata → direct mapping
- **Inferred**: Category confusion pairs or scenario types → intent lookup table

### 7.3 Per-Intent Analytics
Each intent tracks accuracy over time with pass/fail status (≥80% = PASS). Analytics pages show horizontal bar charts with a pass line. Failing intents can be targeted in the next training session via "Train on weakest intents."

---

## 8. Self-Driven Inquiries

Oggy proactively asks questions to improve its knowledge:

### 8.1 Clarifications (Always On)
- Uncategorized expenses that need labeling
- Ambiguous merchants (is "Amazon" groceries or electronics?)
- Category confusion patterns from benchmarks

### 8.2 Suggestions (Opt-In, Rate-Limited)
- Cost-cutting tips based on spending patterns
- Diet health tips based on nutrition logs
- Learning goal suggestions based on project activity
- AI-generated advice with selectable options + free-text input

Inquiries respect user preferences: daily limits, question type filters, and suggestion frequency (3 minutes to once daily).

---

## 9. Behavior & Preference System

Oggy learns not just *what* users want, but *how* they want it:

### 9.1 Preference Events
An append-only log of user signals:
- **Like/Dislike**: Response quality feedback
- **Corrections**: Factual fixes
- **Boundaries**: Topics to avoid
- **Pinned Preferences**: Explicit statements that persist through resets

### 9.2 Preference Profile
Materialized from events into a JSONB profile covering:
- Tone preferences (formal/casual)
- Humor parameters (avoid sarcasm, prefer light teasing)
- Verbosity preferences (concise/detailed)
- Topic preferences (interests, avoid-list)

### 9.3 Response Auditing
Every Oggy response is audited:
- Multiple candidates scored on relevance, tone match, preference alignment
- Winner selection with documented reasoning
- Humor gate: suppresses humor when context demands seriousness

---

## 10. Domain-Specific Design

### 10.1 FinSense (Payments)
- **Expense CRUD**: Create, categorize, query, summarize
- **Tessa Assessment Generator**: Creates novel payment scenarios from domain knowledge for training
- **Category Rules Manager**: Disambiguation rules for confused pairs
- **Receipt Analysis**: Vision LLM extracts merchant, amount, line items from receipt images

### 10.2 HealthAssist (Diet)
- **Food Entry System**: Food, liquid, vitamin, supplement entries by meal type
- **Nutrition Estimation**: AI-estimated + USDA-verified nutrition facts
- **USDA Integration**: 380,000+ lab-verified foods with 3-tier caching (memory → DB → API)
- **Barcode Lookup**: Scan barcodes for instant nutrition info
- **Saved Meals**: Save and replay frequent meals
- **Diet Rules**: Goals, limits, allergies, avoid-lists enforced during chat

### 10.3 GenExplorer (General)
- **Multi-Turn Chat**: Research, planning, recommendations with memory
- **Project Management**: Organize conversations into projects with notes
- **Domain Learning**: Suggest domain tags, build knowledge packs, study plans
- **Study Plan Generation**: AI creates structured learning plans with refinement

### 10.4 Harmony
- **Geographic Scoring**: Multi-level hierarchy (city → state → country → continent → world)
- **Three Dimensions**: Equilibrium (E), Self-Awareness (S), Harmony (H)
- **Indicator System**: Raw measurements (crime, safety, wellness) aggregated via versioned weights
- **Scenario Planning**: "What-if" projections with before/after comparison
- **Intervention Suggestions**: AI-generated recommendations for improving scores
- **Computation Audit**: Every score computation produces a verifiable hash

---

## 11. Authentication & Multi-Tenancy

### 11.1 Auth Flow

Oggy supports two authentication methods:

**Demo Login (Username/Password)**
```
User → Enter Demo_Oggy / welcomeToOggy → POST /v0/auth/demo-login
     → Session Created (7 days) → Redirect to Dashboard
```
A single shared demo account provides instant access for reviewers and evaluators without requiring email verification. The demo user is auto-provisioned in the allowlist on first login.

**Magic Link Login (Email)**
```
User → Request Magic Link → Email Sent
     → Click Link → Token Verified → Session Created (7 days)
     → Every Request: Session Cookie + CSRF Token
```
Quick login: if the email was verified within the past 6 hours, a new session is created instantly without re-sending an email.

### 11.2 Login Page Design
The login page presents demo credentials first (username/password form) with a secondary "or sign in with email" option below. This prioritizes frictionless access for demos while preserving the full magic link flow for registered users.

### 11.3 Multi-Tenancy
- Invite-only via email allowlist (magic link) or shared demo account
- User IDs derived from email: `email.split('@')[0]`
- All data queries filtered by user_id
- Observer data sharing is opt-in and PII-stripped
- Internal services trust `X-User-Id` header from gateway (Docker network only)

---

## 12. Data Flow: Chat Request

```
1. User sends message via browser
2. Gateway authenticates (session + CSRF)
3. Gateway proxies to domain service (e.g., FinSense :3010)
4. Domain service calls Memory Service: POST /retrieve
   → Returns top-k relevant memory cards
5. Domain service constructs system prompt:
   - Domain-specific instructions
   - Retrieved memories injected as context
   - User preference profile
   - Today's date + recent data
6. Domain service calls LLM provider (OpenAI/Claude/Gemini/Grok)
   → Gets Oggy response
7. Simultaneously calls base model (no memory, no preferences)
   → Gets base response
8. Both responses returned to browser
9. User sees side-by-side comparison
10. If learning enabled: corrections stored as memory cards
11. Preference events logged from feedback buttons
12. Cost governor tracks token usage
```

---

## 13. Training Email Reports

During training sessions, Oggy sends structured email reports:

**Report Contents:**
- Session duration and questions answered
- Current accuracy (Oggy vs. Base)
- Scale/level progression
- Weakness analysis with confusion pair tables
- Per-intent performance with PASS/FAIL badges
- Recommendations for next steps

**Report Timing Options:**
- After session ends only
- After each benchmark
- Timed intervals (5/10/15/30/60 minutes)

---

## 14. Resilience Patterns

### 14.1 Circuit Breakers
External API calls (OpenAI, USDA, Memory Service) use circuit breakers:
- **Threshold**: 3 consecutive failures → circuit opens
- **Timeout**: 60 seconds before retry
- **Scope**: Only 5xx and network errors trip the breaker (not 4xx)

### 14.2 Cost Governance
- Daily token budget per user (default: 20M tokens)
- Non-blocking audit logging of every LLM call
- Budget checks before expensive operations

### 14.3 Graceful Degradation
- Memory service down → Oggy continues without memory (base mode)
- USDA API down → Falls back to cached results, then AI estimation
- Redis down → Continue without caching
- Domain service starting → Gateway health check reports partial availability

---

## 15. Deployment Architecture

### 15.1 Production (EC2 t3.small)
- **Single Docker image** built once, run as 4 containers with different CMD
- **Resource limits**: Gateway 128MB, domain services 128-256MB each
- **Domain**: oggy-v1.com via Cloudflare Tunnel
- **Database backups**: Automated via deploy scripts
- **Deployment**: tar + scp to EC2, extract, `docker compose up -d --build`

### 15.2 Container Layout
| Container | Port | Memory | CMD |
|-----------|------|--------|-----|
| oggy-gateway | 3001 | 128MB | node src/gateway.js |
| oggy-payments (FinSense) | 3010 | 256MB | node src/payments-entry.js |
| oggy-general (GenExplorer) | 3011 | 128MB | node src/general-entry.js |
| oggy-diet (HealthAssist) | 3012 | 128MB | node src/diet-entry.js |
| oggy-harmony | 3013 | 128MB | node src/harmony-entry.js |
| oggy-memory | 3000 | 128MB | node src/index.js |
| oggy-learning | 8000 | 128MB | uvicorn main:app |
| postgres | 5432 | 256MB | - |
| redis | 6379 | 64MB | - |

