# Changelog

All notable changes to SupportOS are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-09-27

The roadmap-closing release: **Help Scout Chat / Docs / Beacon API coverage, real-time ratings refresh, multi-mailbox dashboards and packaged desktop installers** — the entire original public roadmap, delivered. 172/172 tests green (22 new).

### Added — Chat / Docs / Beacon API coverage
- **Beacon chat sessions are first-class mirror citizens**: Help Scout surfaces Beacon chats as conversations with `type=chat` and `source {type=chat, via=beacon}` — SupportOS now stores that attribution (`source_type` / `source_via` columns, migration 007), adds a `chats` catch-up sync resource with its own checkpoint, and gives the inbox a **channel filter (All / Email / Chat)** with Beacon badges on chat rows
- **Channel analytics**: dashboards now compute a channel mix and **per-channel first-response / resolution speeds** (chat in minutes, email in hours — finally measurable side by side)
- **Docs mirror (read-only)**: Help Scout Docs collections, categories and articles sync from `docsapi.helpscout.net` (separate Docs API key via `HELPSCOUT_DOCS_API_KEY`, HTTP Basic auth — implemented as a second `HelpScoutHttpClient` in `header` auth mode). New tables + `docs_fts` FTS5 index, new **Docs page** with offline full-text search, status filters, collection chips, view counts and article reader (`/docs`); `GET /api/docs/collections|articles|stats|articles/:id`
- **Capability matrix flipped**: chat-api, docs-api and beacon rows are now `implemented: true` with honest notes (the conversations endpoint has no documented type filter → local filtering; no Docs key → empty mirror, never an error)
- Provider interface grows `listChatSessions`, `listDocCollections`, `listDocCategories`, `listDocArticles`; implemented by both the real and the fake provider (demo data gains 6 Beacon chats + 9 Docs articles whose content deliberately matches the demo tickets, so search demos are meaningful)

### Added — Real-time ratings refresh
- **Server-Sent Events endpoint `GET /api/events`**: a typed in-process event bus (`serverEventBus`) broadcasts `rating-received`, `ratings-refreshed` and `sync-completed`; every subscription cleans up on disconnect; keep-alive pings; GET-exempt from rate limiting
- **Lightweight ratings watcher** in the worker manager (default every 30s, `ratings_refresh_seconds` setting, 0 disables, clamped 10s–1h): upserts ratings and emits events only for NEW ratings — decoupled from the full sync pass
- **`upsertRating` now reports whether the rating was newly inserted** — the dedup signal the real-time layer needs to avoid spamming on every re-sync
- **Client `ServerEventsBridge`**: one shared `EventSource` for the whole SPA; ratings events invalidate dashboard/customer caches and raise a toast; sync events refresh conversation lists — the UI updates in seconds without polling
- **Demo hook `POST /api/demo/simulate-rating`**: simulates a CSAT rating landing right now (upsert + instant SSE broadcast) so the real-time path is demonstrable and e2e-tested over the wire

### Added — Multi-mailbox dashboards
- **`GET /api/analytics/dashboard` accepts `mailboxIds` (comma list) and `channel` (email|chat)**; every KPI respects the scope; invalid values are 422s
- **`mailbox_comparison` rows**: full KPI set per mailbox (new/active/closed/backlog/first-response/resolution/great-ratings) — computed by the same deterministic SQL as the headline numbers, so single- and multi-mailbox views can never disagree
- **Dashboard UI**: multi-select mailbox chips + channel chips, state in the URL (`/?days=90&mailboxes=1,2&channel=chat` — shareable and back-button safe), plus Channel mix & speed and Mailbox comparison cards

### Added — Packaged desktop installers (MSI / DMG / AppImage)
- **`scripts/build-desktop.mjs`** assembles everything the Tauri shell needs: esbuild single-file server bundle (14MB, `better-sqlite3` external), the native module + its runtime deps (`bindings`, `file-uri-to-path`), the built client, and a **stock official Node runtime downloaded per platform** (version-matched to the assembling Node so the native ABI always matches; `--universal` lipo for macOS)
- **Tauri 2 shell completed**: rewritten `tauri.conf.json` (targets msi/nsis/dmg/appimage, resources bundling), `Cargo.toml` + `build.rs`, and a new `src-tauri/src/lib.rs` that spawns the bundled backend on a free port, waits for `/health`, opens the window, honors `SUPPORTOS_CLIENT_DIST` / data-dir env overrides, kills the child on exit, and single-instance focuses the existing window
- **`.github/workflows/desktop-release.yml`**: matrix build on windows-latest / macos-latest (universal) / ubuntu-22.04 — assembles resources natively, runs `tauri-apps/tauri-action`, and attaches MSI/NSIS/DMG/AppImage to the release. Resources are assembled in CI, never committed
- App icon designed + generated (`scripts/make_icon.py` + `tauri icon`): indigo→blue rounded square, white S, insight spark
- New npm scripts: `desktop:prepare`, `desktop:dev`, `desktop:build`, `desktop:icon`; `esbuild` + `@tauri-apps/cli` added as devDependencies
- Local verification: the packaged bundle boots on the bundled Node runtime (health, SPA, docs API, channel filter and SSE all verified against the exact artifacts CI ships)

### Changed
- `conversations` table gains `source_type` / `source_via` (+ indexes); `ConversationSummary` API responses now include `type` and `source_via`
- Initial sync order gains `chats`, `docs_collections`, `docs_articles`; incremental sync refreshes the docs mirror alongside reference data
- `RealHelpScoutProvider` constructor accepts `docsApiKey` / `docsApiBase`; `HelpScoutHttpClient` supports a `header` auth mode (complete Authorization header, no 401-refresh) for the Docs API
- Config: `HELPSCOUT_DOCS_API_KEY`, `HELPSCOUT_DOCS_API_BASE`, `BACKUPS_PATH`, `SUPPORTOS_CLIENT_DIST` env support (the last two make packaged builds possible without code changes)
- Demo data: 6 Beacon chat sessions (5 closed in minutes, 1 active), 3 new ratings incl. chat ratings, `beacon` tag, 2 Docs collections / 9 articles

### Tests (150 → 172)
- New integration suite `tests/integration/channels_docs.test.ts`: chat sync + source attribution, channel filter, docs mirror + FTS + stats + idempotency, multi-mailbox + channel dashboard scoping, `upsertRating` new-insert semantics, event bus delivery + failing-subscriber isolation
- New e2e suite `tests/e2e/realtime_docs.e2e.test.ts`: channel filter 200/422 paths, docs endpoints incl. 404, mailboxIds/channel dashboard scoping + validation, and a **real SSE stream test** (opens `/api/events`, triggers `simulate-rating`, asserts the rating event arrives on the same stream)
- Updated count-based expectations for the richer demo dataset; capability-matrix e2e now asserts full implementation coverage (previously `total - 3` for the future-extension rows)

## [1.2.0] — 2026-09-27

The hardening release: a full independent audit (static analysis, black-box runtime testing against a fresh database, and line-by-line review of every write path) produced **40+ findings; every confirmed issue is fixed and locked down by a regression test that names it**. 150/150 tests green.

### Fixed — Security & data protection
- **`@fastify/static` upgraded 8.3.0 → 10.1.5** — closes 4 published advisories (path traversal / route-guard bypass / authorization bypass)
- **AI evaluation mode now blocks EVERY remote write** — previously only notes and status changes were guarded; replies, assignments, tag/field edits, moves, snoozes, schedules, workflows and bulk actions could still reach Help Scout while users believed nothing left the machine
- **Demo-mode arbitrary file import closed** — `POST /api/knowledge/import-file` bypassed the allowed-roots check in demo mode, letting an unauthenticated local caller import and read back any `.md/.txt/.csv/.json/.html/.pdf/.docx` file on the machine
- **Settings API hardened** — `PATCH /api/settings` now validates a strict whitelist of user-facing keys; internal keys (`oauth_state`, `me_remote_id`, …) can no longer be poisoned, a NaN `sync_interval_minutes` can no longer collapse the sync loop to a 1ms runaway timer, and `lmstudio_base_url` can no longer be redirected to an arbitrary URL
- **Attachment serving rewritten** — production returned 404 for every attachment (`sendFile` joined the absolute path onto the SPA root); dev served `text/html` inline same-origin (stored XSS). Now: direct stream, images-only inline whitelist, forced `Content-Disposition: attachment`, `nosniff`, separator-aware path containment, id validation
- **Inline CSS scrubbing in sanitized thread HTML** — `position:fixed` overlays and `url()` tracking beacons no longer pass through `style` attributes
- **CORS rebuilt from the configured port** — running on any custom `PORT` previously broke the SPA's own API calls (the allowlist was hardcoded to 3000/5173); foreign origins are now denied cleanly instead of erroring
- **Webhook HMAC computed over the raw request bytes** — re-serialized JSON broke signature verification for legitimate Help Scout payloads; a startup warning is now logged when the webhook secret is unset
- `trustProxy` disabled (spoofable `X-Forwarded-For` no longer defeats rate-limit keying)

### Fixed — Data integrity (Client Interaction Intelligence)
- **Observations are idempotent** — every refresh/sync tick previously inserted duplicate rows, inflating observation counts and confidence, multiplying the weight of frequently-refreshed conversations in recency-weighted baselines, and letting a SINGLE ticket reach the 3-observation preference threshold (spec #39's repeated-evidence rule). Unique index `(conversation_id, dimension, source)` + in-place upsert; migration 006 collapses existing duplicates
- **`client_current_signals` capped at one row per conversation** (was append-per-refresh, unbounded growth); Stage-2 AI recommendations are now persisted and actually served on later GETs (the `heuristic+ai` label previously flipped without merging any AI data)
- **`resolved_after_first_response` requires a CLOSED conversation** — an always-true `|| true` had counted in-flight tickets as resolved, inflating first-response resolution rates and "worked in N cases"
- **Closing acknowledgments excluded from follow-up counting** — "thanks, that worked, closing from my side" is courtesy, not customer effort
- **Change detection: nominal dimensions (tone, expectation, question structure) report "changed", not a meaningless "increase"** — only genuinely ordinal dimensions get direction/magnitude/significance
- **Preference threshold counts DISTINCT conversations**, not repeated rows
- **Human override flow rebuilt** — the UI previously sent the preference value as the field name (every override attempt returned 422); overrides are value-keyed, validated against the known preference vocabulary, visible in the UI with a manual-entry path when nothing is inferred yet, and reverting now fully restores AI semantics (previously left a phantom "human-entered preference with 0 interactions" and leaked the literal field name into draft prompts)
- **AI evidence integrity** — hallucinated `evidence_thread_local_id`s no longer persist (validated against the ids actually present in the prompt); evidence excerpts are scanned for forbidden trait claims like every other free-text field
- **Safety vocabulary extended** — "rude", "entitled", "needy", "passive-aggressive", "the customer is X" trait statements and more are rejected
- **Heuristic evidence mandate** — every heuristic classifier's evidence predicate now covers its own trigger phrases (a "please give a short answer" preference previously carried no evidence excerpt)

### Fixed — Correctness & crashes
- **Zod validation failures return 422** (not 500) with a readable message — and no longer pollute `application_errors`
- **NaN query parameters are clamped** — `?page=abc`, `?pageSize=abc`, `?limit=abc` previously threw 500s ("datatype mismatch")
- **Schedule publish/delete tolerate missing bodies** (422 instead of a crash) and verify the thread belongs to the conversation
- **Draft-then-send no longer blocked by duplicate-send protection** — the draft flag is part of the idempotency key; true duplicate sends are still blocked
- **Rate limiting is mutation-only** — the global 300/min limiter previously 429'd the SPA itself (reads + index.html) during normal polling; webhook endpoint (HMAC-authenticated, deduplicated) is exempt
- **Custom-field editor sends Help Scout REMOTE field ids** — local-id keys made every save of existing values fail silently and rendered each field twice
- **Attachment download buttons download the clicked attachment** (not always the first of the thread)
- **Search deep links work** — knowledge hits open the document reader (`/knowledge?doc=N`), known-issue hits open the Issues tab; previously all three scopes redirected to the Dashboard
- **Tag filter preserved** when paginating or switching inbox views
- **Bulk "Unassigned" works** (null instead of empty-string user id) and bulk params accept numbers/null
- **Query errors surface on every page** — detail pages no longer spin forever on API failure
- **Fire-and-forget actions report failures** (publish/delete schedule, snooze removal, workflow run, HS draft creation, sync cancel) instead of silently doing nothing
- **Backups endpoint caches integrity verification** (was a full DB scan of every backup on every request) and closes file handles on error
- **`retention_days` is now enforced** — webhook events, application errors, audit log entries and AI run records older than the window are pruned by the maintenance worker (conversations mirror Help Scout and are intentionally untouched)
- Knowledge document replace and FTS index rebuild wrapped in transactions; CSV ingestion row-capped at 500
- g-chord navigation re-checks typing context; settings number inputs no longer save 0 when cleared; duplicate React keys fixed; modals trap focus; SPA navigation uses `Link` instead of full page reloads

### Added
- Migration 006 `interaction_integrity` (idempotent upgrade path for v1.1.0 databases)
- 20 new regression tests that name their audit findings (`tests/integration/audit-fixes.test.ts`, `tests/e2e/audit-fixes.e2e.test.ts`)
- `README` gains "The Story" — why SupportOS exists and the reasoning behind every major architectural decision
- Startup warning when webhooks are accepted without signature verification

## [1.1.0] — 2026-09-27

Client Interaction Intelligence: per-client communication behavior intelligence, built with a deterministic core and optional two-stage local AI.

### Added — Client Interaction Intelligence
- **Current interaction analysis** — observable signals (tone, directness, detail, technical language, question structure, urgency, frustration, expectation) with confidence and evidence excerpts linked to the source thread; first-time vs returning client distinction
- **Historical behavioral baseline** — recency-weighted (90-day half-life) typical values per dimension, built from closed conversations only; profile versioning
- **Current-vs-normal change detection** — per-dimension direction, magnitude and significance ("today the client is more urgent and less detailed than usual")
- **Support approach recommendations** — tone, length, start-with, response strategy, avoid list, de-escalation guidance, escalation recommendation, with "why" explanations
- **Observed communication preferences** — repeated evidence (3+ interactions) required before a pattern counts; explicit in-message requests always win
- **Human overrides** — reps can correct any preference with a reason; overrides take precedence over AI inference and are fully audited and revertible
- **Support outcomes** — first-response resolution rate, follow-up/clarification/escalation rates, customer effort score, conversation friction detection, historically effective approaches
- **Repeat-issue detection** — customer + problem recurrence across conversations
- **Client Support Playbook** — best opening, explanation style, troubleshooting style, likely follow-up, historically successful patterns, avoid list
- **Draft pipeline integration** — communication approach + already-provided facts injected into customer-draft prompts so drafts never ask customers to repeat themselves

### Added — Safety (defense in depth)
- Fixed observable-dimension vocabulary enforced by schema — personality labels, diagnoses and protected-attribute claims are structurally impossible
- Evidence requirement: significant AI signals without a quoted excerpt are dropped
- Free-text sanitizer rejects mental-health language, personality typing, clinical diagnosis language and moral-character judgments
- Two-stage prompts (observation → recommendation) with the anti-diagnosis wording enforced at the service layer
- Every surface labeled "Observable support-communication behavior — never a psychological assessment"

### Added — Engineering
- Database migration 005: `client_current_signals`, `client_behavior_observations`, `client_behavior_baselines`, `client_communication_preferences`, `client_human_overrides`, `client_support_outcomes`
- Deterministic engine works entirely without LM Studio (graceful degradation); AI stages enrich signals/recommendations when available
- New API: `GET/POST /api/interaction/:id`, `GET /api/interaction/:id/evidence`, `GET /api/interaction/profile/:customerId`, `POST/DELETE /api/interaction/profile/:customerId/override`
- Inbox CLIENT INTELLIGENCE card with View Evidence drawer; Customer page Client Interaction Profile section with timeline, preferences, outcomes and playbook
- Workers populate interaction history after initial sync; lazy backfill for databases created before v1.1.0
- Demo world: returning client Ravi Sundaram with three calm technical historical tickets vs today's urgent Slack ticket (change-detection showcase)
- 22 new tests (heuristics vocabulary/word-boundary matching, evidence requirements, forbidden-claim sanitizer, baseline/change, override precedence, outcomes, repeat detection, e2e API) — 130 total

### Fixed
- Customer emails/phones returned as a GROUP_CONCAT string instead of an array, crashing the customer detail page (`peopleRepo` rows now normalized at the repository boundary)

## [1.0.0] — 2026-09-27

First public release.

### Added — Support workspace
- Local SQLite mirror of Help Scout: account, users, teams, inboxes, folders, tags, custom fields, customers, organizations, conversations, threads, attachments, ratings, saved replies, workflows, routing, user statuses
- Sync engine with per-resource checkpoints, dependency-ordered initial sync (19 resources), incremental sync with overlap window, drift reconciliation, resumable after restart
- 3-pane inbox workspace: conversation views, filters, bulk actions, sanitized thread rendering, customer and AI context panes
- Rich composer: reply, draft, internal note, cc/bcc, status-after-send, saved replies, AI draft insertion
- Full ticket operations with write protection (validate → auth → fresh-read → merge → write → confirm → persist → audit): status, assignment, inbox moves, subjects, merge-safe tags, system-field-safe custom fields, snooze, scheduled replies + publish, attachments, workflow runs
- First-run onboarding wizard, command palette (⌘K), keyboard shortcuts, dark/light theme

### Added — Search & intelligence
- FTS5 universal search across tickets, thread text, customers, knowledge, known issues, saved replies and AI analyses, with filters and exact ticket-number lookup
- Optional semantic search via local Qdrant with graceful fallback
- Issue Radar: new/rising/recurring clusters with ticket links; known issues with customer-safe vs internal explanations; doc-gap detection; answer-reuse candidates
- Reports: local analytics with metric definitions and limitations, Help Scout native report import (labeled), AI narratives (labeled AI-derived), release correlation that never claims causation
- Local knowledge base: MD/TXT/CSV/JSON/HTML native import, PDF/DOCX parsing, chunking, customer-safe vs internal visibility
- Local automation rules engine with read / non-destructive / higher-risk tiers; higher-risk actions always require approval

### Added — Local AI (LM Studio, OpenAI-compatible)
- Ticket analysis (intent, questions, urgency, sentiment), evidence-backed verified answer drafts, verification pass (unsupported claims, missing questions, internal leakage)
- Customer memories, issue clustering, report narratives, rewrites, AI notes
- Multi-stage pipeline with input-hash caching and change detection; read-only tool registry with server-side validation
- Every output versioned, audited and labeled AI-generated

### Added — Safety & operations
- Automatic reply sending permanently OFF; AI operates in observe/assist mode only
- Redaction of payment data, tokens and API keys before prompting and logging
- Sanitized rendering of untrusted ticket HTML (no scripts, no `javascript:` URLs)
- Webhook ingestion with HMAC-SHA1 timing-safe verification, persist-first processing, hash deduplication
- Background job queues (sync / API / attachments / embeddings / AI / reports / maintenance) with priority, backoff and restart recovery
- Verified backups (VACUUM INTO), restore tooling, CSV/JSON export, audit log, capability matrix, Sync Health screen

### Added — Engineering
- 108 automated tests (29 unit, 51 integration, 28 e2e) covering spec-critical behaviors; the suite is architected so no test can ever send a real message (FakeHelpScoutProvider)
- Strict TypeScript (server + client), ESLint clean, Vitest, GitHub Actions CI (lint → typecheck → build → tests → demo-mode boot smoke test)
- Tauri 2 desktop wrapper (optional native build)
- Documentation set: architecture, API integration matrix, AI setup, Windows install, local run, backup/restore, testing, troubleshooting

[1.1.0]: https://github.com/kimpearce888/supportos/releases/tag/v1.1.0
[1.0.0]: https://github.com/kimpearce888/supportos/releases/tag/v1.0.0

