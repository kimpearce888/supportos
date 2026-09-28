import type { DB } from '../database/connection.js';
import type { ChatMessage } from '../integrations/lmstudio/lmStudioClient.js';
import type { SegmentDefinition, SegmentNode } from '../../shared/segmentation.js';
import { AI_ATTRIBUTE_CATALOG } from '../../shared/constants.js';

/**
 * Natural-language -> segment definition (v2.1.0, plan Phase 31).
 *
 * "AI may translate natural-language requests into a structured segment
 * definition. The deterministic segment engine executes the actual
 * selection. Never let an LLM directly decide final recipients."
 *
 * This service asks the LOCAL model for a condition tree, then validates it
 * against the closed kind catalog with a strict structural validator. The
 * validated tree is IMMEDIATELY evaluated by the deterministic SegmentEngine
 * - the preview returned to the user is the engine's output, not the
 * model's. Nothing is saved automatically: the user must explicitly save
 * the segment (and campaigns snapshot recipients through the normal
 * creation flow with human review).
 */

export type SuggestChatFn = (opts: { messages: ChatMessage[]; temperature?: number; maxTokens?: number; jsonMode?: boolean }) => Promise<{ content: string | null; model: string; latencyMs: number }>;

const KNOWN_CONDITION_KINDS = new Set([
  'customer_property', 'contact', 'ticket', 'history', 'history_tag',
  'organization_property', 'history_issue', 'incident_exposure', 'campaign_history',
  'support_health', 'custom_object_link', 'customer_event'
]);

const KNOWN_CONTACT_FIELDS = new Set(['name', 'email', 'email_domain', 'organization', 'job_title', 'location', 'background', 'has_email', 'has_phone', 'has_multiple_emails']);
const KNOWN_HISTORY_METRICS = new Set(['ticket_count', 'open_count', 'closed_count', 'last_contact_within_days', 'first_contact_before_days', 'waited_over_hours_count']);
const KNOWN_HEALTH_METRICS = new Set(['avg_rating', 'avg_effort_score', 'first_response_resolution_rate', 'high_friction_rate']);
const KNOWN_EVENT_KINDS = new Set(['signup', 'support_conversation', 'customer_message', 'campaign', 'campaign_reply', 'rating', 'incident_exposure', 'custom_object_event']);

/** Strict structural validation of an untrusted (model-generated) tree. */
export function validateSegmentTree(input: unknown): { ok: true; tree: SegmentDefinition } | { ok: false; error: string } {
  if (input == null || typeof input !== 'object') return { ok: false, error: 'The suggestion was not a JSON object.' };
  const b = input as { combinator?: unknown; conditions?: unknown; exclude?: unknown };
  const combinator: 'all' | 'any' = b.combinator === 'any' ? 'any' : 'all';
  if (!Array.isArray(b.conditions) || !Array.isArray(b.exclude)) return { ok: false, error: 'The suggestion must contain conditions[] and exclude[] arrays.' };
  if (b.conditions.length > 20 || b.exclude.length > 20) return { ok: false, error: 'Too many conditions in the suggestion.' };
  let nodes = 0;
  const checkNode = (n: unknown, depth: number): string | null => {
    if (n == null || typeof n !== 'object') return 'A node was not an object.';
    nodes++;
    if (nodes > 60 || depth > 6) return 'The suggested tree is too large or too deep.';
    const node = n as { kind?: unknown; children?: unknown };
    if (node.kind === 'group') {
      if (!Array.isArray(node.children) || node.children.length === 0) return 'A group node had no children.';
      for (const child of node.children) {
        const err = checkNode(child, depth + 1);
        if (err) return err;
      }
      return null;
    }
    if (typeof node.kind !== 'string' || !KNOWN_CONDITION_KINDS.has(node.kind)) {
      return `Unknown condition kind '${String(node.kind)}'.`;
    }
    const c = n as Record<string, unknown>;
    switch (node.kind) {
      case 'customer_property': {
        if (!Number.isInteger(c.definitionId) || (c.definitionId as number) <= 0) return 'customer_property needs a positive integer definitionId.';
        if (typeof c.op !== 'string' || typeof (c.value ?? '') !== 'string') return 'customer_property needs op and value.';
        return null;
      }
      case 'contact': {
        if (!KNOWN_CONTACT_FIELDS.has(String(c.field))) return `Unknown contact field '${String(c.field)}'.`;
        if (typeof c.op !== 'string') return 'contact needs op.';
        return null;
      }
      case 'ticket': {
        if (c.tags != null && !Array.isArray(c.tags)) return 'ticket.tags must be an array.';
        if (c.statuses != null && !Array.isArray(c.statuses)) return 'ticket.statuses must be an array.';
        if (c.mailboxLocalIds != null && !Array.isArray(c.mailboxLocalIds)) return 'ticket.mailboxLocalIds must be an array.';
        if (c.assigneeLocalIds != null && !Array.isArray(c.assigneeLocalIds)) return 'ticket.assigneeLocalIds must be an array.';
        if (c.customFields != null && !Array.isArray(c.customFields)) return 'ticket.customFields must be an array.';
        if (c.channel != null && typeof c.channel !== 'string') return 'ticket.channel must be a string.';
        if (c.aiAttribute != null) {
          const aa = c.aiAttribute as Record<string, unknown>;
          if (typeof aa.attribute !== 'string' || !AI_ATTRIBUTE_CATALOG.some((d) => d.key === aa.attribute)) return `Unknown AI attribute '${String(aa.attribute)}'.`;
          if (typeof aa.value !== 'string' || typeof aa.op !== 'string') return 'ticket.aiAttribute needs op and value.';
        }
        return null;
      }
      case 'history': {
        if (!KNOWN_HISTORY_METRICS.has(String(c.metric))) return `Unknown history metric '${String(c.metric)}'.`;
        if (!Number.isFinite(Number(c.value))) return 'history needs a numeric value.';
        return null;
      }
      case 'history_tag':
        return typeof c.tag === 'string' && c.tag.trim() !== '' ? null : 'history_tag needs a tag.';
      case 'organization_property': {
        if (c.field == null) {
          if (!Number.isInteger(c.definitionId) || (c.definitionId as number) <= 0) return 'organization_property needs field or definitionId.';
        } else if (c.field !== 'name' && c.field !== 'domains') {
          return `Unknown organization field '${String(c.field)}'.`;
        }
        if (typeof c.op !== 'string') return 'organization_property needs op.';
        return null;
      }
      case 'history_issue': {
        if (c.issueKind !== 'cluster' && c.issueKind !== 'known_issue') return 'history_issue.issueKind must be cluster or known_issue.';
        if (!Number.isFinite(Number(c.value))) return 'history_issue needs a numeric value.';
        return null;
      }
      case 'incident_exposure':
        return null;
      case 'campaign_history': {
        if (c.relation !== 'received' && c.relation !== 'replied' && c.relation !== 'not_received') return 'campaign_history.relation must be received, replied or not_received.';
        return null;
      }
      case 'support_health': {
        if (!KNOWN_HEALTH_METRICS.has(String(c.metric))) return `Unknown support_health metric '${String(c.metric)}'.`;
        if (!Number.isFinite(Number(c.value))) return 'support_health needs a numeric value.';
        return null;
      }
      case 'custom_object_link':
        return null;
      case 'customer_event': {
        if (!KNOWN_EVENT_KINDS.has(String(c.eventKind))) return `Unknown customer event kind '${String(c.eventKind)}'.`;
        return null;
      }
      default:
        return 'Unreachable.';
    }
  };
  for (const n of b.conditions) {
    const err = checkNode(n, 1);
    if (err) return { ok: false, error: err };
  }
  for (const n of b.exclude) {
    const err = checkNode(n, 1);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, tree: { combinator, conditions: b.conditions as SegmentNode[], exclude: b.exclude as SegmentNode[] } };
}

export class SegmentSuggestService {
  constructor(
    private db: DB,
    private chat: SuggestChatFn | null
  ) {}

  /** Build the catalog context the model may reference (closed vocabularies). */
  private catalogContext(): string {
    const tags = (this.db.prepare('SELECT name FROM tags WHERE deleted_at IS NULL ORDER BY name LIMIT 40').all() as { name: string }[]).map((t) => t.name);
    const mailboxes = (this.db.prepare('SELECT id, name FROM mailboxes WHERE deleted_at IS NULL LIMIT 20').all() as { id: number; name: string }[]).map((m) => `${m.id}=${m.name}`);
    const propDefs = (this.db.prepare('SELECT id, name, type FROM customer_property_definitions LIMIT 30').all() as { id: number; name: string; type: string | null }[]).map((d) => `${d.id}=${d.name} (${d.type ?? 'text'})`);
    const orgPropDefs = (this.db.prepare('SELECT id, name, type FROM organization_property_definitions LIMIT 30').all() as { id: number; name: string; type: string | null }[]).map((d) => `${d.id}=${d.name} (${d.type ?? 'text'})`);
    const issues = (this.db.prepare("SELECT id, title FROM known_issues LIMIT 20").all() as { id: number; title: string }[]).map((k) => `known_issue ${k.id}=${k.title}`);
    const incidents = (this.db.prepare("SELECT id, code, title FROM incidents WHERE status <> 'resolved' LIMIT 20").all() as { id: number; code: string; title: string }[]).map((i) => `incident ${i.id}=${i.code} ${i.title}`);
    const campaigns = (this.db.prepare('SELECT id, name FROM outreach_campaigns LIMIT 20').all() as { id: number; name: string }[]).map((c) => `campaign ${c.id}=${c.name}`);
    const objectTypes = (this.db.prepare('SELECT id, name FROM custom_object_types WHERE deleted_at IS NULL LIMIT 20').all() as { id: number; name: string }[]).map((t) => `type ${t.id}=${t.name}`);
    const attributes = AI_ATTRIBUTE_CATALOG.map((a) => `${a.key} (${a.value_type}${a.values ? `: ${a.values.join('|')}` : ''})`);
    return [
      `tags: ${tags.join(', ') || '(none)'}`,
      `mailboxes (local ids): ${mailboxes.join(', ') || '(none)'}`,
      `customer property definitions (id=name): ${propDefs.join(', ') || '(none)'}`,
      `organization property definitions (id=name): ${orgPropDefs.join(', ') || '(none)'}`,
      `known issues: ${issues.join(', ') || '(none)'}`,
      `active incidents: ${incidents.join(', ') || '(none)'}`,
      `campaigns: ${campaigns.join(', ') || '(none)'}`,
      `custom object types: ${objectTypes.join(', ') || '(none)'}`,
      `AI attributes (key: values): ${attributes.join(', ')}`
    ].join('\n');
  }

  async suggest(request: string): Promise<{
    definition: SegmentDefinition;
    model: string;
    notes: string[];
  }> {
    if (this.chat == null) {
      throw new Error('AI is disabled or LM Studio is not configured - the natural-language segment suggestion needs the local model. You can build the segment manually.');
    }
    const system = [
      'You translate a natural-language audience request into a structured segment definition (JSON).',
      'Output ONLY a JSON object: {"combinator":"all"|"any","conditions":[...],"exclude":[...]}',
      'Available condition kinds and their fields:',
      '- customer_property: {kind, definitionId (from the catalog), op (equals|not_equals|contains|not_contains|starts_with|ends_with|is_empty|is_not_empty|gt|gte|lt|lte|between|before|after|is_any_of|is_none_of), value}',
      '- contact: {kind, field (name|email|email_domain|organization|job_title|location|background|has_email|has_phone|has_multiple_emails), op (equals|not_equals|contains|starts_with|ends_with|is_empty|is_not_empty), value}',
      '- ticket: {kind, tags:[], tagMode (any|all|none), statuses:[], mailboxLocalIds:[], assigneeLocalIds:[], createdWithinDays, modifiedWithinDays, channel, customFields:[{fieldLocalId, op, value}], aiAttribute:{attribute, op, value}}',
      '- history: {kind, metric (ticket_count|open_count|closed_count|last_contact_within_days|first_contact_before_days|waited_over_hours_count), op (gte|lte|eq), value}',
      '- history_tag: {kind, tag, withinDays}',
      '- organization_property: {kind, field (name|domains) OR definitionId, op, value}',
      '- history_issue: {kind, issueKind (cluster|known_issue), issueLocalId (omit for any), op (gte|eq), value}',
      '- incident_exposure: {kind, incidentId (omit for any active), withinDays}',
      '- campaign_history: {kind, relation (received|replied|not_received), campaignId (omit for any)}',
      '- support_health: {kind, metric (avg_rating|avg_effort_score|first_response_resolution_rate|high_friction_rate), op (gte|lte), value}',
      '- custom_object_link: {kind, typeId (omit for any)}',
      '- customer_event: {kind, eventKind (signup|support_conversation|customer_message|campaign|campaign_reply|rating|incident_exposure|custom_object_event), withinDays}',
      'Rules: use ONLY ids/names from the catalog below; when unsure of an id, prefer tag/contact/text conditions instead of guessing ids; put exclusions in exclude[]; never invent fields.'
    ].join('\n');
    const result = await this.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Catalog:\n${this.catalogContext()}\n\nRequest: ${request}` }
      ],
      temperature: 0.1,
      maxTokens: 900,
      jsonMode: true
    });
    let parsed: unknown;
    try {
      if (result.content == null) throw new Error('empty model output');
      parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    } catch {
      throw new Error('The model returned unparseable JSON; no segment was created. Try rephrasing or build the segment manually.');
    }
    const validated = validateSegmentTree(parsed);
    if (!validated.ok) {
      throw new Error(`The suggested definition failed validation (${validated.error}); nothing was saved. Try rephrasing or build the segment manually.`);
    }
    return {
      definition: validated.tree,
      model: result.model,
      notes: ['The model only PROPOSED this definition; the deterministic engine selects recipients.']
    };
  }
}
