# Changelog

All notable changes to SupportOS are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] — 2026-09-28

The intelligence release: SupportOS gains a **Local Copilot** and a **general AI attribute layer**, and automation learns to act on both — safely. The **Local Copilot** (plan phase 15) is an interactive, read-only assistant living in every conversation's context pane: it answers questions like *What is this customer asking? Have we seen this issue before? What solved the previous cases? Why is this ticket urgent?* using an allowlisted read-only tool registry (current conversation, customer history, similar conversations, knowledge, known issues, issue clusters, saved replies, AI analyses, SupportOS metadata, the attribute layer). The model never sees SQL, every tool result is server-validated, bounded and redacted, the tool loop is hard-bounded, and **citations are machine-generated** — the source list is built by the server from the tools it actually executed, so a model cannot fabricate a source that survives. The Copilot performs zero writes by construction; if LM Studio is off, it says so instead of pretending. The **general AI attribute layer** (plan phase 16) gives every conversation first-class local attributes — intent, product, feature, issue, urgency, frustration cues, technical familiarity, customer goal, question count, risk, known issue, issue cluster, response style, escalation signal — in two layers: deterministic slots computed from observable local facts with zero AI, and AI slots extracted by LM Studio with evidence excerpts and enum-closed values. Every snapshot is **versioned** (recompute supersedes, history is preserved), confidence-aware, and honest: a missing attribute IS `unknown` and is never fabricated. Attributes are searchable, filterable and reportable: a live inbox filter (compiled through the *same* viewEngine code path as saved views — one implementation, never two), saved Inbox Views, Outreach segments, and an AI Center coverage report with per-attribute drill-downs. **AI escalation rules** (plan phase 17) extend automation with `ai_attribute` and `ai_verification` conditions: high urgency can route to the review queue, but the AI never performs a write — conditions only decide whether a rule matches, actions flow through the same approval tiers as before, and an unknown attribute never matches a concrete value. 462/462 tests green (+54 over v1.8.0), the black-box audit grew a v1.9.0 section (383 checks, 0 HIGH / 0 MEDIUM after fixes), and the human-like browser pass walked all 17 pages with zero console errors.

### Added — Local Copilot (plan phase 15)
- Interactive read-only assistant in the conversation context pane (third tab), plus a Copilot sessions browser in the AI Center.
- 7 new read-only tools join the registry: `get_conversation_context`, `get_customer_history`, `get_similar_conversations`, `get_issue_clusters`, `get_ai_analysis`, `get_supportos_metadata`, `get_ai_attributes` — every result bounded and redacted before the model sees it.
- Machine-generated citations from real tool executions (the model cannot fabricate sources); answers must cite evidence with inline markers.
- Bounded tool loop (max rounds + max calls per turn): a tool-looping model gets a hard stop and must answer from what it has, honestly.
- Persistent sessions and messages (`copilot_sessions` / `copilot_messages`), every turn audited with `ai_involvement=true` and recorded in `ai_runs` with model, prompt version and latency.
- Deterministic starter questions personalized from local facts (prior tickets, known-issue links, analysis state).
- Honest degradation: AI disabled or LM Studio unreachable → clear 503s and in-UI error states, never fake answers.

### Added — general AI attribute layer (plan phase 16)
- Closed 14-key catalog (`ai_attributes` table, migration 013) with per-key value types and vocabularies; every stored row is validated against the catalog at write time.
- Deterministic layer (zero AI): urgency, frustration cues, technical familiarity, escalation signal, question count, risk composite, known-issue and issue-cluster membership, customer goal, response style — always computable from observable local facts.
- AI layer (LM Studio only): intent, product, feature, issue, customer goal, response style — evidence excerpts required for medium/high confidence, thread references validated against ids that were actually in the prompt, enum violations are dropped rather than stored.
- Versioned snapshots: recompute retires prior rows (`superseded_at`), full history preserved per attribute; a key with no record reads as honest `unknown`.
- Searchable / filterable / reportable: live inbox filter (`aiAttribute`/`aiAttrOp`/`aiAttrValue` — compiled by the same viewEngine path as saved views), saved-view conditions, Outreach segment conditions (`aiAttribute`), AI Center coverage report with known/unknown percentages and conversation drill-downs.
- Per-conversation snapshot card in the AI sidebar with confidence, source (deterministic/AI), evidence excerpts and one-click recompute.
- `compute_attributes` worker job + bounded v1.9.0 backfill (analyzed conversations without attribute rows, capped at 500).

### Added — AI escalation rules (plan phase 17)
- Automation conditions can test `ai_attribute` (with a required catalog key) and `ai_verification` (`failed`/`passed`/`none`), all Zod-validated at the API boundary.
- Operator semantics follow the attribute's value type; ordered enum comparisons use vocabulary position; missing attributes match `equals unknown` and nothing else.
- Safety invariant preserved: conditions only decide matches — actions flow through the existing read / non-destructive / higher-risk approval tiers; nothing customer-facing ever happens silently.
- The Automation UI exposes the new condition fields with the closed attribute-key selector and the safety note.

### Fixed
- Copilot citations now deep-link conversations for every tool result shape (conversation-shaped results carry `id`+`number`; similar-conversation results keep their `conversation_id`; number-only results are resolved server-side).
- `ai_runs` rows for copilot chats now record the model column, not just the output JSON.
- Copilot chat with an unknown session id returns a clean 404 (client error) instead of a service-shaped 503.
- Boolean attributes get closed true/false/unknown selects in the filter UI (no free-text guessing).

### Security & integrity
- Black-box audit section K (22 new checks; 383 total): injection-shaped attribute keys/values, LIKE-wildcard probes, live-filter parity vs. the snapshot, hostile copilot bodies, oversized questions, unknown sessions/conversations, closed-vocabulary automation conditions — final: 0 HIGH / 0 MEDIUM.
- The model never receives SQL, raw thread bodies beyond bounded redacted excerpts, or write-shaped tools; the tools endpoint publishes the allowlist for transparency.
- Attributes are local intelligence only — they never write to Help Scout and never overwrite source data.

## [1.8.0] — 2026-09-28

The collaboration release: SupportOS stops being a single-operator mirror and becomes a **team operating system**. A live **Operations Center** puts the whole support operation on one screen — 16 tiles (unassigned, needs first response, customer waiting, waiting over threshold, urgent, SLA at risk/breached, high customer effort, repeated issue, known issue, AI escalation, issue spike, automation approvals, failed jobs, sync problems, campaign activity), scoped by mailbox, every conversation tile drilling into the *exact same filtered inbox list* (one SQL fragment is the single source of truth for both the count and the drill-down — they can never disagree). A **workload & capacity engine** exposes per-agent and per-team load with an explicit, configurable capacity model (never inferred from anything about a person), Help Scout-synced availability, and a **suggested assignee** that is a read-only recommendation with its reasoning exposed — nothing ever reassigns automatically. A persistent **Notification Center** produces 14 notification types from a single idempotent sweep (customer replies, assignments, mentions, SLA states, approvals, AI escalations, known issues, spikes, campaign replies, sync/job failures, customer events) with targeting, per-type preferences, unread badge and live SSE delivery. **@mentions** work in internal notes and side threads (exact identity matching against the Help Scout mirror — unknown tokens stay plain text, never guessed), and **side collaboration threads** give conversations internal-only discussion spaces (Support / Engineering / Billing style) that never touch the customer-visible Help Scout thread. 408/408 tests green (+64 over v1.7.0), the black-box audit grew a v1.8.0 section (361 checks, 0 HIGH / 0 MEDIUM after fixes), and the human-like browser pass walked all 16 pages with zero console errors.

### Added — Operations Center (plan phase 10)
- **`GET /api/operations/center?mailboxes=…`**: the 16-tile live snapshot, scoped to all/selected inboxes. Conversation-scoped tiles are COUNT(*) over ONE whitelisted parameterized fragment (`tileFragments.ts`); the same fragment powers `GET /api/conversations?ops=<tileKey>` drill-downs — a tile number can never disagree with the inbox list it links to (locked by parity tests and a live audit check).
- **Honest measurement notes on every tile**: the waiting threshold is wall-clock minutes (configurable via `PUT /api/operations/waiting-threshold`, clamped 1–20160); SLA tiles reuse `SlaService`'s exact business-minutes logic (one implementation in the codebase); "high customer effort" is a labeled heuristic (strong frustration signal OR 5+ customer messages); AI escalation reflects the latest analysis (urgency high/critical or frustrated sentiment, medium/high confidence) — a flag to look, never an action.
- **Reused infrastructure, not parallel plumbing**: SLA states from the existing Issue Radar computation, approvals/failed jobs from the existing queue, sync health from the existing state machine, campaign activity from the existing outreach store; live updates ride the existing SSE event bus.

### Added — team workload & capacity (plan phase 11)
- **`GET /api/operations/workload`**: per-agent open/pending/customer-waiting/urgent/SLA-risk workload, weighted load, capacity, pressure, 7-day average active load (honestly labeled an approximation — assignment changes mid-conversation are not historically reconstructable), recent closed volume, and availability from the already-synced Help Scout user statuses (unknown when not synced, never guessed).
- **Explicit capacity model** (`PUT /api/operations/capacity`): default max open + per-user overrides (digit-keyed, validated) + tier weights (urgent/SLA/waiting/open). Every conversation counts once at its highest tier — no double counting. An invalid stored model falls back to defaults instead of guessing.
- **`GET /api/operations/suggested-assignees`**: deterministic ranking (available agents first, then lowest resulting pressure, user-id tiebreak) with the reasoning exposed per suggestion. Read-only by construction — assignment happens when a human clicks Assign (the normal audited write path), or through the existing approved-automation flow if explicitly enabled.

### Added — Notification Center (plan phase 12)
- **One producer, one funnel**: `NotificationSweep` (v1.8.0) derives every notification from an observable local fact — new `conversation_events` (customer replies, assignments, note mentions), `SlaService` alerts, automation-approval jobs, failed jobs, sync state, campaign replies, known issues, issue clusters, `ai_runs`, ratings. No free-form producers, no guesses. Runs in the worker loop (default every 15s, `notification_sweep_seconds` setting) + a manual `POST /api/notifications/sweep`.
- **Idempotent by construction**: event-derived notifications reuse the event's own dedup key; state-derived ones (SLA, spikes, sync failures) include the day — re-syncs, re-sweeps and crashes mid-sweep can never duplicate. Disabled preference types produce no rows at all (not hidden rows).
- **Targeting**: assignee-targeted assignment/reply notifications, mention-targeted rows, broadcast SLA/system rows — list/read queries filter to the acting user (broadcasts + own rows). "Me" is the connected Help Scout user (`me_remote_id`), falling back to the first synced user like the my-tickets view.
- **API**: list (filters: unread/type, limit/offset), unread count, mark read/unread (visibility-checked), mark all read, per-type preferences (14 types, defaults on), the "mentions for me" queue, and retention pruning alongside other local operational data.
- **SSE delivery**: every new notification emits `notification-received` → the client invalidates the badge/center/ops queries live (verified in the browser: the nav badge went 1→2 without a refresh); only CRITICAL severities interrupt with a toast (SLA breach, sync failure).

### Added — mentions (plan phase 13)
- **`@agent` and `@team` in internal notes and side-thread messages**: exact case-insensitive matching against the identities Help Scout itself knows (mention names, plus deterministic first/full-name fallbacks for users that lack one; teams by name, spaces allowed after `@`). No prefix or substring matching — `@al` never notifies Alex; unknown tokens stay plain text and create nothing (verified by audit probes).
- **@autocomplete in the note composer and side-thread composer**: typing `@` opens a filtered suggestion popup (arrow keys + Enter/Tab complete, Escape closes) sourced from `GET /api/mention-directory`. Notes show resolved mention chips; side-thread bodies render mention tokens highlighted.
- **"Mentions for me" queue**: mention notifications (notes, via the sweep) + side-thread mention rows (created at message time), both linking back to the conversation. Team mentions fan out to every member except the author; self-mentions produce no notification.

### Added — side collaboration threads (plan phase 14)
- **`side_threads` / `side_thread_participants` / `side_thread_messages` / `side_thread_mentions` (migration 012)**: internal-only discussions attached to a conversation (optionally anchored to a team), with participants, messages, timestamps, mentions, resolve/reopen and full audit history — every create/message/participant/status change writes `audit_log` entries with before/after state.
- **Never customer-visible by construction**: purely local tables, no route touches the Help Scout provider, nothing syncs out. The UI says so.
- **Participants are explicit; mentioning auto-joins** (observable behavior, not inference). Resolved threads reject new messages with 409. Existence checks validate users/teams before insert — an unknown id is a 422, never an FK 500.

### Fixed — found by this release's own testing (each locked by a regression test)
- **Fresh-install notification spam** (found live during browser verification): the boot sweep initialized its cursor *before* the initial sync populated `conversation_events`, so the entire first-sync history arrived "after the cursor" and notified — 15+ rows on a brand-new install. The sweep now defers cursor initialization while the sync state is NEW/INITIALIZING/BACKFILLING and initializes silently once the mirror has settled.
- **Sweep dropped assignment metadata**: the event query didn't SELECT `e.metadata`, so `assignment_changed` events never resolved their new assignee — assignment notifications were silently skipped. (Caught by integration tests.)
- **`team_members` column confusion** (`user_local_id` vs the actual `user_id`): crashed the workload snapshot and team-mention fan-out with "no such column". (Caught by the live smoke test.)
- **Duplicate query params crashed the Operations Center** (`?mailboxes=1&mailboxes=2` arrives as an array → 500). Now normalized.
- **Unknown participant/user ids in side threads** passed Zod shape validation then hit FK constraints → 500. Existence checks now return 422.
- **`notification read` with a non-boolean body** silently defaulted to "mark read" instead of 422.
- **`per_user_max` accepted arbitrary string keys** (injection-shaped keys were inert but sloppy) — keys now must be digits.
- **`sync_state` JSON-quoting**: the sweep compared the raw stored value (`"ERROR"` with quotes) against `ERROR` and never fired sync-failure notifications.

## [1.7.0] — 2026-09-28

The activity-intelligence release: SupportOS stops treating conversations as rows with two timestamps and starts treating them as **event histories with a lifecycle**. A new **conversation activity engine** derives a normalized event log from the Help Scout mirror (messages, notes, lineitem action records, observed changes, local writes — deduplicated, honestly sourced), maintains **14 derived activity timestamps** per conversation (first response, last customer reply, waiting-since, last status/tag/field change…), and layers a deterministic **response-state machine** (Needs First Response / Customer Waiting / Agent Waiting / Recently Responded / Never Responded / Closed / Snoozed / Unknown) on top. The Inbox gains **date & activity filters** across 14 activity fields × 16 date modes (DST-safe in the user's timezone), **saved Inbox Views** (structured condition trees with AND/OR groups, dynamically re-resolved every time they are opened), a first-class local **ticket priority**, and configurable **custom ticket states** with full transition history and per-state lifecycle metrics. 344/344 tests green (+56 over v1.6.0), the black-box audit grew a dedicated v1.7.0 section (335 checks, 0 HIGH/0 MEDIUM findings).

### Added — conversation activity engine (plan phases 1–2)
- **`conversation_events` table + repository (migration 011)**: a normalized local event history — `conversation_created`, `customer_message`, `human_agent_message`, `system_agent_message`, `internal_note`, `status_changed`, `assignment_changed`, `team_changed`, `inbox_changed`/`moved`, `tag_added`/`tag_removed`, `custom_field_changed`, `snoozed`/`unsnoozed`, `closed`/`reopened`, `attachment_added`, `priority_changed`, `ticket_state_changed`, `lineitem_action` — each with actor, occurred_at, source and metadata. Dedup keys make re-syncs idempotent (one event per remote thread, verified by rebuild-twice tests).
- **Honest sourcing (a Help Scout API limitation, documented)**: Help Scout exposes no historical change log. Message events are derived from the thread mirror with EXACT timestamps; change events observed during sync record the observation time (`source: sync`, `observed: true` in metadata); local writes record their own exact time (`source: local`); pre-migration history is derived once at upgrade (`source: rebuild`). Conversations whose full thread history is not locally known are flagged `activity_history_complete = 0` and their response state reports `unknown` instead of guessing.
- **14 derived activity columns on `conversations`** (indexed for range scans): `first_customer_message_at`, `first_response_at`, `last_customer_reply_at`, `last_human_agent_response_at`, `last_system_response_at`, `last_note_at`, `customer_waiting_since`, `last_status_change_at`, `last_assignment_change_at`, `last_tag_change_at`, `last_custom_field_change_at`, plus history-completeness. Recomputed transactionally on every thread/conversation upsert; backfilled in SQL at migration time (a fresh DB and an upgraded DB converge on identical values — locked by tests).
- **`GET /api/conversations/:id/events`**: chronological timeline with resolved actor names, event counts, and an idempotent `POST /api/conversations/activity/rebuild` admin endpoint (bounded batches, re-derives everything from the mirror).
- **Help Scout lineitem threads** (action records) map conservatively to change events — status/assign/move/tag keyword matching with the raw action text preserved in metadata; anything unrecognized is kept as `lineitem_action` so nothing is lost to an imperfect mapping.

### Added — date & activity filters, response states, response ages (plan phases 3–5)
- **Inbox filter bar**: activity field (14 options) × date mode (Today / Yesterday / Tomorrow / Last 24h/48h/7d/14d/30d/90d / This & Last week / This & Last month / Exact date / Custom range) with optional time-of-day bounds. Calendar-day modes resolve local wall-clock boundaries in the user's configured IANA timezone; rolling modes are exact now-minus windows — the two are labeled distinctly (`calendar` vs `rolling`) so "Today" and "Last 24 hours" can never be confused. Every filter state lives in the page URL (shareable, back-button-safe).
- **DST correctness, verified adversarially**: the date-range resolver deliberately avoids dayjs's `.startOf('day')` on timezone instances (its keepLocalTime path derives the offset from the wrong instant — wrong by the DST delta for half-hour zones; caught against Australia/Lord_Howe 2024-04-07 and fixed before release). Boundaries are computed with date-only arithmetic and converted via a direct `dayjs.tz` parse. Unit tests pin the 23-hour spring-forward day (America/New_York 2024-03-10), the 25-hour fall-back day (2024-11-03), the 24.5-hour Lord Howe day, the 5:45-offset Kathmandu day, and time-of-day bounds on both sides of a jump.
- **Deterministic response states**: one SQL CASE expression (`RESPONSE_STATE_SQL`) used by the list filter, the view engine and the detail route — a badge in the list can never disagree with the detail view. Precedence is part of the public contract (closed > snoozed > needs-first-response > customer-waiting > recently-responded/agent-waiting > unknown/never-responded). No LLM anywhere in the classification. A row-by-row equivalence test locks the SQL and JS implementations together.
- **Response ages**: time since customer reply / agent response, customer waiting duration, first-response delay, resolution duration, conversation age — exact minutes plus human form (`14m`, `3h 21m`, `1d 6h`), filterable and sortable (`waiting_longest`, `priority`, `priority_then_waiting`).

### Added — saved Inbox Views (plan phase 6)
- **Structured condition trees, never SQL**: views persist as Zod-validated JSON definitions (AND/OR groups, 21 condition kinds: status, assignee, team, mailbox, channel, tags any/all/none, custom fields, customer properties, customer text fields, date/activity, response state, response age, SLA state, priority, ticket state, known issue, AI analyzed, interaction signals, unread, snoozed, customer). The ViewEngine compiles them at evaluation time to parameterized SQL with whitelisted identifiers — user input can never become SQL (injection-shaped probes are bound as parameters and match nothing; the audit confirms the table is intact).
- **Dynamic by design**: a view saved with "today" is re-resolved every time it is opened — locked by a test that compiles the same saved definition against two different clock times.
- **Save-time compile check**: a definition that cannot be evaluated is rejected at create/update (422), never persisted for the user to discover on open.
- **Dry-run preview endpoint** (`POST /api/inbox-views/preview`) shows exactly what a definition matches before saving. SLA conditions reuse `SlaService`'s exact business-hours logic (live evaluation, no parallel implementation).
- Kept deliberately separate from the v1.5.0 Outreach Saved Segments (conversation vs contact semantics): one shared philosophy, two stores.

### Added — SupportOS priority + custom ticket states (plan phases 7–9)
- **`supportos_priority`** (None/Low/Medium/High/Urgent): a local triage field, distinct from Help Scout data. When (and only when) a Help Scout custom-field mapping is configured in settings, priority writes also flow to the mapped field via the existing fresh-read-merge path — default OFF. Every change is audited and recorded as a `priority_changed` event.
- **Configurable ticket states** with six seeded defaults (New, Investigating, Waiting on Customer, Waiting on Engineering, Ready to Verify, Resolved): full CRUD (built-ins protected from deletion and resolved-semantics changes; deleting a custom state in use resets those conversations), set/clear with reason, filterable, and usable in views.
- **Transition history + lifecycle metrics**: every transition records previous/new state, actor, reason and timestamp. Per-conversation lifecycle (time in current state, per-state entries/durations/averages) and a cross-conversation bottleneck ranking (`GET /api/ticket-states`). State-change events feed the activity timeline; the dedup key uses the transition rowid so same-millisecond changes are distinct events.

### Fixed — found by this release's own adversarial testing
- **dayjs timezone-plugin DST bug worked around** (would have shipped wrong filter boundaries for every half-hour-DST zone): `.startOf('day')` on a tz instance uses the offset of the pre-conversion instant, not the target wall time — 30 minutes wrong on Lord Howe-style transitions. The resolver now does all calendar math on neutral date-only values and converts boundaries with a direct `dayjs.tz` parse (correct in all zones, pinned by tests).
- **View schemas tightened after black-box audit findings**: `status` conditions are a closed enum (hostile strings are rejected at the boundary instead of being stored as match-nothing views), and time-of-day bounds validate ranges (`99:99` is now a 422 instead of silently dropping the time constraint — no silent degradation).
- **Same-millisecond state-change events** deduplicated to one row when they occurred within one `nowIso()` tick — the dedup key now includes the transition rowid.
- **`new_state_id` nullable**: clearing a ticket state is a real transition (previous → none) recorded in history instead of violating the FK.

### Verification
- 344/344 tests (28 new unit, 12 new integration, 16 new e2e) covering: DST boundaries across four zone shapes, response-state SQL/JS equivalence, event derivation + dedup across re-syncs and rebuilds, view compilation for every condition kind (including injection-shaped values), saved-view dynamic re-resolution, priority/state lifecycles, malformed filter params (422, never 500), and the v1.4→v1.7 in-place upgrade path with legacy rows.
- Black-box audit extended with a dedicated v1.7.0 section (335 checks total): hostile filter params, hostile view definitions, injection-shaped priority/state payloads, timeline chronology/dedup, rebuild idempotency — 0 HIGH, 0 MEDIUM findings after the fixes above.
- Human-like browser pass on the real v1.6.0 demo database upgraded in place (314 conversations → 672 derived events): filters, badges, pickers, timeline and saved views exercised as a user; all 14 pages walked with zero console errors.

## [1.6.0] — 2026-09-28

The hardening release: a **second full neutral audit** — this time three independent adversarial passes over the server core, the data/sync layer, and the React client, followed by a **human-like usage pass** (driving the app in a browser like a real operator) — found **2 HIGH, 28 MEDIUM and 30+ LOW issues**; every meaningful one is fixed here with regression coverage. No new features: v1.6.0 makes everything that already shipped behave the way it already claimed to. 288/288 tests green (+29 over v1.5.0), 320-check black-box audit clean, every previously-crashing input re-verified live.

### Fixed — HIGH
- **Outreach send-queue livelock** (found by the data-layer audit): a recipient that exhausted its 3 retryable send attempts stayed `queued` with `attempts=3` — never claimable again, yet still counted as remaining. `sendBatch` claimed 0, saw remaining > 0 and re-enqueued itself **forever**: the campaign could never complete, the jobs table churned, and `campaign-updated` SSE events spammed every ~2s. Exhausted rows are now swept to `failed` before counting, and **Retry failed resets the attempt budget** (it was a silent no-op before — re-queued rows kept attempts=3 and were swept straight back). Locked by a livelock regression test.
- **Docs embedding churn** (data-layer audit): every incremental sync re-listed every docs article and unconditionally re-chunked it — `rechunkArticle` DELETEs all chunks and re-inserts them at `not_indexed`, **destroying every stored embedding even when the text was byte-identical**. With an embedding model configured, the whole corpus re-embedded (and re-upserted to Qdrant) on every 5-minute tick, and since each embed pass handles 60 chunks, semantic docs search degraded permanently once the corpus exceeded 60 chunks. `upsertArticle` now stores a SHA-256 `content_hash` (migration 010) and re-chunks only when content actually changes — verified by a test that re-upserts an unchanged article and asserts its embeddings survive.

### Fixed — silent-dead features (client audit, verified live before/after)
- **The entire v1.4.0 webhook-push client UX never fired**: the shared EventSource subscribed to `['hello','ratings','sync','campaign','error']` — the server's `conversation` event name was never registered, so the toast ("#N updated — pushed by webhook") and the live invalidation of conversations/nav-counts/dashboard were dead code on arrival. One missing word, invisible to every test that asserted the wire event instead of the UI. Fixed and locked by a regression test that asserts the client-visible notification, not just the wire frame; re-verified live in a browser this release.
- **Bulk actions left the list stale**: bulk tag/assign/close toasted "N operations queued" but never invalidated `['conversations']`/`['nav-counts']`; combined with the dead SSE listener above, the Inbox showed pre-bulk state until manual navigation.
- **Write-behind writes never told anyone they landed** (found during the human-like pass, new this release): bulk operations are queued jobs — the client invalidates when the API *acks*, races the worker, and reads stale state; nothing re-invalidated when the write actually landed. The worker now emits `conversation-updated` after each successful bulk write, so lists and detail views converge within one worker tick (~2s). Verified live: an externally-applied tag appears in an open conversation view with zero manual refresh. Regression test drives the full path (HTTP bulk → worker → SSE frame → tag on the wire payload).
- **~20 mutations failed silently** (Settings save/test/export/import, Backups, Automation toggles, Outreach queue/pause/resume/cancel/retry/DNC, AI Center): network/server failures were no-ops with no feedback. All now surface onError toasts using the existing convention.
- **Missing error states everywhere a query could fail**: the Inbox list showed the misleading "No conversations in this view… run a sync" empty state on API failure (verified live by aborting `/api/conversations`); Search silently blanked; the Knowledge doc reader spun forever on a stale `?doc=` deep link; every Reports tab (overview, questions, definitions, releases, all Intelligence cards), AI Center jobs/evaluation, and the interaction profile had infinite-spinner or render-nothing failure modes. All render an explicit ErrorState now.
- **Settings forms could silently overwrite real config**: the LM Studio / Qdrant forms captured server data through one-shot `useState` initializers — a slow or failed fetch left hard-coded defaults in the form, and Save wrote those defaults over the real stored settings (verified live). Forms now gate on loaded data.
- **Outreach audience preview POSTed on every keystroke** (query key embedded the whole definition object): a 300ms debounce now guards both the query key and the request body — and the preview has an error state instead of silently blanking (it also counts against the 300/min mutation budget).
- **External URL scheme validation**: customer websites and engineering-ref URLs from API data rendered as raw `<a href>` — a `javascript:` value from a compromised upstream would render as a clickable script link. A shared `safeExternalHref` allowlist (http/https/mailto only) now gates both render sites.
- **Toast stack capped at 5** (a burst of events previously stacked unbounded toasts), **snooze with a cleared date input validated instead of throwing a silent RangeError**, **Inbox rows are keyboard-operable** (tabIndex + Enter/Space, matching what Search already did), **EmptyState icons fixed** (megaphone/shield/users were referenced by Outreach panels but missing from the icon map — they silently rendered as nothing).

### Fixed — server input hardening (server-core audit; every crash reproduced live before fixing)
- **Rate limiter bypass** (MEDIUM): the mutation limiter keyed on `X-Forwarded-For`, pure client input with `trustProxy` off — rotating the header bought an unlimited budget (verified: 310/310 requests passed). Now keyed on the socket address (one local user, one budget — the intended semantics), with opportunistic pruning so the key map cannot grow unbounded. Re-verified live: the same rotating-header burst now throttles.
- **Six endpoints 500'd on NaN query params**: `?page=abc` / `?pageSize=xyz` (customers, organizations — SqliteError datatype mismatch), `?days=abc` (dashboard, SLA report — RangeError via `toISOString()`), `?limit=abc` (AI jobs). All clamped with sane fallbacks; each has an e2e regression test.
- **Seven POST/PATCH routes crashed on missing bodies** (TypeError 500 or a 503 leaking "Cannot read properties of undefined"): AI rewrite/feedback/memory/narrative, issues known/refs, onboarding step, automation rules PATCH. All guarded with zod schemas now (clean 400/422).
- **Type-confused bodies 500'd**: numeric `name` on campaign/segment create (`name.trim is not a function`), numeric `text` on demo simulate-incoming (`text.slice is not a function`) — clean 422s now.
- **Automation rules PATCH accepted anything**: the POST route validated with the full zod schema but PATCH took unvalidated trigger/conditions/actions — now validated with the partial schema.
- **A multi-megabyte search query crashed FTS5** ("LIKE or GLOB pattern too complex", 500): queries are capped at 500 chars with a clean 422.
- **Queue retry/cancel lied**: they returned `ok:true` ("Job requeued.") for nonexistent or NaN ids — now 404 when nothing changed.
- **Knowledge file-import allowlist included `data/`** — the live SQLite database lives there (wider than the error message admitted): restricted to `knowledge-import/`, with the statSync ENOENT race tolerated.
- Plus: unguarded `JSON.parse` of stored settings rows wrapped with fallbacks; invalid LM Studio PATCH now returns 422 (was `ok:false` 200); `NODE_ENV` validated against its literal union; webhook payload `conversationId` numerically validated before enqueueing; search embeds the query once and reuses the vector (was embedded twice per request).

### Fixed — sync & data-layer correctness (data-layer audit)
- **Incremental sync coverage gap**: organizations, teams and both property-definition sets synced ONLY during initial sync — anything created in Help Scout afterwards never appeared locally. New organizations resolved to null (silently dropping customer→org linkage) and new property definitions never synced, so **segmentation conditions on any post-initial property could never match** (the value rows were skipped forever: `if (defId == null) continue`). All join the cheap incremental reference pass now, still ordered before customers so org FKs resolve. Locked by a test that creates post-initial entities and verifies they appear after one incremental pass.
- **Systemic date-format comparison bug** (the class of the v1.4 `jobs.run_at` bug, live in 12+ more sites): ISO-8601 remote timestamps (`2026-09-27T05:00:00.000Z`) compared against SQLite `datetime('now')` space-format strings compare LEXICOGRAPHICALLY — day-granular boundary skew up to 24h (SQL-verified: an earlier-same-day ISO timestamp compares `>=` the cutoff). Fixed at every site by normalizing to `julianday()` comparison: all segmentation date windows (createdWithinDays / modifiedWithinDays / last-contact / first-contact / history-tag windows — meaning segment membership could be wrong on boundary days), searchEngine's recency filter, the AI pipeline's recency windows, issue-trend classification (new/rising/falling), outreach reply detection (same-day-but-earlier threads counted as replies), and webhook_events retention pruning.
- **Ratings never landed on the real provider** (MEDIUM): the satisfaction.ratings webhook enqueued a job that re-synced the conversation+threads but never inserted a rating row, `listAllRatings()` returned `[]` (no endpoint), and `getRating()` was called nowhere — against real Help Scout the ratings table stayed empty forever, killing customer average_rating, CSAT reports and rating SSE events (demo mode masked it). The webhook job now reads the conversationId correctly (it read a phantom `remoteId` field) and fetches + stores the actual rating.
- **Tag id collision**: locally-created tags use `remote_id = -Date.now()`; two new tags created in the same millisecond collide on `UNIQUE(remote_id)` and the whole tag transaction fails (reproduced in-memory). Adding 2+ never-seen-before tags to one conversation reliably 500'd the outbound write flow and rolled back ALL tag changes. Local ids now come from a monotonic sequence — locked by a test that creates two brand-new tags in one call.
- **Soft-deleted customers never resurrected**: `upsertCustomer`'s ON CONFLICT clause didn't clear `deleted_at` (unlike the conversation/thread upserts) — a customer deleted then restored in Help Scout stayed invisible forever while their conversations still referenced them. Fixed (and sibling upserts audited for the same asymmetry).
- **FTS drift on thread deletion**: hard-deleting stale threads left their `fts_threads` rows behind (and a thread updated to an empty body kept its stale indexed text) — deleted/emptied messages kept surfacing in search as ghost content. FTS rows now die with their threads, unconditionally.
- **Backup cadence & retention**: maintenance ran a full `VACUUM INTO` backup every 6h regardless of the configured interval (default 24h — 4x faster than configured, each blocking the event loop for the copy duration), and nothing ever pruned old backups — the backups directory grew forever. The interval is honored via a last-backup timestamp, and a prune keeps the newest N files (encrypted `.sosync` bundles are managed separately and untouched).
- **Approval jobs were silently dropped**: `automation_action_awaiting_approval` jobs were claimed and immediately completed as no-ops — every automation write action requiring approval vanished while automation_runs said `awaiting_approval` forever. Such jobs are now PARKED (visible in the Queue panel, never claimed); approving swaps the job to an executable type. Locked by a park→approve→execute test.
- **Failed embedding chunks retried forever**: failing chunks (LM Studio configured-but-down) were re-listed and re-failed on every pass with no cap — an infinite retry loop of 60 embed calls + 60 state writes per tick, forever. Chunks now count attempts (migration 010); after 5 failures they're left alone until their content changes.
- **`is_empty` segment semantics**: "Plan is empty" matched only customers who HAVE a property row stored as NULL/'' — customers with no row at all (the common case: the property was never set) were excluded, while `not_equals` correctly included them. Absence IS emptiness now; locked by a test named exactly that.
- **`outreach` monitor recipients list** still caps at 1000 visible rows per campaign (counts and validation were fixed with aggregates in v1.5) — documented known limitation for very large single campaigns, not silently wrong.
- Plus: webhook dedup hash now includes the provider event id (two byte-identical payloads from different events were dropped as duplicates), the webhook_events table is bounded (prune keeps the newest N — the endpoint is rate-limit-exempt by design), HelpScout client's Retry-After parsing survives non-numeric headers (NaN previously meant setTimeout(0) — up to 3 immediate retries against a rate-limited API), and outbound writes for outreach sends enqueue the single-conversation sync immediately so the created conversation lands in the local mirror within seconds instead of at the next 5-minute tick.

### Changed
- Migration 010 (`audit_v16_hardening`): adds `docs_articles.content_hash` and `embedding_attempts` counters on both chunk tables. Idempotent, safe to re-run, applies on first boot of 1.6.0.
- The client's shared SSE layer now subscribes to all six server event channels (`hello`, `ratings`, `sync`, `conversation`, `campaign`, `error`) — with a comment explaining why the list must match the server emitters.
- Demo-mode honesty: the simulated Help Scout provider re-seeds its in-memory world on restart, so runtime-created demo conversations (from webhook simulations) vanish from the fake remote while the local mirror keeps them — outbound writes to them fail with the honest "no longer exists remotely" message. This is demo-mode-only behavior (the real API persists); noted here because the human-like testing pass surfaced it.

## [1.5.0] — 2026-09-27

The contact-first release: **Client Segmentation & Outreach** (the full spec — audience builder, explainable segments, individual campaign conversations with a complete audit trail), **vector search over tickets/threads**, **business-hours-aware SLA alerts on the Issue Radar**, and **optional end-to-end encrypted sync for multi-device use**. Built under a fresh independent audit: 7 real bugs found by the audit and fixed (each with regression coverage). 259/259 tests green (+35).

### Added — Client Segmentation & Outreach
- **Contact-first segment engine**: a deterministic condition-tree engine (`SegmentEngine`) evaluates audience rules against the local SQLite mirror and always resolves to UNIQUE CUSTOMERS — properties answer "which customers?", tags answer "which tickets?", the resolver answers "which customers own those tickets". AI never decides campaign membership; the engine's output is the only recipient source
- **Exact tag semantics, conversation-level before contact resolution**: Ticket has ANY / ALL / NONE of tags, with ALL meaning one single conversation carries every tag (a customer with `timezone` on one ticket and `bug` on another does NOT match "ALL of timezone,bug") — the spec's critical test cases are locked by automated tests
- **Explainable selections**: every matched customer carries a "why selected" evidence trail — property values that matched, matching conversations with their tags/status/dates — re-checked per customer at preview time; the recipient review table shows it inline and a matching-tickets drawer links straight into the inbox
- **Property targeting driven by synced definitions**: customer property definitions (text/number/date/dropdown/url) are discovered from Help Scout; the operator matrix changes per type; **customer property VALUES are now synced** (pass-through on the v3/v2 customer payloads, stored in `customer_properties`) with a raw_json backfill that heals pre-1.5 databases without a re-sync
- **Contact-field conditions**: name, email, email domain, organization, job title, location, background, has-email/phone/multiple-emails — Help Scout's background/age/gender/location fields are now mirrored on customers
- **Support-history conditions**: total/open/closed ticket counts (computed over ALL customers, so "open = 0" works), last-contact/first-contact windows, ever-had-tag (optionally time-boxed)
- **Saved segments**: reusable, versioned rules stored as structured JSON condition trees (never SQL); a saved segment is dynamic, a campaign's recipients are a STATIC snapshot taken at creation
- **Individual campaign conversations**: one Help Scout conversation per selected customer via `POST /v2/conversations` (provider gains `createConversation`, real + fake implementations) — never a shared BCC send; customer identified by id (email fallback only when unresolvable, and it is recorded in the audit trail)
- **Campaign lifecycle with full audit**: draft → queued → sending → paused/completed/cancelled; per-recipient states (selected/queued/sending/sent/failed/skipped/cancelled/unknown) with attempt log and event trail — "why did this customer receive this email?" is answerable with evidence long after the segment changed
- **Safe sending**: sends go through the SAME priority API queue and rate limiter as manual replies in small batches; validation before queueing (emails, DNC, already-sent, unresolved personalization variables); Do-Not-Contact list enforced at send time; duplicate-send protection refuses re-queueing completed campaigns; timeouts land in `unknown` and are reconciled by customer+subject+time before any retry (never blindly resent); pause/resume/cancel-remaining/retry-failed; crash recovery reclaims recipients stranded mid-batch
- **Personalization with preview**: `{{first_name}} {{last_name}} {{company}} {{organization}} {{last_ticket_number}} {{last_ticket_subject}}` render from each recipient's own snapshot (the compose step previews the exact rendered message via the same code path as the send; unknown/empty variables are flagged, never silently shipped)
- **Reply intelligence**: campaign report tracks replies from the local mirror (a customer thread after the send) with honest labeling as conversation outcomes, not email-delivery analytics
- **UI**: an Outreach page with the four-stage wizard (audience → recipient review → compose → explicit final review), campaign monitor with per-recipient states + audit events + report, saved segments manager and DNC manager; real-time progress over the existing SSE stream (`campaign-updated`)

### Added — Vector search over tickets/threads
- **Ticket chunking**: every conversation (subject + customer + tags header, then thread bodies in order) is chunked into `conversation_chunks` (migration 009) on sync; re-syncs are idempotent, content changes reset embedding state
- **Embedding pipeline**: a background `embed_conversation_chunks` job (enqueued after the conversations pass and by the v1.5 boot backfill) embeds chunks with the configured LM Studio model; vectors are ALWAYS stored locally and upserted to Qdrant when connected
- **Hybrid ticket search**: `POST /api/search` fuses FTS5 and semantic retrievers with Reciprocal Rank Fusion; Qdrant serves ANN when reachable, otherwise a local cosine scan over stored embeddings — semantic ticket search works with zero external services; every hit records why it surfaced (keyword / semantic / both) and a `mode_note` says which mode ran

### Added — Business-hours-aware SLA alerts (Issue Radar)
- `GET /api/issues/sla-alerts`: for every business-hours-configured mailbox, active/pending conversations are aged in BUSINESS minutes since their last CUSTOMER message (snoozed conversations excluded; conversations awaiting nobody never alert) against the first-response target (no reply yet) or resolution target (replied, unresolved) — states: breached, at-risk (≥80% of target), with per-mailbox rollups
- The Issue Radar renders the alert table at the top with links into the inbox; unconfigured mailboxes are listed honestly — nothing is guessed

### Added — Optional end-to-end encrypted sync (multi-device)
- **File-based `.sosync` bundles by design** — no relay server exists on purpose: SupportOS never sees your data in transit; move the bundle yourself (cloud drive, USB, company share) and only the passphrase holder can decrypt it
- **Crypto**: AES-256-GCM with a scrypt-derived key (N=2^15, per-export salt + IV, params in an unencrypted JSON header after a `SOSYNC` magic); authentication failure = wrong passphrase or tampering, nothing changes; all primitives from Node's built-in crypto
- **Content**: the complete SQLite mirror (customers, conversations, AI analysis, segments, campaigns) via `VACUUM INTO` consistent snapshots; attachments are deliberately NOT bundled — they re-download from Help Scout automatically on the other device
- **Import is safe-by-default**: decrypt to a temp file → PRAGMA integrity_check → schema-version guard (never import newer schemas into older apps) → automatic safety backup of the current data → atomic swap → restart prompt; verify-first dry run available; a sync ledger records every export/import
- **Settings → Encrypted sync**: export (passphrase + confirmation + strength hint), upload or path-based import, two-step verify-then-import so the passphrase never rides a URL

### Fixed — found by the fresh independent audit (not by the existing test suite)
- **Deeply nested condition trees crashed the whole server**: a hostile segment tree recursed without bound in the engine (stack overflow → process death → DoS). Trees are now depth- (10) and node-count-capped at the route boundary with a clean 422, plus a defensive depth guard inside the engine; locked by an audit-phase regression test
- **Malformed JSON bodies returned 500** (and logged as server errors): the custom raw-body JSON parser forwarded raw SyntaxErrors without a status code; malformed bodies are now a clean 400 client error
- **`POST /api/outreach/dnc` with a negative id returned 500**: the FK violation surfaced as a server error; ids are validated as positive integers first
- **A crash mid-batch stranded recipients in `sending` forever**: countRemaining() counted them but claimPendingRecipients() never picked them — an infinite re-enqueue loop. sendBatch now reclaims stale `sending` rows at start (the worker is strictly sequential, so this can never race a live batch); proven by a crash-recovery test that also asserts no double-sends
- **Campaign validation and reports truncated at 1000 recipients**: counts were computed over the capped recipients list — a >1000-recipient campaign was under-validated (and could be refused despite being fully sendable); counts now come from SQL aggregates over ALL recipients
- **The property backfill could never heal the common case**: it expected the wire shape (`{id,key,value}`) while raw_json stores the normalized shape (`{definitionRemoteId,...}`); both shapes are now accepted
- **Campaign monitor inbox links used the conversation NUMBER where the route expects the local id**: recipient rows now carry the resolved local conversation id

### Changed
- `HsCustomer` (provider DTO) gains `background/age/gender/location` and normalized `properties`; the v3/v2 mappers pass them through defensively (unknown property shapes are skipped honestly, not guessed)
- `searchEngine` responses carry a `mode_note` explaining the retrieval mode that actually ran
- Help Scout customer-property VALUES: synced when the API returns them (shape varies by endpoint vintage — normalized defensively); the capability matrix documents the honest limitation

## [1.4.0] — 2026-09-27

The real-time release: **incoming webhook push for conversations, semantic docs search via local Qdrant (with a no-Qdrant fallback), and per-mailbox SLA/business-hours reporting** — plus two serious latent bugs found and fixed in the job pipeline underneath the webhook path. 224/224 tests green (+52).

### Added — Incoming webhook push for conversations
- **Webhook registration from the app**: `POST /api/webhooks/register` creates the webhook in Help Scout with the locally configured secret (provider interface grows `createWebhook` / `deleteWebhook`, implemented by real + fake providers); `DELETE /api/webhooks/:remoteId` removes it; Sync Health gains a registration card with the default event set (convo.created/updated/assigned/status/customer+agent reply/note + satisfaction.ratings)
- **Real-time conversation updates over SSE**: webhook-source sync jobs now emit `conversation-updated` events (conversation id/number/mailbox/subject + honest `reason: webhook|sync|manual`) on the existing `/api/events` stream; the client bridge invalidates the open conversation, lists, nav counts and dashboard, and raises a toast for webhook pushes
- **Demo simulation through the REAL pipeline**: `POST /api/demo/simulate-webhook` mutates the simulated remote, then HMAC-signs and self-POSTs to the production `/api/webhooks/helpscout` endpoint — persist → dedup → job → worker tick → mirror update → SSE, exactly the path production events travel (a per-push nonce mirrors Help Scout's unique payloads so repeated demos are not deduplicated)
- **Restart safety**: `WorkerManager.start()` now drains persisted-but-unprocessed webhook events on boot (the endpoint persists first and acknowledges, so a crash in between previously left events pending forever)

### Added — Semantic docs search (Qdrant + local fallback)
- **Docs chunking**: mirror articles are chunked (`docs_chunks`, migration 008) on every sync; a background `embed_docs_chunks` job (enqueued by the coordinator after the docs pass) embeds chunks with the configured LM Studio embedding model
- **Vectors are always stored locally** (mirroring knowledge_chunks): semantic search works with OR without Qdrant — Qdrant serves ANN retrieval when connected; otherwise a local cosine scan over the stored embeddings answers the same queries
- **Hybrid retrieval**: `GET /api/docs/search?q=&semantic=` fuses FTS5 and semantic result lists with Reciprocal Rank Fusion (rank-based, scale-free); every hit carries `why: [fts, semantic]` provenance and a human-readable `mode_note` explains exactly which retrievers ran
- **Honest degradation**: no embedding model → FTS only with setup instructions; model configured but nothing embedded yet → FTS only with an explicit note; provider unreachable on a query → FTS only, retried next search
- **Docs page UI**: Semantic toggle (URL-state), per-hit keyword/semantic badges, fused score, embedding readiness counters in stats

### Added — SLA / business-hours reporting per mailbox
- **Business-hours engine** (pure, unit-tested): `businessMinutesBetween` counts only minutes inside a per-mailbox schedule (IANA timezone, active weekdays, start/end minute-of-day) — DST transitions handled via the platform tz database (guess-and-correct wall→instant), half-hour zones supported, nights/weekends contribute zero, invalid input returns null (never a fabricated number)
- **Per-mailbox schedules + SLA targets**: `mailbox_business_hours` storage (migration 008) with zod-validated `GET/PUT/DELETE /api/settings/business-hours(/:mailboxId)`; a Settings → Business hours editor (timezone with suggestions, weekday chips, time inputs, first-response and resolution targets in business minutes)
- **SLA report**: `GET /api/reports/sla?days=&mailboxIds=` — per mailbox: first-response and resolution measured in BOTH wall and business minutes (median included), met/missed against configured targets, and live "currently waiting" aging (avg/oldest business minutes, at-risk past target); unconfigured mailboxes are labeled wall-clock honestly. Reports gains an SLA & business hours tab

### Fixed — latent job-pipeline bugs (found while wiring the webhook e2e)
- **Queued jobs were never claimable**: `jobs.run_at` was stored in ISO-8601 (`2026-09-27T07:35:43.424Z`) while `claimNext` compares against SQLite `datetime('now')` (`2026-09-27 07:35:43`); `'T' > ' '` lexicographically, so every job stayed invisible forever — silently disabling webhook-triggered syncs, attachment downloads, AI jobs and embedding passes at runtime (tests passed because they called the components directly). `run_at` is now written in SQLite's own format; regression test included
- **Job payloads reached the worker as JSON strings**: `claimNext` cast the raw row to `QueueJob` without parsing the `payload` TEXT column, so `payload.remoteId` read as `undefined` → `syncSingleConversation(NaN)` "completed" without syncing anything. Payload is now parsed like every other getter; regression tests assert the parsed payload AND that a webhook-source job lands the thread through the real claim→execute path

### Changed
- Migration 008 `semantic_docs_sla`: `docs_chunks` (+ article/state indexes) and `mailbox_business_hours`; migrations unit test updated
- `GET /api/docs/stats` reports embedding readiness (`docs_chunks`, `docs_chunks_indexed/pending/failed`); `api` client helper gains `put`
- Webhook event routing tags sync jobs with `source: 'webhook'` (drives the honest SSE reason)
- Capability matrix: webhooks row documents in-app registration, push semantics and restart drain

### Tests (172 → 224)
- Unit: business-hours engine (window edges, weekend exclusion, DST spring-forward in America/New_York, Asia/Kolkata half-hour zone, invalid-input nulls, span cap, slaStatus) and docs semantic helpers (RRF fusion ordering + provenance, cosine including Float32 buffer views)
- Integration `tests/integration/v14_features.test.ts`: docs chunking + idempotency + embedding round-trip + job wiring, business-hours storage, SLA report before/after configuration (24/7 schedule ⇒ business == wall) + scope filter, webhook drainPending, source-tagged jobs, job-claim REGRESSION tests
- E2E `tests/e2e/v14_features.e2e.test.ts`: full webhook push over the wire (SSE conversation event with reason webhook + thread landing), created-conversation webhook appearance, validation paths, hybrid docs search flags + mode notes, SLA report before/after business-hours configuration, CRUD validation

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

