import { z } from 'zod';
import type { DB } from '../database/connection.js';
import type { CustomFieldType, CustomObjectLinkTarget } from '../../shared/workspace.js';

export interface CustomFieldDefRow {
  id: number;
  type_id: number;
  key: string;
  label: string;
  field_type: CustomFieldType;
  required: 0 | 1;
  options: string | null;
  sort_order: number;
}

export interface CustomObjectTypeRow {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  provenance: string;
}

export interface CustomObjectTypeDetail extends CustomObjectTypeRow {
  fields: { key: string; label: string; fieldType: CustomFieldType; required: boolean; options: string[] | null }[];
  object_count: number;
}

export interface CustomObjectRow {
  id: number;
  type_id: number;
  title: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  provenance: string;
}

export interface CustomObjectDetail extends CustomObjectRow {
  type_name: string;
  type_slug: string;
  links: { target_kind: CustomObjectLinkTarget; target_local_id: number; target_label: string | null; note: string | null; linked_at: string }[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomObjectValidationError';
  }
}

const FIELD_KEY_REGEX = /^[a-z][a-z0-9_]{0,58}$/;

/**
 * Custom objects (plan Phase 21): a local extensible object model. Types
 * define typed fields; VALUES are stored as JSON and validated by a Zod
 * schema built from the type's own field definitions at every write, so
 * user-defined data never becomes SQL. Filtering compiles to parameterized
 * json_extract fragments with a WHITELISTED field-key/operator vocabulary
 * (the viewEngine safety model). Core Help Scout entities are untouched -
 * relationships are edge rows in custom_object_links.
 */
export class CustomObjectRepository {
  constructor(private db: DB) {}

  // ---------------- Types ----------------

  createType(input: { name: string; description?: string | null; fields: { key: string; label: string; fieldType: CustomFieldType; required?: boolean; options?: string[] | null }[] }): CustomTypeCreateResult {
    const slug = input.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'type';
    if (!FIELD_KEY_REGEX.test(slug.replace(/-/g, '_')) && slug.length > 0 && !/^[a-z][a-z0-9-]{0,58}$/.test(slug)) {
      throw new ValidationError('Type name must start with a letter and contain only letters, digits and spaces');
    }
    const exists = this.db.prepare('SELECT 1 FROM custom_object_types WHERE slug = ? AND deleted_at IS NULL').get(slug);
    if (exists) throw new ValidationError(`A type with slug "${slug}" already exists`);
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO custom_object_types (name, slug, description) VALUES (?, ?, ?)')
        .run(input.name.trim(), slug, input.description ?? null);
      const typeId = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT INTO custom_object_fields (type_id, key, label, field_type, required, options, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
      input.fields.forEach((f, i) => {
        if (!FIELD_KEY_REGEX.test(f.key)) throw new ValidationError(`Field key "${f.key}" must be lowercase snake_case`);
        if (f.fieldType === 'select' && (f.options ?? []).length === 0) {
          throw new ValidationError(`Select field "${f.key}" needs at least one option`);
        }
        ins.run(typeId, f.key, f.label, f.fieldType, f.required ? 1 : 0, f.options ? JSON.stringify(f.options) : null, i);
      });
      return typeId;
    });
    return { id: tx() as number, slug };
  }

  patchType(typeId: number, input: { name?: string; description?: string | null; fields?: { key: string; label: string; fieldType: CustomFieldType; required?: boolean; options?: string[] | null }[] }): void {
    const existing = this.getType(typeId);
    if (!existing) throw new ValidationError('Type not found');
    // Removing or re-typing a field that stored values would corrupt data:
    // allow label/option/required changes and NEW fields only.
    const current = new Map(existing.fields.map((f) => [f.key, f]));
    for (const f of input.fields ?? []) {
      const c = current.get(f.key);
      if (c && c.fieldType !== f.fieldType) {
        throw new ValidationError(`Field "${f.key}" already exists as ${c.fieldType}; field types are immutable (existing objects store values)`);
      }
      if (f.fieldType === 'select' && (f.options ?? []).length === 0) {
        throw new ValidationError(`Select field "${f.key}" needs at least one option`);
      }
    }
    const tx = this.db.transaction(() => {
      if (input.name != null || input.description !== undefined) {
        this.db
          .prepare("UPDATE custom_object_types SET name = COALESCE(?, name), description = ?, updated_at = datetime('now') WHERE id = ?")
          .run(input.name ?? null, input.description ?? null, typeId);
      }
      if (input.fields) {
        this.db.prepare('DELETE FROM custom_object_fields WHERE type_id = ?').run(typeId);
        const ins = this.db.prepare('INSERT INTO custom_object_fields (type_id, key, label, field_type, required, options, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
        input.fields.forEach((f, i) => {
          if (!FIELD_KEY_REGEX.test(f.key)) throw new ValidationError(`Field key "${f.key}" must be lowercase snake_case`);
          ins.run(typeId, f.key, f.label, f.fieldType, f.required ? 1 : 0, f.options ? JSON.stringify(f.options) : null, i);
        });
        // Existing objects keep their stored JSON; re-validation happens on
        // the next edit. The list view tolerates unknown keys gracefully.
      }
    });
    tx();
  }

  listTypes(): CustomObjectTypeDetail[] {
    const types = this.db.prepare('SELECT * FROM custom_object_types WHERE deleted_at IS NULL ORDER BY name').all() as CustomFieldTypeRowSafe[];
    const fieldStmt = this.db.prepare('SELECT * FROM custom_object_fields WHERE type_id = ? ORDER BY sort_order, key');
    const countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM custom_objects WHERE type_id = ? AND deleted_at IS NULL');
    return types.map((t) => ({
      id: t.id, name: t.name, slug: t.slug, description: t.description, deleted_at: t.deleted_at,
      created_at: t.created_at, updated_at: t.updated_at, provenance: t.provenance,
      fields: (fieldStmt.all(t.id) as CustomFieldDefRow[]).map((f) => ({
        key: f.key, label: f.label, fieldType: f.field_type, required: f.required === 1,
        options: f.options ? (JSON.parse(f.options) as string[]) : null
      })),
      object_count: (countStmt.get(t.id) as { n: number }).n
    }));
  }

  getType(typeId: number): CustomObjectTypeDetail | undefined {
    const t = this.db.prepare('SELECT * FROM custom_object_types WHERE id = ? AND deleted_at IS NULL').get(typeId) as CustomFieldTypeRowSafe | undefined;
    if (!t) return undefined;
    const fields = (this.db.prepare('SELECT * FROM custom_object_fields WHERE type_id = ? ORDER BY sort_order, key').all(typeId) as CustomFieldDefRow[])
      .map((f) => ({ key: f.key, label: f.label, fieldType: f.field_type, required: f.required === 1, options: f.options ? (JSON.parse(f.options) as string[]) : null }));
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM custom_objects WHERE type_id = ? AND deleted_at IS NULL').get(typeId) as { n: number }).n;
    return { ...t, fields, object_count: n };
  }

  getTypeBySlug(slug: string): CustomObjectTypeDetail | undefined {
    const row = this.db.prepare('SELECT id FROM custom_object_types WHERE slug = ? AND deleted_at IS NULL').get(slug) as { id: number } | undefined;
    return row ? this.getType(row.id) : undefined;
  }

  deleteType(typeId: number): boolean {
    const existing = this.getType(typeId);
    if (!existing) return false;
    if (existing.object_count > 0) {
      throw new ValidationError(`Type "${existing.name}" still has ${existing.object_count} object(s); delete or move them first`);
    }
    this.db.prepare('DELETE FROM custom_object_types WHERE id = ?').run(typeId);
    return true;
  }

  // ---------------- Objects ----------------

  /** Build the dynamic Zod schema from a type's field definitions. */
  private buildSchema(fields: CustomObjectTypeDetail['fields']): z.ZodType<Record<string, unknown>> {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const f of fields) {
      let base: z.ZodTypeAny;
      switch (f.fieldType) {
        case 'text': base = z.string().max(300); break;
        case 'long_text': base = z.string().max(5000); break;
        case 'number': base = z.number().finite(); break;
        case 'date': base = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'Dates must be ISO (YYYY-MM-DD)'); break;
        case 'boolean': base = z.boolean(); break;
        case 'select': base = z.enum((f.options ?? ['__none__']) as [string, ...string[]]); break;
      }
      shape[f.key] = f.required ? base : base.nullish();
    }
    const schema = z.object(shape).strict();
    return schema;
  }

  createObject(input: { typeId: number; title: string; properties: Record<string, unknown>; links?: { targetKind: CustomObjectLinkTarget; targetLocalId: number; note?: string | null }[] }): CustomObjectDetail {
    const type = this.getType(input.typeId);
    if (!type) throw new ValidationError('Type not found');
    const parsed = this.buildSchema(type.fields).safeParse(input.properties ?? {});
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500));
    }
    const clean = this.stripNullish(parsed.data as Record<string, unknown>);
    const searchText = this.buildSearchText(input.title, clean);
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO custom_objects (type_id, title, properties, search_text) VALUES (?, ?, ?, ?)')
        .run(input.typeId, input.title, JSON.stringify(clean), searchText);
      const objectId = Number(r.lastInsertRowid);
      this.db.prepare('INSERT INTO fts_custom_objects (title, search_text, object_id) VALUES (?, ?, ?)').run(input.title, searchText, objectId);
      for (const link of input.links ?? []) {
        this.insertLink(objectId, link.targetKind, link.targetLocalId, link.note ?? null);
      }
      return objectId;
    });
    return this.getObject(tx() as number)!;
  }

  patchObject(objectId: number, input: { title?: string; properties?: Record<string, unknown>; links?: { targetKind: CustomObjectLinkTarget; targetLocalId: number; note?: string | null }[] }): CustomObjectDetail | undefined {
    const existing = this.getObject(objectId);
    if (!existing) return undefined;
    const type = this.getType(existing.type_id);
    if (!type) throw new ValidationError('Type not found');
    let clean: Record<string, unknown>;
    if (input.properties !== undefined) {
      // Merged with existing values so partial updates stay valid.
      const merged = { ...existing.properties, ...input.properties };
      const parsed = this.buildSchema(type.fields).safeParse(merged);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 500));
      }
      clean = this.stripNullish(parsed.data as Record<string, unknown>);
    } else {
      clean = existing.properties;
    }
    const title = input.title ?? existing.title;
    const searchText = this.buildSearchText(title, clean);
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE custom_objects SET title = ?, properties = ?, search_text = ?, updated_at = datetime('now') WHERE id = ?")
        .run(title, JSON.stringify(clean), searchText, objectId);
      this.db.prepare('DELETE FROM fts_custom_objects WHERE object_id = ?').run(objectId);
      this.db.prepare('INSERT INTO fts_custom_objects (title, search_text, object_id) VALUES (?, ?, ?)').run(title, searchText, objectId);
      if (input.links !== undefined) {
        this.db.prepare('DELETE FROM custom_object_links WHERE object_id = ?').run(objectId);
        for (const link of input.links) this.insertLink(objectId, link.targetKind, link.targetLocalId, link.note ?? null);
      }
    });
    tx();
    return this.getObject(objectId);
  }

  deleteObject(objectId: number): boolean {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare("UPDATE custom_objects SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL").run(objectId);
      this.db.prepare('DELETE FROM fts_custom_objects WHERE object_id = ?').run(objectId);
      return r;
    });
    return tx().changes > 0;
  }

  getObject(objectId: number): CustomObjectDetail | undefined {
    const row = this.db
      .prepare('SELECT o.*, t.name AS type_name, t.slug AS type_slug FROM custom_objects o JOIN custom_object_types t ON t.id = o.type_id WHERE o.id = ? AND o.deleted_at IS NULL')
      .get(objectId) as (Omit<CustomObjectDetail, 'properties' | 'links'> & { properties: string }) | undefined;
    if (!row) return undefined;
    const links = (this.db.prepare('SELECT target_kind, target_local_id, note, linked_at FROM custom_object_links WHERE object_id = ?').all(objectId) as { target_kind: CustomObjectLinkTarget; target_local_id: number; note: string | null; linked_at: string }[])
      .map((l) => ({ ...l, target_label: this.linkLabel(l.target_kind, l.target_local_id) }));
    let properties: Record<string, unknown> = {};
    try { properties = JSON.parse(row.properties) as Record<string, unknown>; } catch { properties = {}; }
    return { ...row, properties, links };
  }

  listObjects(filters: { typeId?: number; query?: string; limit?: number; offset?: number } = {}): { objects: CustomObjectRow[]; total: number } {
    const where: string[] = ['o.deleted_at IS NULL'];
    const params: unknown[] = [];
    if (filters.typeId) { where.push('o.type_id = ?'); params.push(filters.typeId); }
    if (filters.query) { where.push('(o.title LIKE ? OR o.search_text LIKE ?)'); params.push(`%${filters.query}%`, `%${filters.query}%`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);
    const rows = (this.db
      .prepare(`SELECT o.id, o.type_id, o.title, o.properties, o.created_at, o.updated_at, o.provenance FROM custom_objects o ${whereSql} ORDER BY o.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as (CustomObjectRow & { properties: string })[])
      .map((r) => {
        let properties: Record<string, unknown> = {};
        try { properties = JSON.parse(r.properties) as Record<string, unknown>; } catch { properties = {}; }
        return { ...r, properties };
      });
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM custom_objects o ${whereSql}`).get(...params) as { n: number }).n;
    return { objects: rows, total };
  }

  /** FTS search (quoted-prefix terms, the knowledge search safety pattern). */
  searchObjects(query: string, typeId: number | null, limit = 10): (CustomObjectRow & { type_name: string; snippet: string })[] {
    const tokens = query.replace(/["*()]/g, ' ').split(/\s+/).filter((t) => t.length > 1).slice(0, 6).map((t) => `"${t}"*`).join(' ');
    if (!tokens) return [];
    const sql = `
      SELECT o.id, o.type_id, o.title, o.properties, o.created_at, o.updated_at, o.provenance,
        t.name AS type_name,
        snippet(fts_custom_objects, 1, '[', ']', '...', 12) AS snippet
      FROM fts_custom_objects f
      JOIN custom_objects o ON o.id = f.object_id AND o.deleted_at IS NULL
      JOIN custom_object_types t ON t.id = o.type_id
      WHERE fts_custom_objects MATCH ? ${typeId ? 'AND o.type_id = ?' : ''}
      ORDER BY rank LIMIT ?`;
    const params: unknown[] = typeId ? [tokens, typeId, Math.min(50, limit)] : [tokens, Math.min(50, limit)];
    return (this.db.prepare(sql).all(...params) as (CustomObjectRow & { properties: string; type_name: string; snippet: string })[])
      .map((r) => {
        let properties: Record<string, unknown> = {};
        try { properties = JSON.parse(r.properties) as Record<string, unknown>; } catch { properties = {}; }
        const { properties: _p, ...rest } = r;
        return { ...rest, properties };
      });
  }

  // ---------------- Links ----------------

  private insertLink(objectId: number, targetKind: CustomObjectLinkTarget, targetLocalId: number, note: string | null): void {
    if (!this.linkTargetExists(targetKind, targetLocalId)) {
      throw new ValidationError(`${targetKind} #${targetLocalId} does not exist`);
    }
    this.db.prepare('INSERT OR IGNORE INTO custom_object_links (object_id, target_kind, target_local_id, note) VALUES (?, ?, ?, ?)').run(objectId, targetKind, targetLocalId, note);
  }

  addLink(objectId: number, targetKind: CustomObjectLinkTarget, targetLocalId: number, note: string | null): boolean {
    const obj = this.getObject(objectId);
    if (!obj) throw new ValidationError('Object not found');
    this.insertLink(objectId, targetKind, targetLocalId, note);
    return true;
  }

  removeLink(objectId: number, targetKind: CustomObjectLinkTarget, targetLocalId: number): boolean {
    return this.db.prepare('DELETE FROM custom_object_links WHERE object_id = ? AND target_kind = ? AND target_local_id = ?').run(objectId, targetKind, targetLocalId).changes > 0;
  }

  /** Reverse lookup: objects linked to a target (customer/org/conversation/...). */
  objectsForTarget(targetKind: CustomObjectLinkTarget, targetLocalId: number, limit = 20): (CustomObjectRow & { type_name: string })[] {
    return this.db
      .prepare(
        `SELECT o.id, o.type_id, o.title, o.properties, o.created_at, o.updated_at, o.provenance, t.name AS type_name
         FROM custom_object_links l
         JOIN custom_objects o ON o.id = l.object_id AND o.deleted_at IS NULL
         JOIN custom_object_types t ON t.id = o.type_id
         WHERE l.target_kind = ? AND l.target_local_id = ?
         ORDER BY o.updated_at DESC LIMIT ?`
      )
      .all(targetKind, targetLocalId, Math.min(100, limit))
      .map((r) => {
        const row = r as CustomObjectRow & { properties: string; type_name: string };
        let properties: Record<string, unknown> = {};
        try { properties = JSON.parse(row.properties) as Record<string, unknown>; } catch { properties = {}; }
        return { ...row, properties };
      });
  }

  private linkTargetExists(kind: CustomObjectLinkTarget, id: number): boolean {
    const table = { customer: 'customers', organization: 'organizations', conversation: 'conversations', known_issue: 'known_issues', incident: 'incidents', campaign: 'outreach_campaigns' }[kind];
    if (!table) return false;
    if (kind === 'customer' || kind === 'organization' || kind === 'conversation' || kind === 'known_issue' || kind === 'incident' || kind === 'campaign') {
      const deleted = kind === 'customer' || kind === 'organization' ? ' AND deleted_at IS NULL' : kind === 'conversation' ? ' AND deleted_at IS NULL' : '';
      return this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?${deleted}`).get(id) != null;
    }
    return false;
  }

  private linkLabel(kind: CustomObjectLinkTarget, id: number): string | null {
    switch (kind) {
      case 'customer': return ((this.db.prepare("SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS label FROM customers WHERE id = ?").get(id) as { label: string } | undefined)?.label?.trim()) || `customer #${id}`;
      case 'organization': return (this.db.prepare('SELECT name AS label FROM organizations WHERE id = ?').get(id) as { label: string } | undefined)?.label ?? `organization #${id}`;
      case 'conversation': return `#${(this.db.prepare('SELECT number FROM conversations WHERE id = ?').get(id) as { number: number } | undefined)?.number ?? id}`;
      case 'known_issue': return (this.db.prepare('SELECT title AS label FROM known_issues WHERE id = ?').get(id) as { label: string } | undefined)?.label ?? `known issue #${id}`;
      case 'incident': return (this.db.prepare('SELECT code || \': \' || title AS label FROM incidents WHERE id = ?').get(id) as { label: string } | undefined)?.label ?? `incident #${id}`;
      case 'campaign': return (this.db.prepare('SELECT name AS label FROM outreach_campaigns WHERE id = ?').get(id) as { label: string } | undefined)?.label ?? `campaign #${id}`;
    }
  }

  // ---------------- Reporting ----------------

  report(): { types: { id: number; name: string; slug: string; object_count: number; link_counts: Record<string, number> }[]; total_objects: number; total_links: number } {
    const types = this.listTypes();
    const linkStmt = this.db.prepare("SELECT target_kind, COUNT(*) AS n FROM custom_object_links l JOIN custom_objects o ON o.id = l.object_id AND o.deleted_at IS NULL JOIN custom_object_types t ON t.id = o.type_id WHERE t.id = ? GROUP BY target_kind");
    const out = types.map((t) => {
      const links: Record<string, number> = {};
      for (const row of linkStmt.all(t.id) as { target_kind: string; n: number }[]) {
        links[row.target_kind] = row.n;
      }
      return { id: t.id, name: t.name, slug: t.slug, object_count: t.object_count, link_counts: links };
    });
    const totalObjects = (this.db.prepare('SELECT COUNT(*) AS n FROM custom_objects WHERE deleted_at IS NULL').get() as { n: number }).n;
    const totalLinks = (this.db.prepare('SELECT COUNT(*) AS n FROM custom_object_links').get() as { n: number }).n;
    return { types: out, total_objects: totalObjects, total_links: totalLinks };
  }

  // ---------------- helpers ----------------

  private stripNullish(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }

  private buildSearchText(title: string, properties: Record<string, unknown>): string {
    const parts: string[] = [title];
    for (const v of Object.values(properties)) {
      if (v == null) continue;
      if (typeof v === 'string') parts.push(v);
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    }
    return parts.join(' ').slice(0, 5000);
  }
}

type CustomFieldTypeRowSafe = CustomObjectTypeRow;

export interface CustomTypeCreateResult { id: number; slug: string }
