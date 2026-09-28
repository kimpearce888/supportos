import type { DB } from '../connection.js';
import { jsonGet } from './helpers.js';
import { AI_ATTRIBUTE_CATALOG, AI_ATTRIBUTE_KEYS, AI_ATTRIBUTE_SCHEMA_VERSION, type AiAttributeKey, type AiAttributeValueType } from '../../../shared/constants.js';
import type { AiAttributeRow, AiAttributeEvidence, AiAttributeDistribution } from '../../../shared/types.js';

interface AttributeRecord {
  conversation_id: number;
  attribute: AiAttributeKey;
  value: string;
  value_type: AiAttributeValueType;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source: 'deterministic' | 'ai';
  evidence: AiAttributeEvidence[];
  run_id?: number | null;
}

const CATALOG_BY_KEY = new Map<string, (typeof AI_ATTRIBUTE_CATALOG)[number]>(AI_ATTRIBUTE_CATALOG.map((d) => [d.key, d]));

export function attributeDefinition(key: string): (typeof AI_ATTRIBUTE_CATALOG)[number] | undefined {
  return CATALOG_BY_KEY.get(key);
}

/**
 * v1.9.0 (M3, plan Phase 16): first-class local AI attributes.
 * VERSIONED via superseded_at (full history preserved); current =
 * superseded_at IS NULL; a missing row IS the honest 'unknown'.
 */
export class AttributeRepository {
  constructor(private db: DB) {}

  /** Write a full attribute snapshot for one conversation (one transaction). */
  saveSnapshot(conversationId: number, records: AttributeRecord[], runId: number | null): void {
    const tx = this.db.transaction(() => {
      // The snapshot is AUTHORITATIVE: retire every current row first so keys
      // that produced no record this round honestly read 'unknown' again
      // (e.g. AI offline after previously extracting product). History is
      // preserved - versioning, plan Phase 16.
      this.db
        .prepare("UPDATE ai_attributes SET superseded_at = datetime('now') WHERE conversation_id = ? AND superseded_at IS NULL")
        .run(conversationId);
      for (const r of records) {
        const def = CATALOG_BY_KEY.get(r.attribute);
        if (!def) continue; // closed catalog: unknown keys are dropped, never stored
        if (r.value_type !== def.value_type) continue; // type disagreement = do not store
        if (def.value_type === 'enum' && def.values && !def.values.includes(r.value)) continue; // closed vocabulary
        if (def.value_type === 'number' && !Number.isFinite(Number(r.value))) continue;
        if (def.value_type === 'boolean' && r.value !== 'true' && r.value !== 'false') continue;
        this.db
          .prepare(
            `INSERT INTO ai_attributes (conversation_id, attribute, value, value_type, confidence, source, evidence, run_id, schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(conversationId, r.attribute, r.value, r.value_type, r.confidence, r.source, JSON.stringify(r.evidence ?? []).slice(0, 4000), r.run_id ?? runId, AI_ATTRIBUTE_SCHEMA_VERSION);
      }
    });
    tx();
  }

  /** Current rows for one conversation (empty array = all unknown). */
  currentForConversation(conversationId: number): AiAttributeRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.conversation_id, a.attribute, a.value, a.value_type, a.confidence, a.source, a.evidence, a.run_id, a.schema_version, a.computed_at, c.number AS conversation_number
         FROM ai_attributes a JOIN conversations c ON c.id = a.conversation_id
         WHERE a.conversation_id = ? AND a.superseded_at IS NULL`
      )
      .all(conversationId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Full version history for one attribute (newest first). */
  history(conversationId: number, attribute: AiAttributeKey, limit = 50): AiAttributeRow[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.conversation_id, a.attribute, a.value, a.value_type, a.confidence, a.source, a.evidence, a.run_id, a.schema_version, a.computed_at, c.number AS conversation_number, a.superseded_at
         FROM ai_attributes a JOIN conversations c ON c.id = a.conversation_id
         WHERE a.conversation_id = ? AND a.attribute = ?
         ORDER BY a.id DESC LIMIT ?`
      )
      .all(conversationId, attribute, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Conversations currently matching an attribute test (searchable /
   * drillable). Attribute must be in the closed catalog (else empty).
   */
  conversationsMatching(attribute: string, op: 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'unknown', value: string, limit: number): { conversation_id: number; number: number; subject: string | null; value: string; confidence: string; source: string; computed_at: string }[] {
    const def = CATALOG_BY_KEY.get(attribute);
    if (!def) return [];
    const cap = Math.min(200, Math.max(1, limit));
    if (op === 'unknown') {
      return (this.db
        .prepare(
          `SELECT c.id AS conversation_id, c.number, c.subject, '' AS value, 'unknown' AS confidence, 'none' AS source, '' AS computed_at
           FROM conversations c
           WHERE c.deleted_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM ai_attributes a WHERE a.conversation_id = c.id AND a.attribute = ? AND a.superseded_at IS NULL
           ) ORDER BY c.number LIMIT ?`
        )
        .all(attribute, cap) as Record<string, unknown>[]).map(mapMatch);
    }
    const table = def.value_type === 'number' ? 'CAST(a.value AS REAL)' : 'LOWER(a.value)';
    const target = def.value_type === 'number' ? Number(value) : value.toLowerCase();
    if (def.value_type === 'number' && !Number.isFinite(target)) return [];
    let cmp: string;
    switch (op) {
      case 'equals': cmp = def.value_type === 'number' ? '= ?' : '= ?'; break;
      case 'not_equals': cmp = def.value_type === 'number' ? '!= ?' : '!= ?'; break;
      case 'contains': cmp = "LIKE ? ESCAPE '\\'"; break;
      case 'gt': cmp = '> ?'; break;
      case 'gte': cmp = '>= ?'; break;
      case 'lt': cmp = '< ?'; break;
      case 'lte': cmp = '<= ?'; break;
      default: return [];
    }
    let param: unknown = target;
    if (op === 'contains') param = `%${String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT a.conversation_id, c.number, c.subject, a.value, a.confidence, a.source, a.computed_at
         FROM ai_attributes a JOIN conversations c ON c.id = a.conversation_id
         WHERE a.attribute = ? AND a.superseded_at IS NULL AND c.deleted_at IS NULL AND ${table} ${cmp}
         ORDER BY c.number LIMIT ?`
      )
      .all(attribute, param, cap) as Record<string, unknown>[];
    return rows.map(mapMatch);
  }

  /** Distribution + honest coverage per attribute over non-deleted conversations. */
  distributions(): AiAttributeDistribution[] {
    const total = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL').get() as { n: number }).n
    );
    return AI_ATTRIBUTE_CATALOG.map((def) => {
      const rows = this.db
        .prepare(
          `SELECT value, COUNT(DISTINCT conversation_id) AS count FROM ai_attributes
           WHERE attribute = ? AND superseded_at IS NULL GROUP BY value ORDER BY count DESC, value`
        )
        .all(def.key) as { value: string; count: number }[];
      const known = rows.reduce((a, r) => a + r.count, 0);
      return {
        attribute: def.key,
        label: def.label,
        value_type: def.value_type,
        total_conversations: total,
        known,
        unknown: Math.max(0, total - known),
        values: rows.slice(0, 25).map((r) => ({ value: r.value, count: r.count }))
      };
    });
  }

  /** Distinct current values for one attribute (autocomplete for filters). */
  distinctValues(attribute: string, limit = 50): string[] {
    if (!CATALOG_BY_KEY.has(attribute)) return [];
    const rows = this.db
      .prepare(
        `SELECT DISTINCT value FROM ai_attributes WHERE attribute = ? AND superseded_at IS NULL ORDER BY value LIMIT ?`
      )
      .all(attribute, Math.min(200, Math.max(1, limit))) as { value: string }[];
    return rows.map((r) => r.value);
  }

  /** Conversations with at least one current attribute row (backfill targeting). */
  conversationsWithAttributes(limit = 1000): number[] {
    return (this.db
      .prepare('SELECT DISTINCT conversation_id FROM ai_attributes WHERE superseded_at IS NULL LIMIT ?')
      .all(limit) as { conversation_id: number }[]).map((r) => r.conversation_id);
  }

  private mapRow(r: Record<string, unknown>): AiAttributeRow {
    return {
      id: Number(r.id),
      conversation_id: Number(r.conversation_id),
      conversation_number: r.conversation_number == null ? null : Number(r.conversation_number),
      attribute: r.attribute as AiAttributeKey,
      value: String(r.value),
      value_type: r.value_type as AiAttributeValueType,
      confidence: r.confidence as AiAttributeRow['confidence'],
      source: r.source as AiAttributeRow['source'],
      evidence: jsonGet<AiAttributeEvidence[]>(r.evidence, []),
      run_id: r.run_id == null ? null : Number(r.run_id),
      schema_version: String(r.schema_version),
      computed_at: String(r.computed_at)
    };
  }
}

function mapMatch(r: Record<string, unknown>): { conversation_id: number; number: number; subject: string | null; value: string; confidence: string; source: string; computed_at: string } {
  return {
    conversation_id: Number(r.conversation_id),
    number: Number(r.number),
    subject: r.subject == null ? null : String(r.subject),
    value: String(r.value ?? ''),
    confidence: String(r.confidence ?? ''),
    source: String(r.source ?? ''),
    computed_at: String(r.computed_at ?? '')
  };
}

export { AI_ATTRIBUTE_KEYS };
