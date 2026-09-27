/** CLI health check (exit code reflects health). Usage: npm run healthcheck [url] */
const base = process.argv[2] ?? process.env.LOCAL_APP_URL ?? 'http://127.0.0.1:3000';

interface HealthResponse {
  status: string;
  database?: { ok: boolean };
  helpscout?: { connected: boolean; demo_mode: boolean };
  lmstudio?: { connected: boolean };
  qdrant?: { connected: boolean };
  sync?: { state: string };
  workers?: { running: boolean };
}

try {
  const res = await fetch(`${base}/health/detailed`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as HealthResponse;
  console.log(`Status:      ${body.status}`);
  console.log(`Database:    ${body.database?.ok ? 'ok' : 'FAIL'}`);
  console.log(`Help Scout:  ${body.helpscout?.demo_mode ? 'demo mode' : body.helpscout?.connected ? 'connected' : 'unreachable'}`);
  console.log(`LM Studio:   ${body.lmstudio?.connected ? 'connected' : 'offline (AI features disabled, app still functional)'}`);
  console.log(`Qdrant:      ${body.qdrant?.connected ? 'connected' : 'offline (keyword search fallback active)'}`);
  console.log(`Sync state:  ${body.sync?.state ?? 'unknown'}`);
  console.log(`Workers:     ${body.workers?.running ? 'running' : 'stopped'}`);
  process.exit(body.status === 'error' ? 1 : 0);
} catch (e) {
  console.error(`Health check failed: ${e instanceof Error ? e.message : String(e)}`);
  console.error(`Is SupportOS running at ${base}? Start it with: npm run start`);
  process.exit(2);
}
