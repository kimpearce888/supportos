/** Create a verified backup. Usage: npm run db:backup */
import { openDatabase, closeDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';
import { SettingsRepository } from '../src/server/database/repositories/settingsRepo.js';
import { BackupService } from '../src/server/services/backupService.js';
import path from 'node:path';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/supportos.db');
applyMigrations(db);
const backupsDir = path.resolve(process.cwd(), 'backups');
const service = new BackupService(db, process.env.DATABASE_PATH ?? './data/supportos.db', new SettingsRepository(db), backupsDir);
const result = service.backup();
console.log(result.ok ? `OK: ${result.message} (${result.verified ? 'integrity verified' : 'NOT verified'})` : `FAILED: ${result.message}`);
if (result.path) console.log(`File: ${result.path}`);
closeDatabase();
process.exit(result.ok ? 0 : 1);
