/* One-off migration upgrade check: copies the real demo DB, applies migrations,
 * verifies the six new M2 tables + indexes exist. Run: npx tsx scripts/check-m012.ts */
import fs from 'node:fs';
import { openDatabase, closeDatabase } from '../src/server/database/connection.js';
import { applyMigrations } from '../src/server/database/migrations/index.js';

const src = 'data/supportos.db';
const copy = '/tmp/upgrade_test.db';
fs.copyFileSync(src, copy);
const db = openDatabase(copy);
const result = applyMigrations(db);
console.log('migrations applied:', JSON.stringify(result));
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('notifications','notification_prefs','side_threads','side_thread_participants','side_thread_messages','side_thread_mentions') ORDER BY name")
  .all();
console.log('new tables:', tables.map((t) => t.name).join(', '));
const idx = db
  .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications' AND sql IS NOT NULL")
  .all();
console.log('notification indexes:', idx.map((t) => t.name).join(', '));
const conv = db.prepare('SELECT COUNT(*) AS n FROM conversations').get();
console.log('conversations intact:', JSON.stringify(conv));
closeDatabase(db);
console.log('UPGRADE_OK');
