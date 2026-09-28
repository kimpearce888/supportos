import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations } from '../../src/server/database/migrations/index.js';
import { CustomObjectRepository, ValidationError } from '../../src/server/customobjects/customObjectsRepo.js';

/**
 * v2.0.0 (M4) integration tests, part 2 (plan Phase 21): the custom object
 * system - typed field definitions, dynamic Zod validation of stored values
 * (user data never becomes SQL), relationships as link edges, FTS search and
 * the per-type report.
 */

let db: ReturnType<typeof openTestDatabase>;
let repo: CustomObjectRepository;

beforeAll(() => {
  db = openTestDatabase();
  applyMigrations(db);
  repo = new CustomObjectRepository(db);
  db.prepare("INSERT INTO mailboxes (remote_id, name, slug) VALUES (601, 'Support', 'support')").run();
  db.prepare("INSERT INTO customers (remote_id, first_name) VALUES (9501, 'Ada')").run();
  db.prepare("INSERT INTO organizations (remote_id, name) VALUES (7501, 'Compute Inc')").run();
});

afterAll(() => {
  closeDatabase(db);
});

describe('custom object types (Phase 21)', () => {
  it('creates a type with typed fields and a slug', () => {
    const created = repo.createType({
      name: 'Account',
      description: 'Commercial record',
      fields: [
        { key: 'plan_tier', label: 'Plan tier', fieldType: 'select', required: true, options: ['free', 'growth', 'enterprise'] },
        { key: 'mrr', label: 'MRR', fieldType: 'number' },
        { key: 'renewal_date', label: 'Renewal', fieldType: 'date' },
        { key: 'vip', label: 'VIP', fieldType: 'boolean' }
      ]
    });
    expect(created.slug).toBe('account');
    const t = repo.getType(created.id)!;
    expect(t.fields).toHaveLength(4);
    expect(t.fields[0]?.options).toEqual(['free', 'growth', 'enterprise']);
    expect(repo.getTypeBySlug('account')?.id).toBe(created.id);
  });

  it('rejects duplicate slugs, bad keys and missing select options', () => {
    expect(() => repo.createType({ name: 'Account', fields: [{ key: 'x', label: 'X', fieldType: 'text' }] })).toThrow(ValidationError);
    expect(() => repo.createType({ name: 'Bad Keys', fields: [{ key: 'Not-Snake', label: 'X', fieldType: 'text' }] })).toThrow(ValidationError);
    expect(() => repo.createType({ name: 'No Options', fields: [{ key: 'tier', label: 'T', fieldType: 'select' }] })).toThrow(ValidationError);
  });

  it('field types are immutable once objects exist; labels/required can change', () => {
    const t = repo.createType({ name: 'Mutable', fields: [{ key: 'amount', label: 'Amount', fieldType: 'number' }] });
    repo.patchType(t.id, { fields: [{ key: 'amount', label: 'Amount USD', fieldType: 'number', required: true }] });
    expect(repo.getType(t.id)?.fields[0]?.label).toBe('Amount USD');
    expect(() => repo.patchType(t.id, { fields: [{ key: 'amount', label: 'Amount', fieldType: 'text' }] })).toThrow(ValidationError);
  });

  it('refuses to delete a type that still has objects (409 semantics)', () => {
    const t = repo.createType({ name: 'Occupied', fields: [{ key: 'name', label: 'Name', fieldType: 'text', required: true }] });
    repo.createObject({ typeId: t.id, title: 'One', properties: { name: 'x' } });
    expect(() => repo.deleteType(t.id)).toThrow(ValidationError);
    const empty = repo.createType({ name: 'Empty', fields: [{ key: 'name', label: 'Name', fieldType: 'text' }] });
    expect(repo.deleteType(empty.id)).toBe(true);
  });
});

describe('custom objects (Phase 21)', () => {
  it('validates property values against the dynamic schema at write time', () => {
    const t = repo.createType({
      name: 'Sub',
      fields: [
        { key: 'tier', label: 'Tier', fieldType: 'select', required: true, options: ['a', 'b'] },
        { key: 'seats', label: 'Seats', fieldType: 'number' },
        { key: 'expires', label: 'Expires', fieldType: 'date' }
      ]
    });
    const ok = repo.createObject({ typeId: t.id, title: 'Acme sub', properties: { tier: 'a', seats: 12, expires: '2026-01-01' } });
    expect(ok.properties).toEqual({ tier: 'a', seats: 12, expires: '2026-01-01' });
    // Missing required, bad enum, wrong type, bad date, unknown key.
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: {} })).toThrow(ValidationError);
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: { tier: 'c' } })).toThrow(ValidationError);
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: { tier: 'a', seats: 'many' } })).toThrow(ValidationError);
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: { tier: 'a', expires: 'tomorrow' } })).toThrow(ValidationError);
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: { tier: 'a', rogue: 1 } })).toThrow(ValidationError);
  });

  it('links objects to customers/organizations and validates target existence', () => {
    const t = repo.createType({ name: 'Linked', fields: [{ key: 'name', label: 'Name', fieldType: 'text', required: true }] });
    const obj = repo.createObject({
      typeId: t.id,
      title: 'Compute account',
      properties: { name: 'compute' },
      links: [
        { targetKind: 'customer', targetLocalId: 1 },
        { targetKind: 'organization', targetLocalId: 1 }
      ]
    });
    expect(obj.links).toHaveLength(2);
    expect(obj.links.find((l) => l.target_kind === 'customer')?.target_label).toContain('Ada');
    // Unknown target -> ValidationError (a 422 in the route, never an FK 500).
    expect(() => repo.createObject({ typeId: t.id, title: 'x', properties: { name: 'x' }, links: [{ targetKind: 'customer', targetLocalId: 999 }] })).toThrow(ValidationError);
    // Reverse lookup works.
    expect(repo.objectsForTarget('customer', 1).map((o) => o.title)).toContain('Compute account');
    expect(repo.removeLink(obj.id, 'customer', 1)).toBe(true);
    expect(repo.objectsForTarget('customer', 1)).toHaveLength(0);
  });

  it('indexes objects into FTS and searches them', () => {
    const t = repo.createType({ name: 'Searchable', fields: [{ key: 'note', label: 'Note', fieldType: 'text' }] });
    repo.createObject({ typeId: t.id, title: 'Alpha deployment', properties: { note: 'production cluster frankfurt' } });
    repo.createObject({ typeId: t.id, title: 'Beta deployment', properties: { note: 'staging cluster berlin' } });
    const hits = repo.searchObjects('frankfurt production', null, 5);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.title).toBe('Alpha deployment');
    expect(hits[0]?.type_name).toBe('Searchable');
    // Hostile query characters are neutralized (quoted-prefix pattern).
    expect(repo.searchObjects('" * ( ) OR DROP', null, 5)).toBeInstanceOf(Array);
  });

  it('soft-deletes objects (FTS removed, rows kept) and reports per-type counts', () => {
    const t = repo.createType({ name: 'Deletable', fields: [{ key: 'name', label: 'Name', fieldType: 'text', required: true }] });
    const a = repo.createObject({ typeId: t.id, title: 'Keep me', properties: { name: 'keep' } });
    const b = repo.createObject({ typeId: t.id, title: 'Delete me searchable-token-xyz', properties: { name: 'delete' } });
    expect(repo.deleteObject(b.id)).toBe(true);
    expect(repo.getObject(b.id)).toBeUndefined();
    expect(repo.getObject(a.id)?.title).toBe('Keep me');
    expect(repo.searchObjects('searchable-token-xyz', null, 5)).toHaveLength(0);
    const report = repo.report();
    const entry = report.types.find((x) => x.name === 'Deletable');
    expect(entry?.object_count).toBe(1);
    expect(report.total_objects).toBeGreaterThan(0);
  });
});
