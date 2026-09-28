/**
 * CLI wrapper: seeds demo intelligence (knowledge, known issues, clusters,
 * sample AI analyses) into a DEMO database. Refuses to touch non-demo data.
 * Usage: LOCAL_DEMO_MODE=true npm run db:seed
 */
// v2.2.1 audit fix: load .env like the server (DATABASE_PATH and
// LOCAL_DEMO_MODE now work from .env, not only shell env).
import 'dotenv/config';
import { openDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';
import { seedDemoData } from '../src/server/services/demoSeed.js';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/supportos.db');
applyMigrations(db);
try {
  seedDemoData(db);
  db.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES ('demo_data_loaded', 'true', datetime('now'))").run();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
