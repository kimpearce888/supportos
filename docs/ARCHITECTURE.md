# Architecture

SupportOS is a **modular monolith**: one Node.js process, one SQLite database, background workers, and a built frontend served by the same process. No microservices, no cloud dependencies.

## Layers

```
src/
  shared/        domain types, zod schemas, constants, pure utilities
  server/
    config/      env config, structured logger (secret-scrubbing)
    database/    connection (WAL/FK/busy-timeout), migration system,
                 repositories (the ONLY layer that writes SQL)
    integrations/
      helpscout/ provider interface + real provider (OAuth + rate-limited
                 priority API queue, v3 reads / v2 writes) + fake provider
      lmstudio/  OpenAI-compatible local client
      qdrant/    vector store adapter (graceful fallback to FTS)
    sync/        SyncCoordinator: state machine, initial/incremental sync,
                 single-conversation sync, reconciliation
    ai/          prompts (versioned), provider interface, evidence builder,
                 tool registry (read-only), multi-stage pipeline
    search/      FTS5 search engine
    knowledge/   ingestion (MD/TXT/CSV/JSON/HTML/PDF/DOCX)
    analytics/   deterministic SQL metrics + report logic
    automation/  local rules engine with safety tiers
    security/    HTML sanitizer, redaction layer
    services/    app context (wiring), operations (write protection),
                 workers (job queues), webhook endpoint, backup service
    routes/      Fastify route modules + capability matrix
  client/        React app (pages, components, stores, typed API client)
```

## Key design decisions

### 1. The provider boundary (`HelpScoutProvider`)
The whole application depends on an interface, never on endpoints or API versions. `RealHelpScoutProvider` composes 14 service classes (users, teams, inboxes, fields, tags, saved replies, workflows, webhooks, customers, organizations, conversations, threads, reports, attachments) and hides the v2/v3 split: reads use the current v3 conversation endpoints, writes use the documented v2 operations. The UI never knows which version serves an operation. `FakeHelpScoutProvider` implements the same interface with an in-memory mutable world — powering demo mode AND the entire test suite (pagination, rate limits, merges, duplicate events, write flows) without touching a real account.

### 2. Sync engine
Polling + incremental sync is the primary mechanism (webhooks are optional — a localhost app cannot receive external webhooks without a relay). Every resource has a **checkpoint** (last success, cursor, processed/failed counts, last error, retries, status). The initial sync runs in dependency order (account → users → teams → inboxes → fields → tags → organizations → customers → conversations+threads → ratings → statuses) and is fully resumable — restarts never corrupt state and recovery never requires deleting the database. Incremental sync uses `modifiedSince` with a 10-minute overlap window and deduplicates by remote IDs. Remote/created/updated/local timestamps are never conflated.

### 3. Write protection
Every remote mutation follows: validate → verify auth → **read latest remote state** → compute desired state → perform → confirm → persist locally → audit. Tag updates are the canonical example: Help Scout's API is replacement-style, so SupportOS always fetches current remote tags and merges (`remote A,B + add C → A,B,C`, never `A,C` — covered by dedicated tests). Custom fields preserve system fields (Topics/Sentiment) when omitted, per documented behavior. Replies are idempotency-keyed and **never blindly retried** — after a timeout the UI says delivery is uncertain and asks the human to verify.

### 4. Provenance model
The database distinguishes remote source data (`raw_json` + hash retained for every entity, enabling schema-evolution tolerance), local derived data (support cases, metrics), AI-generated data (analyses, drafts, memories — always marked), and human local data (known issues, memories entered by people). Original data is never overwritten with derived data. Every AI source carries `{source_type, source_id, visibility}` and the UI renders sources as clickable evidence chips.

### 5. Job queues
SQLite-backed queues with priorities P0 (user send) → P4 (background indexing), atomic claim, bounded retries with exponential backoff, restart recovery (stale `running` jobs return to the queue). The rate limiter tracks Help Scout's documented headers (`X-RateLimit-Limit-Minute` / `Remaining-Minute` / `Retry-After`), counts writes double, and backs off automatically on 429.

### 6. AI pipeline
Separate stages (analysis → evidence retrieval → draft → verification → note → memory), each an `ai_runs` row with model, prompt version, input hash (caching), latency and output. Prompts live in one versioned module. Retrieval is deterministic (SQL + FTS + hybrid similar-conversation scoring that combines keyword, semantic (when available), same-customer, shared-tag and recency signals); the LLM explains, never counts. Customer-facing generation is bounded: customer-safe evidence only, anti-fabrication rules, redaction layer, then a strict verification pass whose findings (unsupported claims, missing questions, internal leakage) are stored and shown.

### 7. Data flow diagram

```
Help Scout API
      │ (OAuth2, priority queue, rate limiter)
      ▼
SyncCoordinator ──► repositories ──► SQLite (WAL, migrations, FTS5)
      │                                    │
      │                              search indexing (FTS)
      │                              embedding indexing (Qdrant optional)
      ▼                                    ▼
  job queues ◄──── webhook events ──► AI pipeline (LM Studio)
      │                                    │
      ▼                                    ▼
Fastify API  ◄────────────────────────  ai_runs/ai_drafts/verifications
      │
      ▼
React client (TanStack Query server state / Zustand UI state)
```

### 8. Startup sequence
validate environment → run migrations → initialize services → probe Help Scout/LM Studio/Qdrant (optional failures never block startup) → recover stale jobs → start workers → serve UI. In demo mode with an empty database, the initial demo sync + intelligence seeding run automatically.

### 9. Conversation activity engine (v1.7.0)
Help Scout exposes no historical change log — that API limitation shapes the whole design. The `conversation_events` table is a **derived, honestly-sourced** event history, not a claim of what happened upstream:

- **Message events** (`customer_message`, `human_agent_message`, `system_agent_message`, `internal_note`) are derived from the thread mirror with EXACT timestamps (`source: sync`, dedup key `thread:<remoteId>` — one event per remote thread, idempotent across re-syncs).
- **Change events** (`status_changed`, `assignment_changed`, `tag_added`…) observed during sync record the **observation time** with `observed: true` metadata — the change happened between two observations, and the event says so.
- **Local writes** (through `ConversationOperations` — status, assign, tags, fields, snooze, moves, priority, state) record their own exact time with `source: local`.
- **Rebuild events** (`source: rebuild`) derive once at migration/upgrade time from threads, conversation rows, attachments and Help Scout lineitem action records (conservative keyword mapping, raw action text preserved).
- `activity_history_complete = 0` flags conversations whose full thread history is not locally known; their response state is `unknown`, never "never responded".

**Derived activity columns** (first_response_at, customer_waiting_since, last_tag_change_at, … 14 total) are indexed on `conversations` and recomputed transactionally on every upsert — the same SQL the migration backfill uses, so fresh and upgraded databases converge. The **response-state machine** is a single SQL CASE (`RESPONSE_STATE_SQL`) shared by the list filter, the view engine and the detail route, with a JS mirror locked to it by a row-by-row equivalence test. **Saved Inbox Views** persist as Zod-validated JSON condition trees; the ViewEngine compiles them to parameterized SQL with whitelisted identifiers at evaluation time (calendar date modes re-resolve on every open). **Priority and custom ticket states** are local layers — `supportos_priority` never touches Help Scout data unless an explicit custom-field mapping is configured, and `ticket_state_transitions` records every transition (previous/new, actor, reason, timestamp) feeding per-state lifecycle metrics and bottleneck ranking.

### 10. Collaboration layer (v1.8.0)
Five systems built on one discipline: **derive team features from observable facts, never guess, and keep internal data on internal paths**.

- **Operations Center**: 16 tiles computed live, mailbox-scoped. Every conversation-scoped tile is a COUNT(*) over ONE whitelisted parameterized fragment (`tileFragments.ts`) — the *same* fragment `GET /api/conversations?ops=<tileKey>` uses for its drill-down list, so a tile and its list can never disagree (locked by parity tests + a live audit check). SLA tiles call `SlaService` directly (one business-minutes implementation in the codebase); system tiles (approvals, failed jobs, sync, campaigns) read the existing job/sync/outreach stores. Live updates ride the existing SSE bus.
- **Workload & capacity**: per-agent/per-team aggregates with **tiered weighted pressure** (each conversation counts once at its highest tier: urgent > SLA > waiting > open). Capacity is explicit configuration in `application_settings` (default max, per-user overrides, weights — never inferred); availability is the Help Scout `user_statuses` the mirror already syncs; the 7-day average active load is labeled an approximation (current-assignee attribution). The **suggested assignee** ranks available agents by resulting pressure and exposes its reasoning — read-only by construction.
- **Notification Center**: `NotificationSweep` is the **single producer** — one idempotent pass deriving every notification from observable facts (new `conversation_events`, SLA alerts, approval/failed jobs, sync state, campaign replies, known issues, spikes, `ai_runs`, ratings). Dedup keys make re-runs structurally duplicate-free; event-derived notifications reuse the event's own dedup key; state-derived ones include the day. The cursor **defers initialization until the first sync settles** (history is not news). Preferences gate at insert (disabled types produce no rows). Targeting: assignee/mention rows + broadcasts; list/read queries filter to the acting user (`me_remote_id`, first-user fallback). Runs in the worker loop (default 15s) + manual trigger; emits `notification-received` over SSE.
- **Mentions**: exact case-insensitive matching against the identity mirror (mention names, deterministic name fallbacks, team names with spaces) — never prefix/substring; unknown tokens stay plain text and create nothing. Mentions in internal notes are detected by the sweep; mentions in side-thread messages resolve at write time with immediate fan-out (team mentions notify every member except the author; self-mentions notify nobody). The "mentions for me" queue merges both sources, each row linking back to its conversation.
- **Side collaboration threads**: `side_threads` / `side_thread_participants` / `side_thread_messages` / `side_thread_mentions` (migration 012) are **internal-only by construction** — local tables, no provider path, never synced, never customer-visible; the UI states this. Participants are explicit rows (mentioning auto-joins), resolved threads reject messages (409), and every mutation writes `audit_log` entries. Routes validate user/team EXISTENCE before insert (unknown ids are 422, never FK 500s).

## Database

~66 tables across twelve migrations (see `src/server/database/migrations/`; migration 011 adds `conversation_events`, `ticket_states`, `ticket_state_transitions`, `inbox_views` and the derived activity columns on `conversations`; migration 012 adds the collaboration tables — `notifications`, `notification_prefs`, `side_threads`, `side_thread_participants`, `side_thread_messages`, `side_thread_mentions`). FTS5 virtual tables are maintained by repositories (delete+insert pattern) and can be rebuilt from base tables at any time (Sync Health → Rebuild search index); the activity engine has its own idempotent global rebuild (`POST /api/conversations/activity/rebuild`). WAL mode, foreign keys, busy timeout 5000ms, prepared statements everywhere, batched writes in transactions.

## Frontend

React 19 + Vite. Server state via TanStack Query (never the whole database in the browser); UI state via Zustand; composer state is component-local so AI actions and network failures **never lose typed text**. The design system is hand-rolled CSS (dense, professional, desktop-first, dark/light themes) — no marketing chrome. Accessibility: semantic controls, ARIA labels, visible focus, keyboard shortcuts (⌘K command palette, `/` search, `g`+`d/i/s` navigation).
