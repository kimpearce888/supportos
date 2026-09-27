# SupportOS

[![CI](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml/badge.svg)](https://github.com/kimpearce888/supportos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-green)](package.json)

**A local-first, AI-powered support operating system for your Help Scout mailbox.**

SupportOS mirrors your Help Scout Inbox into a local SQLite database and gives you a fast, professional workspace for operating support: instant local search, analytics, issue intelligence, a local knowledge base, and local AI assistance (via LM Studio) — with **no cloud AI, no cloud vector database, and no data leaving your machine**.

> Help Scout remains the authoritative mailbox. SQLite is the authoritative local history/intelligence store. AI operates in observe/assist mode only: it **never** sends a customer reply automatically.

---

## What it does

| Area | Highlights |
|---|---|
| **Local mirror** | Account, users, teams, inboxes, folders, tags, custom fields, customers, organizations, conversations, threads, attachments, ratings, saved replies, workflows, routing, user statuses — synced via polling with checkpoints, resumable after restart, with reconciliation for drift |
| **Inbox workspace** | Professional 3-pane workspace: conversation list (views, filters, bulk actions), thread view (sanitized HTML), customer + AI context panes, rich composer (reply / note / draft / cc / bcc / status-after-send / saved replies / AI draft insertion) |
| **Ticket operations** | Reply, draft, internal note, status, assignment, inbox move, subject, tags (merge-safe), custom fields (system-field-safe), snooze, scheduled replies + publish, attachments, workflow runs, "Open in Help Scout" links — every remote write is audited, confirmed, and duplicate-protected |
| **Search** | SQLite FTS5 across tickets, thread text, customers, knowledge, known issues, saved replies and AI analyses — with filters (status, inbox, tag, date) and exact conversation-number lookup; optional semantic search via Qdrant |
| **AI (local)** | LM Studio integration: ticket analysis (intent, questions, urgency, sentiment…), evidence-backed verified-answer drafts, verification pass (unsupported claims, missing questions, internal leakage), AI notes, rewrites, customer memory, issue clustering, report narratives — all versioned, cached, audited and clearly labeled as AI-generated |
| **Issue intelligence** | Issue Radar (new/rising/recurring clusters with ticket links), known issues (customer-safe vs internal explanations, engineering refs), doc-gap detection, answer-reuse candidates, "why are customers contacting us" |
| **Reports** | Local analytics (labeled as local, with metric definitions and limitations), Help Scout native report import (labeled as Help Scout), AI narratives (labeled AI-derived), release correlation (never claims causation) |
| **Automation** | Local rules engine, separated from Help Scout workflows, with read / non-destructive / higher-risk action tiers; higher-risk actions always require approval |
| **Ops & safety** | Sync Health screen, background job queues (sync/api/attachments/embeddings/AI/reports/maintenance), audit log, backups + verified restore, export (CSV/JSON), capability matrix, first-run wizard, dark/light theme, keyboard shortcuts |

## Architecture

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

A **modular monolith**: one Node process, one SQLite database, background workers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) for the verified Help Scout API capability matrix.

## Requirements

- **Node.js ≥ 20** (developed on 24) and npm
- **Help Scout** account + an OAuth2 app (for live mode; not needed for demo mode)
- Optional: **LM Studio** (local AI) — any OpenAI-compatible local model
- Optional: **Qdrant** (local vector search) — e.g. `docker run -p 6333:6333 qdrant/qdrant`

## Quick start (demo mode — 2 minutes, no credentials)

```bash
npm install
cp .env.example .env        # LOCAL_DEMO_MODE=true
npm run build               # builds client + server
npm run start               # open http://127.0.0.1:3000
```

Demo mode runs against a simulated Help Scout mailbox (12 conversations, 8 customers, tags/fields/notes/replies, known issues, knowledge, sample AI analyses) and exercises the **real sync engine** — nothing is mocked at the UI level.

## Quick start (live mode)

1. In Help Scout: **Your Profile → My Apps → Create My App**, redirect URI `http://localhost:3000/oauth/callback`
2. Put `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` into `.env`, set `LOCAL_DEMO_MODE=false`
3. `npm run start`, open http://127.0.0.1:3000
4. First-run wizard → **Connect Help Scout** (Client Credentials is the simplest flow for a personal integration, or the browser OAuth code flow)
5. Run the **initial sync** from the wizard or Sync Health; watch per-resource checkpoints progress
6. Optional: configure LM Studio + Qdrant in Settings

## Development

```bash
npm run dev          # Vite dev server (5173) + Fastify dev server (3000) with hot reload
npm run test         # unit tests
npm run test:integration   # integration tests (fake provider, real sync engine)
npm run test:e2e     # end-to-end API tests (real Fastify app, demo provider)
npm run lint         # ESLint (0 errors, 0 warnings)
npm run typecheck    # strict TypeScript for server + client
npm run build        # production build (dist/client + dist/server)
npm run db:migrate   # run pending migrations
npm run db:backup    # verified backup to ./backups
npm run db:restore -- backups/<file>.db   # restore (stop the app first)
npm run healthcheck  # CLI health check
npm run db:seed      # seed demo intelligence (demo DBs only; refuses production data)
```

See [docs/TESTING.md](docs/TESTING.md) for the test philosophy (no production messages can ever be sent from tests — everything runs against `FakeHelpScoutProvider`).

## Configuration

All configuration lives in `.env` (see `.env.example`) and the Settings screen. Non-secret settings are stored in SQLite; OAuth tokens are stored **server-side only** and never exposed to the browser. No credentials, tokens, model names or account IDs are hard-coded anywhere.

| Variable | Purpose |
|---|---|
| `LOCAL_DEMO_MODE` | `true` = simulated Help Scout account (no credentials needed) |
| `HELPSCOUT_CLIENT_ID/SECRET`, `HELPSCOUT_REDIRECT_URI` | OAuth2 app credentials |
| `LMSTUDIO_BASE_URL`, `LMSTUDIO_CHAT_MODEL`, `LMSTUDIO_EMBEDDING_MODEL` | Local AI gateway |
| `QDRANT_URL`, `QDRANT_ENABLED` | Local vector store (optional) |
| `DATABASE_PATH`, `ATTACHMENTS_PATH` | Local storage locations |
| `HELPSCOUT_WEBHOOK_SECRET` | Webhook signature verification (optional) |
| `HOST` | Defaults to `127.0.0.1` — the app warns loudly before binding non-localhost |

## Safety model (defaults)

- **Automatic reply sending: permanently OFF** — AI drafts always require explicit human review + send action
- Automation write actions **OFF**; higher-risk actions (status/assign/close) always require approval
- Customer-facing drafts use **verified-answer mode**: only customer-safe evidence, explicit anti-fabrication rules, and a verification pass that flags unsupported claims, missing questions and internal leakage
- Internal-only knowledge never enters customer drafts; every AI output is labeled AI-generated with model + sources
- Payment data, tokens and API keys are redacted before prompting; untrusted ticket HTML is sanitized (no scripts, no `javascript:` URLs); attachments are never executed

## Documentation

- [docs/INSTALL-WINDOWS.md](docs/INSTALL-WINDOWS.md) — Windows installation, including the Tauri desktop build
- [docs/LOCAL-RUN.md](docs/LOCAL-RUN.md) — everyday running (dev, production, demo)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design, data flow, provenance model
- [docs/API-INTEGRATION.md](docs/API-INTEGRATION.md) — verified Help Scout API usage (v2/v3), capability matrix, known limitations
- [docs/AI-SETUP.md](docs/AI-SETUP.md) — LM Studio + Qdrant setup and the AI pipeline
- [docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) — backups, restore, exports
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — common problems and fixes
- [docs/TESTING.md](docs/TESTING.md) — test suite and quality gates

---

## Running on your own machine (Windows)

1. **Clone the repository**: `git clone https://github.com/kimpearce888/supportos.git` (or download the ZIP and extract it)
2. **Install Node.js ≥ 20** from https://nodejs.org (accept defaults)
3. **Install dependencies**: open PowerShell in the project folder → `npm install`
4. **Install local Qdrant if desired** (optional): `docker run -d -p 6333:6333 qdrant/qdrant`
5. **Install LM Studio** (optional): https://lmstudio.ai — load a chat model (e.g. a 7B instruct model), optionally an embedding model, then Developer → Start Server (port 1234)
6. **Configure `.env`**: `cp .env.example .env`, fill in your Help Scout OAuth app credentials, set `LOCAL_DEMO_MODE=false`
7. **Run migrations**: `npm run db:migrate`
8. **Start the application**: `npm run build` then `npm run start` (or `npm run dev` for development) → open http://127.0.0.1:3000 and complete the first-run wizard (connect Help Scout → initial sync → optional AI)
9. **Optional Tauri desktop build**: install Rust (https://rustup.rs) + `npm i -g @tauri-apps/cli`, then `tauri dev` / `tauri build` — see docs/INSTALL-WINDOWS.md

The project is fully portable: no platform-specific databases, auth, storage, deployments or runtime APIs are used anywhere — it is a plain Node.js app plus a local SQLite file.

## Repository structure

```
src/client/     React 19 app (pages, components, API hooks, state)
src/server/     Fastify 5 server (routes, sync, AI, search, security, workers)
src/shared/     Types + zod schemas shared by client and server
tests/          unit / integration / e2e (vitest)
scripts/        migrate, backup, restore, seed-demo, healthcheck
src-tauri/      Tauri 2 desktop wrapper (optional Windows build)
docs/           architecture, API integration, AI setup, testing, ops
```

## License

Released under the [MIT License](LICENSE). Help Scout is a trademark of Help Scout, Inc.; this project is an independent integration and is not affiliated with or endorsed by Help Scout.
