# Backup & Restore

## Automatic backups

Set `backup_interval_hours` (Settings → Synchronization & AI, default 24h) and the background maintenance worker creates verified backups in `./backups/` automatically.

## Manual backup

- UI: Settings → Backups → **Backup database now**
- CLI: `npm run db:backup`

Each backup is a **consistent SQLite snapshot** (online `VACUUM INTO`, safe even while the app is writing) plus a `.settings.json` sidecar (non-secret settings only). Backups are integrity-verified (`PRAGMA integrity_check`) and listed with size/date/verification state.

## Restore

1. **Stop SupportOS** (close the app / stop the process)
2. `npm run db:restore -- backups/<file>.db`
3. Start the app again — migrations re-verify automatically

Restore refuses backups that fail the integrity check. Stale WAL/SHM files are cleaned up automatically.

## What backups include

- The complete SQLite database (mirror + AI metadata + knowledge + issues + automation + settings)
- Not included: attachment files (`./data/attachments`) and Qdrant vector data — both are **rebuildable**: re-run attachment downloads (Sync Health) and "Rebuild embeddings" after a restore.

## Exports

- **JSON export** (Settings → Backups): conversations, customers, organizations, known issues, clusters, knowledge documents, AI drafts — for archival or migration
- **CSV export**: conversation list with customer/email columns

> Exports contain customer data. Both the UI and CLI explicitly say so before you run them — treat export files as sensitive.
