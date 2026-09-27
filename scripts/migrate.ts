/** Run pending database migrations. Usage: npm run db:migrate */
import { openDatabase, closeDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';
import { migrationsApplied } from '../src/server/database/migrator.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/supportos.db');
const result = applyMigrations(db);
console.log(`Migrations: ${result.applied} applied, ${migrationsApplied(db)} total in history.`);
console.log(`Database: ${process.env.DATABASE_PATH ?? './data/supportos.db'}`);
closeDatabase();
