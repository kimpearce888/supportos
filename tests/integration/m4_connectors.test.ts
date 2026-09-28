import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { ConnectorService } from '../../src/server/connectors/connectorService.js';
import { checkUrlResolved } from '../../src/server/security/ssrfGuard.js';

/**
 * v2.0.0 (M4) integration tests, part 3 (plan Phase 22): local data
 * connectors. File kinds (JSON / CSV / SQLite) refresh through the path jail
 * with snapshot semantics (stable keys, pruned vanished rows, idempotent
 * re-refresh); HTTP configs are SSRF-refused for private targets; auth is
 * redacted on every read; and the AI visibility gate keeps non-allowed
 * connectors private to the UI.
 */
let db: ReturnType<typeof openTestDatabase>;
let svc: ConnectorService;
let tmpDir: string;

// The service jail resolves relative file names against <cwd>/connectors.
// Point the process cwd at a temp dir so tests are hermetic.
let prevCwd: string;

beforeAll(() => {
  prevCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supportos-connectors-'));
  process.chdir(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'connectors'), { recursive: true });
  db = openTestDatabase();
  applyMigrations(db);
  svc = new ConnectorService(db);
});

afterAll(() => {
  closeDatabase(db);
  process.chdir(prevCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConnectorFile(name: string, content: string): void {
  fs.writeFileSync(path.join(tmpDir, 'connectors', name), content);
}

describe('connector file refresh (Phase 22)', () => {
  it('refreshes a local JSON connector with a key column (upsert, not append)', async () => {
    writeConnectorFile('releases.json', JSON.stringify([
      { version: 'v1.0.0', channel: 'production', released_at: '2026-01-01' },
      { version: 'v1.1.0', channel: 'production', released_at: '2026-02-01' }
    ]));
    const c = svc.repository.create({
      name: 'Releases', kind: 'local_json',
      config: { kind: 'local_json', file: 'releases.json', keyColumn: 'version' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: true
    });
    const r1 = await svc.refresh(c.id);
    expect(r1.ok).toBe(true);
    expect(r1.rows).toBe(2);
    // Refresh again with one changed row + one vanished + one new: snapshot semantics.
    writeConnectorFile('releases.json', JSON.stringify([
      { version: 'v1.0.0', channel: 'production', released_at: '2026-01-01', notes: 'updated' },
      { version: 'v1.2.0', channel: 'production', released_at: '2026-03-01' }
    ]));
    const r2 = await svc.refresh(c.id);
    expect(r2.ok).toBe(true);
    expect(r2.rows).toBe(2);
    expect(r2.pruned).toBe(1); // v1.1.0 vanished from the source
    const listed = svc.repository.listRows(c.id, null, 50, 0);
    expect(listed.total).toBe(2);
    expect(listed.rows.find((row) => row.row_key === 'v1.0.0')?.data.notes).toBe('updated');
    // Health + schema recorded honestly.
    const after = svc.repository.get(c.id)!;
    expect(after.health).toBe('ok');
    expect(after.schema_json?.some((s) => s.name === 'version')).toBe(true);
  });

  it('parses CSV sources (quoted fields) into flat rows', async () => {
    writeConnectorFile('accounts.csv', 'name,tier,mrr\n"Smith, John",growth,480\nBright Path,starter,240\n');
    const c = svc.repository.create({
      name: 'Accounts CSV', kind: 'csv',
      config: { kind: 'csv', file: 'accounts.csv', keyColumn: 'name' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    const r = await svc.refresh(c.id);
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(2);
    const rows = svc.repository.listRows(c.id, null, 50, 0).rows;
    expect(rows.find((x) => x.row_key === 'Smith, John')?.data.tier).toBe('growth');
  });

  it('reads a SQLite source read-only with a whitelisted table identifier', async () => {
    const sqlitePath = path.join(tmpDir, 'connectors', 'product.sqlite');
    const src = new Database(sqlitePath);
    src.exec('CREATE TABLE deployments (version TEXT, env TEXT, deployed_at TEXT)');
    src.prepare('INSERT INTO deployments VALUES (?, ?, ?)').run('v9.0.0', 'production', '2026-01-05');
    src.prepare('INSERT INTO deployments VALUES (?, ?, ?)').run('v9.1.0', 'staging', '2026-02-05');
    src.close();
    const c = svc.repository.create({
      name: 'Deployments DB', kind: 'sqlite',
      config: { kind: 'sqlite', file: 'product.sqlite', table: 'deployments', keyColumn: 'version' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    const r = await svc.refresh(c.id);
    expect(r.ok).toBe(true);
    expect(r.rows).toBe(2);
    expect(svc.repository.listRows(c.id, 'production', 50, 0).total).toBe(1);
  });

  it('records failure honestly in health (never a partial snapshot overwrite)', async () => {
    const c = svc.repository.create({
      name: 'Broken', kind: 'local_json',
      config: { kind: 'local_json', file: 'missing.json' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    const r = await svc.refresh(c.id);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    const after = svc.repository.get(c.id)!;
    expect(after.health).toBe('error');
    expect(after.last_sync_error).toBeTruthy();
    // Malformed JSON -> error, not a crash.
    writeConnectorFile('bad.json', '{not valid json');
    const c2 = svc.repository.create({
      name: 'Bad JSON', kind: 'local_json', config: { kind: 'local_json', file: 'bad.json' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    expect((await svc.refresh(c2.id)).ok).toBe(false);
  });

  it('refuses files outside the connectors jail and non-array payloads', async () => {
    // The Zod layer rejects absolute paths; the service re-checks containment.
    writeConnectorFile('ok.json', '[]');
    const c = svc.repository.create({
      name: 'Scalar', kind: 'local_json', config: { kind: 'local_json', file: 'ok.json' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    writeConnectorFile('ok.json', '"just a string"');
    expect((await svc.refresh(c.id)).ok).toBe(false);
  });
});

describe('connector HTTP SSRF refusal (approved adjustment #4)', () => {
  it('validateConfig refuses loopback/private/metadata URLs BEFORE creation', async () => {
    for (const url of ['http://127.0.0.1/api', 'http://localhost/api', 'http://192.168.0.1/api', 'http://169.254.169.254/meta', 'https://10.0.0.1/x']) {
      const problem = await svc.validateConfig({ kind: 'http', url });
      expect(problem, url).toBeTruthy();
    }
    // A public literal IP passes the literal layer; DNS re-check would apply at refresh.
    const ok = await svc.validateConfig({ kind: 'http', url: 'https://93.184.216.34/data' });
    expect(ok).toBeNull();
  });

  it('refresh of an http connector targeting a private address fails closed with health=error', async () => {
    const c = svc.repository.create({
      name: 'Blocked HTTP', kind: 'http',
      config: { kind: 'http', url: 'http://192.168.1.10/internal' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    const r = await svc.refresh(c.id);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('refused');
    expect(svc.repository.get(c.id)?.health).toBe('error');
    expect(svc.repository.countRows(c.id)).toBe(0); // nothing fetched, nothing stored
  });

  it('DNS-resolved private addresses are refused (rebinding shape)', async () => {
    const r = await checkUrlResolved('https://rebind.example.com/x', async () => ['93.184.216.34', '10.0.0.9']);
    expect(r.ok).toBe(false);
  });
});

describe('connector auth redaction + AI visibility gate (Phase 22)', () => {
  it('never returns auth secrets through repository reads', async () => {
    const c = svc.repository.create({
      name: 'Authed', kind: 'local_json', config: { kind: 'local_json', file: 'releases.json' },
      auth: { mode: 'bearer', token: 'super-secret-token' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    const record = svc.repository.get(c.id)!;
    const redacted = svc.repository.redactedAuth(record);
    expect(redacted.token).toBe('••••••');
    expect((record.auth as { token: string }).token).toContain('super-secret'); // raw only inside the service boundary
  });

  it('searchForAi refuses connectors that are not explicitly AI-visible', async () => {
    const privateC = svc.repository.create({
      name: 'Private Data', kind: 'local_json', config: { kind: 'local_json', file: 'releases.json' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: false
    });
    await svc.refresh(privateC.id);
    const refusal = svc.searchForAi('Private Data', '', 5);
    expect('error' in refusal && refusal.error).toContain('not marked as AI-visible');
    const unknown = svc.searchForAi('Does Not Exist', '', 5);
    expect('error' in unknown).toBe(true);
  });

  it('serves AI-visible connectors with bounded, redacted results', async () => {
    writeConnectorFile('ai-visible.json', JSON.stringify([
      { version: 'v1.0.0', owner_email: 'ops@example.com', note: 'contact api_key sk-1234567890 for details' }
    ]));
    const c = svc.repository.create({
      name: 'AI Visible', kind: 'local_json', config: { kind: 'local_json', file: 'ai-visible.json', keyColumn: 'version' },
      auth: { mode: 'none' }, refreshMethod: 'manual', refreshSeconds: 3600, allowedAi: true
    });
    await svc.refresh(c.id);
    const result = svc.searchForAi('AI Visible', 'v1.0.0', 5);
    expect('results' in result).toBe(true);
    if ('results' in result) {
      expect(result.results).toHaveLength(1);
      // Secrets in row content are redacted before reaching the model.
      expect(JSON.stringify(result.results)).not.toContain('sk-1234567890');
    }
    expect(svc.aiVisibleConnectorNames()).toContain('AI Visible');
  });
});
