# Contributing to SupportOS

Thanks for your interest in contributing!

## Development setup

```bash
git clone https://github.com/kimpearce888/supportos.git
cd supportos
npm install
cp .env.example .env        # LOCAL_DEMO_MODE=true → no credentials needed
npm run dev                 # Vite (5173) + Fastify (3000) with hot reload
```

## Ground rules

- **Never bypass the write-protection pipeline.** All remote mutations must go through validate → auth → fresh-read → merge → write → confirm → persist → audit (see `docs/ARCHITECTURE.md`).
- **Never commit real credentials, real customer data, or real ticket content.** Demo data lives in `fakeProvider`/`fakeData`; use it.
- **Tests must never be able to send real messages.** Everything runs against `FakeHelpScoutProvider` (see `docs/TESTING.md`).
- **Customer-facing AI output stays in observe/assist mode.** Automatic sending is permanently OFF by design.

## Before opening a PR

```bash
npm run lint         # 0 errors, 0 warnings
npm run typecheck    # strict TS, server + client
npm run test:all     # 108 tests must pass
npm run build        # must produce dist/client + dist/server
```

CI runs the same gates on every push and PR.

## Scope

Good first issues: UI polish, report metrics, knowledge-import formats, documentation.
Design changes (sync engine, write pipeline, AI safety model) need an issue discussion first.
