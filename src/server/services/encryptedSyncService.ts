import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DB } from '../database/connection.js';

/** Magic header: identifies a SupportOS encrypted sync bundle. */
const MAGIC = Buffer.from('SOSYNC', 'utf8');
const FORMAT_VERSION = 1;
/** scrypt work factor: ~0.5s on a modern laptop - deliberately slow for offline brute force. */
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32; // AES-256

export interface SyncBundleInfo {
  version: number;
  created_at: string;
  conversations: number;
  customers: number;
  app_version: string | null;
  sha256: string;
}

export interface ExportResult {
  ok: boolean;
  message: string;
  path?: string;
  size_bytes?: number;
  info?: SyncBundleInfo;
}

export interface ImportResult {
  ok: boolean;
  message: string;
  require_restart?: boolean;
}

/**
 * EncryptedSyncService (v1.5.0): optional end-to-end encrypted sync for
 * multi-device use.
 *
 * Design decisions (deliberate, and documented in README/SECURITY):
 * - FILE-BASED bundles, not a relay server. SupportOS is local-first and
 *   privacy-first: there is no SupportOS-operated server that could read
 *   your data, so "sync" is an encrypted .sosync file you move yourself -
 *   cloud drive, USB, company share, anything. The file is ciphertext end
 *   to end: only the passphrase holder can open it. A relay would add a
 *   trusted third party the product explicitly refuses to need.
 * - CONTENT = the SQLite mirror (VACUUM INTO snapshot): customers,
 *   conversations, threads, AI analysis, segments, campaigns - every
 *   structured datum. Attachments are NOT bundled: they are re-downloadable
 *   from Help Scout on the new device (the existing attachment jobs pick
 *   them up automatically), which keeps bundles small and avoids shipping
 *   large binaries through the crypto layer.
 * - CRYPTO = AES-256-GCM with a scrypt-derived key (params stored in the
 *   unencrypted header so future formats can evolve). GCM gives
 *   confidentiality AND integrity: a tampered bundle fails authentication
 *   instead of silently restoring corrupt data. All primitives come from
 *   Node's built-in crypto - no new dependencies, no un-audited code.
 * - IMPORT is safe-by-default: the bundle is decrypted to a temp file,
 *   integrity-checked (PRAGMA integrity_check) and schema-version-checked
 *   (never import a NEWER schema into an OLDER app), an automatic backup of
 *   the current DB is written, and only then does the swap happen. The app
 *   must restart to open the restored mirror - same model as restore.
 */
export class EncryptedSyncService {
  constructor(
    private db: DB,
    private dbPath: string,
    private bundlesDir: string
  ) {}

  // ---------------- Export ----------------

  exportBundle(passphrase: string): ExportResult {
    try {
      if (typeof passphrase !== 'string' || passphrase.length < 8) {
        return { ok: false, message: 'Passphrase must be at least 8 characters.' };
      }
      fs.mkdirSync(this.bundlesDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const snapshotPath = path.join(this.bundlesDir, `.snapshot-${stamp}.tmp`);
      const target = path.join(this.bundlesDir, `supportos-sync-${stamp}.sosync`);

      // 1. Consistent snapshot (same primitive as backups: VACUUM INTO under WAL)
      const escaped = snapshotPath.replace(/'/g, "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);

      // 2. Metadata from the snapshot
      const info = this.snapshotInfo(snapshotPath);

      // 3. Encrypt
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = crypto.scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 });
      const header = Buffer.from(
        JSON.stringify({
          v: FORMAT_VERSION,
          kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('base64') },
          cipher: 'aes-256-gcm',
          iv: iv.toString('base64'),
          created_at: new Date().toISOString(),
          app_version: this.appVersion(),
          conversations: info.conversations,
          customers: info.customers,
          sha256: info.sha256
        }),
        'utf8'
      );
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32BE(header.length, 0);

      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const plaintext = fs.readFileSync(snapshotPath);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      fs.writeFileSync(target, Buffer.concat([MAGIC, headerLen, header, ciphertext, tag]));
      fs.unlinkSync(snapshotPath);

      const size = fs.statSync(target).size;
      this.log('export', target, size, info);
      // Best-effort: keep at most the 5 newest bundles (they can be large)
      this.pruneOldBundles();
      return { ok: true, message: `Encrypted sync bundle created (${(size / 1024 / 1024).toFixed(1)} MB). Move it to the other device and import it there with the same passphrase.`, path: target, size_bytes: size, info };
    } catch (e) {
      return { ok: false, message: `Export failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ---------------- Import ----------------

  /** Two-phase import: decrypt+verify first (dry run), then commit. */
  verifyBundle(bundlePath: string, passphrase: string): { ok: boolean; message: string; info?: SyncBundleInfo } {
    try {
      const decrypted = this.decryptToTemp(bundlePath, passphrase);
      if (typeof decrypted === 'string') return { ok: false, message: decrypted };
      const info = this.snapshotInfo(decrypted.tempPath);
      const currentSchema = this.schemaVersion();
      const bundleSchema = this.schemaVersionOfFile(decrypted.tempPath);
      fs.rmSync(decrypted.tempPath, { force: true });
      if (bundleSchema > currentSchema) {
        return { ok: false, message: `The bundle was created by a newer SupportOS (schema ${bundleSchema} > local ${currentSchema}). Update SupportOS on this device first.` };
      }
      return { ok: true, message: `Bundle verified: ${info.conversations} conversations, ${info.customers} customers, schema ${bundleSchema}.`, info };
    } catch (e) {
      return { ok: false, message: `Verification failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  importBundle(bundlePath: string, passphrase: string): ImportResult {
    try {
      const decrypted = this.decryptToTemp(bundlePath, passphrase);
      if (typeof decrypted === 'string') return { ok: false, message: decrypted };
      const tempPath = decrypted.tempPath;

      // Integrity + schema guard
      const integrity = this.integrityCheck(tempPath);
      if (!integrity) {
        fs.rmSync(tempPath, { force: true });
        return { ok: false, message: 'The decrypted database failed the integrity check. The bundle is corrupt - nothing was changed.' };
      }
      const currentSchema = this.schemaVersion();
      const bundleSchema = this.schemaVersionOfFile(tempPath);
      if (bundleSchema > currentSchema) {
        fs.rmSync(tempPath, { force: true });
        return { ok: false, message: `The bundle was created by a newer SupportOS (schema ${bundleSchema} > local ${currentSchema}). Update this device first.` };
      }

      // Metadata from the DECRYPTED snapshot (the bundle itself is ciphertext)
      const info = this.snapshotInfo(tempPath);

      // Safety net: automatic backup of the CURRENT data before the swap
      const backupPath = this.dbPath + `.pre-import-${Date.now()}.db`;
      const escaped = backupPath.replace(/'/g, "''");
      this.db.exec(`VACUUM INTO '${escaped}'`);

      // Swap (same model as BackupService.restore; caller restarts the app)
      fs.copyFileSync(tempPath, this.dbPath + '.restore-tmp');
      fs.rmSync(tempPath, { force: true });
      fs.renameSync(this.dbPath + '.restore-tmp', this.dbPath);
      for (const ext of ['-wal', '-shm']) {
        const p = this.dbPath + ext;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      const size = fs.statSync(bundlePath).size;
      this.log('import', bundlePath, size, info);
      return { ok: true, message: `Encrypted bundle imported (${info.conversations} conversations, ${info.customers} customers). A safety backup of the previous data was written next to the database. Restart SupportOS to use the restored mirror.`, require_restart: true };
    } catch (e) {
      return { ok: false, message: `Import failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ---------------- Bundle listing ----------------

  listBundles(): { file: string; size_bytes: number; created_at: string }[] {
    try {
      return fs
        .readdirSync(this.bundlesDir)
        .filter((f) => f.endsWith('.sosync'))
        .map((f) => {
          const full = path.join(this.bundlesDir, f);
          const stat = fs.statSync(full);
          return { file: f, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    } catch {
      return [];
    }
  }

  syncLog(): { id: number; direction: string; file_path: string; size_bytes: number; conversations: number | null; customers: number | null; at: string }[] {
    try {
      return this.db
        .prepare('SELECT id, direction, file_path, size_bytes, conversations, customers, at FROM encrypted_sync_log ORDER BY id DESC LIMIT 50')
        .all() as { id: number; direction: string; file_path: string; size_bytes: number; conversations: number | null; customers: number | null; at: string }[];
    } catch {
      return [];
    }
  }

  bundleDir(): string {
    return this.bundlesDir;
  }

  // ---------------- internals ----------------

  private decryptToTemp(bundlePath: string, passphrase: string): { tempPath: string } | string {
    if (!fs.existsSync(bundlePath)) return 'Bundle file not found.';
    const raw = fs.readFileSync(bundlePath);
    if (raw.length < MAGIC.length + 4) return 'File is too small to be a SupportOS sync bundle.';
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) return 'This is not a SupportOS encrypted sync bundle (.sosync).';
    let offset = MAGIC.length;
    const headerLen = raw.readUInt32BE(offset);
    offset += 4;
    if (headerLen <= 0 || headerLen > 65536 || offset + headerLen >= raw.length) return 'Bundle header is corrupt.';
    let header: {
      v: number;
      kdf: { name: string; N: number; r: number; p: number; salt: string };
      cipher: string;
      iv: string;
      created_at: string;
      app_version?: string | null;
      conversations?: number;
      customers?: number;
      sha256?: string;
    };
    try {
      header = JSON.parse(raw.subarray(offset, offset + headerLen).toString('utf8'));
    } catch {
      return 'Bundle header is corrupt.';
    }
    if (header.v !== FORMAT_VERSION) return `Unsupported bundle format version ${header.v}.`;
    if (header.cipher !== 'aes-256-gcm' || header.kdf?.name !== 'scrypt') return 'Bundle uses an unsupported cipher.';
    const ciphertext = raw.subarray(offset + headerLen, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const key = crypto.scryptSync(passphrase, Buffer.from(header.kdf.salt, 'base64'), KEY_LEN, {
      N: header.kdf.N,
      r: header.kdf.r,
      p: header.kdf.p,
      maxmem: 256 * 1024 * 1024
    });
    let plain: Buffer;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return 'Wrong passphrase (or the bundle was modified). Nothing was changed.';
    }
    const tempPath = path.join(this.bundlesDir, `.import-${Date.now()}.tmp`);
    fs.mkdirSync(this.bundlesDir, { recursive: true });
    fs.writeFileSync(tempPath, plain);
    return { tempPath };
  }

  private snapshotInfo(snapshotPath: string): SyncBundleInfo {
    let test: Database.Database | null = null;
    try {
      test = new Database(snapshotPath, { readonly: true });
      const conversations = (test.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
      const customers = (test.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(snapshotPath)).digest('hex');
      return { version: FORMAT_VERSION, created_at: new Date().toISOString(), conversations, customers, app_version: this.appVersion(), sha256 };
    } finally {
      if (test) test.close();
    }
  }

  private integrityCheck(snapshotPath: string): boolean {
    let test: Database.Database | null = null;
    try {
      test = new Database(snapshotPath, { readonly: true });
      const r = test.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      return r.integrity_check === 'ok';
    } catch {
      return false;
    } finally {
      if (test) test.close();
    }
  }

  private schemaVersion(): number {
    try {
      return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM schema_migrations').get() as { v: number }).v;
    } catch {
      return 0; // unmigrated database: treat as schema 0 (import still guarded by bundle schema)
    }
  }

  private schemaVersionOfFile(snapshotPath: string): number {
    let test: Database.Database | null = null;
    try {
      test = new Database(snapshotPath, { readonly: true });
      // The table name is fixed by the migrator
      const tables = test.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('schema_migrations', 'migrations')").all() as { name: string }[];
      const table = tables[0]?.name;
      if (!table) return 0;
      return (test.prepare(`SELECT COALESCE(MAX(id), 0) AS v FROM ${table}`).get() as { v: number }).v;
    } catch {
      return 0;
    } finally {
      if (test) test.close();
    }
  }

  private appVersion(): string | null {
    try {
      // injected via npm lifecycle at build time; fall back to reading package.json once
      const pkgPath = path.resolve(process.cwd(), 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        return pkg.version ?? null;
      }
    } catch {
      /* non-fatal */
    }
    return null;
  }

  private log(direction: 'export' | 'import', filePath: string, size: number, info: SyncBundleInfo): void {
    try {
      this.db
        .prepare('INSERT INTO encrypted_sync_log (direction, file_path, size_bytes, conversations, customers, sha256) VALUES (?, ?, ?, ?, ?, ?)')
        .run(direction, filePath, size, info.conversations, info.customers, info.sha256);
    } catch {
      /* the ledger must never break the operation */
    }
  }

  private pruneOldBundles(): void {
    try {
      const files = fs
        .readdirSync(this.bundlesDir)
        .filter((f) => f.endsWith('.sosync'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(this.bundlesDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(5)) fs.unlinkSync(path.join(this.bundlesDir, old.f));
    } catch {
      /* pruning is best-effort */
    }
  }
}
