import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { SavedInboxView, ViewDefinition } from '../../../shared/activity.js';

/**
 * InboxViewRepository (v1.7.0): persistence for saved Inbox Views.
 * Definitions are stored as JSON condition trees - NEVER SQL (plan Phase 6).
 * The ViewEngine compiles them at evaluation time, so a view with "today"
 * filters is re-resolved on every open (dynamically meaningful).
 *
 * Kept deliberately separate from the v1.5.0 Outreach Saved Segments
 * (segments table): different shape (conversation vs contact semantics),
 * different surface (Inbox vs Outreach). One shared philosophy, two stores.
 */
export class InboxViewRepository {
  constructor(private db: DB) {}

  listViews(): SavedInboxView[] {
    return (this.db
      .prepare('SELECT id, name, description, definition, sort_order, folder, version, created_at, updated_at FROM inbox_views ORDER BY sort_order ASC, name ASC')
      .all() as ViewRow[])
      .map(rowToView);
  }

  getView(id: number): SavedInboxView | undefined {
    const row = this.db
      .prepare('SELECT id, name, description, definition, sort_order, folder, version, created_at, updated_at FROM inbox_views WHERE id = ?')
      .get(id) as ViewRow | undefined;
    return row ? rowToView(row) : undefined;
  }

  createView(input: { name: string; description?: string | null; definition: ViewDefinition; sort_order?: number; folder?: string | null }): SavedInboxView {
    const result = this.db
      .prepare('INSERT INTO inbox_views (name, description, definition, sort_order, folder) VALUES (?, ?, ?, ?, ?)')
      .run(input.name, input.description ?? null, JSON.stringify(input.definition), input.sort_order ?? 0, input.folder ?? null);
    return this.getView(Number(result.lastInsertRowid))!;
  }

  updateView(id: number, patch: { name?: string; description?: string | null; definition?: ViewDefinition; sort_order?: number; folder?: string | null }): SavedInboxView | undefined {
    const existing = this.getView(id);
    if (!existing) return undefined;
    const definitionChanged = patch.definition !== undefined && JSON.stringify(patch.definition) !== JSON.stringify(existing.definition);
    this.db
      .prepare(
        `UPDATE inbox_views SET
           name = ?, description = ?, definition = ?, sort_order = ?, folder = ?,
           version = CASE WHEN ? THEN version + 1 ELSE version END,
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.description !== undefined ? patch.description : existing.description,
        patch.definition !== undefined ? JSON.stringify(patch.definition) : JSON.stringify(existing.definition),
        patch.sort_order ?? existing.sort_order,
        patch.folder !== undefined ? patch.folder : existing.folder,
        definitionChanged ? 1 : 0,
        nowIso(),
        id
      );
    return this.getView(id);
  }

  deleteView(id: number): boolean {
    const result = this.db.prepare('DELETE FROM inbox_views WHERE id = ?').run(id);
    return result.changes > 0;
  }
}

interface ViewRow {
  id: number;
  name: string;
  description: string | null;
  definition: string;
  sort_order: number;
  folder: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToView(row: ViewRow): SavedInboxView {
  let definition: ViewDefinition;
  try {
    definition = JSON.parse(row.definition) as ViewDefinition;
  } catch {
    // Corrupt definition: surface an empty-but-valid tree; the API flags it.
    definition = { combinator: 'all', conditions: [] };
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    definition,
    sort_order: row.sort_order,
    folder: row.folder,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
