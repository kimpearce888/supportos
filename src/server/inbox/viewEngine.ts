import type { DB } from '../database/connection.js';
import type { ViewDefinition, ViewNode, ViewGroup, ViewCondition, ActivityField, DateMode } from '../../shared/activity.js';
import { ACTIVITY_FIELD_COLUMN } from '../../shared/activity.js';
import { resolveDateRange, AGE_METRIC_SQL } from '../services/dateRange.js';
import { RESPONSE_STATE_SQL } from './responseState.js';

export interface CompiledView {
  /** SQL WHERE content (no leading WHERE); safe to embed as `AND (${sql})`. */
  whereSql: string;
  /** Bound parameters in order. */
  params: unknown[];
  /** Honest notes about how the tree was evaluated (surfaced by the API). */
  notes: string[];
}

export class ViewCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ViewCompileError';
  }
}

interface Fragment {
  sql: string;
  params: unknown[];
}

/** Escape LIKE metacharacters in a user value (same policy as segmentEngine). */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * ViewEngine (v1.7.0): compiles saved Inbox View condition TREES into
 * parameterized SQL WHERE fragments.
 *
 * Safety model (plan Phase 6: "structured condition definitions, NOT
 * generated SQL"):
 * - Stored definitions are pure JSON trees (Zod-validated at the route).
 * - At evaluation time each node compiles to a fixed SQL template chosen from
 *   a closed switch on `kind`; every VALUE is a bound parameter, every
 *   IDENTIFIER is a whitelisted constant (ACTIVITY_FIELD_COLUMN,
 *   AGE_METRIC_SQL, RESPONSE_STATE_SQL). User input can never become SQL.
 * - Views are DYNAMIC: calendar date modes ("today") resolve to concrete UTC
 *   instants at OPEN time, so a saved view means "today whenever it is opened".
 */
export class ViewEngine {
  constructor(
    private db: DB,
    private opts: {
      /** SLA alert resolution reusing SlaService's exact business-hours logic. */
      resolveSlaConversationIds?: (states: ('at_risk' | 'breached')[]) => number[];
      /** User timezone for calendar/rolling boundary resolution. */
      timezone: string;
      /** Injectable clock (tests). */
      now?: number;
    }
  ) {}

  compile(def: ViewDefinition): CompiledView {
    const notes: string[] = [];
    const fragment = this.compileNodes(def.conditions, def.combinator === 'all', notes, 0);
    if (fragment.sql === '') {
      // Empty condition list = no filtering (all conversations).
      return { whereSql: '1=1', params: [], notes };
    }
    return { whereSql: fragment.sql, params: fragment.params, notes };
  }

  private compileNodes(nodes: ViewNode[], intersect: boolean, notes: string[], depth: number): Fragment {
    if (depth > 10) throw new ViewCompileError('Condition tree nesting deeper than supported (max 10).');
    const fragments: Fragment[] = [];
    for (const node of nodes) {
      fragments.push(this.compileNode(node, notes, depth));
    }
    const nonEmpty = fragments.filter((f) => f.sql !== '');
    if (nonEmpty.length === 0) return { sql: '', params: [] };
    const joiner = intersect ? ' AND ' : ' OR ';
    const sql = nonEmpty.map((f) => `(${f.sql})`).join(joiner);
    const params: unknown[] = [];
    for (const f of nonEmpty) params.push(...f.params);
    return { sql, params };
  }

  private compileNode(node: ViewNode, notes: string[], depth: number): Fragment {
    if ((node as ViewGroup).kind === 'group') {
      const group = node as ViewGroup;
      if (group.children.length === 0) return { sql: '', params: [] };
      return this.compileNodes(group.children, group.combinator === 'all', notes, depth + 1);
    }
    return this.compileCondition(node as ViewCondition, notes);
  }

  private compileCondition(cond: ViewCondition, notes: string[]): Fragment {
    switch (cond.kind) {
      case 'status': {
        if (cond.statuses.length === 0) return { sql: '', params: [] };
        return { sql: `c.status IN (${cond.statuses.map(() => '?').join(',')})`, params: cond.statuses };
      }
      case 'assignee': {
        const parts: string[] = [];
        const params: unknown[] = [];
        if (cond.assigneeLocalIds.length > 0) {
          parts.push(`c.assignee_local_id IN (${cond.assigneeLocalIds.map(() => '?').join(',')})`);
          params.push(...cond.assigneeLocalIds);
        }
        if (cond.includeUnassigned) parts.push('c.assignee_local_id IS NULL');
        if (parts.length === 0) return { sql: '', params: [] };
        return { sql: parts.join(' OR '), params };
      }
      case 'team': {
        if (cond.teamLocalIds.length === 0) return { sql: '', params: [] };
        return { sql: `c.assigned_team_local_id IN (${cond.teamLocalIds.map(() => '?').join(',')})`, params: cond.teamLocalIds };
      }
      case 'mailbox': {
        if (cond.mailboxLocalIds.length === 0) return { sql: '', params: [] };
        return { sql: `c.mailbox_local_id IN (${cond.mailboxLocalIds.map(() => '?').join(',')})`, params: cond.mailboxLocalIds };
      }
      case 'channel': {
        if (cond.channels.length === 0) return { sql: '', params: [] };
        return { sql: `c.type IN (${cond.channels.map(() => '?').join(',')})`, params: cond.channels };
      }
      case 'tags': {
        const lowered = cond.tags.map((t) => t.toLowerCase());
        if (lowered.length === 0) return { sql: '', params: [] };
        const tagExists = (names: string[]): Fragment => ({
          sql: `EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(t.name) IN (${names.map(() => '?').join(',')}))`,
          params: names
        });
        if (cond.mode === 'any') return tagExists(lowered);
        if (cond.mode === 'none') {
          const any = tagExists(lowered);
          return { sql: `NOT ${any.sql}`, params: any.params };
        }
        // all: every tag must appear on the SAME conversation
        const parts = lowered.map(() => 'EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id AND LOWER(t.name) = ?)');
        return { sql: parts.join(' AND '), params: lowered };
      }
      case 'custom_field': {
        const base = 'cf.field_local_id = ?';
        switch (cond.op) {
          case 'is_empty':
            return { sql: `NOT EXISTS (SELECT 1 FROM conversation_fields cf WHERE cf.conversation_id = c.id AND ${base} AND cf.value IS NOT NULL AND cf.value <> '')`, params: [cond.fieldLocalId] };
          case 'is_not_empty':
            return { sql: `EXISTS (SELECT 1 FROM conversation_fields cf WHERE cf.conversation_id = c.id AND ${base} AND cf.value IS NOT NULL AND cf.value <> '')`, params: [cond.fieldLocalId] };
          case 'equals':
            return { sql: `EXISTS (SELECT 1 FROM conversation_fields cf WHERE cf.conversation_id = c.id AND ${base} AND LOWER(cf.value) = LOWER(?))`, params: [cond.fieldLocalId, cond.value ?? ''] };
          case 'not_equals':
            return { sql: `NOT EXISTS (SELECT 1 FROM conversation_fields cf WHERE cf.conversation_id = c.id AND ${base} AND LOWER(cf.value) = LOWER(?))`, params: [cond.fieldLocalId, cond.value ?? ''] };
          case 'contains':
            return { sql: `EXISTS (SELECT 1 FROM conversation_fields cf WHERE cf.conversation_id = c.id AND ${base} AND cf.value LIKE ? ESCAPE '\\')`, params: [cond.fieldLocalId, `%${escapeLike(cond.value ?? '')}%`] };
          default:
            throw new ViewCompileError(`Unsupported custom_field operator: ${(cond as { op: string }).op}`);
        }
      }
      case 'customer_property': {
        const def = 'cp.definition_id = ?';
        const custJoin = 'cp.customer_id = c.customer_local_id';
        switch (cond.op) {
          case 'is_empty':
            return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND cp.value IS NOT NULL AND cp.value <> '')`, params: [cond.definitionId] };
          case 'is_not_empty':
            return { sql: `EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND cp.value IS NOT NULL AND cp.value <> '')`, params: [cond.definitionId] };
          case 'equals':
            return { sql: `EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND LOWER(cp.value) = LOWER(?))`, params: [cond.definitionId, cond.value ?? ''] };
          case 'not_equals':
            return { sql: `NOT EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND LOWER(cp.value) = LOWER(?))`, params: [cond.definitionId, cond.value ?? ''] };
          case 'contains':
            return { sql: `EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND cp.value LIKE ? ESCAPE '\\')`, params: [cond.definitionId, `%${escapeLike(cond.value ?? '')}%`] };
          case 'gt': case 'gte': case 'lt': case 'lte': {
            const n = Number(cond.value ?? '');
            if (!Number.isFinite(n)) throw new ViewCompileError('customer_property numeric operator requires a numeric value.');
            const opSql = cond.op === 'gt' ? '>' : cond.op === 'gte' ? '>=' : cond.op === 'lt' ? '<' : '<=';
            return { sql: `EXISTS (SELECT 1 FROM customer_properties cp WHERE ${custJoin} AND ${def} AND CAST(cp.value AS REAL) ${opSql} ?)`, params: [cond.definitionId, n] };
          }
          default:
            throw new ViewCompileError(`Unsupported customer_property operator: ${(cond as { op: string }).op}`);
        }
      }
      case 'customer_text': {
        const v = (cond.value ?? '').trim();
        switch (cond.field) {
          case 'name': {
            const nameExpr = `TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, ''))`;
            switch (cond.op) {
              case 'is_empty': return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND ${nameExpr} <> '')`, params: [] };
              case 'is_not_empty': return { sql: `EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND ${nameExpr} <> '')`, params: [] };
              case 'contains': return { sql: `EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND ${nameExpr} LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              case 'equals': return { sql: `EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND ${nameExpr} = ?)`, params: [v] };
              case 'not_contains': return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND ${nameExpr} LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              default: throw new ViewCompileError(`Unsupported customer_text operator: ${(cond as { op: string }).op}`);
            }
          }
          case 'email': {
            switch (cond.op) {
              case 'is_empty': return { sql: `NOT EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id)`, params: [] };
              case 'is_not_empty': return { sql: `EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id)`, params: [] };
              case 'contains': return { sql: `EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id AND ce.value LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              case 'equals': return { sql: `EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id AND ce.value = ?)`, params: [v] };
              case 'not_contains': return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customer_emails ce WHERE ce.customer_id = c.customer_local_id AND ce.value LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              default: throw new ViewCompileError(`Unsupported customer_text operator: ${(cond as { op: string }).op}`);
            }
          }
          case 'organization': {
            switch (cond.op) {
              case 'is_empty': return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.id = c.customer_local_id AND cu.organization_id IS NOT NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = cu.organization_id AND o.name <> ''))`, params: [] };
              case 'is_not_empty': return { sql: `EXISTS (SELECT 1 FROM customers cu JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = c.customer_local_id AND o.name <> '')`, params: [] };
              case 'contains': return { sql: `EXISTS (SELECT 1 FROM customers cu JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = c.customer_local_id AND o.name LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              case 'equals': return { sql: `EXISTS (SELECT 1 FROM customers cu JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = c.customer_local_id AND o.name = ?)`, params: [v] };
              case 'not_contains': return { sql: `c.customer_local_id IS NULL OR NOT EXISTS (SELECT 1 FROM customers cu JOIN organizations o ON o.id = cu.organization_id WHERE cu.id = c.customer_local_id AND o.name LIKE ? ESCAPE '\\')`, params: [`%${escapeLike(v)}%`] };
              default: throw new ViewCompileError(`Unsupported customer_text operator: ${(cond as { op: string }).op}`);
            }
          }
          default:
            throw new ViewCompileError(`Unsupported customer_text field: ${(cond as { field: string }).field}`);
        }
      }
      case 'date_activity': {
        const range = this.resolveRange(cond.activityField, cond.mode, cond, notes);
        const column = ACTIVITY_FIELD_COLUMN[cond.activityField];
        // NULL timestamp = unknown, never "matches" a date window (honest semantics).
        return { sql: `${column} IS NOT NULL AND ${column} >= ? AND ${column} < ?`, params: [range.from, range.to] };
      }
      case 'response_state': {
        if (cond.states.length === 0) return { sql: '', params: [] };
        const cases = cond.states.map(() => '?').join(',');
        return { sql: `(${RESPONSE_STATE_SQL}) IN (${cases})`, params: cond.states };
      }
      case 'response_age': {
        const metric = AGE_METRIC_SQL[cond.metric];
        if (!metric) throw new ViewCompileError(`Unsupported response_age metric: ${cond.metric}`);
        const opSql = cond.op === 'gt' ? '>' : cond.op === 'gte' ? '>=' : cond.op === 'lt' ? '<' : '<=';
        return { sql: `${metric.sql} ${opSql} ?`, params: [cond.minutes] };
      }
      case 'sla': {
        if (!this.opts.resolveSlaConversationIds) throw new ViewCompileError('SLA conditions require the SLA service.');
        const ids = this.opts.resolveSlaConversationIds(cond.states);
        notes.push(`SLA state evaluated live against current mailbox business-hours (${ids.length} conversation(s) currently ${cond.states.join('/')}).`);
        if (ids.length === 0) {
          return cond.negate ? { sql: '1=1', params: [] } : { sql: '1=0', params: [] };
        }
        const inList = ids.map(() => '?').join(',');
        return cond.negate
          ? { sql: `c.id NOT IN (${inList})`, params: ids }
          : { sql: `c.id IN (${inList})`, params: ids };
      }
      case 'priority': {
        if (cond.priorities.length === 0) return { sql: '', params: [] };
        return { sql: `c.supportos_priority IN (${cond.priorities.map(() => '?').join(',')})`, params: cond.priorities };
      }
      case 'ticket_state': {
        const parts: string[] = [];
        const params: unknown[] = [];
        if (cond.stateIds.length > 0) {
          parts.push(`c.supportos_state_id IN (${cond.stateIds.map(() => '?').join(',')})`);
          params.push(...cond.stateIds);
        }
        if (cond.includeNoState) parts.push('c.supportos_state_id IS NULL');
        if (parts.length === 0) return { sql: '', params: [] };
        return { sql: parts.join(' OR '), params };
      }
      case 'known_issue': {
        if (cond.any) return { sql: 'EXISTS (SELECT 1 FROM known_issue_conversations kic WHERE kic.conversation_id = c.id)', params: [] };
        if (cond.knownIssueIds == null || cond.knownIssueIds.length === 0) return { sql: '', params: [] };
        return { sql: `EXISTS (SELECT 1 FROM known_issue_conversations kic WHERE kic.conversation_id = c.id AND kic.known_issue_id IN (${cond.knownIssueIds.map(() => '?').join(',')}))`, params: cond.knownIssueIds };
      }
      case 'ai_analyzed': {
        return cond.analyzed
          ? { sql: `EXISTS (SELECT 1 FROM ai_runs ar WHERE ar.conversation_id = c.id AND ar.type = 'ticket_analysis' AND ar.status = 'completed')`, params: [] }
          : { sql: `NOT EXISTS (SELECT 1 FROM ai_runs ar WHERE ar.conversation_id = c.id AND ar.type = 'ticket_analysis' AND ar.status = 'completed')`, params: [] };
      }
      case 'interaction_signal': {
        const frag: Fragment = {
          sql: `EXISTS (SELECT 1 FROM client_current_signals s, json_each(s.signals_json) je WHERE s.conversation_id = c.id AND json_extract(je.value, '$.dimension') = ? AND json_extract(je.value, '$.value') = ?)`,
          params: [cond.dimension, cond.value]
        };
        return cond.negate ? { sql: `NOT ${frag.sql}`, params: frag.params } : frag;
      }
      case 'unread': {
        return { sql: 'c.is_unread = ?', params: [cond.unread ? 1 : 0] };
      }
      case 'snoozed': {
        return cond.snoozed
          ? { sql: "c.snoozed_until IS NOT NULL AND c.snoozed_until > datetime('now')", params: [] }
          : { sql: 'c.snoozed_until IS NULL OR c.snoozed_until <= datetime(\'now\')', params: [] };
      }
      case 'customer': {
        if (cond.customerLocalIds.length === 0) return { sql: '', params: [] };
        return { sql: `c.customer_local_id IN (${cond.customerLocalIds.map(() => '?').join(',')})`, params: cond.customerLocalIds };
      }
      default:
        throw new ViewCompileError(`Unknown condition kind: ${(cond as { kind: string }).kind}`);
    }
  }

  private resolveRange(activityField: ActivityField, mode: DateMode, cond: ViewCondition & { kind: 'date_activity' }, notes: string[]): { from: string; to: string } {
    const range = resolveDateRange({
      mode,
      timezone: this.opts.timezone,
      from: cond.from ?? null,
      to: cond.to ?? null,
      fromTime: cond.fromTime ?? null,
      toTime: cond.toTime ?? null,
      now: this.opts.now
    });
    if (!range) throw new ViewCompileError(`Date filter '${mode}' requires valid from/to dates (YYYY-MM-DD).`);
    notes.push(`Date filter '${activityField}' resolved to ${range.label} (${range.from} to ${range.to}, ${range.kind} boundaries, ${this.opts.timezone}).`);
    return range;
  }
}
