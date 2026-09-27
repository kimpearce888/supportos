import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { TicketStateDef, StateTransition } from '../../../shared/activity.js';

/**
 * TicketStateRepository (v1.7.0): the SupportOS custom ticket-state layer -
 * configurable workflow states layered ON TOP of Help Scout status (never
 * replacing it), with full transition history and per-state time metrics.
 */
export class TicketStateRepository {
  constructor(private db: DB) {}

  listStates(): TicketStateDef[] {
    return this.db
      .prepare('SELECT id, key, name, color, sort_order, is_resolved, built_in, created_at, updated_at FROM ticket_states ORDER BY sort_order ASC, id ASC')
      .all() as TicketStateDef[];
  }

  getState(id: number): TicketStateDef | undefined {
    return this.db
      .prepare('SELECT id, key, name, color, sort_order, is_resolved, built_in, created_at, updated_at FROM ticket_states WHERE id = ?')
      .get(id) as TicketStateDef | undefined;
  }

  getStateByKey(key: string): TicketStateDef | undefined {
    return this.db
      .prepare('SELECT id, key, name, color, sort_order, is_resolved, built_in, created_at, updated_at FROM ticket_states WHERE key = ?')
      .get(key) as TicketStateDef | undefined;
  }

  createState(input: { name: string; key?: string; color?: string | null; sort_order?: number; is_resolved?: boolean }): TicketStateDef {
    const key = input.key ?? (input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `state-${Date.now()}`);
    if (this.getStateByKey(key)) throw new Error(`A state with key '${key}' already exists.`);
    const result = this.db
      .prepare('INSERT INTO ticket_states (key, name, color, sort_order, is_resolved) VALUES (?, ?, ?, ?, ?)')
      .run(key, input.name, input.color ?? null, input.sort_order ?? 500, input.is_resolved ? 1 : 0);
    return this.getState(Number(result.lastInsertRowid))!;
  }

  updateState(id: number, patch: { name?: string; color?: string | null; sort_order?: number; is_resolved?: boolean }): TicketStateDef | undefined {
    const state = this.getState(id);
    if (!state) return undefined;
    if (state.built_in && patch.is_resolved !== undefined && patch.is_resolved !== !!state.is_resolved) {
      // built-in states keep their resolved semantics (they feed reporting defaults)
      throw new Error('The resolved semantics of built-in states cannot be changed.');
    }
    this.db
      .prepare('UPDATE ticket_states SET name = ?, color = ?, sort_order = ?, is_resolved = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? state.name, patch.color !== undefined ? patch.color : state.color, patch.sort_order ?? state.sort_order, patch.is_resolved !== undefined ? (patch.is_resolved ? 1 : 0) : state.is_resolved, nowIso(), id);
    return this.getState(id);
  }

  deleteState(id: number): { ok: boolean; message: string } {
    const state = this.getState(id);
    if (!state) return { ok: false, message: 'State not found.' };
    if (state.built_in) return { ok: false, message: `Built-in state '${state.name}' cannot be deleted (it is part of the default workflow).` };
    const inUse = (this.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE supportos_state_id = ?').get(id) as { n: number }).n;
    const tx = this.db.transaction(() => {
      if (inUse > 0) this.db.prepare('UPDATE conversations SET supportos_state_id = NULL WHERE supportos_state_id = ?').run(id);
      this.db.prepare('UPDATE ticket_state_transitions SET previous_state_id = NULL WHERE previous_state_id = ?').run(id);
      this.db.prepare('DELETE FROM ticket_state_transitions WHERE new_state_id = ?').run(id);
      this.db.prepare('DELETE FROM ticket_states WHERE id = ?').run(id);
    });
    tx();
    return { ok: true, message: inUse > 0 ? `State deleted; ${inUse} conversation(s) reset to no state.` : 'State deleted.' };
  }

  /** Current state row for a conversation (or null). */
  getConversationState(conversationLocalId: number): TicketStateDef | null {
    const row = this.db
      .prepare(
        `SELECT ts.id, ts.key, ts.name, ts.color, ts.sort_order, ts.is_resolved, ts.built_in, ts.created_at, ts.updated_at
         FROM conversations c JOIN ticket_states ts ON ts.id = c.supportos_state_id WHERE c.id = ?`
      )
      .get(conversationLocalId) as TicketStateDef | undefined;
    return row ?? null;
  }

  /**
   * Apply a state change: records the transition + updates the conversation +
   * bumps the state-change event into the activity log. Callers wrap in their
   * own transaction when composing with other writes.
   */
  setState(input: {
    conversationLocalId: number;
    newStateId: number | null;
    actorType?: string;
    actorLocalId?: number | null;
    reason?: string | null;
    source?: string;
    occurredAt?: string;
  }): { ok: boolean; message: string; previousStateId: number | null } {
    const conv = this.db.prepare('SELECT id, supportos_state_id FROM conversations WHERE id = ?').get(input.conversationLocalId) as { id: number; supportos_state_id: number | null } | undefined;
    if (!conv) return { ok: false, message: 'Conversation not found locally.', previousStateId: null };
    const newState = input.newStateId != null ? this.getState(input.newStateId) : undefined;
    if (input.newStateId != null && !newState) return { ok: false, message: 'State not found.', previousStateId: conv.supportos_state_id };
    if (conv.supportos_state_id === (input.newStateId ?? null)) {
      return { ok: true, message: 'Conversation already in this state.', previousStateId: conv.supportos_state_id };
    }
    const occurredAt = input.occurredAt ?? nowIso();
    const tx = this.db.transaction(() => {
      const transitionResult = this.db
        .prepare(
          `INSERT INTO ticket_state_transitions (conversation_id, previous_state_id, new_state_id, actor_type, actor_local_id, reason, occurred_at, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(input.conversationLocalId, conv.supportos_state_id, input.newStateId ?? null, input.actorType ?? 'user', input.actorLocalId ?? null, input.reason ?? null, occurredAt, input.source ?? 'local');
      if (input.newStateId == null) {
        this.db.prepare('UPDATE conversations SET supportos_state_id = NULL WHERE id = ?').run(input.conversationLocalId);
      } else {
        this.db.prepare('UPDATE conversations SET supportos_state_id = ? WHERE id = ?').run(input.newStateId, input.conversationLocalId);
      }
      // Activity log entry: dedup key uses the TRANSITION rowid, so two state
      // changes in the same millisecond are two distinct events (the timestamp
      // alone would collide).
      this.db
        .prepare(
          `INSERT OR IGNORE INTO conversation_events (conversation_id, event_type, actor_type, actor_local_id, occurred_at, source, metadata, dedup_key)
           VALUES (?, 'ticket_state_changed', ?, ?, ?, 'local', ?, 'ticket_state_changed:' || ? || ':' || ?)`
        )
        .run(
          input.conversationLocalId,
          input.actorType ?? 'user',
          input.actorLocalId ?? null,
          occurredAt,
          JSON.stringify({ previous_state_id: conv.supportos_state_id, new_state_id: input.newStateId, reason: input.reason ?? null }),
          input.conversationLocalId,
          String(transitionResult.lastInsertRowid)
        );
    });
    tx();
    return { ok: true, message: newState ? `State set to ${newState.name}.` : 'State cleared.', previousStateId: conv.supportos_state_id };
  }

  /** Full transition history for one conversation (newest first; new_state NULL = cleared). */
  listTransitions(conversationLocalId: number, limit = 100): StateTransition[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.conversation_id, t.previous_state_id, t.new_state_id, t.actor_type, t.actor_local_id, t.reason, t.occurred_at, t.source,
                p.name AS previous_state_name,
                COALESCE(n.name, '(no state)') AS new_state_name,
                CASE WHEN t.actor_type = 'user' THEN (SELECT TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) FROM users u WHERE u.id = t.actor_local_id) ELSE NULL END AS actor_name
         FROM ticket_state_transitions t
         LEFT JOIN ticket_states p ON p.id = t.previous_state_id
         LEFT JOIN ticket_states n ON n.id = t.new_state_id
         WHERE t.conversation_id = ?
         ORDER BY t.occurred_at DESC, t.id DESC
         LIMIT ?`
      )
      .all(conversationLocalId, limit) as StateTransition[];
    return rows;
  }

  /**
   * Lifecycle metrics per state (plan Phase 9): total/average time in state,
   * time since entering current state, re-entry counts and bottleneck ranking.
   * Time in state = minutes between consecutive transitions (or until now).
   */
  stateLifecycle(conversationLocalId: number): {
    current_state: TicketStateDef | null;
    time_in_current_state_min: number | null;
    transitions: number;
    per_state: { state_id: number; state_name: string; entries: number; total_minutes: number | null; avg_minutes: number | null; last_entered: string | null }[];
  } {
    const transitions = this.listTransitions(conversationLocalId, 1000).reverse(); // oldest first
    const current = this.getConversationState(conversationLocalId);
    const perState = new Map<number, { state_id: number; state_name: string; entries: number; totalMinutes: number[]; lastEntered: string | null }>();
    for (let i = 0; i < transitions.length; i++) {
      const t = transitions[i];
      if (!t) continue;
      const entry = perState.get(t.new_state_id ?? 0) ?? { state_id: t.new_state_id ?? 0, state_name: t.new_state_name, entries: 0, totalMinutes: [] as number[], lastEntered: null as string | null };
      entry.entries++;
      entry.lastEntered = t.occurred_at;
      const nextAt = i + 1 < transitions.length ? transitions[i + 1]?.occurred_at ?? null : null;
      const end = nextAt ?? (current && current.id === t.new_state_id ? nowIso() : null);
      if (end && t.occurred_at) {
        const mins = (Date.parse(end) - Date.parse(t.occurred_at)) / 60000;
        if (Number.isFinite(mins) && mins >= 0) entry.totalMinutes.push(mins);
      }
      perState.set(t.new_state_id ?? 0, entry);
    }
    let timeInCurrent: number | null = null;
    if (current && transitions.length > 0) {
      const last = transitions[transitions.length - 1];
      if (last && last.new_state_id === current.id && last.occurred_at) {
        const mins = (Date.now() - Date.parse(last.occurred_at)) / 60000;
        if (Number.isFinite(mins) && mins >= 0) timeInCurrent = Math.round(mins);
      }
    }
    return {
      current_state: current,
      time_in_current_state_min: timeInCurrent,
      transitions: transitions.length,
      per_state: [...perState.values()].map((e) => ({
        state_id: e.state_id,
        state_name: e.state_name,
        entries: e.entries,
        total_minutes: e.totalMinutes.length > 0 ? Math.round(e.totalMinutes.reduce((a, b) => a + b, 0)) : null,
        avg_minutes: e.totalMinutes.length > 0 ? Math.round(e.totalMinutes.reduce((a, b) => a + b, 0) / e.totalMinutes.length) : null,
        last_entered: e.lastEntered
      }))
    };
  }

  /** Aggregate bottleneck view across all conversations (avg time in state, ranked). */
  stateBottlenecks(): { state_id: number; state_name: string; conversations: number; avg_minutes: number | null; max_minutes: number | null }[] {
    // Spans are computed in JS from the (small) transition log: one pass,
    // deterministic, no SQL window gymnastics on ambiguous timestamps.
    return this.computeBottlenecks();
  }

  private computeBottlenecks(): { state_id: number; state_name: string; conversations: number; avg_minutes: number | null; max_minutes: number | null }[] {
    const all = this.db
      .prepare(
        `SELECT t.conversation_id, t.new_state_id, t.occurred_at,
                CASE
                  WHEN EXISTS (SELECT 1 FROM ticket_state_transitions t2 WHERE t2.conversation_id = t.conversation_id AND (t2.occurred_at > t.occurred_at OR (t2.occurred_at = t.occurred_at AND t2.id > t.id)))
                    THEN (SELECT MIN(t2.occurred_at) FROM ticket_state_transitions t2 WHERE t2.conversation_id = t.conversation_id AND (t2.occurred_at > t.occurred_at OR (t2.occurred_at = t.occurred_at AND t2.id > t.id)))
                  WHEN (SELECT supportos_state_id FROM conversations c WHERE c.id = t.conversation_id) = t.new_state_id
                    THEN 'now-marker'
                  ELSE NULL END AS span_end
         FROM ticket_state_transitions t
         ORDER BY t.conversation_id, t.occurred_at, t.id`
      )
      .all() as { conversation_id: number; new_state_id: number; occurred_at: string; span_end: string | null }[];
    const byState = new Map<number, number[]>();
    const convsByState = new Map<number, Set<number>>();
    for (const row of all) {
      if (row.span_end == null) continue;
      const end = row.span_end === 'now-marker' ? nowIso() : row.span_end;
      const mins = (Date.parse(end) - Date.parse(row.occurred_at)) / 60000;
      if (!Number.isFinite(mins) || mins < 0) continue;
      const list = byState.get(row.new_state_id) ?? [];
      list.push(mins);
      byState.set(row.new_state_id, list);
      const convs = convsByState.get(row.new_state_id) ?? new Set<number>();
      convs.add(row.conversation_id);
      convsByState.set(row.new_state_id, convs);
    }
    return [...byState.entries()].map(([stateId, mins]) => {
      const state = this.getState(stateId);
      return {
        state_id: stateId,
        state_name: state?.name ?? `#${stateId}`,
        conversations: convsByState.get(stateId)?.size ?? 0,
        avg_minutes: mins.length > 0 ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
        max_minutes: mins.length > 0 ? Math.round(Math.max(...mins)) : null
      };
    }).sort((a, b) => (b.avg_minutes ?? 0) - (a.avg_minutes ?? 0));
  }
}
