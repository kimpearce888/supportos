import { buildApp } from './app.js';
import { getContext } from './services/context.js';
import { createLogger } from './config/logger.js';
import { config } from './config/config.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Startup sequence (spec #99):
 * 1. validate environment  2. run safe migrations  3. initialize database
 * 4. initialize queue  5. initialize local services  6-8. check connections
 * 9. start background workers  10. start UI (serves dist/client when built)
 * A failed optional AI/vector dependency NEVER blocks startup.
 */
async function main(): Promise<void> {
  const logger = createLogger(config.logLevel);
  logger.info('SupportOS starting', { service: 'startup', operation: 'boot' });

  const ctx = getContext();
  logger.info('Database initialized', { service: 'startup', operation: 'database', path: ctx.dbStats().path });

  // Warn loudly before binding a non-loopback address (spec #113)
  if (ctx.config.host !== '127.0.0.1' && ctx.config.host !== 'localhost') {
    logger.warn(`BINDING TO NON-LOCALHOST ADDRESS ${ctx.config.host}. This exposes SupportOS and all its local data to your network. Set HOST=127.0.0.1 unless you intentionally want this.`, { service: 'startup' });
  }

  // Optional dependency probes (failures are non-fatal)
  const clientDir = path.resolve(process.cwd(), 'dist', 'client');
  const hasClient = fs.existsSync(path.join(clientDir, 'index.html'));
  if (!hasClient) {
    logger.info('No built frontend found (dist/client). Run "npm run build:client" or use "npm run dev" for the Vite dev server.', { service: 'startup' });
  }

  const app = await buildApp(ctx);

  // 9. background workers
  ctx.workers.start();

  // If the DB is empty and demo mode is on, run the initial demo sync automatically
  const conversationCount = (ctx.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n;
  if (ctx.provider.kind === 'fake' && conversationCount === 0) {
    logger.info('Demo mode with empty database - running initial demo sync', { service: 'startup' });
    void ctx.coordinator
      .initialSync()
      .then(async () => {
        ctx.jobsRepo.enqueue('embeddings', 'embed_knowledge_chunks', {}, 4, 2);
        try {
          const { seedDemoData } = await import('./services/demoSeed.js');
          seedDemoData(ctx.db);
          ctx.settingsRepo.set('demo_data_loaded', true);
        } catch (e) {
          logger.warn('Demo intelligence seed skipped', { service: 'startup', error: String(e) });
        }
      })
      .catch((e) => logger.warn('Demo initial sync failed', { service: 'startup', error: String(e) }));
  }

  // 10. start UI/API
  await app.listen({ port: ctx.config.port, host: ctx.config.host });
  logger.info(`SupportOS ready on http://${ctx.config.host}:${ctx.config.port}`, {
    service: 'startup',
    operation: 'listen',
    demo_mode: ctx.provider.kind === 'fake',
    frontend: hasClient
  });
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'Fatal startup error', error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
  process.exit(1);
});
