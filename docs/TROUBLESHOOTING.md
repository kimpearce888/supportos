# Troubleshooting

## Startup

| Symptom | Cause / fix |
|---|---|
| `Cannot find module .../dist/server/index.js` | Run `npm run build` first (or `npm run dev` for development) |
| `EADDRINUSE :3000` | Another process owns the port. Change `PORT` in `.env` or stop the other process |
| "No built frontend found" in the log | The API is running but `dist/client` doesn't exist yet → `npm run build:client` (or use `npm run dev`) |
| `better-sqlite3` compile error on install | Install the VS Build Tools "Desktop development with C++" workload, then `npm rebuild better-sqlite3`. Normal setups use prebuilt binaries and never hit this |

## Help Scout connection

| Symptom | Fix |
|---|---|
| Wizard says credentials missing | Set `HELPSCOUT_CLIENT_ID` / `HELPSCOUT_CLIENT_SECRET` in `.env`, restart the app |
| "Help Scout rejected the login credentials" | Verify the Client ID/Secret; for the browser OAuth flow the redirect URI in your Help Scout app must exactly match `HELPSCOUT_REDIRECT_URI` |
| Sync stuck in `ERROR` | Open Sync Health → look at the failed resource's last error → **Retry** happens automatically with backoff; use "Full reconciliation" after fixing the root cause. You never need to delete the database |
| 429 rate limit messages | Normal for very large mailboxes during the first sync — the queue backs off automatically; reduce `SYNC_API_CONCURRENCY` in Settings if it persists |
| Writes fail with "conversation no longer exists" | The conversation was deleted or merged upstream — open the target conversation (the UI links to it) |

## AI

| Symptom | Fix |
|---|---|
| "LM Studio is not reachable at http://127.0.0.1:1234" | Start LM Studio, load a model, Developer → Start Server. Everything except AI keeps working meanwhile |
| AI drafts are empty or unparseable | Use a stronger (larger) instruct model in Settings → LM Studio; weaker models sometimes ignore JSON mode |
| Semantic search never activates | Needs BOTH Qdrant running and an embedding model configured (Settings → LM Studio) |
| Embeddings stuck "failed" | Check the embedding model is actually loaded in LM Studio, then Sync Health → Rebuild embeddings |

## Data

| Symptom | Fix |
|---|---|
| Search results look stale | Sync Health → **Rebuild search index** |
| Attachment download fails | The file may have expired upstream; the metadata is preserved and marked failed |
| Database locked errors | Rare (WAL + 5s busy timeout). If it persists, ensure only one instance is running |
| Restore didn't apply | The app must be STOPPED during `npm run db:restore` — start it again afterwards |

## Webhooks

Webhooks require a network-accessible relay to reach a localhost app. Without one, everything still syncs via polling — this is expected, not a bug. If you set up a relay: point it at `POST /api/webhooks/helpscout`, configure the same secret in `HELPSCOUT_WEBHOOK_SECRET` and in the Help Scout Webhooks app, then verify events appear in Sync Health → Recent webhook events (401 = signature mismatch).

## Demo mode oddities

Demo conversations come from the simulated provider. "Simulate incoming ticket" (Onboarding/Settings → demo tools, `POST /api/demo/simulate-incoming`) creates a new ticket that appears after the next sync tick (a few seconds). To reset all demo data: stop the app, delete `./data/supportos.db*`, start again.

## Getting diagnostics

- `npm run healthcheck` — CLI status of every subsystem
- Sync Health screen — checkpoints, rate limit state, job queues, recent webhook events
- `GET /api/errors` — recent internal errors
- Structured logs on stdout with `LOG_LEVEL=debug` (never contain tokens or full customer bodies)
