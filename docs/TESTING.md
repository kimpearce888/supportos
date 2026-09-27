# Testing

## Philosophy

- **No test can ever send a production message.** Every integration/E2E test runs against `FakeHelpScoutProvider` — an in-memory, mutable Help Scout simulator (pagination, cursor behavior, 301 merges, remote mutations, rate-limit failure injection).
- The **real sync engine** is exercised end-to-end in tests: the same coordinator code that syncs your live account populates the test database from the fake provider.
- SQLite tests use isolated in-memory databases; E2E boots the real Fastify app on a temp database and port.

## Suites

| Command | What it covers |
|---|---|
| `npm run test` (unit) | redaction patterns, HTML sanitization/XSS, friendly error mapping, rate limiter + priority queue ordering, migrations (schema completeness, idempotency, WAL/FK, safe defaults), prompt structure |
| `npm run test:integration` | initial sync (all resources, idempotency, checkpoints), incremental sync (new/changed conversations), merged conversations (301 handling), reconciliation (remote deletions, missing local records, FTS rebuild), **tag replacement safety (the spec's A,B + add C ⇒ A,B,C test)**, custom-field system-field preservation, reply/draft/note/status/assign/snooze/schedule flows, duplicate-send protection, AI-evaluation-mode guard, webhook signature + dedup + routing, search (keyword, filters, number, scopes), knowledge ingestion + visibility separation, evidence builder (bounded context, hybrid similar, provenance labels), analytics (deterministic counts, metric definitions, radar links), automation (safety tiers, approval requirements, condition matching), AI caching/change detection, backups (verified snapshot, CSV export), settings safety (reply sending can never be enabled) |
| `npm run test:e2e` | full app boot: health + degradation semantics, SPA + API 404s, conversation list/detail (sanitized threads), reply/draft/note flows over HTTP, duplicate protection, tag merge, custom fields, status/assignment/snooze, global search, customer/organization drill-downs, audit trail, capability matrix honesty, graceful AI-unavailable behavior, settings round-trip, queue panel, sync status, webhook endpoint, backup/export |
| `npm run lint` / `npm run typecheck` | strict TypeScript + ESLint, zero errors/warnings |

## Golden AI evaluation set

The deterministic parts of the AI pipeline (retrieval, evidence assembly, verification wiring, caching) are covered by automated tests. Full model-dependent evaluation uses the golden scenarios in AI Center → Evaluation with **AI evaluation mode** enabled (all Help Scout writes disabled) so you can compare outputs against your own local model without risk.

## Real-world verification steps (require your credentials)

Documented honestly rather than claimed: connecting a real Help Scout account, running a live initial sync, and exercising write operations against your real mailbox are one-time manual verifications — the same code paths are covered by the fake-provider tests above.

## Client Interaction Intelligence (v1.1.0)

- `tests/unit/interaction.test.ts` — heuristic vocabulary, word-boundary marker matching (e.g. "against" must not match "again"), evidence requirements, forbidden-claim sanitizer (personality labels impossible)
- `tests/integration/interaction.test.ts` — full engine over the real sync engine: returning vs first-time clients, change directions vs baseline, preference overfit guard (3+ observations), human override precedence + revert, outcome metrics, repeat-issue detection, profile/playbook assembly
- e2e — all six `/api/interaction/*` endpoints over the real Fastify app, including the 422 validation path, safety labeling and 404s

Total: 288 tests (`npm run test:all`).

## v1.2.0 audit regression tests

`tests/integration/audit-fixes.test.ts` and `tests/e2e/audit-fixes.e2e.test.ts` lock down every confirmed finding from the independent audit — observation idempotency, closed-only resolution, nominal-dimension change semantics, the CSS scrubber, NaN-param clamping, 422 validation semantics, settings whitelist, demo-mode import containment, evaluation-mode write blocking, draft-then-send idempotency, mutation-only rate limiting and the CORS port allowlist. Each test names the finding it protects, so a regression fails with an explanation.

## v1.3.0 — channels, docs mirror, real-time, multi-mailbox

- `tests/integration/channels_docs.test.ts` — Beacon chat sync with source attribution (`type=chat`, `via=beacon`), the inbox channel filter, the docs mirror (collections/categories/articles, offline FTS search, stats, idempotent re-sync), multi-mailbox + channel dashboard scoping (comparison rows, chat speed in minutes), `upsertRating` new-insert semantics, and event-bus delivery including failing-subscriber isolation
- `tests/e2e/realtime_docs.e2e.test.ts` — channel filter happy + 422 paths, docs endpoints incl. 404 and status filters, `mailboxIds`/`channel` dashboard scoping + validation, and a **real SSE stream test**: opens `GET /api/events`, triggers `POST /api/demo/simulate-rating`, and asserts the rating event arrives on the same open stream — the real-time path is verified over the wire, not inferred
- The packaged desktop bundle is verified by booting the exact artifacts CI ships (bundled Node runtime + esbuild server bundle) and probing `/health`, the SPA, the docs API and the SSE endpoint — see [docs/DESKTOP.md](DESKTOP.md)

## v1.4.0 — webhook push, semantic docs search, SLA

- `tests/unit/businessHours.test.ts` — the pure SLA engine: window edges (before open / after close), weekend exclusion (Friday 17:05 → Monday 09:05 = 5 minutes), multi-day sums, a DST spring-forward case in America/New_York, the Asia/Kolkata half-hour zone, honest nulls (invalid timezone, empty days, reversed window, unparseable dates, >400-day spans) and slaStatus classification
- `tests/unit/docsSemantic.test.ts` — RRF fusion (both-retriever articles outrank single-retriever hits, provenance labels, limits, determinism) and cosine similarity (identical/orthogonal/opposite, Float32 buffer views of stored embeddings)
- `tests/integration/v14_features.test.ts` — docs chunking + idempotent re-sync + embedding round-trip + job wiring; business-hours storage round-trip; SLA report before/after configuration (24/7 schedule ⇒ business minutes equal wall minutes) + scope filter; webhook drainPending; and **REGRESSION tests for the two latent job-queue bugs** (run_at ISO-vs-SQLite format, claimNext returning unparsed JSON payloads) that had silently disabled the whole job pipeline at runtime since v1.0.0
- `tests/e2e/v14_features.e2e.test.ts` — the full webhook push over the wire: `simulate-webhook` HMAC-self-POSTs to the production endpoint, the worker claims the job within one 2s tick, the mirror gains the thread, and the open SSE stream delivers a `conversation` event with `reason: "webhook"`; plus created-conversation appearance, 422 paths, hybrid docs-search flags and mode notes, and the SLA report before/after business-hours configuration

## v1.5.0 — segmentation, outreach, ticket vectors, SLA alerts, encrypted sync

- `tests/integration/v15_features.test.ts` — segment-engine critical semantics (the spec's #60-#62 test cases: conversation-level ALL/ANY/NONE before contact resolution, "open = 0" over all customers, absence-as-emptiness semantics for properties), campaign lifecycle / duplicate-send refusal / DNC enforcement / personalization mirror, the ticket-chunk state machine, SLA-alert computation before/after business-hours configuration, and the encrypted-sync round trip (export → verify → import, wrong-passphrase refusal, tamper detection)
- `tests/e2e/v15_features.e2e.test.ts` — the full campaign flow over HTTP with SSE progress events, segment CRUD, DNC add/remove, SLA alerts before/after config, hybrid ticket search with honest mode notes, and encrypted-bundle upload rejection paths
- `tests/integration/audit-v15.test.ts` — regression locks for the 7 findings of the first v1.5 neutral audit (recursion-depth caps, mid-batch crash recovery, aggregate counts, property-backfill shape acceptance, conversation-id link resolution)

## v1.6.0 — the second neutral audit (three adversarial passes + human-like testing)

- `tests/integration/audit-v16.test.ts` — locks the audit's data-layer findings: the outreach send-queue **livelock** (attempts-capped rows swept to failed, not re-enqueued forever), **Retry failed resets the attempt budget**, **re-upserting an unchanged article preserves its chunk embeddings** (content-hash gating), approval jobs **parked then approved then executed** (never silently dropped), **absence IS emptiness** for `is_empty` segment conditions, **two brand-new tags in one update both persist** (monotonic local ids), **backup pruning** keeps only the newest N, the ratings worker **fetches and stores the real rating** (reads conversationId, not the phantom remoteId), and **incremental sync refreshes organizations + property definitions**
- `tests/e2e/audit-v16.e2e.test.ts` — clean-response probes for every crash input the server-core audit found (`?page=abc`, `?pageSize=xyz`, `?days=abc`, `?limit=abc` all 200 with fallbacks; missing/mistyped bodies all 400/422; the 2MB FTS killer now 422; queue retry/cancel 404 on nonsense ids; knowledge import confined to `knowledge-import/`), outreach sends enqueue the single-conversation mirror sync immediately, the **rate limiter keys on the socket address** (310 rotating-X-Forwarded-For requests share ONE budget and throttle), and — the finding of the human-like pass — **write-behind bulk writes notify clients**: bulk tag over HTTP → worker tick → `conversation` SSE frame on the open stream → tag visible in the conversation payload
- `scripts/audit-phase1.mjs` — the 320-check black-box audit script (malformed bodies, injection-shaped trees, depth attacks, hostile campaign creation, path traversal, wrong-passphrase/tampered bundles, rate limiting, log hygiene) is committed so anyone can re-run the whole audit against their own instance: `node scripts/audit-phase1.mjs`

## v1.7.0 — the conversation activity engine

**28 unit + 12 integration + 16 e2e tests (344 total)** covering the activity engine, the date-range resolver, response states, saved views, priority and custom ticket states:

- **DST correctness as a first-class suite** (`tests/unit/activity.test.ts`): the 23-hour spring-forward day (America/New_York 2024-03-10), the 25-hour fall-back day (2024-11-03), the 24.5-hour Lord Howe day (half-hour DST), the 5:45-offset Kathmandu day, time-of-day bounds on both sides of a jump, invalid dates (Feb 30, month 13), order-safe custom ranges, and invalid-timezone fallback. This suite caught a real dayjs timezone-plugin bug (`.startOf('day')` deriving the offset from the wrong instant) before release — the lesson is codified: **test the weird timezone, not just yours**.
- **Response-state determinism**: every precedence branch unit-tested, plus an integration test that runs `RESPONSE_STATE_SQL` and the JS `responseStateOf` over every row in the database and asserts row-by-row equivalence — the list badge can never disagree with the detail view.
- **Event derivation & dedup** (`tests/integration/activity.test.ts`): the v1.4→v1.7 in-place upgrade path (legacy rows derive honest values; no-threads conversations flag incomplete history), sync-diff events fire only on real changes (re-syncs emit nothing new), thread events classify by type/from_type, drafts are not events, and `rebuildAll()` is idempotent (rebuild-twice assertions).
- **View engine**: every condition kind compiles and matches the expected rows (including tags any/all/none case-insensitivity, nested AND/OR groups, injection-shaped values as bound parameters — the conversations table is asserted intact afterward), depth caps throw `ViewCompileError`, and date conditions are **dynamic** (the same saved definition resolves to different windows at two clock times).
- **E2E over real HTTP** (`tests/e2e/v17_features.e2e.test.ts`): filters with adversarial params (nine malformed shapes, all 422), the full saved-view lifecycle (create → run → preview → rename (no version bump) → redefine (bump) → delete → 404), priority + state write paths with transition history and lifecycle metrics, the chronological timeline with honest sources, rebuild idempotency over HTTP, and hostile view definitions rejected at save time.
- **Black-box audit extended** (`scripts/audit-phase1.mjs`, section H — 335 checks total): hostile filter params never 500, hostile view definitions never persist, injection-shaped priority/state payloads are clean 422s, the timeline is chronological and deduplicated, and the activity rebuild is idempotent. The two MEDIUM findings it produced (hostile status strings accepted as match-nothing views; `99:99` silently dropping time bounds) were fixed with closed enums and strict HH:mm validation before release.
