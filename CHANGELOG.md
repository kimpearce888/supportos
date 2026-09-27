# Changelog

All notable changes to SupportOS are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

