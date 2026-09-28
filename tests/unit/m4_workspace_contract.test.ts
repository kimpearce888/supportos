import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../src/server/connectors/csv.js';
import { z } from 'zod';
import { customObjectTypeCreateSchema, customFieldDefSchema, connectorConfigSchema, connectorCreateSchema } from '../../src/shared/workspace.js';

/**
 * v2.0.0 (M4) unit tests: the CSV parser (RFC-4180-ish), the custom object
 * contract (field definitions, dynamic validation semantics) and the
 * connector config schema (closed unions, jail-path shape, auth modes).
 */
describe('parseCsv', () => {
  it('parses plain rows with CRLF and LF endings', () => {
    const { headers, rows } = parseCsv('version,channel,released\r\nv4.12.0,production,2026-01-01\nv4.11.2,production,2025-12-01');
    expect(headers).toEqual(['version', 'channel', 'released']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ version: 'v4.12.0', channel: 'production', released: '2026-01-01' });
  });

  it('handles quoted fields, escaped quotes and commas inside quotes', () => {
    const { headers, rows } = parseCsv('name,notes\n"Smith, John","said ""hi"" twice"');
    expect(headers).toEqual(['name', 'notes']);
    expect(rows[0]?.name).toBe('Smith, John');
    expect(rows[0]?.notes).toBe('said "hi" twice');
  });

  it('drops a trailing empty record from the final newline', () => {
    const { rows } = parseCsv('a,b\n1,2\n');
    expect(rows).toHaveLength(1);
  });

  it('returns empty for empty input and caps max rows', () => {
    expect(parseCsv('').rows).toEqual([]);
    const big = parseCsv('a\n' + Array.from({ length: 20 }, (_, i) => `${i}`).join('\n'), 5);
    expect(big.rows.length).toBeLessThanOrEqual(5);
  });
});

describe('custom object contract', () => {
  it('accepts a valid type with typed fields', () => {
    const r = customObjectTypeCreateSchema.safeParse({
      name: 'Account',
      fields: [
        { key: 'plan_tier', label: 'Plan tier', fieldType: 'select', required: true, options: ['free', 'growth'] },
        { key: 'mrr', label: 'MRR', fieldType: 'number' }
      ]
    });
    expect(r.success).toBe(true);
  });

  it('rejects bad field keys, missing select options and duplicate keys', () => {
    expect(customFieldDefSchema.safeParse({ key: 'Bad-Key', label: 'x', fieldType: 'text' }).success).toBe(false);
    expect(customFieldDefSchema.safeParse({ key: '2abc', label: 'x', fieldType: 'text' }).success).toBe(false);
    expect(customFieldDefSchema.safeParse({ key: 'tier', label: 'x', fieldType: 'select' }).success).toBe(false); // no options
    expect(customObjectTypeCreateSchema.safeParse({
      name: 'T',
      fields: [
        { key: 'a', label: 'A', fieldType: 'text' },
        { key: 'a', label: 'A2', fieldType: 'text' }
      ]
    }).success).toBe(false);
  });

  it('rejects unknown field types (closed union)', () => {
    expect(customFieldDefSchema.safeParse({ key: 'x', label: 'x', fieldType: 'json' }).success).toBe(false);
  });

  it('dynamic value schema semantics: optional fields accept null, required reject missing', () => {
    // The exact buildSchema logic the repository uses at write time.
    const schema = z.object({ mrr: z.number().finite().nullish(), tier: z.enum(['a', 'b'] as [string, ...string[]]) }).strict();
    expect(schema.safeParse({ tier: 'a' }).success).toBe(true);
    expect(schema.safeParse({ tier: 'a', mrr: null }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ tier: 'c' }).success).toBe(false);
    expect(schema.safeParse({ tier: 'a', extra: 1 }).success).toBe(false);
  });
});

describe('connector config contract', () => {
  it('accepts all four kinds with their required shape', () => {
    expect(connectorConfigSchema.safeParse({ kind: 'local_json', file: 'data.json' }).success).toBe(true);
    expect(connectorConfigSchema.safeParse({ kind: 'csv', file: 'rows.csv', keyColumn: 'id' }).success).toBe(true);
    expect(connectorConfigSchema.safeParse({ kind: 'sqlite', file: 'db.sqlite', table: 'releases' }).success).toBe(true);
    expect(connectorConfigSchema.safeParse({ kind: 'http', url: 'https://api.example.com/data' }).success).toBe(true);
  });

  it('rejects absolute paths, traversal, wrong-kind fields and unknown kinds', () => {
    expect(connectorConfigSchema.safeParse({ kind: 'csv', file: '/etc/passwd' }).success).toBe(false);
    expect(connectorConfigSchema.safeParse({ kind: 'csv', file: '../secrets.json' }).success).toBe(false);
    expect(connectorConfigSchema.safeParse({ kind: 'http', file: 'x.json' }).success).toBe(false); // http needs url
    expect(connectorConfigSchema.safeParse({ kind: 'local_json', url: 'https://x' }).success).toBe(false); // file kind needs file
    expect(connectorConfigSchema.safeParse({ kind: 'grpc', url: 'x' }).success).toBe(false);
  });

  it('auth is a closed discriminated union', () => {
    const ok = connectorCreateSchema.safeParse({
      name: 'X', config: { kind: 'http', url: 'https://api.example.com' },
      auth: { mode: 'header', headerName: 'X-API-Key', headerValue: 'secret' },
      refreshMethod: 'interval', refreshSeconds: 120, allowedAi: false
    });
    expect(ok.success).toBe(true);
    expect(connectorCreateSchema.safeParse({ name: 'X', config: { kind: 'http', url: 'https://x.example.com' }, auth: { mode: 'header', headerValue: 'v' } }).success).toBe(false);
    expect(connectorCreateSchema.safeParse({ name: 'X', config: { kind: 'http', url: 'https://x.example.com' }, auth: { mode: 'token' } }).success).toBe(false);
    expect(connectorCreateSchema.safeParse({ name: 'X', config: { kind: 'http', url: 'https://x.example.com' }, refreshSeconds: 10 }).success).toBe(false); // min 60
  });
});
