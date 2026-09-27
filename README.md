<div align="center">

# 🎧 SupportOS

### The local-first, AI-powered support operating system for your Help Scout mailbox

**Fast support tooling with a privacy guarantee: your customer data never leaves your machine.**

[![CI](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-344%2F344-brightgreen)](docs/TESTING.md)
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
- **📡 Real-time by default** — new CSAT ratings *and* webhook-pushed conversation changes arrive over Server-Sent Events the moment they land; dashboards and the inbox update without polling or refresh
- **🎧 Every channel, one inbox** — email and Beacon chat sessions live side by side, filterable by channel, with honest chat-vs-email speed analytics
- **📚 Your Docs, mirrored — and semantically searchable** — Help Scout Docs synced locally, searched with hybrid keyword + vector retrieval (local embeddings, optional Qdrant)
- **⏱️ SLA reporting in business minutes** — per-mailbox schedules (timezones, weekdays, targets) make first-response and resolution times mean what customers actually experience
- **🤖 Local AI assistance** — ticket analysis, evidence-backed reply drafts, issue clustering and report narratives via [LM Studio](https://lmstudio.ai) on your own hardware. **No OpenAI. No cloud. No data leakage.**
- **🧠 Client Interaction Intelligence** — knows how each client *normally* communicates and flags when today's ticket is different (urgency ↑, detail ↓), with an evidence-backed support approach and per-client playbook. Behavior, never psychology.
- **📦 Desktop installers** — MSI, DMG and AppImage with the Node runtime and SQLite bundled in: install and run, no prerequisites
- **🛡️ Privacy by architecture** — support tickets contain payment details, personal data and secrets. SupportOS keeps them local-first, GDPR-friendly and audit-logged
- **🔬 Support intelligence** — Issue Radar surfaces emerging problems before they become incidents; answer-reuse shows which tickets could have been deflected by docs
- **✍️ Human in command** — AI never sends a customer reply. Every remote write is validated, merged, confirmed and audited
- **🔬 Audited, not assumed** — v1.2.0 and v1.5.0 shipped after full independent audits; **v1.6.0 is the audit release**: three adversarial passes (server core, data/sync layer, client) plus a human-like usage pass found 2 HIGH + 28 MEDIUM issues — all fixed, each locked by a named regression test

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
| 10 | **A fake Help Scout provider as the test backbone** | The entire 288-test suite runs against a deterministic simulated mailbox. It is architecturally impossible for a test to email a real customer — the provider interface simply has no path to production credentials. |
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

### 🆕 v1.7.0 — the activity-intelligence release: event histories, saved views, priorities & states

**Inbox with date/activity filters, response states and waiting ages — every conversation row now shows its deterministic response state (Needs First Response / Customer Waiting / …), local priority and how long the customer has been waiting; the filter bar combines 14 activity fields × 16 date modes (DST-safe in your timezone) with response-state, priority and ticket-state filters, sortable by waiting duration**

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
cp .env.example .env        # LOCAL_DEMO_MODE=true → no Help Scout account needed
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
| **📅 Inbox date/activity filters (v1.7.0)** | 14 activity fields × 16 date modes (calendar-day modes DST-safe in your IANA timezone, rolling windows exact, labeled distinctly) with optional time-of-day bounds; all filter state lives in the URL |
| **💾 Saved Inbox Views (v1.7.0)** | Structured condition trees (AND/OR groups, 21 condition kinds incl. SLA state and interaction signals), compiled to parameterized SQL at open time — "today" means the day it's opened; save-time compile checks, dry-run preview, versioned definitions; deliberately separate from Outreach segments |
| **🚩 Priority & custom ticket states (v1.7.0)** | Local SupportOS priority (None→Urgent; optional, off-by-default Help Scout custom-field mapping) and a configurable state layer (6 seeded defaults + your own) with per-transition history (actor, reason, timestamps), per-state lifecycle metrics and bottleneck ranking — layered on Help Scout status, never replacing it |
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
- 🔒 **Independently audited (v1.2.0, v1.5.0, v1.6.0, v1.7.0)** — every write path reviewed line-by-line plus black-box runtime testing; the v1.6.0 audit added three adversarial layer-by-layer passes (server core / data & sync / client) and a human-like usage pass; the v1.7.0 audit extended the black-box suite with activity-engine probes (hostile filters, hostile view definitions, injection-shaped payloads — 335 checks, 0 HIGH/0 MEDIUM); each confirmed finding is fixed and covered by a named regression test

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

Automated tests (unit / integration / e2e) — grown to **288** with the v1.4.0 webhook-push/semantic-docs/SLA coverage, the v1.5.0 outreach, ticket-vector, SLA-alert, encrypted-sync and audit coverage, and the v1.6.0 audit-hardening suite (29 new tests: the outreach livelock, embedding-churn hash gating, approval-job parking, monotonic local tag ids, incremental-sync coverage, the SSE write-behind notification over the wire, and clean-response probes for every crash input the audit found) — run in CI on every push: lint, strict typecheck, full suite, production build and a real demo-mode boot smoke test. On top of the automated suite, each release since v1.2.0 ships after an audit that deliberately avoids the project's own tests: v1.6.0's audit ran three adversarial passes over the codebase plus a **human-like browser pass**, and its 320-check black-box script (`scripts/audit-phase1.mjs`) is in the repo so you can re-run it against your own instance. The test suite is architected so **no test can ever send a real message** — see [docs/TESTING.md](docs/TESTING.md).
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
- [ ] v1.8.0+ — Operations Center, workload/capacity engine, Notification Center, mentions and side collaboration threads
- [ ] v1.9.0+ — Local Copilot over the read-only tool registry, versioned AI attributes, AI-driven escalation rules
- [ ] v2.0.0+ — incident/master-issue workspace, custom objects, local data connectors, customer event timeline, knowledge freshness, post-resolution QA

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
