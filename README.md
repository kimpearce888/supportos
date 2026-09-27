<div align="center">

# 🎧 SupportOS

### The local-first, AI-powered support operating system for your Help Scout mailbox

**Fast support tooling with a privacy guarantee: your customer data never leaves your machine.**

[![CI](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-108%2F108-brightgreen)](docs/TESTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.base.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](docs/LOCAL-RUN.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4)](CONTRIBUTING.md)

[What is SupportOS?](#-what-is-supportos) · [Screenshots](#-see-it-in-action) · [2-Minute Demo](#-try-it-in-2-minutes-no-credentials-needed) · [Features](#-features) · [Safety Model](#-safety--trust-by-design) · [Docs](#-documentation)

</div>

---

## 🧭 What is SupportOS?

SupportOS is a **self-hosted help desk companion and support intelligence platform**. It mirrors your Help Scout inbox into a local SQLite database on your own machine and layers a professional support workspace on top:

- **⚡ Instant everything** — search your entire local archive in milliseconds with local full-text search; no API round-trips, no rate limits, no spinners
- **🤖 Local AI assistance** — ticket analysis, evidence-backed reply drafts, issue clustering and report narratives via [LM Studio](https://lmstudio.ai) on your own hardware. **No OpenAI. No cloud. No data leakage.**
- **🛡️ Privacy by architecture** — support tickets contain payment details, personal data and secrets. SupportOS keeps them local-first, GDPR-friendly and audit-logged
- **🔬 Support intelligence** — Issue Radar surfaces emerging problems before they become incidents; answer-reuse shows which tickets could have been deflected by docs
- **✍️ Human in command** — AI never sends a customer reply. Every remote write is validated, merged, confirmed and audited

> **Help Scout stays the source of truth.** SupportOS is a local mirror + intelligence layer — it reads your mailbox and writes back through Help Scout's official API with full write protection. Your team can keep using Help Scout (and its mobile app) exactly as before.

---

## 📸 See it in action

All screenshots are the **real application** running in demo mode (simulated mailbox) — clone the repo and you'll see exactly this, in under two minutes.

### 📥 Support workspace

**Dashboard — volume, response times and backlog at a glance, with per-metric definitions and provenance labels**

[![SupportOS dashboard: support KPIs and trends](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png)

**Inbox — 3-pane workspace: views and filters, sanitized thread view, customer + AI context panes**

[![SupportOS inbox: 3-pane support ticket workspace](docs/screenshots/inbox.png)](docs/screenshots/inbox.png)

**Conversation — thread view with customer history, AI context pane and rich composer (reply / note / saved replies / AI draft insertion)**

[![SupportOS conversation view with AI context](docs/screenshots/conversation.png)](docs/screenshots/conversation.png)

**Search — one query across tickets, threads, customers, knowledge, known issues and AI analyses, with match explanations**

[![SupportOS universal support search](docs/screenshots/search.png)](docs/screenshots/search.png)

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

Demo mode spins up a simulated Help Scout mailbox (12 conversations, customers, tags, known issues, knowledge and sample AI analyses) and runs the **real sync engine** against it — nothing is mocked at the UI level, so you're evaluating the actual product.

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
<summary><b>🖥️ Optional: native desktop app (Windows/macOS/Linux)</b></summary>

SupportOS ships with a [Tauri 2](https://tauri.app) wrapper for a native desktop build:

```bash
# requires Rust: https://rustup.rs
npm i -g @tauri-apps/cli
tauri build
```

See [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) for the full walkthrough.
</details>

---

## ✨ Features

| Area | What you get |
|---|---|
| **📥 Local mirror** | Account, users, teams, inboxes, folders, tags, custom fields, customers, organizations, conversations, threads, attachments, ratings, saved replies, workflows, routing — synced via polling with checkpoints, resumable after restart, with drift reconciliation |
| **🎧 Support inbox** | 3-pane workspace: views, filters, bulk actions, sanitized HTML threads, customer + AI context panes, rich composer (reply / note / draft / cc / bcc / status-after-send / saved replies / AI draft insertion) |
| ✅ **Ticket operations** | Reply, drafts, internal notes, status, assignment, inbox moves, subject edits, merge-safe tags, custom fields (system-field-safe), snooze, scheduled replies, attachments, workflow runs, "Open in Help Scout" links — every write audited and duplicate-protected |
| **🔍 Universal search** | SQLite FTS5 across tickets, thread text, customers, knowledge, known issues, saved replies and AI analyses — filters (status/inbox/tag/date), exact ticket-number lookup, optional semantic search via local Qdrant |
| **🤖 Local AI** | Ticket analysis (intent, questions, urgency, sentiment), evidence-backed verified reply drafts, a verification pass (unsupported claims / missing questions / internal leakage), rewrites, customer memory, issue clustering, report narratives — versioned, cached, audited, always labeled AI-generated |
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

The app is fully useful without AI: search, analytics, issue radar (keyword-based), ticket operations and reports all work — LM Studio integration degrades gracefully and says so honestly in the AI Center and capability matrix.
</details>

<details>
<summary><b>How is this tested?</b></summary>

108 automated tests (unit / integration / e2e) run in CI on every push: lint, strict typecheck, full suite, production build and a real demo-mode boot smoke test. The test suite is architected so **no test can ever send a real message** — see [docs/TESTING.md](docs/TESTING.md).
</details>

<details>
<summary><b>Can I use it offline?</b></summary>

Yes for everything local: the mirror, search, analytics, knowledge base and previously generated AI outputs all work offline. Sync and new remote writes naturally need connectivity to Help Scout.
</details>

---

## 🗺️ Roadmap

- [x] v1.0.0 — local mirror, inbox workspace, FTS5 search, local AI pipeline, Issue Radar, reports, automation, backups, 108-test CI ([changelog](CHANGELOG.md))
- [ ] Help Scout **Chat / Docs / Beacon** API coverage (currently conversations/mailbox APIs)
- [ ] Real-time ratings refresh (currently polled during sync)
- [ ] Multi-mailbox dashboards
- [ ] Packaged desktop installers (MSI / DMG / AppImage)

Ideas and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 📚 Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, provenance model |
| [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) | Verified Help Scout v2/v3 API usage, capability matrix, known limitations |
| [docs/AI-SETUP.md](docs/AI-SETUP.md) | LM Studio + Qdrant setup and the AI pipeline |
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
