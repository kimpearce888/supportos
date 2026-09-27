/** Restore the database from a backup. The application MUST be stopped. Usage: npm run db:restore -- backups/<file>.db */
import { BackupService } from '../src/server/services/backupService.js';
import fs from 'node:fs';

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: npm run db:restore -- backups/<file>.db');
  process.exit(1);
}
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}
const dbPath = process.env.DATABASE_PATH ?? './data/supportos.db';
// integrity check first
const Database = (await import('better-sqlite3')).default;
const check = new Database(backupPath, { readonly: true });
const integrity = check.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
check.close();
if (integrity.integrity_check !== 'ok') {
  console.error('Backup failed the integrity check - refusing to restore.');
  process.exit(1);
}
const result = BackupService.restore(dbPath, backupPath);
console.log(`${result.ok ? 'OK' : 'FAILED'}: ${result.message}`);
process.exit(result.ok ? 0 : 1);
