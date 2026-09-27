<div align="center">

# 🎧 SupportOS

### The local-first, AI-powered support operating system for your Help Scout mailbox

**Fast support tooling with a privacy guarantee: your customer data never leaves your machine.**

[![CI](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-224%2F224-brightgreen)](docs/TESTING.md)
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
- **🔬 Audited, not assumed** — v1.2.0 shipped after a full independent audit; v1.3.0 extends the same evidence-first discipline to channels, docs and real-time updates

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
| 10 | **A fake Help Scout provider as the test backbone** | The entire 172-test suite runs against a deterministic simulated mailbox. It is architecturally impossible for a test to email a real customer — the provider interface simply has no path to production credentials. |
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

**Webhook push — register conversation webhooks and watch events land in real time (with demo buttons that exercise the exact production pipeline)**

[![SupportOS webhook push registration](docs/screenshots/v140-webhook-push.png)](docs/screenshots/v140-webhook-push.png)

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
- 🔒 **Independently audited (v1.2.0)** — every write path reviewed line-by-line plus black-box runtime testing; each confirmed finding is fixed and covered by a named regression test

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

172 automated tests (unit / integration / e2e) — grown to **224** with the v1.4.0 webhook-push, semantic-docs-search and SLA coverage — run in CI on every push: lint, strict typecheck, full suite, production build and a real demo-mode boot smoke test. The v1.4.0 additions include the full webhook pipeline over the wire (HMAC self-POST → dedup → job → sync → SSE), regression tests for two latent job-queue bugs, and the DST-safe business-hours engine. The test suite is architected so **no test can ever send a real message** — see [docs/TESTING.md](docs/TESTING.md).
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
- [ ] Vector search over tickets/threads (the retrieval layer exists; chunking + job wiring to come)
- [ ] Business-hours-aware SLA alerts on the Issue Radar
- [ ] Optional end-to-end encrypted sync for multi-device use

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
