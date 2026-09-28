/** Create a verified backup. Usage: npm run db:backup */
// v2.2.1 audit fix: load .env like the server does (DATABASE_PATH), and
// honor BACKUPS_PATH instead of a hardcoded ./backups so CLI backups land
// in the same directory the server writes to.
import 'dotenv/config';
import { openDatabase, closeDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';
import { SettingsRepository } from '../src/server/database/repositories/settingsRepo.js';
import { BackupService } from '../src/server/services/backupService.js';
import path from 'node:path';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/supportos.db');
applyMigrations(db);
const backupsDir = path.resolve(process.env.BACKUPS_PATH ?? './backups');
const service = new BackupService(db, process.env.DATABASE_PATH ?? './data/supportos.db', new SettingsRepository(db), backupsDir);
const result = service.backup();
console.log(result.ok ? `OK: ${result.message} (${result.verified ? 'integrity verified' : 'NOT verified'})` : `FAILED: ${result.message}`);
if (result.path) console.log(`File: ${result.path}`);
closeDatabase();
process.exit(result.ok ? 0 : 1);
