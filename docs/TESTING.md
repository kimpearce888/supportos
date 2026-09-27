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

Total: 172 tests (`npm run test:all`).

## v1.2.0 audit regression tests

`tests/integration/audit-fixes.test.ts` and `tests/e2e/audit-fixes.e2e.test.ts` lock down every confirmed finding from the independent audit — observation idempotency, closed-only resolution, nominal-dimension change semantics, the CSS scrubber, NaN-param clamping, 422 validation semantics, settings whitelist, demo-mode import containment, evaluation-mode write blocking, draft-then-send idempotency, mutation-only rate limiting and the CORS port allowlist. Each test names the finding it protects, so a regression fails with an explanation.

## v1.3.0 — channels, docs mirror, real-time, multi-mailbox

- `tests/integration/channels_docs.test.ts` — Beacon chat sync with source attribution (`type=chat`, `via=beacon`), the inbox channel filter, the docs mirror (collections/categories/articles, offline FTS search, stats, idempotent re-sync), multi-mailbox + channel dashboard scoping (comparison rows, chat speed in minutes), `upsertRating` new-insert semantics, and event-bus delivery including failing-subscriber isolation
- `tests/e2e/realtime_docs.e2e.test.ts` — channel filter happy + 422 paths, docs endpoints incl. 404 and status filters, `mailboxIds`/`channel` dashboard scoping + validation, and a **real SSE stream test**: opens `GET /api/events`, triggers `POST /api/demo/simulate-rating`, and asserts the rating event arrives on the same open stream — the real-time path is verified over the wire, not inferred
- The packaged desktop bundle is verified by booting the exact artifacts CI ships (bundled Node runtime + esbuild server bundle) and probing `/health`, the SPA, the docs API and the SSE endpoint — see [docs/DESKTOP.md](DESKTOP.md)
