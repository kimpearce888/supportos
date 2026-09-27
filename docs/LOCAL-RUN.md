# Running Locally

## Everyday production run

```bash
npm run build     # once, after pulling changes
npm run start     # serves the app + API at http://127.0.0.1:3000
```

The built server serves the compiled frontend from `dist/client` — a single process, single port. Data lives in `./data/supportos.db` (SQLite, WAL mode) and attachments in `./data/attachments`.

## Development mode

```bash
npm run dev
```

Runs the Fastify backend with hot reload (`tsx watch`, port 3000) and the Vite dev server (port 5173) which proxies `/api` to the backend. Open http://localhost:5173.

## Demo mode

Set `LOCAL_DEMO_MODE=true` in `.env` (or use the button in the first-run wizard). Demo mode:

- requires **no Help Scout credentials**
- makes **no remote calls** — a simulated mailbox (FakeHelpScoutProvider) serves the real sync engine
- auto-populates on first boot: conversations, customers, threads, ratings + knowledge, known issues, clusters and sample AI analyses (all AI content is marked AI-generated)
- can simulate incoming tickets: `POST /api/demo/simulate-incoming` (also exposed in the UI)

Demo data never mixes with production data — the seed script refuses to run against non-demo databases.

## Ports & binding

The backend binds to `HOST` (default `127.0.0.1` — localhost only). Binding anything else triggers a loud warning in the log; only do this if you intentionally want LAN access. No other ports are opened: LM Studio and Qdrant are *outbound* connections to your own local services.

## Logs

Structured JSON logs go to stdout (`LOG_LEVEL=debug|info|warn|error`). Logs never contain OAuth tokens, API secrets, or full customer message bodies by default. The application_errors table (visible via `GET /api/errors`) keeps recent internal errors for diagnostics.

## Graceful shutdown

`Ctrl+C` stops workers and closes the database cleanly. Interrupted syncs resume from the last checkpoint on the next start — no manual recovery, no database deletion.
