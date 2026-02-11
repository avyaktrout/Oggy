/**
 * Application Knowledge Module
 * Provides Oggy with comprehensive self-awareness about the application architecture,
 * security model, features, and data model so it can answer user questions about itself.
 */

function getApplicationKnowledge() {
    return `
# About Oggy — Application Knowledge

## What is Oggy?
Oggy is an AI-powered personal assistant platform with persistent memory. Unlike standard AI chatbots, Oggy remembers conversations, learns from user interactions, and improves over time through continuous training. The platform supports multiple domains (payments, general conversation, diet tracking) and allows users to bring their own AI model provider and API keys.

## Architecture
- **Microservices**: Docker-based with two core services:
  - **application-service** (port 3001): Main application server — handles all API routes, chat, training, benchmarks, and UI
  - **memory-service** (port 3000): Manages persistent memory cards with tiered storage and semantic retrieval
- **Database**: PostgreSQL (41 tables) for all persistent data
- **Cache**: Redis for session caching and preference profiles
- **Hosting**: AWS EC2 behind Cloudflare Tunnel with HTTPS (oggy-v1.com)
- **Backups**: Nightly PostgreSQL dumps to AWS S3 with 30-day retention

## Multi-Domain Architecture
Oggy operates across three domains, each with its own chat interface:

### V1 — Payments Assistant
- Expense tracking, categorization, and spending analysis
- Memory-enhanced categorization that learns from corrections
- Behavior engine with candidate generation, scoring, and audit
- Tables: \`expenses\`, \`domain_knowledge\`, \`preference_events\`, \`user_preference_profiles\`

### V2 — General Conversation
- General-purpose AI assistant with project context
- Full memory integration for context-aware responses
- Project management (create, organize, chat within projects)
- Tables: \`v2_projects\`, \`v2_project_messages\`, \`v2_preference_events\`

### V3 — Diet Agent
- Food logging and nutritional analysis
- Custom dietary rules (allergies, restrictions, goals)
- AI-powered nutrition estimation from natural language descriptions
- Tables: \`v3_diet_entries\`, \`v3_diet_items\`, \`v3_diet_rules\`, \`v3_diet_chat_messages\`

## Security Model

### Authentication
- **Magic Link Login**: Passwordless authentication via email
  - User enters email → receives a magic link valid for 6 hours
  - Two-step verification: GET shows confirmation page (safe for email prefetchers), POST consumes the token
  - Only pre-approved emails can log in (allowlist in \`auth_allowed_emails\` table)
  - Rate limiting: max 5 magic link requests per email per hour (\`auth_rate_limits\` table)
  - Tokens are single-use and expire after 6 hours

### Session Security
- **Session Cookies**: HttpOnly, SameSite=Lax, Secure (in production)
  - 7-day session expiry
  - Tokens are cryptographically random (32 bytes, hex-encoded)
  - Sessions stored server-side in PostgreSQL (\`auth_sessions\` table)
  - Cookie name: \`oggy_session\` — never exposed to JavaScript (HttpOnly flag)

### API Key Encryption (BYO-Model)
- **Algorithm**: AES-256-GCM (authenticated encryption)
  - This is the gold standard for symmetric encryption — the same algorithm used by banks and government systems
  - GCM mode provides both confidentiality AND integrity/authenticity (tamper detection)
- **Key Management**: 256-bit encryption key stored as server environment variable (ENCRYPTION_KEY)
  - Never committed to source code or version control
  - 32 random bytes (64 hex characters)
- **Storage Format**: \`iv:authTag:ciphertext\` (all hex-encoded)
  - Each encryption uses a unique random 12-byte IV (initialization vector)
  - 16-byte authentication tag detects any tampering
  - Keys are decrypted only at request time, never cached in plaintext
- **Display**: Only last 4 characters shown as hint (e.g., "...sk-abcd")
- **Validation**: Keys can be tested against provider APIs; validity status tracked with timestamp
- **Table**: \`user_provider_secrets\` — stores encrypted keys per user per provider

### Infrastructure Security
- Cloudflare Tunnel (no open ports to the internet)
- UFW firewall (only SSH allowed directly)
- Fail2Ban for SSH brute-force protection
- SSH key-only authentication (no passwords)

## BYO-Model (Bring Your Own Model)
Users can choose which AI model powers Oggy and the Base comparison independently:

### Supported Providers
- **OpenAI**: GPT-4o, GPT-4o-mini, GPT-4-turbo (system default)
- **Anthropic (Claude)**: Claude 3.5 Sonnet, Claude 3 Haiku, Claude 3 Opus
- **Google Gemini**: Gemini 1.5 Pro, Gemini 1.5 Flash
- **xAI (Grok)**: Grok-2, Grok-2-mini

### How It Works
1. User saves their API key on the Settings page → encrypted with AES-256-GCM and stored
2. User selects provider + model for "Oggy" (with memory) and "Base" (without memory) independently
3. Every chat request resolves the user's provider preference:
   - First tries user's own API key
   - Falls back to system default key if no user key is set
4. All requests are audited in \`model_request_audit\` table (provider, model, tokens used, latency, success/failure)
5. Provider adapters normalize the different API formats (OpenAI, Anthropic Messages API, Gemini parts format, Grok OpenAI-compatible)

### Tables
- \`user_model_settings\`: User's chosen Oggy/Base provider and model
- \`user_provider_secrets\`: Encrypted API keys per provider
- \`provider_model_registry\`: Available models per provider (display names, defaults, max tokens)
- \`model_request_audit\`: Request-level audit trail

## Memory System
Oggy uses a tiered memory system powered by the memory-service:

### Memory Tiers
- **Tier 1**: Short-term / low confidence (conversation snippets, observations)
- **Tier 2**: Medium-term / user-confirmed (explicit "remember this" requests, corrections)
- **Tier 3**: Long-term / high confidence (promoted patterns with proven reliability)

### How Memory Works
1. **Storage**: Facts stored as "memory cards" with content, tags, utility weight, and reliability score
2. **Retrieval**: Semantic search retrieves top-K relevant cards for each query
3. **Learning**: Oggy extracts learnable insights from conversations (merchant preferences, categorization patterns)
4. **Promotion**: High-performing Tier 1/2 cards get promoted to higher tiers over time
5. **Tables**: \`memory_cards\`, \`memory_audit_events\`, \`retrieval_traces\`, \`knowledge_promotions\`

## Training & Continuous Learning
Oggy improves through structured training sessions:

### Training Sessions
- Users start training sessions (5 min to 24 hours, or indefinite)
- Each cycle: practice scenarios → evaluate → update domain knowledge → optionally run benchmarks
- Progress tracked via scale (1-3) and difficulty level (1-5)
- Email reports sent on completion or errors

### Benchmarks
- Sealed benchmark scenarios test Oggy (with memory) vs Base (without memory)
- Metrics: accuracy, advantage delta, pass/fail
- Historical results in \`sealed_benchmark_results\` with detailed per-scenario breakdowns
- Analytics dashboard shows trends, accuracy over time, category strengths/weaknesses

### Difficulty Progression
- Scale 1 (Beginner): Levels 1-5, basic categorization scenarios
- Scale 2 (Intermediate): Levels 1-5, mixed difficulty with nuanced cases
- Scale 3 (Advanced): Levels 1-5, edge cases and ambiguous merchants
- Oggy levels up by passing benchmarks and accumulating training cycles

### Tables
- \`continuous_learning_state\`: Current scale, difficulty level per user
- \`sealed_benchmarks\`, \`sealed_benchmark_scenarios\`, \`sealed_benchmark_results\`: Benchmark infrastructure
- \`training_metrics\`: Per-cycle training metrics
- \`domain_knowledge\`: Learned categorization rules (scoped per user)
- \`app_events\`: Event log (training starts, completions, benchmark runs)

## Behavior Engine (V1 Payments)
The behavior engine generates multiple candidate responses and selects the best one:
1. Generates 3-4 candidate responses with different styles (concise, detailed, friendly, analytical)
2. Scores candidates based on user preference profile
3. Audits the selection for quality metrics
4. Tables: \`response_audits\`, \`preference_events\`, \`user_preference_profiles\`

## Observer System
Automated background analysis:
- Observer packs analyze benchmark results to identify weak categories
- Generates SDL (Structured Domain Learning) plans to address weaknesses
- Tables: \`observer_packs\`, \`observer_pack_applications\`, \`observer_job_log\`, \`observer_tenant_config\`

## Cost Governance
- Daily token budget (configurable, currently 20M tokens)
- Every LLM call checks budget before proceeding
- Usage tracked and enforced to prevent runaway costs

## Complete Database Tables (41 tables)
| Table | Purpose |
|-------|---------|
| expenses | User expense records with merchant, amount, category |
| domain_knowledge | Learned categorization rules per user |
| continuous_learning_state | Current training scale/level per user |
| sealed_benchmarks | Benchmark definitions |
| sealed_benchmark_scenarios | Individual test scenarios within benchmarks |
| sealed_benchmark_results | Benchmark results (accuracy, advantage, pass/fail) |
| v2_benchmark_scenarios | V2 benchmark scenarios |
| training_metrics | Per-cycle training metrics |
| memory_cards | Persistent memory cards (tiered) |
| memory_audit_events | Memory system audit trail |
| retrieval_traces | Memory retrieval debugging traces |
| knowledge_promotions | Memory tier promotion history |
| app_events | Application event log |
| audit_log | General audit log |
| preference_events | User preference signals (thumbs up/down) |
| user_preference_profiles | Cached user preference profiles |
| v2_preference_events | V2 preference events |
| response_audits | Behavior engine response audit trail |
| suggestion_telemetry | UI suggestion tracking |
| auth_magic_links | Magic link tokens (single-use, 6h expiry) |
| auth_sessions | Active user sessions |
| auth_allowed_emails | Email allowlist |
| auth_rate_limits | Rate limiting for auth endpoints |
| user_model_settings | BYO-Model provider/model selection per user |
| user_provider_secrets | Encrypted API keys (AES-256-GCM) |
| provider_model_registry | Available AI models per provider |
| model_request_audit | Per-request model usage audit |
| oggy_inquiries | Active inquiry questions for users |
| oggy_inquiry_preferences | Inquiry response preferences |
| cir_violations | Circuit breaker violation log |
| sdl_plans | Structured Domain Learning plans |
| observer_packs | Observer analysis packs |
| observer_pack_applications | Observer pack application results |
| observer_job_log | Observer job execution log |
| observer_tenant_config | Per-tenant observer configuration |
| v2_projects | V2 General Chat projects |
| v2_project_messages | V2 project conversation messages |
| v3_diet_entries | Diet log entries |
| v3_diet_items | Individual food items within diet entries |
| v3_diet_rules | User dietary rules and restrictions |
| v3_diet_chat_messages | Diet chat conversation history |
`;
}

/**
 * Detect if the user is asking about the application itself.
 */
function detectAppKnowledgeIntent(message) {
    const lower = message.toLowerCase();
    const keywords = [
        // Security questions
        'encrypted', 'encryption', 'api key', 'api keys', 'secure', 'security',
        'how safe', 'how protected', 'password', 'authentication', 'magic link',
        'session', 'cookie', 'httponly', 'aes', 'gcm', 'credentials',
        // Architecture questions
        'how does oggy work', 'how do you work', 'architecture', 'microservice',
        'database', 'tables', 'data model', 'tech stack', 'infrastructure',
        'how are you built', 'how were you built', 'what technology',
        'docker', 'postgres', 'redis', 'cloudflare',
        // Feature questions
        'what can you do', 'your features', 'what features', 'capabilities',
        'memory system', 'how does memory', 'how do you remember',
        'byo model', 'bring your own', 'model settings', 'provider',
        'training system', 'how does training', 'continuous learning',
        'behavior engine', 'observer', 'benchmark system',
        'diet', 'diet tracking', 'nutrition',
        'general chat', 'payments assistant', 'expense tracking',
        // General about questions
        'tell me about oggy', 'what is oggy', 'about this app',
        'about this application', 'about the platform', 'how does this work',
        'explain how', 'explain the', 'how is data stored',
        'data storage', 'where is my data', 'privacy', 'data privacy',
        'cost governance', 'token budget', 'rate limit',
        'what tables', 'schema', 'data schema',
        // Self-referential
        'about you', 'how were you made', 'who made you', 'who built you'
    ];
    return keywords.some(kw => lower.includes(kw));
}

module.exports = { getApplicationKnowledge, detectAppKnowledgeIntent };
