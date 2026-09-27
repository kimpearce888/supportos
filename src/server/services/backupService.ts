import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '../database/connection.js';
import type { SettingsRepository } from '../database/repositories/settingsRepo.js';

export interface BackupResult {
  ok: boolean;
  message: string;
  path?: string;
  verified?: boolean;
}

/**
 * Backup/restore (spec #61): SQLite checkpoint (WAL-consistent) + settings JSON.
 * Restore is safe: closes the DB handle, replaces the file, re-opens.
 */
export class BackupService {
  constructor(
    private db: DB,
    private dbPath: string,
    private settings: SettingsRepository,
    private backupsDir: string
  ) {}

  backup(): BackupResult {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(this.backupsDir, `supportos-backup-${stamp}.db`);
      // Consistent online backup (works under WAL and for any journal mode)
      await_sync_backup(this.db, target);
      // Settings snapshot next to it
      const settingsTarget = target.replace(/\.db$/, '.settings.json');
      const rows = this.db.prepare('SELECT key, value FROM application_settings').all() as { key: string; value: string }[];
      const safeRows = rows.filter((r) => !/token|secret|password/i.test(r.key));
      fs.writeFileSync(settingsTarget, JSON.stringify({ version: 1, exported_at: new Date().toISOString(), settings: safeRows }, null, 2));
      const size = fs.statSync(target).size;
      return { ok: true, message: `Backup created (${(size / 1024 / 1024).toFixed(1)} MB).`, path: target, verified: this.verify(target) };
    } catch (e) {
      return { ok: false, message: `Backup failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  verify(backupPath: string): boolean {
    let test: Database.Database | null = null;
    try {
      test = new Database(backupPath, { readonly: true });
      const result = test.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      return result.integrity_check === 'ok';
    } catch {
      return false;
    } finally {
      // Always close: a throwing prepare() previously leaked the readonly handle
      if (test) test.close();
    }
  }

  /**
   * Verification is cached per (file, mtime): listBackups() previously ran a
   * full PRAGMA integrity_check (a complete database scan) on EVERY backup on
   * EVERY request, blocking the event loop for longer and longer as backups
   * accumulated. Cache keyed by file mtime (backups are immutable once written).
   */
  private verificationCache = new Map<string, { mtimeMs: number; verified: boolean }>();

  private cachedVerify(fullPath: string, mtimeMs: number): boolean {
    const cached = this.verificationCache.get(fullPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.verified;
    const verified = this.verify(fullPath);
    this.verificationCache.set(fullPath, { mtimeMs, verified });
    return verified;
  }

  listBackups(): { file: string; size_bytes: number; created_at: string; verified: boolean }[] {
    try {
      return fs
        .readdirSync(this.backupsDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => {
          const full = path.join(this.backupsDir, f);
          const stat = fs.statSync(full);
          return { file: f, size_bytes: stat.size, created_at: stat.mtime.toISOString(), verified: this.cachedVerify(full, stat.mtimeMs) };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    } catch {
      return [];
    }
  }

  /**
   * v1.6.0 audit fix: keep only the newest `keep` backup FILES (.db + matching
   * .settings.json snapshots). Without this the backups directory grew forever
   * (one new file pair per accepted maintenance tick). Encrypted .sosync
   * bundles are NOT touched - the encrypted-sync service prunes those itself.
   */
  pruneBackups(keep: number): number {
    try {
      const files = fs
        .readdirSync(this.backupsDir)
        .filter((f) => f.endsWith('.db'))
        .map((f) => ({ f, mtimeMs: fs.statSync(path.join(this.backupsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      let removed = 0;
      for (const old of files.slice(Math.max(1, keep))) {
        try {
          fs.rmSync(path.join(this.backupsDir, old.f));
          fs.rmSync(path.join(this.backupsDir, old.f.replace(/\.db$/, '.settings.json')), { force: true });
          this.verificationCache.delete(path.join(this.backupsDir, old.f));
          removed++;
        } catch {
          // individual prune failures must never break maintenance
        }
      }
      return removed;
    } catch {
      return 0;
    }
  }

  /**
   * Restore: caller must close the current DB first (this app stops workers and restarts).
   * Returns instructions; the actual swap is done by the CLI script.
   */
  static restore(dbPath: string, backupPath: string): { ok: boolean; message: string } {
    try {
      if (!fs.existsSync(backupPath)) return { ok: false, message: 'Backup file not found.' };
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.copyFileSync(backupPath, dbPath + '.restore-tmp');
      fs.renameSync(dbPath + '.restore-tmp', dbPath);
      // Remove stale WAL/SHM files so SQLite does not reuse them
      for (const ext of ['-wal', '-shm']) {
        const p = dbPath + ext;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      return { ok: true, message: 'Database restored. Restart SupportOS to use the restored data.' };
    } catch (e) {
      return { ok: false, message: `Restore failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Export data (spec #62): JSON export of local intelligence; CSV of conversations. */
  exportJson(): { ok: boolean; message: string; path?: string } {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const target = path.join(this.backupsDir, `supportos-export-${Date.now()}.json`);
      const data: Record<string, unknown[]> = {};
      for (const table of ['conversations', 'customers', 'organizations', 'known_issues', 'issue_clusters', 'knowledge_documents', 'ai_drafts']) {
        data[table] = this.db.prepare(`SELECT * FROM ${table}`).all();
      }
      fs.writeFileSync(target, JSON.stringify({ version: 1, exported_at: new Date().toISOString(), data }, null, 2));
      return { ok: true, message: 'JSON export created. Note: this export contains customer data - handle it carefully.', path: target };
    } catch (e) {
      return { ok: false, message: `Export failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  exportConversationsCsv(): { ok: boolean; message: string; path?: string } {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const target = path.join(this.backupsDir, `supportos-conversations-${Date.now()}.csv`);
      const rows = this.db
        .prepare(
          `SELECT c.number, c.subject, c.status, m.name AS mailbox,
             TRIM(COALESCE(cu.first_name,'') || ' ' || COALESCE(cu.last_name,'')) AS customer,
             (SELECT ce.value FROM customer_emails ce WHERE ce.customer_id = cu.id LIMIT 1) AS email,
             c.remote_created_at AS created_at, c.closed_at
           FROM conversations c LEFT JOIN customers cu ON cu.id = c.customer_local_id
           LEFT JOIN mailboxes m ON m.id = c.mailbox_local_id WHERE c.deleted_at IS NULL`
        )
        .all() as Record<string, unknown>[];
      const header = ['number', 'subject', 'status', 'mailbox', 'customer', 'email', 'created_at', 'closed_at'];
      const esc = (v: unknown): string => {
        const s = v == null ? '' : String(v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      };
      const lines = [header.join(',')];
      for (const r of rows) lines.push(header.map((h) => esc(r[h])).join(','));
      fs.writeFileSync(target, lines.join('\n'));
      return { ok: true, message: 'CSV export created. Note: this export contains customer data.', path: target };
    } catch (e) {
      return { ok: false, message: `Export failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
}

export function checksumFile(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Synchronous SQLite consistent snapshot via VACUUM INTO (works under WAL, any journal mode). */
function await_sync_backup(db: DB, target: string): void {
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}
