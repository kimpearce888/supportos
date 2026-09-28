/** Run pending database migrations. Usage: npm run db:migrate */
// v2.2.1 audit fix: CLI scripts used to read raw process.env only, ignoring
// the .env file the SERVER loads (the documented configuration mechanism) -
// a customized DATABASE_PATH silently produced migrations of a DIFFERENT
// (freshly created) database while the output looked successful.
import 'dotenv/config';
import { openDatabase, closeDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';
import { migrationsApplied } from '../src/server/database/migrator.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/supportos.db');
const result = applyMigrations(db);
console.log(`Migrations: ${result.applied} applied, ${migrationsApplied(db)} total in history.`);
console.log(`Database: ${process.env.DATABASE_PATH ?? './data/supportos.db'}`);
closeDatabase();
