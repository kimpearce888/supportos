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
