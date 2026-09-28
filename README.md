<div align="center">

# 🎧 SupportOS

### The local-first, AI-powered support operating system for your Help Scout mailbox

**Fast support tooling with a privacy guarantee: your customer data never leaves your machine.**

[![CI](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-672%2F672-brightgreen)](docs/TESTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.base.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](docs/LOCAL-RUN.md)
[![Releases](https://img.shields.io/badge/installers-MSI%20%7C%20DMG%20%7C%20AppImage-blue)](https://github.com/kimpearce888/supportos/releases/latest)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4)](CONTRIBUTING.md)

[What is SupportOS?](#-what-is-supportos) · [The Story](#-the-story-why-it-exists-and-why-its-built-this-way) · [Screenshots](#-see-it-in-action) · [2-Minute Demo](#-try-it-in-2-minutes-no-credentials-needed) · [Features](#-features) · [Safety Model](#-safety--trust-by-design) · [Docs](#-documentation)

</div>

---

## 🧭 What is SupportOS?

SupportOS is a **self-hosted help desk companion and support intelligence platform**. It mirrors your Help Scout inbox into a local SQLite database on your own machine and layers a professional support workspace on top:

- **⚡ Instant everything** — search your entire local archive in milliseconds with local full-text search; no API round-trips, no rate limits, no spinners
- **🕰️ Conversations as event histories (v1.7.0)** — every message, note, status/tag/assignment change and snooze lands in a local activity log with honest sourcing; 14 derived activity timestamps (first response, waiting-since, last tag change…) power date filters, response states and saved views
- **📡 Real-time by default** — new CSAT ratings, webhook-pushed conversation changes *and* notification-center updates arrive over Server-Sent Events the moment they land; dashboards, the inbox, the unread badge and the Operations Center update without polling or refresh
- **🖥️ Operations Center & team workload (v1.8.0)** — the whole support operation on one screen: 16 live tiles (unassigned, needs first response, waiting, SLA, urgent, AI escalations, approvals, failures…), every tile drilling into the exact same filtered list that produced its count; per-agent and per-team workload with an explicit capacity model and read-only suggested assignees
- **🔔 Notification Center & mentions (v1.8.0)** — a persistent local inbox of what changed (customer replies, assignments, @mentions, SLA states, approvals, job/sync failures) with per-type preferences and a live unread badge; **@agent / @team mentions** work in internal notes and side threads; **side collaboration threads** give any conversation internal-only team discussions that never touch the customer-visible thread
- **🎧 Every channel, one inbox** — email and Beacon chat sessions live side by side, filterable by channel, with honest chat-vs-email speed analytics
- **📚 Your Docs, mirrored — and semantically searchable** — Help Scout Docs synced locally, searched with hybrid keyword + vector retrieval (local embeddings, optional Qdrant)
- **⏱️ SLA reporting in business minutes** — per-mailbox schedules (timezones, weekdays, targets) make first-response and resolution times mean what customers actually experience
- **🤖 Local AI assistance** — ticket analysis, evidence-backed reply drafts, issue clustering and report narratives via [LM Studio](https://lmstudio.ai) on your own hardware. **No OpenAI. No cloud. No data leakage.**
- **🧠 Client Interaction Intelligence** — knows how each client *normally* communicates and flags when today's ticket is different (urgency ↑, detail ↓), with an evidence-backed support approach and per-client playbook. Behavior, never psychology.
- **📦 Desktop installers** — MSI, DMG and AppImage with the Node runtime and SQLite bundled in: install and run, no prerequisites
- **🛡️ Privacy by architecture** — support tickets contain payment details, personal data and secrets. SupportOS keeps them local-first, GDPR-friendly and audit-logged
- **🔬 Support intelligence** — Issue Radar surfaces emerging problems before they become incidents; answer-reuse shows which tickets could have been deflected by docs
- **✍️ Human in command** — AI never sends a customer reply. Every remote write is validated, merged, confirmed and audited
- **🔬 Audited, not assumed** — v1.2.0 and v1.5.0 shipped after full independent audits; **v1.6.0 is the audit release**: three adversarial passes (server core, data/sync layer, client) plus a human-like usage pass found 2 HIGH + 28 MEDIUM issues — all fixed, each locked by a named regression test; v1.8.0 extended the black-box suite with collaboration-layer probes (361 checks, 0 HIGH / 0 MEDIUM after fixes); v2.1.0 grew it to 425 checks across every layer including the quality features (0 HIGH / 0 MEDIUM after fixes); v2.2.0 grew it to 446 checks including the graph/coaching/memory hostile matrices (0 HIGH / 0 MEDIUM); **v2.2.1 ran a fresh full-project audit from scratch and fixed 45 confirmed defects in existing functionality** (452 checks, 0 HIGH / 0 MEDIUM, no new features)

> **Help Scout stays the source of truth.** SupportOS is a local mirror + intelligence layer — it reads your mailbox and writes back through Help Scout's official API with full write protection. Your team can keep using Help Scout (and its mobile app) exactly as before.

---

## 📖 The Story — why it exists, and why it's built this way

### The problem

Every support team eventually hits the same wall. Your ticket archive — years of customer conversations, the issues they hit, the words they used, the fixes that worked — lives inside a SaaS tool you rent. Search is slow because every query round-trips to someone else's data center. Analytics are limited to whatever the vendor exposes. And the moment you want AI assistance, the obvious path means shipping your customers' emails, payment references and secrets to a third-party model API.

That's the trade nobody should have to make: **intelligence in exchange for privacy**. SupportOS exists because a support workspace can be fast, smart and *yours* — all three at once, on hardware you already own.

### How it got built

The first version was a single question: *what if the whole mailbox lived in one local SQLite file?* That decision — a mirror, not a replacement — shaped everything after it. Help Scout stays the source of truth; SupportOS syncs it through the official API, adds a fast workspace on top, and writes back through the same protected path. Your team keeps the Help Scout mobile app; the support lead gets millisecond search, an issue radar and local AI that no one else can read.

Client Interaction Intelligence (v1.1.0) came from a second observation: experienced reps *know* their regulars — who wants bullet points, who is detail-hungry, whose tone today is off. That knowledge usually lives in one person's head and leaves when they do. SupportOS turns it into observable, evidence-backed signals a team can share — with hard guardrails, because describing *behavior* is useful and labeling *people* is not.

v1.2.0 is the unglamorous, essential chapter: an independent audit of every write path, every route, every signal. Not the project's own test suite — a from-scratch review with black-box testing against a fresh database. It found real bugs (an evaluation-mode bypass, a broken attachment endpoint, duplicated behavioral data inflating baselines). Every one is fixed, and every fix ships with a regression test that names its finding, so the audit can never silently rot.

v1.3.0 closes the original public roadmap — and each item earned its place the same way. **Chat/Docs/Beacon coverage** started with an honest question: what does a *mirror* actually need from those APIs? Beacon chats already arrive as conversations (type=`chat`, source via=`beacon`) — so instead of bolting on a second sync system, SupportOS unified them into the existing mirror and built the channel filter and chat-speed analytics on top. Docs *did* need a real second surface (a separate API key on a separate host), so it got one: a read-only mirror with offline FTS search. **Real-time ratings** chose Server-Sent Events over WebSockets because server→client notifications don't need bidirectional complexity — and the new event bus deliberately pushes *facts* (a rating landed), leaving every computation local. **Multi-mailbox dashboards** reuse the same deterministic SQL with a scope parameter rather than a parallel "multi-mailbox mode", so metric definitions can never drift between single- and multi-mailbox views. And **packaged installers** came from a simple constraint: the app is a Node process, so the package must ship a Node runtime — an esbuild bundle, one native module, and a stock official Node binary, assembled per-platform in CI.

v1.4.0 is the real-time release, and its most important fix is one nobody planned. Wiring the webhook-push e2e test exposed that the background job queue had been **silently dead at runtime since v1.0.0** — two bugs (an ISO-vs-SQLite timestamp format mismatch that made every job permanently unclaimable, and job payloads reaching the worker as unparsed JSON strings) meant webhook-triggered syncs, attachment downloads and embedding passes all "completed" without doing anything. The green test suite never caught it because tests called the components directly instead of through the claim loop; the new regression tests now do exactly that. On top of that honest foundation: conversation webhooks push through the real HMAC pipeline and land as SSE events within seconds; Docs search became hybrid (FTS + semantic vectors fused with Reciprocal Rank Fusion — vectors stored locally so Qdrant is an accelerator, not a dependency); and SLA reporting grew business-hours math built on the platform's timezone database, because "responded in 3 hours" means something different on a Friday night.

v1.5.0 is the contact-first release. The segmentation spec's sharpest insight became the architecture: **properties answer "which customers?", tags answer "which tickets?", and a resolver answers "which customers own those tickets?"** — so the segment engine is deterministic SQL over the local mirror (an AI may *suggest* a segment, but it can never decide who gets emailed), every result row is a unique contact with a "why selected" evidence trail, and tag ALL/ANY/NONE semantics happen at the conversation level *before* resolving to people. Campaigns send one individual Help Scout conversation per customer — never a BCC blast — through the same rate-limited queue as manual replies, with per-recipient states, duplicate-send protection, timeout reconciliation (a send that *might* have landed is investigated, never blindly resent) and an audit trail that answers "why did this customer get this?" with ticket-level evidence years later. On top of that: ticket/thread vector search (same local-vectors-first design as docs search), business-hours-aware SLA alerts on the Issue Radar, and encrypted multi-device sync as a **file you carry yourself** — because a privacy-first product with no relay server is end-to-end encrypted by construction: there is no third party to trust. The release was built under a fresh independent audit that didn't touch the project's own test suite: 320 black-box probes plus a white-box review found **7 real bugs** (a recursion DoS that could crash the whole server with one hostile request, a mid-batch crash that stranded recipients forever, a truncation bug that mis-validated >1000-recipient campaigns, and four more) — all fixed with regression tests before shipping.

v1.6.0 is the release where the audit itself became the product. Three independent adversarial passes — server core, data/sync layer, React client — deliberately did NOT reuse the project's own test suite, reproduced every crash live against a running instance before reporting it, and found what 288 green tests couldn't: **the entire v1.4.0 webhook-push client UX had never fired** (the browser subscribed to five SSE channels and the server emitted a sixth — one missing word in a listener list, invisible to tests that asserted the wire event instead of the toast); an **outreach livelock** where three retryable failures left a recipient permanently unclaimable yet permanently counted, so the campaign could never complete and the send job re-enqueued itself every two seconds forever; and **docs embeddings that suicided every five minutes** — each incremental sync re-chunked every article, deleting every stored vector even when the text hadn't changed by a byte. Then came the step no audit had tried before: using the app like a human, in a browser, clicking the actual buttons — which surfaced the failure mode automation can't feel: bulk operations ack "queued", the client refreshes immediately, races the background job, and reads stale state; nothing told anyone when the write actually *landed*. That gap is now closed at the source (the worker announces every completed write), and the regression test that locks it drives the full path — HTTP bulk → worker tick → SSE frame → tag visible on the wire — because a test that asserts only the wire event is exactly how the dead webhook UX survived four releases. The date-format comparison bug that killed the job queue in v1.4 turned out to be a *species*, not a specimen: twelve more sites compared ISO-8601 timestamps against SQLite's space-format `datetime('now')` — segmentation windows that could be wrong on boundary days, reply detection that counted same-day-but-earlier threads as responses — all normalized to one comparison basis now. And every crash input from the audit (?page=abc, missing bodies, numeric names, 2MB queries, spoofed X-Forwarded-For) has an e2e test asserting the *clean* response it gets today.

v1.7.0 asks a question the mirror had never answered: *what actually happened on this ticket?* A conversation row with `created_at` and `updatedAt` can't tell you who's waiting, for how long, or what changed — so this release derives a **real event history** from what the mirror can prove. Message events carry exact thread timestamps; changes observed during sync are recorded at observation time and *labeled* as observations (Help Scout exposes no change log — pretending otherwise would be fabrication); local writes record their own exact moments; conversations whose thread history never fully synced classify as `unknown` instead of "never responded". On top of that honest foundation: **14 derived activity timestamps** per conversation, a **deterministic response-state machine** (one SQL CASE shared by the list, the views and the detail — a badge can never disagree with itself), **date & activity filters** that treat "today" and "last 24 hours" as the different questions they are, **saved Inbox Views** as structured condition trees compiled to parameterized SQL at open time ("today" means the day you open it — the tree is stored, never the SQL), a local **priority**, and **custom ticket states** with full transition history. The release's own testing earned its keep twice: the DST test suite caught **dayjs's timezone plugin computing midnight with the wrong offset** for half-hour-DST zones (correct for New York by coincidence, 30 minutes wrong on Lord Howe Island — fixed before any user could hit it), and the extended black-box audit caught hostile view definitions that were schema-valid but semantically garbage (closed status enums and strict HH:mm validation close both holes).

v1.8.0 turns the mirror into a **team operating system**. The Operations Center answers the question every support lead actually asks at 9am — *what's on fire?* — with 16 live tiles computed from the same fragments that power their drill-down lists, so a number and the list behind it can never disagree. The workload engine refuses the industry's favorite trick: it does not infer capacity from anything about a person — capacity is explicit configuration, availability is the status Help Scout already syncs, and the suggested assignee is a recommendation with its reasoning printed next to it, because a system that quietly reassigns tickets is a system nobody trusts. The Notification Center is built on one discipline — **one producer, one funnel**: a single idempotent sweep derives every notification from an observable local fact, with dedup keys that make re-syncs, re-sweeps and crashes structurally incapable of duplicating. Mentions took the opposite trade from autocomplete-everywhere culture: **exact identity matching only** — `@al` never notifies Alex, unknown tokens stay plain text — because a mention system that guesses identities manufactures notification spam and, worse, silent misdirection. And side threads finally give support its actual working pattern — a customer conversation with Engineering, Billing and Management discussions hanging off it — without pretending Help Scout's customer-visible thread model is the place for that. The release's own verification found and fixed eight real bugs before any user could: a fresh-install notification flood (the sweep's cursor initialized before the first sync finished — history arrived looking like news), assignment notifications silently dropped (a SELECT that forgot its own metadata column), a workload crash on a misnamed column, and five more hardening gaps, each locked with a regression test.

v1.9.0 is the intelligence release, and its two headline features share one discipline: **the AI is never allowed to be the authority**. The Local Copilot is an interactive assistant inside every conversation, but it runs on an allowlisted read-only tool registry — the model never sees SQL, every result is bounded and redacted before it reaches the prompt, the tool loop is hard-capped, and the citation list is **generated by the server from the tools it actually executed**, which makes fabricated sources structurally impossible instead of merely forbidden. The general AI attribute layer gives every ticket first-class local attributes in two layers: deterministic slots computed from observable facts with zero AI (urgency, question count, risk, known-issue links…), and AI slots that require evidence excerpts and enum-closed values to be stored at all — a missing attribute stays `unknown`, because a local-first system's credibility is its willingness to say "we don't know". Attributes are versioned (recompute supersedes, history survives), searchable, reportable with honest coverage percentages, and filterable through the *same* compiled path as saved views — one implementation, so the live inbox filter and a saved view can never disagree about what `urgency: high` means. AI escalation rules close the loop: automation can now match on attributes and draft-verification outcomes, but conditions only decide *whether* a rule fires — every action still flows through the approval tiers, so high urgency can route a ticket to the review queue without the AI ever touching a customer. The release's own verification earned its keep again: the audit's hostile probes caught citation deep-links that silently failed to resolve conversations and an unknown-session 503 that should have been a 404 — both fixed and regression-locked before any user could hit them.

v2.0.0 turns the intelligence into a workspace. When something breaks, fifty tickets arrive about one problem — so this release adds the **incident workspace**: declare a master issue from a known issue or a rising cluster, link conversations to it, and run the outage from one screen while the impact panel derives *distinct customers* (never ticket counts), growth, trend, inboxes and who is waiting right now. The affected-customer list is not stored anywhere — it is computed from the links at read time, because a stored copy starts accurate and drifts the first time a conversation is unlinked. The same honesty rules run through everything new: the extended Issue Radar's concentration and burst alerts carry evidence links and association-only wording (a temporal cluster near a release is *suggestive*, never proof); support health reports operational facts with definitions and evidence and **deliberately has no aggregate score**, because a number that summarizes a human invites reading it as a judgment; the customer timeline is a dedup-keyed append-only log where kinds without an observable source simply do not appear; and knowledge freshness flags stale or conflicting articles but only a human can stamp "reviewed" or "verified" — nothing is published automatically. Two systems had to be built with security as the architecture, not a checklist: **custom objects** store user-defined data as JSON validated by a schema compiled from the user's own field definitions (the moment a user's field key can influence SQL is the moment an object system becomes an injection surface — this one structurally cannot), and **connectors** read approved local sources behind a fail-closed SSRF guard (private ranges, localhost, cloud metadata, IPv4-mapped tricks and DNS-rebinding shapes are refused, twice: at configuration and at every request) with an explicit per-connector AI-visibility switch — connector data is private to the UI until a human says otherwise, and the Copilot's connector tool answers with a refusal and the honest list of what IS visible. The release's own verification earned its keep once more: the browser pass caught the incident link-by-number flow querying a search parameter the endpoint never had (now an exact-match `?number=` filter), and the contract tests caught a traversal-shaped file pattern and a sub-second connector refresh that pruned nothing.

v2.1.0 turns the intelligence inward: SupportOS now reviews its own work. The **knowledge gap engine** asks "what do customers keep asking that our docs don't answer?" and turns the answer into candidates with evidence — repeated uncovered questions, questions the existing docs failed to solve (the asking conversations still show follow-up friction), conflicting document pairs, missing troubleshooting steps, undocumented new issues — and then does the most important thing in the whole feature: **nothing**. A human approves or rejects; approving marks the candidate; drafting returns a suggested outline for a person to take away. The **post-resolution QA** pipeline applies the same two-layer honesty to closed tickets: a deterministic tier that always computes (back-and-forth, repeated information spans with thread evidence, handoffs, messages after close) and an optional local-model tier that answers "was the question answered / was the response evidence-supported / was the right issue identified" — recorded as its own `ai_runs` type, deliberately separate from pre-send draft verification. **Response effectiveness** reports observed associations between how replies were written and what happened next, and the plan's own rule ("do not claim causation from simple correlation") is structural: the notes lead with it, the audit greps for causal vocabulary. **Friction detection** grew to six evidence-pinned kinds — every finding cites thread ids and excerpts, and every detail line says *heuristic, a pattern, never a judgment about a person*. **Translation** is local-only: deterministic language detection (Han script honestly low-confidence, `unknown` an acceptable answer) plus LM Studio translation with content-hash caching and a prompt that preserves technical terms — side-by-side in the conversation detail, nothing ever sent automatically, no cloud fallback exists anywhere. **Advanced segmentation** grew seven condition families (organization data, ticket custom fields, waiting history, previous issues, incident exposure, campaign history, support health, custom objects, timeline events) — and the natural-language suggestion endpoint obeys the oldest rule in the codebase: the model may PROPOSE a definition, the deterministic engine executes the selection, nothing saves implicitly. The custom report builder compiles 21 local metrics × 14 dimensions from closed catalogs (injection-shaped configs are 422s), and every metric ships its definition and limitations in the response itself — because a number without its definition is a number you can't trust. This release's own verification found real bugs again: the audit caught `history_issue` falling through to a default link table for hostile kinds (now safe-deny), and the new demo scenario — a repeated question — surfaced a latent v2.0.0 freshness crash that had been unreachable until repeated questions existed: the exact condition the feature was built for.

v2.2.0 is the memory release — and the closing release of the roadmap: SupportOS now understands how everything connects, coaches replies before they are sent, and remembers customers safely. The **support graph** connects the twelve node kinds the plan enumerates (customers, organizations, conversations, issues, incidents, knowledge, agents, campaigns, products, custom objects, connector rows) using exactly what the plan prescribes — relational tables, no graph database. The decision that shapes everything else: **derived edges are computed live from the mirror at read time and only human-asserted edges are persisted**, because a stored copy of a relationship starts accurate and drifts the first time the underlying row changes — the same rule that has governed incident impact since v2.0.0, now applied to the whole data model. A products registry is derived INSERT-OR-IGNORE from the product strings incidents and known issues already carry (a rebuild can only add names); connector rows honestly have no derived links (rows carry only a row key) and the stats page says so instead of inventing structure. **Agent coaching** implements the plan's ten pre-send checks with a rule stated in the code and the UI: advisory only, ever — the send button is never disabled, delayed or annotated by coaching. Nine deterministic checks always compute (unanswered questions, duplicated questions, timeframe promises cross-checked against linked ACTIVE incidents, missing acknowledgment when frustration is present, excessive wording, insufficient detail, internal leakage as verbatim 6-gram spans against the conversation's own notes and linked incident internals, wrong-customer context, preference mismatch) and two run through the local model under their own `ai_runs` type. The browser pass caught the feature doing its job on real data: a "within 2 hours" promise flagged against the active INC-001, and a draft quoting the incident's internal explanation verbatim flagged with the incident itself quoted as evidence. **Customer memory** is composed at read time from the tables that already hold each fact — issue history, resolutions, preferences, patterns, campaigns, account facts — so it can never drift; every entry carries source, timestamp, confidence, freshness and evidence; human-written entries are the only persisted rows; and the plan's red line (*never store psychological/personality judgments*) is enforced twice: stored entries matching a closed quarantine pattern list are pulled out of usable memory (listed with a reason, purgeable), and human writes matching the list are refused outright. The **performance pass** bounds every remaining unbounded hot path, replaces the every-GET interaction backfill with a cheap COUNT guard, adds targeted indexes, and ships the project's first performance regression guards — a synthetic 2,000-conversation world with CI-safe budgets and deterministic EXPLAIN QUERY PLAN index assertions, because "fast with large datasets" should be a tested property, not a hope.

### 🆕 v2.2.1 — the polish release: a fresh full-project audit, 45 fixes, zero new features

v2.2.1 exists to make everything that already shipped work exactly the way it was designed to. After the roadmap completed at v2.2.0, a **completely fresh, independent audit** of the entire project ran from a neutral standpoint — four parallel adversarial passes (backend, frontend, consistency/docs, security) that deliberately did not trust the project's own 647 green tests, every finding verified and root-caused before a line was changed, followed by a human-like browser pass on the real 313-conversation database. It found **45 confirmed defects in existing functionality** — and the release adds no features and removes none. The standouts: the report builder's `organizations` metric had shipped with a SQL reference to a column that does not exist (every run was a 422); sample conversations on grouped reports bound display labels against id columns and were therefore always empty; the composer's typed reply bled across conversations (a draft written for ticket A sat one click away from ticket B's customer — fixed by keying the detail pane per conversation); a whole family of CSS utilities the M5/M6 panels referenced had never been defined, so stacked panels silently laid out as horizontal rows; the OAuth "Authorize via browser" button was a dead end that silently discarded the authorization code; campaign-creation evaluated up to 100,000 recipients in one request; an unanchored `screenshots/` gitignore pattern had swallowed 44 README gallery images out of git for four releases; and a stored AI analysis lacking optional fields crashed the entire conversation detail — found by the browser pass on a conversation no automated test had opened. The audit also hardened existing surfaces without changing their behavior: a DNS-rebinding Host guard (a rebinding page is same-origin from the browser's viewpoint, so the CORS allowlist enforced nothing against it in Firefox/Safari), GET endpoints no longer trigger synchronous rebuilds, and three under-validated routes (legacy memory writes, known-issue PATCH, release events) now enforce the same zod discipline as the rest of the API. Every fix ships with its regression lock: 25 new tests (672/672) and a new black-box audit section (452 checks, 0 HIGH / 0 MEDIUM).

### The decision log — the logic behind every major choice

| # | Decision | The reasoning |
|---|---|---|
| 1 | **One local SQLite file (WAL + FTS5), not a cloud DB** | Your data physically cannot leak if it never leaves the machine. SQLite in WAL mode gives concurrent reads during sync; FTS5 gives millisecond full-text search with zero infrastructure. The database is a file you can back up with `cp`. |
| 2 | **A mirror, not a Help Scout replacement** | Fighting the source of truth is a losing battle. SupportOS syncs through the official API, writes back through the same protected path, and never becomes the only place data lives. Teams keep their existing workflows and mobile app. |
| 3 | **TypeScript strict end-to-end, Zod at every boundary** | A local API that can lie about shapes is a debugging time bomb. Every request body, every Help Scout response and every AI output is schema-validated at runtime — the types and the runtime checks cannot drift. |
| 4 | **Write protection: validate → auth → fresh-read → merge → write → confirm → persist → audit** | The classic support-tool disaster is the stale-state overwrite (two agents edit tags; one silently wins). Before every remote write, SupportOS re-reads the live remote state, merges the intended change into it, confirms the result and records an immutable audit entry. |
| 5 | **Idempotent, durable replies with an explicit no-auto-retry rule** | A timed-out send may still have been delivered. SupportOS deduplicates identical sends via an idempotency key and *never* automatically resends — the safest failure mode for customer-visible email. |
| 6 | **Deterministic intelligence first, AI second** | The Client Intelligence engine (signals, baselines, change detection, effort scores) runs on pure heuristics — zero AI required. LM Studio enrichment layers on top when available. The feature cannot break when a model is down, and every result degrades gracefully. |
| 7 | **The evidence mandate** | A behavioral signal without a quoted excerpt is an opinion. Every signal carries evidence linked to the thread it came from; significant signals without evidence are dropped by the safety layer. |
| 8 | **Behavior, never psychology** | The vocabulary is fixed and observable (urgency, directness, detail level…). Personality labels, diagnoses and protected-attribute claims are structurally impossible — enforced at the schema, the sanitizer, the prompts and the UI labels, in depth. |
| 9 | **Human overrides beat AI, everywhere** | When a rep corrects an inferred preference, that correction wins — in storage, in the recommendation engine and in the draft prompts. The override is audited, revertible, and the revert fully restores AI semantics. |
| 10 | **A fake Help Scout provider as the test backbone** | The entire test suite (672 tests today) runs against a deterministic simulated mailbox. It is architecturally impossible for a test to email a real customer — the provider interface simply has no path to production credentials. |
| 11 | **Demo mode runs the REAL sync engine** | The 2-minute demo is not a mockup; it is the production sync pipeline pointed at the fake provider. What you evaluate is what you run. |
| 12 | **Local-first AI via LM Studio (OpenAI-compatible)** | Same ergonomics as the cloud APIs, zero data egress. And because the AI layer is optional (see #6), the product's value does not depend on anyone's model — including ours. |
| 13 | **Audit your own release** | v1.2.0's audit did not trust the project's own green test suite — it re-derived the findings from scratch (static analysis plus black-box runtime testing) and turned each fix into a named regression test. Trust, but verify; then lock it in. |
| 14 | **Chats are conversations (v1.3.0)** | Help Scout already models Beacon chats as conversations with `type=chat` — so the mirror treats them as first-class conversations with a channel filter, instead of duplicating them into a parallel "chat object" that could drift out of sync. One table, one truth, per-channel analytics on top. |
| 15 | **Docs get their own mirror, not a bolt-on (v1.3.0)** | The Docs API lives on a different host with a different key and different auth (HTTP Basic) — so it gets its own service class and its own tables, synced by the same coordinator. Read-only forever: SupportOS never writes back to Docs. |
| 16 | **SSE, not WebSockets (v1.3.0)** | Real-time updates are one-way notifications. Server-Sent Events give auto-reconnect over plain HTTP with zero new dependencies; the client needs only `EventSource`. The bus pushes *events* ("a rating landed"), and every number the UI shows is still computed locally — the push layer can never fabricate a metric. |
| 17 | **Scope parameters, not a parallel dashboard (v1.3.0)** | Multi-mailbox dashboards reuse the exact same deterministic SQL with a `scope` argument (mailboxes + channel). One code path means the single-mailbox numbers and the comparison rows can never disagree, and metric definitions stay honest. |
| 18 | **Ship a boring runtime (v1.3.0)** | The desktop package bundles a stock official Node binary matched to the CI runner's ABI, an esbuild bundle of the server, and exactly one native module (`better-sqlite3`). Node SEA/pkg were rejected: unmaintained or hostile to native addons. Boring is a feature — it's the runtime you can debug with `node --inspect`. |
| 19 | **Cross-platform builds belong in CI (v1.3.0)** | A Windows MSI cannot be built on Linux. The desktop workflow runs the same assembly script on all three GitHub runners, so every installer is built and booted on its native OS — and the resources are *assembled*, never committed. |
| 20 | **Push what happened, compute what it means (v1.4.0)** | The webhook layer persists the event, verifies the HMAC, dedups, and enqueues a sync of exactly one conversation — then the SSE stream announces "conversation #N changed, reason: webhook". The event never carries computed metrics; every number stays a local SQL computation. Push notifications and honest numbers stay separable. |
| 21 | **Local vectors beat a vector dependency (v1.4.0)** | Semantic docs search stores embeddings in SQLite and treats Qdrant as an accelerator, not a requirement: Qdrant up when available (ANN speed), local cosine scan when not. Fusing with Reciprocal Rank Fusion (rank-based) means keyword ranks and cosine scores never need to be normalized against each other, and every hit records which retriever found it. |
| 22 | **Business minutes via the platform tz database (v1.4.0)** | Hand-rolled DST arithmetic is how SLA reports lie. The business-hours engine converts wall-clock times through Intl's timezone data (guess-and-correct, DST-safe), returns null instead of a guess on invalid input, and the report always shows wall minutes *next to* business minutes so nothing pretends to be adjusted that isn't. |
| 23 | **Test the seam, not just the parts (v1.4.0)** | The job pipeline was green in tests and dead in production for four versions because tests called components directly, skipping the claim loop where two format bugs lived. The new regression tests enqueue → claim → execute exactly as the worker does. Every integration point deserves a test that travels the real path. |
| 24 | **Deterministic segments, AI-assisted humans (v1.5.0)** | Who receives a customer-visible email is too consequential for a language model. The segment engine is pure SQL over the local mirror; the LLM may explain or suggest rules, but the recipient set is always the engine's output. The same separation as the AI pipeline's "drafts, never sends" — scaled up to audiences. |
| 25 | **Contact-first resolution (v1.5.0)** | Help Scout's search is ticket-first; outreach needs people. The engine's pipeline is conversations → conversation-level tag semantics → customer ids → dedupe — so "ALL of timezone,bug" means one ticket carrying both (a customer with each tag on separate tickets does not match), and one customer with five matching tickets is still exactly one recipient. |
| 26 | **Snapshots over references for campaigns (v1.5.0)** | A saved segment is a living rule; a campaign's recipients are a frozen snapshot with the evidence that selected them (matching tickets, property values at selection time). The segment changing later can never silently alter who a campaign already targeted — auditability requires that time travel. |
| 27 | **Encrypted sync is a file, not a server (v1.5.0)** | A relay would be a third party that sees ciphertext and decides availability. SupportOS ships `.sosync` bundles (AES-256-GCM, scrypt-derived key, integrity-checked, verified before import): move them by any channel you already trust. The attachments re-download from Help Scout on the other device, so bundles stay small. |
| 28 | **Test what the user sees, not what the wire carries (v1.6.0)** | The v1.4.0 webhook-push UX shipped dead for four versions because tests asserted the SSE frame — which worked — while the browser never subscribed to that event name. Regression tests now assert the *client-visible* outcome (the toast, the invalidation, the tag appearing), and the audit itself ends with a human-like pass: clicking real buttons in a real browser, the only method that can feel "the UI says queued but nothing ever landed". |
| 29 | **Diff before you re-chunk (v1.6.0)** | Rebuilding derived data unconditionally feels safe and quietly costs the most: the docs mirror re-chunked every article on every 5-minute sync, destroying every stored embedding even for byte-identical text — permanent re-embedding, permanently lagging semantic search. A SHA-256 content hash now gates re-chunking; derived data rebuilds only when its input actually changed. |
| 30 | **Fix the bug class, not the instance (v1.6.0)** | The v1.4.0 job-queue bug (ISO-8601 vs `datetime('now')` string comparison) turned out to live in 12+ more sites — segmentation windows, reply detection, trend classification, retention pruning. Each instance was individually harmless-looking; the class produced up-to-24-hour boundary skew everywhere at once. The fix normalizes every site to one comparison basis (`julianday()`), and the lesson is process: when a format mismatch bites once, grep for the whole species. |
| 31 | **Key limits on what the client cannot fake (v1.6.0)** | The mutation rate limiter keyed on `X-Forwarded-For` — pure client input once no proxy is trusted — so rotating the header bought an unlimited budget (310/310 verified). It now keys on the socket address: one local operator, one budget, which was always the intended semantics. Anything a client can freely write is not an identity. |
| 32 | **Derive history, don't invent it (v1.7.0)** | Help Scout exposes no change log, so the activity engine records what it can PROVE: message events carry exact thread timestamps; observed changes record the observation time and say so (`source: sync, observed: true`); conversations with unknown thread history report response state `unknown` instead of guessing "never responded". A local-first system's credibility is its willingness to say "we don't know". |
| 33 | **One response-state expression, everywhere (v1.7.0)** | The deterministic state machine (Needs First Response / Customer Waiting / …) is a single SQL CASE used by the list filter, the view engine and the detail route — plus a JS mirror with a row-by-row equivalence test. Two implementations of a classification is how a list badge disagrees with the detail view. |
| 34 | **Store conditions, compile SQL at open time (v1.7.0)** | Saved Inbox Views persist as Zod-validated JSON condition trees (AND/OR groups, 21 kinds); the engine compiles them to parameterized SQL with whitelisted identifiers on every evaluation — so "today" means the day you open it, and user input can never become SQL. The same philosophy as v1.5.0 segments: structured definitions in, deterministic execution out. |
| 35 | **Calendar days and rolling windows are different filters — label them (v1.7.0)** | "Today" (local midnight to midnight, DST-correct) and "last 24 hours" (exact now-minus window) answer different questions and are surfaced with distinct labels and notes. Silently treating them as synonyms is how a support report quietly lies by an hour. |
| 36 | **Trust library date math only as far as your tests pin it (v1.7.0)** | dayjs's `.startOf('day')` under the timezone plugin derives the offset from the wrong instant — correct for New York by coincidence, 30 minutes wrong for Lord Howe-style half-hour DST zones. Caught by testing the WEIRD zone before shipping, worked around by doing calendar math on neutral date-only values. DST bugs hide in the zones nobody tests. |
| 37 | **One fragment, one truth — the tile IS the filter (v1.8.0)** | Every conversation-scoped Operations Center tile is a COUNT(*) over the exact same whitelisted parameterized SQL fragment that `GET /api/conversations?ops=<tileKey>` filters with. A dashboard number that disagrees with the list behind it is worse than no number — so the architecture makes disagreement structurally impossible instead of testing harder for it. |
| 38 | **Capacity is configuration, never inference (v1.8.0)** | Workload pressure could have been "estimated" from response speed, hours, tone — all of it guesswork about human beings. The capacity model is explicit configuration (default max, per-user overrides, tier weights); availability is the Help Scout user status already synced; and the suggested assignee exposes its reasoning and does nothing else. A tool that recommends should never be a tool that decides. |
| 39 | **One producer, one funnel for notifications (v1.8.0)** | Every notification is derived by a single idempotent sweep from observable local facts (events, SLA alerts, jobs, sync state, campaign replies, ratings) — dedup keys make re-runs structurally duplicate-free. The alternative — each feature emitting its own notifications — is how notification systems accumulate spam, ordering bugs and unkillable duplicates. The sweep defers its cursor until the first sync settles, because history is not news. |
| 40 | **Exact identity matching or nothing (v1.8.0)** | Mentions match complete names (mention names, first/full names, team names) case-insensitively — never prefixes, never substrings. `@al` notifying Alex feels helpful right up until it notifies the wrong person; an unknown `@token` staying plain text costs nothing. Identity resolution is the one place where guessing is strictly worse than failing. |
| 41 | **Internal-only data needs internal-only tables (v1.8.0)** | Side collaboration threads live in their own local tables with their own audit trail — never forced into Help Scout's customer-visible thread model, never synced out. "Internal" that shares a data path with "customer-visible" is a leak waiting for its first bug; separation by construction beats separation by discipline. |
| 42 | **Citations the model cannot fake (v1.9.0)** | The Copilot's source list is generated by the SERVER from the tool executions it actually performed — the model's claims about sources are never trusted, stored or displayed. Prohibiting fabrication in a prompt is a request; making fabricated sources structurally unrepresentable is an architecture. |
| 43 | **Deterministic slots, AI slots, honest unknowns (v1.9.0)** | The attribute layer's deterministic half (urgency, question count, risk, known-issue links…) needs zero AI and always exists; the AI half (intent, product, style…) must present evidence excerpts and enum-closed values or it is not stored at all. A missing attribute reads as `unknown` — never a guess wearing a confidence badge. Attributes are versioned, never overwrite Help Scout data, and the same compile path serves the live filter, saved views and segments so "urgent" means one thing everywhere. |
| 44 | **AI decides matches, humans decide actions (v1.9.0)** | Escalation rules can test AI attributes and draft-verification outcomes, but conditions only gate rule firing — every action flows through the same read/non-destructive/higher-risk approval tiers as v1.0. "High urgency → review queue" is safe because the attribute decides nothing about the customer; the queue is internal, and the approval tier is unchanged. |
| 45 | **Derived counts, never stored counts (v2.0.0)** | An incident's affected customers and organizations are computed from the linked conversations at read time. A stored copy starts accurate and drifts the first time a conversation is unlinked; a derivation cannot lie about its own inputs. The same rule powers impact intelligence: customer counts are COUNT(DISTINCT customer) — a ticket count is never silently used as a customer count. |
| 46 | **User-defined data never becomes SQL (v2.0.0)** | Custom object values are JSON validated by a Zod schema built from the type's own field definitions at every write; filtering compiles through whitelisted operators. The moment a user's "field key" can influence a statement is the moment a custom object system becomes an injection surface — this one structurally cannot. |
| 47 | **SSRF fail-closed, twice (v2.0.0)** | Connector HTTP targets are validated at configuration time AND re-validated at every request: protocol allowlist, literal private/loopback/metadata ranges, IPv4-mapped and numeric-encoding tricks, internal hostnames — then DNS resolution is re-checked so a rebinding answer cannot slip through. Anything the guard cannot parse is refused, not allowed. |
| 48 | **AI visibility is an explicit per-connector yes (v2.0.0)** | Connector data is private to the UI until a human flips the allowed_ai switch — the Copilot's connector tool returns an explicit refusal (with the honest list of what IS visible) instead of a silent empty result. Default-private with a visible, auditable opt-in is the only safe default for connected business data. |
| 49 | **Candidates wait for humans (v2.1.0)** | The knowledge gap engine persists deterministic detections as candidates with evidence, and a human approves or rejects; approving marks the candidate, drafting returns an outline. Nothing auto-publishes into the knowledge base — the entire pipeline ends at a human decision, by construction. |
| 50 | **Two layers of QA, honestly separated (v2.1.0)** | Post-resolution QA always computes its deterministic tier (counts, repeats, handoffs — with method notes); the AI tier is optional and recorded under its own ai_runs type, separate from pre-send draft verification. An unavailable model means the AI layer stays honestly absent — never a guess. |
| 51 | **Association is not causation — structurally (v2.1.0)** | Response effectiveness and report comparisons word everything as observed associations; the notes say so in the data itself and the black-box audit greps for causal vocabulary. A correlation report that could be read as a causal claim is a bug, not a nuance. |
| 52 | **The model proposes, the engine selects (v2.1.0)** | The natural-language segment suggestion asks the local model for a condition tree, validates it against the closed kind catalog, then the deterministic SegmentEngine executes it and returns THAT preview. The model never decides recipients and nothing saves implicitly — the same rule that has governed outreach since v1.5.0. |
| 53 | **Derived edges are never stored (v2.2.0)** | The support graph computes every derived relationship live from the mirror at read time; only human-asserted edges are persisted. A stored copy of a relationship starts accurate and drifts the first time the underlying row changes — the incident-impact rule since v2.0.0, applied to the whole data model. |
| 54 | **Coaching advises, the agent decides (v2.2.0)** | Pre-send coaching implements all ten plan checks with evidence per finding — and no code path blocks, delays or annotates the send. The review persists as an audit trail of what the agent was told; the send button is untouched. |
| 55 | **Memory composes, it never copies (v2.2.0)** | Customer memory is derived at read time from the tables that already hold each fact — it cannot drift. Human-written entries are the only persisted rows; AI rows are immutable because they re-derive; every entry carries source/timestamp/confidence/freshness/evidence. |
| 56 | **The personality red line is code, not comment (v2.2.0)** | Psychological/personality judgments are refused on write (422 with the policy message) and quarantined on read (excluded from usable memory, listed with a reason, purgeable). The pattern list is closed, deterministic, and deliberately broad — a false quarantine is an inconvenience; a missed judgment is a policy violation. |
| 57 | **Fix what exists, add nothing (v2.2.1)** | After the roadmap completed, the next release added zero features on purpose. A fresh audit that does not trust the existing test suite is the only honest way to find what 647 green tests had normalized — every finding was verified and root-caused before a line changed, and every fix ships with a named regression lock. |
| 58 | **The local threat model includes the browser's own origins (v2.2.1)** | "Local-only" is not enforced by CORS: a DNS-rebinding page is same-origin from the browser's viewpoint, so the allowlist enforced nothing against it. The Host header is now validated against loopback names in the default bind mode — the documented non-loopback HOST mode still works and still warns loudly. |
| 59 | **Every database surface applies the same rules (v2.2.1)** | The legacy `/api/ai/memory` route now delegates to the same memory service as `/api/memory` — one red line, one existence check, one honest source labeling. Two code paths to one table is two chances to diverge. |
| 60 | **Config files are code (v2.2.1)** | `vitest.config.ts` carried `sequential: true`, which is not a valid Vitest 3 option — silently ignored, invisible to CI, and two e2e suites collided on a port only on multi-core runners. Config files now join the typecheck and lint surface: a typo in a config is a compile error, not a latent CI flake. |

---

## 📸 See it in action

All screenshots are the **real application** running in demo mode (simulated mailbox) — clone the repo and you'll see exactly this, in under two minutes.

### 🎬 The 30-second tour

**A full walk through v1.3.0: multi-mailbox + channel-scoped dashboard, the unified inbox filtering to Beacon chats, Client Intelligence on a chat conversation, the Docs mirror with offline search, and a CSAT rating landing live over Server-Sent Events**

[![SupportOS v1.3.0 demo: channels, docs mirror, multi-mailbox dashboards and real-time ratings](docs/demo.gif)](docs/demo.gif)

### 🆕 v1.3.0 — channels, docs, real-time, multi-mailbox

**Dashboard — pick mailboxes (multi-select) and a channel; per-mailbox comparison rows and chat-vs-email speed are computed from the same local SQL**

[![SupportOS multi-mailbox dashboard with channel scope](docs/screenshots/v130-dashboard.png)](docs/screenshots/v130-dashboard.png)

**Chat scope — the same dashboard focused on Beacon chats: 6 sessions, minutes-not-hours response times**

[![SupportOS dashboard scoped to Beacon chat channel](docs/screenshots/v130-dashboard-chat-scope.png)](docs/screenshots/v130-dashboard-chat-scope.png)

**Unified inbox — channel filter switches between email and Beacon chat sessions in one workspace**

[![SupportOS inbox filtered to Beacon chats](docs/screenshots/v130-inbox-chat.png)](docs/screenshots/v130-inbox-chat.png)

**A Beacon chat conversation — quick thread, and the Client Intelligence card works on chats exactly like on email**

[![SupportOS Beacon chat conversation with client intelligence](docs/screenshots/v130-chat-conversation.png)](docs/screenshots/v130-chat-conversation.png)

**Docs mirror — your Help Scout Docs, synced locally, searchable offline with FTS5**

[![SupportOS Docs mirror with offline full-text search](docs/screenshots/v130-docs-search.png)](docs/screenshots/v130-docs-search.png)

### 🆕 v1.4.0 — webhook push, semantic docs search, SLA

**SLA & business hours — first-response and resolution measured in business minutes per mailbox, with met/missed against targets and live waiting aging**

[![SupportOS SLA report with business minutes per mailbox](docs/screenshots/v140-sla-configured.png)](docs/screenshots/v140-sla-configured.png)

**Business-hours editor — per-mailbox timezone, active weekdays, window and SLA targets**

[![SupportOS business hours editor](docs/screenshots/v140-business-hours.png)](docs/screenshots/v140-business-hours.png)

**Docs search with the semantic layer — hybrid keyword + vector retrieval, per-hit provenance, honest mode notes**

[![SupportOS semantic docs search](docs/screenshots/v140-docs-semantic.png)](docs/screenshots/v140-docs-semantic.png)

### 🆕 v1.5.0 — outreach, ticket vector search, SLA alerts, encrypted sync

**The audience builder — property, contact, ticket and support-history conditions with a live why-selected preview**

[![SupportOS outreach audience builder with live preview](docs/screenshots/v150-audience-builder.png)](docs/screenshots/v150-audience-builder.png)

**Recipient review — every customer explains why they matched, with the matching tickets one click away**

[![SupportOS outreach recipient review with why-selected evidence](docs/screenshots/v150-recipient-review.png)](docs/screenshots/v150-recipient-review.png)

**Campaign monitor — per-recipient states, audit events and outcome reports for every campaign**

[![SupportOS outreach campaign monitor](docs/screenshots/v150-campaign-monitor.png)](docs/screenshots/v150-campaign-monitor.png)

**SLA alerts on the Issue Radar — business-minutes aging against per-mailbox targets, breaches first**

[![SupportOS business-hours SLA alerts on the Issue Radar](docs/screenshots/v150-sla-alerts.png)](docs/screenshots/v150-sla-alerts.png)

**Encrypted sync — passphrase-protected .sosync bundles, no relay server by design**

[![SupportOS encrypted multi-device sync settings](docs/screenshots/v150-encrypted-sync.png)](docs/screenshots/v150-encrypted-sync.png)

**Webhook push — register conversation webhooks and watch events land in real time (with demo buttons that exercise the exact production pipeline)**

[![SupportOS webhook push registration](docs/screenshots/v140-webhook-push.png)](docs/screenshots/v140-webhook-push.png)

### 🆕 v2.2.0 — the memory release: support graph, agent coaching, customer memory, performance guards

**The Graph Explorer — twelve node kinds, every derived edge computed live from the mirror with provenance badges; only human-asserted edges are stored**

[![SupportOS v2.2.0 graph explorer](docs/screenshots/v220-02-graph-stats.png)](docs/screenshots/v220-02-graph-stats.png)

**Incident neighbors — derived product/customer/organization edges with the "via conversation" derivation visible on every edge**

[![SupportOS v2.2.0 incident neighbors](docs/screenshots/v220-03-graph-incident-neighbors.png)](docs/screenshots/v220-03-graph-incident-neighbors.png)

**Pre-send coaching — the full ten-check list with evidence; a "within 2 hours" promise flagged against the linked active incident**

[![SupportOS v2.2.0 coaching panel](docs/screenshots/v220-06-coaching-panel.png)](docs/screenshots/v220-06-coaching-panel.png)

**Internal-leakage detection — a draft quoting the incident's internal explanation verbatim, flagged with the incident quoted as evidence**

[![SupportOS v2.2.0 coaching leak detected](docs/screenshots/v220-07-coaching-leak-detected.png)](docs/screenshots/v220-07-coaching-leak-detected.png)

**Customer memory — composed live from the local mirror; every entry carries source, confidence, freshness and evidence**

[![SupportOS v2.2.0 memory panel](docs/screenshots/v220-08-memory-panel.png)](docs/screenshots/v220-08-memory-panel.png)

### 🆕 v2.1.0 — the quality release: knowledge gaps, post-resolution QA, effectiveness, friction, translation, report builder

**The knowledge gap engine — deterministic detections become candidates with evidence; a human approves or rejects, and nothing ever auto-publishes**

[![SupportOS v2.1.0 knowledge gaps](docs/screenshots/v210-02-knowledge-gaps.png)](docs/screenshots/v210-02-knowledge-gaps.png)

**Post-resolution QA in the conversation detail — the deterministic tier always computes; the optional AI layer reports honestly when the local model is down**

[![SupportOS v2.1.0 QA panel](docs/screenshots/v210-05-qa-ai-honest.png)](docs/screenshots/v210-05-qa-ai-honest.png)

**Local translation with side-by-side review — deterministic detection, LM Studio only, nothing sent automatically**

[![SupportOS v2.1.0 translation panel](docs/screenshots/v210-06-translation-panel.png)](docs/screenshots/v210-06-translation-panel.png)

**The custom report builder — metric × dimension from closed catalogs, previous-period comparison, and every metric ships its definition and limitations**

[![SupportOS v2.1.0 report builder](docs/screenshots/v210-10-builder-run.png)](docs/screenshots/v210-10-builder-run.png)

**Response effectiveness — observed associations with sample conversations; the notes say "not causation" because the data says so**

[![SupportOS v2.1.0 response effectiveness](docs/screenshots/v210-07-effectiveness.png)](docs/screenshots/v210-07-effectiveness.png)

### 🆕 v2.0.0 — the workspace release: incidents, impact intelligence, custom objects, connectors, timeline, health, freshness

**The incident workspace — declare a master issue from a known issue or a cluster, link many conversations to it, and run the outage from one screen: derived impact (distinct customers, never ticket counts), explanations (internal vs customer-safe), engineering refs, releases, notes and an append-only timeline**

[![SupportOS v2.0.0 incident workspace](docs/screenshots/v200-incident-impact.png)](docs/screenshots/v200-incident-impact.png)

**The active-incident chip in the Inbox — linked conversations carry the incident code on their header, so every agent sees the outage context without leaving the ticket**

[![SupportOS v2.0.0 inbox incident chip](docs/screenshots/v200-inbox-incident-chip.png)](docs/screenshots/v200-inbox-incident-chip.png)

**Customer event timeline + support health — an append-only local event log (signups, conversations, campaigns, ratings, incident exposure) next to operational facts with definitions and evidence; no aggregate score, no judgments, by design**

[![SupportOS v2.0.0 customer timeline and health](docs/screenshots/v200-customer-timeline.png)](docs/screenshots/v200-customer-timeline.png)

**Custom objects — define your own typed records (Account, Deployment, anything) with validated fields and relationship edges to customers, organizations, conversations, issues, incidents and campaigns**

[![SupportOS v2.0.0 custom objects](docs/screenshots/v200-custom-objects-empty.png)](docs/screenshots/v200-custom-objects-empty.png)

**Connectors — approved local data sources (JSON / CSV / SQLite / HTTP) with snapshot refresh, inferred schemas and the explicit AI-visibility gate; HTTP targets are SSRF-guarded fail-closed (private networks, localhost and cloud metadata endpoints are refused)**

[![SupportOS v2.0.0 connectors](docs/screenshots/v200-connector-rows.png)](docs/screenshots/v200-connector-rows.png)

**Knowledge freshness — stale, needs-review, conflict candidates, low usage, articles followed by tickets and recurring questions; Review/Verify are human-only timestamps, nothing is published automatically**

[![SupportOS v2.0.0 knowledge freshness](docs/screenshots/v200-knowledge-freshness.png)](docs/screenshots/v200-knowledge-freshness.png)

**The extended Issue Radar — reappearing issues, customer/inbox concentration, release-correlation bursts, repeated unresolved patterns and unusual volume, every alert carrying evidence links and association-only wording**

[![SupportOS v2.0.0 issue radar](docs/screenshots/v200-radar-alerts.png)](docs/screenshots/v200-radar-alerts.png)

### 🆕 v1.9.0 — the intelligence release: Local Copilot, AI attributes, AI escalation rules

**Local Copilot — an interactive read-only assistant in every conversation's context pane: starter questions grounded in local facts, evidence-cited answers, honest unavailability when LM Studio is off (it says so instead of pretending)**

[![SupportOS v1.9.0 Local Copilot](docs/screenshots/v190-copilot-panel.png)](docs/screenshots/v190-copilot-panel.png)

**Per-ticket AI attribute snapshot — deterministic slots (source `det.`) always computable without AI, confidence badges, expandable evidence excerpts, honest unknowns listed separately, one-click recompute**

[![SupportOS v1.9.0 attribute snapshot](docs/screenshots/v190-attribute-snapshot.png)](docs/screenshots/v190-attribute-snapshot.png)

**Live inbox AI-attribute filter — the same compiled condition path as saved views; missing values read as `unknown` and the note says so**

[![SupportOS v1.9.0 live attribute filter](docs/screenshots/v190-attribute-report.png)](docs/screenshots/v190-attribute-report.png)

**AI Center → Attributes — coverage report with known/unknown bars per attribute and a searchable drill-down (blank value = "is unknown")**

[![SupportOS v1.9.0 attribute drill-down](docs/screenshots/v190-attribute-drilldown.png)](docs/screenshots/v190-attribute-drilldown.png)

**AI Center → Copilot — the session history with conversation links and the safety model spelled out**

[![SupportOS v1.9.0 Copilot sessions](docs/screenshots/v190-copilot-ai-center.png)](docs/screenshots/v190-copilot-ai-center.png)

**AI escalation rules — automation conditions can test AI attributes through a closed catalog selector; conditions only decide matches, actions still flow through the approval tiers**

[![SupportOS v1.9.0 AI escalation rule form](docs/screenshots/v190-automation-ai-condition.png)](docs/screenshots/v190-automation-ai-condition.png)

### 🆕 v1.8.0 — the collaboration release: Operations Center, workload, notifications, mentions, side threads

**Operations Center — the whole operation on one screen: 16 live tiles scoped by mailbox; every conversation tile drills into the exact filtered inbox list that produced its count (one SQL fragment is the single source of truth for both)**

[![SupportOS v1.8.0 Operations Center with 16 live tiles](docs/screenshots/v180-operations-center.png)](docs/screenshots/v180-operations-center.png)

**Team workload — per-agent and per-team load with pressure bars, Help Scout-synced availability dots, an explicit capacity model and read-only suggested assignees with their reasoning exposed**

[![SupportOS v1.8.0 team workload and capacity](docs/screenshots/v180-team-workload.png)](docs/screenshots/v180-team-workload.png)

**Notification Center — a persistent local inbox of what changed (unread badge, per-type preferences, source links); the nav badge updates live over SSE without a refresh**

[![SupportOS v1.8.0 Notification Center](docs/screenshots/v180-notification-center.png)](docs/screenshots/v180-notification-center.png)

**@mention autocomplete in the note composer — typing `@pr` offers the identities Help Scout knows (exact matching only; unknown tokens stay plain text)**

[![SupportOS v1.8.0 mention autocomplete](docs/screenshots/v180-mention-autocomplete.png)](docs/screenshots/v180-mention-autocomplete.png)

**Side collaboration threads — internal-only team discussions attached to a conversation (never customer-visible, never synced to Help Scout), with participants, mentions and resolve/reopen**

[![SupportOS v1.8.0 side collaboration thread](docs/screenshots/v180-side-thread-detail.png)](docs/screenshots/v180-side-thread-detail.png)

**Mentions for me — the queue links every mention back to its conversation**

[![SupportOS v1.8.0 mentions queue](docs/screenshots/v180-mentions-queue.png)](docs/screenshots/v180-mentions-queue.png)

### 🆕 v1.7.0 — the activity-intelligence release: event histories, saved views, priorities & states

**Inbox with date/activity filters, response states and waiting ages — every conversation row now shows its deterministic response state (Needs First Response / Customer Waiting / …), local priority and how long the customer has been waiting; the filter bar combines 14 activity fields × 15 date modes (DST-safe in your timezone) with response-state, priority and ticket-state filters, sortable by waiting duration**

[![SupportOS v1.7.0 inbox with activity filters and response states](docs/screenshots/v170-inbox-filters.png)](docs/screenshots/v170-inbox-filters.png)

**Conversation detail with the activity timeline — every message, note, priority change and state transition with honest sourcing (rebuilt from the mirror / observed during sync / recorded at the local write); local priority and custom ticket-state pickers record full transition history with reasons**

[![SupportOS v1.7.0 conversation detail with activity timeline](docs/screenshots/v170-detail-timeline.png)](docs/screenshots/v170-detail-timeline.png)

### 🆕 v1.6.0 — the audit release: verified-live real-time push

**Webhook push, actually pushed — the toast and the live list update now fire when Help Scout pushes a conversation change (the client-side listener for this was silently dead since v1.4.0; found by the client audit, verified fixed live)**

[![SupportOS webhook push toast and live inbox update](docs/screenshots/v160-webhook-toast.png)](docs/screenshots/v160-webhook-toast.png)

**Write-behind writes converge — bulk-tag from anywhere (even curl) and open views refresh within one worker tick, because the worker announces every completed write over SSE**

[![SupportOS live inbox after webhook push](docs/screenshots/v160-webhook-push-live.png)](docs/screenshots/v160-webhook-push-live.png)

**Reports with honest failure states — every query that can fail now says so instead of spinning forever or showing a misleading empty state**

[![SupportOS reports with error-hardened tabs](docs/screenshots/v160-reports-error-hardened.png)](docs/screenshots/v160-reports-error-hardened.png)

**Settings — every save/test/export/import mutation reports failures with a toast; forms gate on loaded data instead of silently capturing defaults**

[![SupportOS settings with hardening](docs/screenshots/v160-settings.png)](docs/screenshots/v160-settings.png)

### 📥 Support workspace

**Dashboard — volume, response times and backlog at a glance, with per-metric definitions and provenance labels**

[![SupportOS dashboard: support KPIs and trends](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png)

**Inbox — 3-pane workspace: views and filters, sanitized thread view, customer + AI context panes**

[![SupportOS inbox: 3-pane support ticket workspace](docs/screenshots/inbox.png)](docs/screenshots/inbox.png)

**Conversation — thread view with customer history, AI context pane and rich composer (reply / note / saved replies / AI draft insertion)**

[![SupportOS conversation view with AI context](docs/screenshots/conversation.png)](docs/screenshots/conversation.png)

**Search — one query across tickets, threads, customers, knowledge, known issues and AI analyses, with match explanations**

[![SupportOS universal support search](docs/screenshots/search.png)](docs/screenshots/search.png)

### 🧠 Client Interaction Intelligence

**Client Intelligence card — current signals with evidence, historical pattern, and today's significant changes vs the client's norm**

[![SupportOS client intelligence card in the inbox sidebar](docs/screenshots/client-intelligence.png)](docs/screenshots/client-intelligence.png)

**Client Interaction Profile — timeline, observed preferences (human-overridable), previous outcomes and a repeat-client support playbook**

[![SupportOS client interaction profile](docs/screenshots/client-profile.png)](docs/screenshots/client-profile.png)

### 🔬 Support intelligence

**AI Center — local LM Studio health, AI job queue, analytics and evaluation mode**

[![SupportOS AI Center with local model analytics](docs/screenshots/ai-center.png)](docs/screenshots/ai-center.png)

**Issue Radar — new/rising/recurring issue clusters with linked tickets, known issues, doc gaps and answer reuse**

[![SupportOS Issue Radar: trending support problems](docs/screenshots/issues.png)](docs/screenshots/issues.png)

**Reports — local analytics + Help Scout native imports + AI narratives, each clearly labeled by source**

[![SupportOS reports with provenance labels](docs/screenshots/reports.png)](docs/screenshots/reports.png)

**Knowledge — local knowledge base with customer-safe vs internal visibility**

[![SupportOS local knowledge base](docs/screenshots/knowledge.png)](docs/screenshots/knowledge.png)

---

## ⚡ Try it in 2 minutes (no credentials needed)

```bash
git clone https://github.com/kimpearce888/supportos.git
cd supportos
npm install
cp .env.example .env        # then set LOCAL_DEMO_MODE=true in .env → no Help Scout account needed
npm run build
npm run start               # → http://127.0.0.1:3000
```

Demo mode spins up a simulated Help Scout mailbox (20 conversations across email and Beacon chat, 9 Docs articles, customers, tags, known issues, knowledge and sample AI analyses) and runs the **real sync engine** against it — nothing is mocked at the UI level, so you're evaluating the actual product. While you're there, open a second terminal and watch updates arrive live:

```bash
# Push a conversation event through the REAL webhook pipeline (HMAC → dedup → job → sync → SSE)
curl -X POST http://127.0.0.1:3000/api/demo/simulate-webhook \
  -H 'Content-Type: application/json' \
  -d '{"event": "convo.customer.reply.created"}'

# Or fire a CSAT rating
curl -X POST http://127.0.0.1:3000/api/demo/simulate-rating \
  -H 'Content-Type: application/json' \
  -d '{"conversationRemoteId": 105015, "rating": "great", "comments": "Shipped in the demo!"}'
```

<details>
<summary><b>🔌 Connect your real Help Scout mailbox</b></summary>

1. In Help Scout: **Your Profile → My Apps → Create My App** with redirect URI `http://localhost:3000/oauth/callback`
2. Put `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` into `.env` and set `LOCAL_DEMO_MODE=false`
3. `npm run start` → first-run wizard → **Connect Help Scout** (client-credentials is simplest for a personal integration)
4. Run the **initial sync** and watch per-resource checkpoints; the mirror is resumable after any restart
5. Optional: point Settings → AI at [LM Studio](https://lmstudio.ai) and/or local [Qdrant](https://qdrant.tech)

See [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) for the verified Help Scout API capability matrix.
</details>

<details>
<summary><b>🖥️ Optional: native desktop app (MSI / DMG / AppImage)</b></summary>

**The easy way:** download a ready-made installer from the [releases page](https://github.com/kimpearce888/supportos/releases) — Windows (MSI + NSIS `.exe`), macOS (universal DMG for Intel + Apple Silicon) and Linux (AppImage). Each package bundles the Node runtime and SQLite, so there is **nothing to install first** — no Node, no npm. Data lives in your user profile (`%APPDATA%` / `~/Library/Application Support` / `~/.local/share`).

**Build it yourself** (requires Rust via [rustup.rs](https://rustup.rs)):

```bash
npm ci
npm run desktop:build        # assembles resources + tauri build → installers in src-tauri/target/release/bundle/
```

The packaging pipeline (`scripts/build-desktop.mjs`) bundles the server with esbuild, copies the one native module, downloads the official Node runtime and hands everything to Tauri — see [docs/DESKTOP.md](docs/DESKTOP.md). The same pipeline runs in CI on all three operating systems for every release.
</details>

---

## ✨ Features

| Area | What you get |
|---|---|
| **📥 Local mirror** | Account, users, teams, inboxes, folders, tags, custom fields, customers, organizations, conversations, threads, attachments, ratings, saved replies, workflows, routing — synced via polling with checkpoints, resumable after restart, with drift reconciliation |
| **🎧 Channels (v1.3.0)** | Beacon chat sessions sync as first-class conversations (`type=chat`, source `via=beacon`) — unified inbox channel filter, chat badges, and honest chat-vs-email speed analytics. The conversations endpoint has no documented type filter, so filtering happens locally (stated openly in the capability matrix) |
| **📚 Docs mirror (v1.3.0)** | Help Scout Docs collections, categories and articles mirrored read-only from docsapi.helpscout.net (separate Docs API key) — offline FTS search, status/view stats, channel-mix overview; without a key the mirror stays empty and says so |
| **📡 Real-time events (v1.3.0)** | Server-Sent Events (`/api/events`) push new CSAT ratings, sync completions and webhook-driven conversation updates the moment they land; a lightweight ratings watcher decoupled from full sync feeds it; dashboards and toasts react without polling |
| **🪝 Webhook push (v1.4.0)** | Register/unregister conversation webhooks from Sync Health; events arrive HMAC-verified, deduped, persisted-first and pushed through the job pipeline within seconds — with real-time `conversation-updated` SSE events, restart draining of unprocessed events, and a demo simulator that exercises the exact production path |
| **🔎 Semantic docs search (v1.4.0)** | Hybrid retrieval over the Docs mirror: FTS5 + vector similarity fused with Reciprocal Rank Fusion; embeddings stored locally (works without Qdrant, faster with it); per-hit provenance and honest mode notes; graceful degradation at every layer |
| **⏱️ SLA & business hours (v1.4.0)** | Per-mailbox schedules (IANA timezone, weekdays, window) + first-response/resolution targets; reports measure wall AND business minutes (DST-safe via the platform tz database), met/missed classification, and live waiting-age risk |
| **🚨 SLA alerts (v1.5.0)** | Business-hours-aware breach detection on the Issue Radar: conversations aged in business minutes since their last customer message against first-response/resolution targets, breached and at-risk (≥80%) states, per-mailbox rollups, honest unconfigured labels |
| **📣 Client Segmentation & Outreach (v1.5.0)** | Contact-first segment engine (properties / contact fields / conversation-level tag ALL-ANY-NONE / support history) with why-selected evidence per customer, saved versioned segments, recipient review, personalization preview, individual Help Scout conversations per customer through the rate-limited queue, per-recipient lifecycle with timeout reconciliation and duplicate-send protection, Do-Not-Contact list, full audit trail and reply intelligence |
| **🧮 Ticket vector search (v1.5.0)** | Hybrid FTS5 + semantic search over tickets and thread text (Reciprocal Rank Fusion): chunked conversations embedded locally, Qdrant as optional accelerator, per-hit provenance (keyword / semantic / both) and honest mode notes |
| **🔐 Encrypted sync (v1.5.0)** | Optional multi-device sync via end-to-end encrypted `.sosync` bundles (AES-256-GCM + scrypt): export with a passphrase, import with integrity + schema checks and an automatic safety backup — no relay server exists by design |
| **🕰️ Activity engine (v1.7.0)** | A normalized conversation event log derived from the mirror — messages, notes, lineitem action records, observed changes, local writes — deduplicated with stable keys and honestly sourced (`rebuild`/`sync`/`local`); 14 derived activity timestamps per conversation (first response, waiting-since, last status/tag/field change…), recomputed transactionally on every upsert and backfilled in SQL at upgrade; a chronological timeline endpoint and an idempotent global rebuild |
| **🎯 Response states & ages (v1.7.0)** | Deterministic classification — Needs First Response / Customer Waiting / Agent Waiting / Recently Responded / Never Responded / Closed / Snoozed / Unknown (unknown = honest, when history is incomplete) — one SQL CASE shared by list, views and detail; waiting/response/resolution ages in exact minutes and human form, filterable and sortable |
| **📅 Inbox date/activity filters (v1.7.0)** | 14 activity fields × 15 date modes (calendar-day modes DST-safe in your IANA timezone, rolling windows exact, labeled distinctly) with optional time-of-day bounds; all filter state lives in the URL |
| **💾 Saved Inbox Views (v1.7.0)** | Structured condition trees (AND/OR groups, 22 condition kinds incl. SLA state, interaction signals and the AI-attribute condition added in v1.9.0), compiled to parameterized SQL at open time — "today" means the day it's opened; save-time compile checks, dry-run preview, versioned definitions; deliberately separate from Outreach segments |
| **🚩 Priority & custom ticket states (v1.7.0)** | Local SupportOS priority (None→Urgent; optional, off-by-default Help Scout custom-field mapping) and a configurable state layer (6 seeded defaults + your own) with per-transition history (actor, reason, timestamps), per-state lifecycle metrics and bottleneck ranking — layered on Help Scout status, never replacing it |
| **🖥️ Operations Center (v1.8.0)** | 16 live operational tiles (unassigned, needs first response, customer waiting, waiting-over-threshold, urgent, SLA at risk/breached, high customer effort, repeated issue, known issue, AI escalation, issue spike, automation approvals, failed jobs, sync problems, campaign activity), mailbox-scoped, honest per-tile measurement notes, live over SSE — conversation tiles and their drill-down lists share ONE SQL fragment so they can never disagree |
| **👥 Team workload & capacity (v1.8.0)** | Per-agent/per-team open, pending, waiting, urgent and SLA-risk workload with tiered weighted pressure; explicit configurable capacity model (default max + per-user overrides + weights — never inferred from anything about a person); Help Scout-synced availability; 7-day average active load (honestly labeled an approximation); read-only suggested assignees with exposed reasoning — nothing ever reassigns automatically |
| **🔔 Notification Center (v1.8.0)** | 15 notification types produced by one idempotent sweep (v2.0.0 adds incident updates) (customer replies, assignments, @mentions, SLA risk/breach, automation approvals, AI escalations, known issues, issue spikes, campaign replies, sync/job failures, customer events) with targeting, per-type preferences, unread badge live over SSE, mark read/all-read, source links, and retention pruning |
| **💬 Mentions & side threads (v1.8.0)** | `@agent` / `@team` mentions in internal notes and side threads with @autocomplete and exact identity matching (never guessed); mentions-for-me queue linking back to conversations; internal-only side collaboration threads per conversation (participants, messages, mentions, resolve/reopen, full audit history) — never customer-visible, never synced to Help Scout |
| **🚨 Incident workspace (v2.0.0)** | First-class master issues with generated INC codes, status/severity/owner, internal vs customer-safe explanations, engineering refs, releases, notes and an append-only timeline; conversations link to incidents (one issue → many tickets) and the Inbox shows an active-incident chip; affected customers/organizations are derived from links, never stored; declare from a known issue or cluster in one action |
| **📊 Issue impact intelligence (v2.0.0)** | Per-incident AND per-known-issue impact: affected conversations, DISTINCT customers and organizations (never ticket counts), first/last seen, 7-day growth and trend, affected inboxes, top tags, products from the attribute layer, open/closed split, waiting count; release correlations are temporal associations only |
| **🧭 Extended Issue Radar (v2.0.0)** | Six new detections — reappearing issues, customer concentration, inbox concentration, release-correlation bursts, repeated unresolved patterns, unusual global volume — each with evidence conversation links and association-only wording |
| **📦 Custom objects (v2.0.0)** | Define your own typed records (Account, Deployment, Subscription…) with validated fields (select/number/date/boolean/text), relationship edges to customers, organizations, conversations, issues, incidents and campaigns, FTS search and per-type reporting — values are JSON validated at every write; user data never becomes SQL |
| **🔌 Local data connectors (v2.0.0)** | Approved sources: local JSON, CSV, SQLite files and HTTP endpoints with snapshot-semantics refresh (stable keys, pruned vanished rows, honest health), inferred schemas, redacted auth, interval or manual refresh — and a fail-closed SSRF guard (private networks, localhost, cloud metadata refused, DNS re-checked). The Copilot sees connector data only where explicitly allowed |
| **🕒 Customer event timeline (v2.0.0)** | An append-only, dedup-keyed local event log per customer: signups, conversations, first messages, campaign sends/replies, ratings, incident exposure and linked records; kinds without an observable source stay honestly absent; organizations get the union view; a rebuild action re-derives history idempotently |
| **🩺 Support health (v2.0.0)** | Operational facts with definitions and evidence links — waiting, volume, unresolved known issues, incident exposure, response delays, escalation history, effort proxy — plus attention flags; no aggregate score and no psychological judgments, by design |
| **📚 Knowledge freshness (v2.0.0)** | Lifecycle observability for the knowledge base: created/updated/last reviewed/last verified/version/usage plus flags for stale content, review gaps, conflict candidates, low usage, articles followed by tickets and articles tied to recurring questions; Review/Verify are human-only timestamps — nothing is published automatically |
| **🕳️ Knowledge gap engine (v2.1.0)** | Five deterministic detections — repeated uncovered questions, questions existing docs failed to solve, conflicting document pairs, missing troubleshooting steps, undocumented new issues — become evidence-backed candidates; human approve/reject survives rebuilds; drafting returns an outline for a human author; nothing auto-publishes |
| **✅ Post-resolution QA (v2.1.0)** | After-close QA per conversation: a deterministic tier (back-and-forth, repeated information with thread evidence, handoffs, post-close messages, timing) plus an optional local-model tier (answered? evidence-supported? right issue?) under its own ai_runs type — strictly separate from pre-send draft verification |
| **📈 Response effectiveness (v2.1.0)** | Observed associations between response style and outcomes (follow-up, clarification, resolution, effort, ratings) with sample conversations; association-only wording is structural, small buckets say so |
| **🧩 Friction detection (v2.1.0)** | Six evidence-pinned detections — repeated customer explanations, repeated agent questions, troubleshooting loops, repeated handoffs, repeated unresolved interactions, duplicated information requests — every finding cites thread ids and excerpts; patterns, never judgments about people |
| **🌍 Local translation (v2.1.0)** | Deterministic language detection (script ranges + function words, honest unknowns) and LM Studio-only translation with content-hash caching, verbatim technical terms, side-by-side review — no cloud fallback, nothing sent automatically |
| **🎯 Advanced segmentation (v2.1.0)** | Seven new condition families (organization data/properties, ticket custom fields + channel, waiting history, previous issues, incident exposure, campaign history, support health, custom objects, timeline events) + natural-language suggestion where the model proposes and the deterministic engine selects |
| **📊 Custom report builder (v2.1.0)** | 20 local metrics × 14 dimensions compiled from closed catalogs with filters, date ranges, previous-period comparison, bar/table output and saved definitions — every metric ships its definition and limitations in the response |
| **🕸️ Support graph (v2.2.0)** | A relationship layer over twelve node kinds (customers, orgs, conversations, issues, incidents, knowledge, agents, campaigns, products, custom objects, connector rows) — derived edges computed live from the mirror (zero drift, provenance on every edge), products registry derived INSERT-OR-IGNORE, human-asserted edges as the only persisted relationships, bounded subgraph exploration, and a Graph Explorer page |
| **🎓 Pre-send agent coaching (v2.2.0)** | The plan's ten checks in the composer — nine deterministic (unanswered/duplicated questions, timeframe-vs-active-incident, missing acknowledgment, wording, detail, verbatim internal-leakage spans, wrong-customer context, preference mismatch) + two local-model checks under their own ai_runs type — advisory-only by construction: nothing ever blocks the send; the last review persists as an audit trail |
| **🧠 Customer support memory (v2.2.0)** | Read-time composition from the tables that already hold each fact (issue history, resolutions, preferences, patterns, campaigns, account facts) — every entry with source/timestamp/confidence/freshness/evidence; human-written entries are the only persisted rows; AI rows immutable; psychological/personality judgments refused on write and quarantined on read |
| **⚡ Performance guards (v2.2.0)** | Bounded hot paths, COUNT-guarded interaction backfill, targeted indexes — plus the project's first performance regression guards: a synthetic 2,000-conversation world with CI-safe budgets and deterministic EXPLAIN QUERY PLAN index assertions |
| **🤝 Local Copilot (v1.9.0)** | Interactive read-only assistant in every conversation's context pane: ask *What is this customer asking? Have we seen this before? What solved previous cases? Why is this urgent?* — answered through an allowlisted read-only tool registry (conversation context, customer history, similar tickets, knowledge, known issues, issue clusters, AI analyses, SupportOS metadata, attributes), with machine-generated citations from the tools the server actually executed, a hard-bounded tool loop, persisted sessions, and honest unavailability when AI is off |
| **🏷️ AI attribute layer (v1.9.0)** | First-class local attributes per conversation — intent, product, feature, issue, urgency, frustration cues, technical familiarity, customer goal, question count, risk, known issue, issue cluster, response style, escalation signal — in two layers: deterministic (zero AI, always available) and AI (evidence excerpts + enum-closed values or not stored). Versioned snapshots, honest unknowns, live inbox filtering (same compiled path as saved views), Outreach segment conditions, AI Center coverage report with drill-downs, per-ticket snapshot card with recompute |
| **⚡ AI escalation rules (v1.9.0)** | Automation conditions on `ai_attribute` (closed 14-key catalog) and `ai_verification` (`failed`/`passed`/`none`); operator semantics follow value types; a missing attribute matches `equals unknown` and nothing else; conditions only decide matches — every action flows through the existing approval tiers, nothing customer-facing ever happens silently |
| **🧊 Audit-hardened input & state (v1.6.0)** | Every route validates its inputs (no more 500s on `?page=abc`, missing bodies, numeric fields or multi-MB queries); rate limiting keyed on the socket address (spoofable headers can't buy budget); incremental sync now covers organizations + property definitions; ISO-vs-SQLite date comparisons normalized everywhere; embeddings survive unchanged re-syncs (content-hash gated); backups honor their configured interval and prune themselves; failed embedding chunks stop retrying after 5 attempts; approval actions park until a human approves them; every client query failure is a visible error state and every mutation failure is a toast |
| **📊 Multi-mailbox dashboards (v1.3.0)** | Scope every dashboard metric by any combination of mailboxes and channel; per-mailbox comparison rows (new/active/closed/backlog/first-response/resolution/ratings) — same deterministic SQL as single-mailbox views |
| **📦 Desktop installers (v1.3.0)** | MSI, NSIS, universal DMG and AppImage built in CI with the Node runtime + SQLite bundled — no prerequisites; or build your own with `npm run desktop:build` |
| **🎧 Support inbox** | 3-pane workspace: views, filters, bulk actions, sanitized HTML threads, customer + AI context panes, rich composer (reply / note / draft / cc / bcc / status-after-send / saved replies / AI draft insertion) |
| ✅ **Ticket operations** | Reply, drafts, internal notes, status, assignment, inbox moves, subject edits, merge-safe tags, custom fields (system-field-safe), snooze, scheduled replies, attachments, workflow runs, "Open in Help Scout" links — every write audited and duplicate-protected |
| **🔍 Universal search** | SQLite FTS5 across tickets, thread text, customers, knowledge, known issues, saved replies and AI analyses — filters (status/inbox/tag/date), exact ticket-number lookup, optional semantic search via local Qdrant |
| **🤖 Local AI** | Ticket analysis (intent, questions, urgency, sentiment), evidence-backed verified reply drafts, a verification pass (unsupported claims / missing questions / internal leakage), rewrites, customer memory, issue clustering, report narratives — versioned, cached, audited, always labeled AI-generated |
| **🧠 Client Interaction Intelligence** | Per-client communication behavior: current signals (urgency/frustration/directness/detail/technical, evidence-linked), recency-weighted historical baseline, "today vs normal" change detection, support-approach recommendations, observed preferences with human overrides, support outcomes + effort score, repeat-client playbooks — observable behavior only, never personality claims |
| **🚨 Issue Radar** | New/rising/recurring issue clusters with linked tickets, known issues (customer-safe vs internal explanations, engineering refs), doc-gap detection, answer-reuse candidates, "why are customers contacting us" |
| **📊 Reports** | Local analytics (with metric definitions and honest limitations), Help Scout native report import (labeled), AI narratives (labeled AI-derived), release correlation that never claims causation |
| **⚙️ Automation** | Local rules engine separated from Help Scout workflows; read / non-destructive / higher-risk action tiers; higher-risk actions always require human approval |
| **🛡️ Ops & safety** | Sync Health screen, background job queues, audit log, verified backups + restore, CSV/JSON export, capability matrix, first-run wizard, dark/light theme, keyboard shortcuts, command palette (⌘K) |

---

## 🔒 Safety & trust by design

Built for teams whose tickets contain **payment data, credentials and personal data**:

- 🔒 **Automatic reply sending is permanently OFF** — AI drafts always require explicit human review and a human send action
- 🔒 **Local-first networking** — the server binds to `127.0.0.1` by default and warns loudly before binding elsewhere; CORS is localhost-only
- 🔒 **Secrets stay server-side** — OAuth tokens live in the local database, never exposed to the browser; nothing sensitive is hard-coded
- 🔒 **Redaction before AI** — payment data, tokens and API keys are scrubbed from every prompt and log line
- 🔒 **Sanitized rendering** — untrusted ticket HTML is stripped of scripts, event handlers and `javascript:` URLs before render
- 🔒 **Verified webhooks** — HMAC-SHA1 timing-safe signature checks, persist-first processing, hash deduplication
- 🔒 **Write-protection pipeline** — every remote mutation: validate → auth → fresh-read → merge → write → confirm → persist → audit
- 🔒 **Internal knowledge stays internal** — internal-only knowledge never enters customer-facing AI drafts
- 🔒 **AI evaluation mode stops EVERY remote write** — replies, notes, status changes, assignments, tags, fields, moves, snoozes, schedules, workflows and bulk actions are all blocked while you trial AI features
- 🔒 **Connectors are SSRF-guarded, fail-closed (v2.0.0)** — HTTP data sources refuse private networks, localhost, cloud metadata endpoints, IPv4-mapped and numeric-encoded addresses, and re-check DNS resolution before every request; connector auth material is always redacted in reads
- 🔒 **AI sees connector data only where you explicitly allow it (v2.0.0)** — each connector carries an explicit AI-visibility switch; the Local Copilot's connector tool refuses anything not switched on and tells you what is
- 🔒 **No psychological or personal judgments (v2.0.0)** — support health is operational facts with evidence links and deliberately has no aggregate score; the timeline records events, never assessments of people
- 🔒 **The personality red line is enforced in code (v2.2.0)** — psychological/personality-shaped memory is refused on write (422 with the policy message) and quarantined on read (excluded from usable memory, listed with a reason, purgeable); the pattern list is closed and deterministic
- 🔒 **Coaching never gates the send (v2.2.0)** — pre-send coaching is advisory-only by construction: no code path disables, delays or annotates the send button; the review persists as an audit trail of what the agent was told
- 🔒 **Graph edges carry provenance (v2.2.0)** — every relationship says whether it is a Help Scout mirror fact, a deterministic derivation, AI-derived evidence or a human assertion; connector rows disclose that they have no derived links
- 🔒 **Independently audited (v1.2.0, v1.5.0, v1.6.0, v1.7.0, v1.8.0, v1.9.0, v2.0.0, v2.1.0, v2.2.0, v2.2.1)** — every write path reviewed line-by-line plus black-box runtime testing; the v1.6.0 audit added three adversarial layer-by-layer passes (server core / data & sync / client) and a human-like usage pass; later audits extended the black-box suite with activity-engine, collaboration-layer, intelligence-layer, workspace and quality probes (hostile filters, hostile view definitions, injection-shaped payloads, mention-token identity guessing, SSRF-shaped connector targets, custom-object SQL injection shapes); **the v2.2.1 audit re-examined the entire project from scratch, fixed 45 confirmed defects in existing functionality without adding a single feature, and added a DNS-rebinding Host guard** (452 checks, 0 HIGH / 0 MEDIUM); each confirmed finding is fixed and covered by a named regression test

The full model is documented in [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 🏗️ Architecture

```
React 19 + Vite + TypeScript  ──►  Fastify 5 (TypeScript)  ──►  SQLite (WAL + FTS5)
        (dist/client)                      │                          │
                                          │                     repositories
        LM Studio (local AI) ◄────────────┤                          │
        Qdrant (local vectors) ◄──────────┤                     job queues
                                          ▼
                              HelpScoutProvider interface
                       ┌────────────────────┴──────────────────┐
             RealHelpScoutProvider                        FakeHelpScoutProvider
        (OAuth2 + v3 reads / v2 writes,                (deterministic simulator for
         rate-limited priority queue)                   demo mode + entire test suite)
```

A **modular monolith**: one Node process, one SQLite database, background workers. No microservices, no cloud dependencies, nothing to pay for at scale — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Tech stack:** React 19 · TypeScript (strict) · Fastify 5 · SQLite (WAL + FTS5) · Zod · TanStack Query · Zustand · Vite · Vitest · optional LM Studio / Qdrant / Tauri

---

## 🤔 FAQ

<details>
<summary><b>Who is SupportOS for?</b></summary>

Support teams (solo agents through mid-size departments) using **Help Scout** who want faster search, support analytics and AI assistance **without sending customer data to a cloud AI vendor**. Also great for privacy-regulated environments (GDPR, HIPAA-adjacent, finance) where "no data leaves the machine" is a requirement, not a preference.
</details>

<details>
<summary><b>Does it replace Help Scout?</b></summary>

No — it complements it. Help Scout remains the authoritative mailbox (agents can keep using Help Scout's own UI and mobile app). SupportOS mirrors it locally and adds an intelligence + speed layer. Every write goes back through Help Scout's official API with duplicate protection and full auditing.
</details>

<details>
<summary><b>Is my customer data really never sent to the cloud?</b></summary>

Yes. Sync traffic goes only to Help Scout (your own mailbox). AI runs against **LM Studio on your machine** — no OpenAI, no hosted inference. Semantic search (optional) runs against a **local Qdrant** instance. There is no telemetry, analytics beacon or crash reporter in SupportOS.
</details>

<details>
<summary><b>What if LM Studio / Qdrant aren't running?</b></summary>

The app is fully useful without AI: search, analytics, issue radar (keyword-based), ticket operations and reports all work — LM Studio integration degrades gracefully and says so honestly in the AI Center and capability matrix. Client Interaction Intelligence also has a deterministic engine that works entirely without AI (the AI stages only enrich signals and recommendations).
</details>

<details>
<summary><b>Does Client Interaction Intelligence profile people psychologically?</b></summary>

No — by design and by enforcement. It reports **observable support-communication behavior only** (tone, directness, detail, technical language, urgency/frustration cues), drawn from a fixed vocabulary so personality labels are structurally impossible. Every significant observation carries evidence and confidence; one angry email never becomes a permanent label (repeated evidence across 3+ interactions is required for a preference, and human overrides always win). See [docs/CLIENT-INTELLIGENCE.md](docs/CLIENT-INTELLIGENCE.md).
</details>

<details>
<summary><b>How is this tested?</b></summary>

Automated tests (unit / integration / e2e) — grown to **672** across the releases (most recently +53 with v2.2.0's graph/coaching/memory/perf suites and +25 with v2.2.1's audit regression locks) — run in CI on every push: lint, strict typecheck (including the config files), full suite, production build and a real demo-mode boot smoke test. On top of the automated suite, each release since v1.2.0 ships after an audit that deliberately avoids the project's own tests: v2.2.1's audit re-examined the ENTIRE project from scratch in four adversarial passes plus a **human-like browser pass**, fixing 45 confirmed defects with zero new features, and its 452-check black-box script (`scripts/audit-phase1.mjs`) is in the repo so you can re-run it against your own instance. The test suite is architected so **no test can ever send a real message** — see [docs/TESTING.md](docs/TESTING.md).
</details>

<details>
<summary><b>Can I use it offline?</b></summary>

Yes for everything local: the mirror, search, analytics, knowledge base and previously generated AI outputs all work offline. Sync and new remote writes naturally need connectivity to Help Scout.
</details>

---

## 🗺️ Roadmap

- [x] v1.0.0 — local mirror, inbox workspace, FTS5 search, local AI pipeline, Issue Radar, reports, automation, backups, 108-test CI ([changelog](CHANGELOG.md))
- [x] v1.1.0 — Client Interaction Intelligence: current-vs-normal change detection, evidence-linked signals, support approaches, human overrides, playbooks, effort/friction metrics
- [x] v1.2.0 — the hardening release: full independent audit, 40+ fixes (security, data integrity, correctness), 150-test CI with named regression tests ([changelog](CHANGELOG.md))
- [x] v1.3.0 — Help Scout **Chat / Docs / Beacon** API coverage, **real-time ratings refresh (SSE)**, **multi-mailbox dashboards**, **packaged desktop installers (MSI / DMG / AppImage)** ([changelog](CHANGELOG.md))
- [x] v1.4.0 — **incoming webhook push for conversations** (register from the app, real-time SSE updates, restart drain), **semantic docs search** (local embeddings + optional Qdrant, hybrid RRF), **per-mailbox SLA / business-hours reporting** — plus two latent job-pipeline bugs found and fixed ([changelog](CHANGELOG.md))
- [x] v1.5.0 — **Client Segmentation & Outreach** (contact-first segments, explainable selection, individual campaign conversations with full audit), **vector search over tickets/threads**, **business-hours-aware SLA alerts on the Issue Radar**, **optional end-to-end encrypted sync for multi-device** — plus a fresh independent audit that found and fixed 7 real bugs ([changelog](CHANGELOG.md))
- [x] v1.6.0 — **the hardening release**: a second full neutral audit in three adversarial passes (server core / data & sync / client) plus a human-like usage pass; 2 HIGH + 28 MEDIUM findings fixed with regression coverage — the dead webhook-push client UX, an outreach send-queue livelock, embedding churn, the ISO-vs-SQLite date-comparison species, incremental-sync coverage gaps, unvalidated-input crashes, silent client failure modes ([changelog](CHANGELOG.md))
- [x] v1.7.0 — **the activity-intelligence release**: a conversation event history derived honestly from the mirror (Help Scout exposes no change log — observations are labeled as observations), 14 derived activity timestamps, deterministic response states, DST-safe date & activity filters, saved Inbox Views as structured condition trees compiled at open time, local ticket priority and configurable custom ticket states with transition history and lifecycle metrics ([changelog](CHANGELOG.md))
- [x] v1.8.0 — **the collaboration release**: a live Operations Center (16 tiles, drill-down parity by construction), the workload & capacity engine with read-only suggested assignees, a persistent Notification Center driven by one idempotent sweep, exact-match @mentions with autocomplete, and internal-only side collaboration threads ([changelog](CHANGELOG.md))
- [x] v1.9.0 — **the intelligence release**: an interactive read-only Local Copilot with machine-generated citations, a versioned two-layer AI attribute layer (deterministic + evidence-backed AI, honest unknowns) filterable/reportable/searchable everywhere, and AI escalation rules that decide matches while approvals decide actions ([changelog](CHANGELOG.md))
- [x] v2.0.0 — **the workspace release**: a first-class incident/master-issue workspace with derived impact intelligence and declare-from-cluster/known-issue actions, six new Issue Radar detections (association wording only), a local custom object system with typed fields and relationship edges, an SSRF-guarded local data connector framework with an explicit AI-visibility gate, an honest customer event timeline, operational support health (facts + evidence, no score), and knowledge freshness with human-only review/verify stamps ([changelog](CHANGELOG.md))
- [x] v2.1.0 — **the quality release**: a knowledge gap engine with human-approved candidates, post-resolution QA (deterministic + optional local-model tier), response effectiveness as association-only reporting, six evidence-pinned friction detections, local-only translation with side-by-side review, advanced contact segmentation with NL suggestion (model proposes, engine selects), outreach audience enhancements, and a custom report builder where every metric ships its definition ([changelog](CHANGELOG.md))
- [x] v2.2.0 — **the memory release (roadmap complete)**: a support graph over twelve node kinds with read-time derived edges and human-asserted edges only, advisory-only pre-send agent coaching (ten evidence-based checks, nothing blocks the send), read-time customer support memory with the personality red line enforced in code, and the performance polish pass with the project's first perf regression guards ([changelog](CHANGELOG.md))
- [x] v2.2.1 — **the polish release**: a completely fresh, independent audit of the entire project (four adversarial passes + a human-like browser pass, none trusting the existing test suite) found and fixed 45 confirmed defects in existing functionality — data correctness, dead UI controls, reliability, validation and documentation — with zero new features; every fix carries a regression lock (672/672 tests, 452 audit checks, 0 HIGH / 0 MEDIUM) ([changelog](CHANGELOG.md))

Ideas and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📚 Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, provenance model |
| [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) | Verified Help Scout v2/v3 API usage (incl. Chat/Docs/Beacon coverage), capability matrix, known limitations |
| [docs/AI-SETUP.md](docs/AI-SETUP.md) | LM Studio + Qdrant setup and the AI pipeline |
| [docs/CLIENT-INTELLIGENCE.md](docs/CLIENT-INTELLIGENCE.md) | Client Interaction Intelligence: design, safety model, API |
| [docs/DESKTOP.md](docs/DESKTOP.md) | Desktop packaging: installers, the bundled-runtime design, building your own |
| [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) | Windows installation incl. Tauri desktop build |
| [docs/LOCAL-RUN.md](docs/LOCAL-RUN.md) | Everyday running (dev, production, demo) |
| [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) | Backups, restore, CSV/JSON export |
| [docs/TESTING.md](docs/TESTING.md) | Test philosophy and quality gates |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems and fixes |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## 🤝 Contributing & support

- **Bug reports and feature requests:** [open an issue](https://github.com/kimpearce888/supportos/issues) — please include steps to reproduce (demo mode repros are gold)
- **Pull requests:** welcome! Run the [quality gates](CONTRIBUTING.md) first (`lint`, `typecheck`, `test:all`, `build`) — CI enforces them
- **Security reports:** see [SECURITY.md](SECURITY.md) — please use private vulnerability reporting rather than public issues

---

## ⭐ Show your support

If SupportOS saves your team time, consider **starring the repository** — it helps other support teams find a privacy-first option. Feedback from real support workflows is what shapes the roadmap.

---

## 📄 License

Released under the [MIT License](LICENSE).

*Help Scout is a trademark of Help Scout, Inc. SupportOS is an independent, open-source integration and is not affiliated with or endorsed by Help Scout.*
