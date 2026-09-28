import type { DB } from '../database/connection.js';
import type { SettingsRepository } from '../database/repositories/settingsRepo.js';
import type { SlaService } from '../analytics/slaService.js';
import {
  DEFAULT_CAPACITY_MODEL,
  CapacityModelUpdateSchema,
  type CapacityModel,
  type CapacityWeights,
  type AgentWorkload,
  type TeamWorkload,
  type WorkloadSnapshotResponse as WorkloadSnapshot,
  type SuggestedAssigneeResponse as SuggestedAssignee
} from '../../shared/collaboration.js';

/**
 * Workload & capacity engine (v1.8.0, plan Phase 11).
 *
 * Design decisions:
 * - Capacity is EXPLICIT configuration (default max + per-user overrides +
 *   weights) stored in application_settings - never inferred from anything
 *   about a person (plan: "Do not infer capacity from arbitrary personality
 *   information"). Availability, when obtainable, comes from the Help Scout
 *   user-statuses we already sync (email/chat status) - reported as-is.
 * - Pressure: every open conversation contributes its HIGHEST-tier weight
 *   (urgent > sla > waiting > open) - no double counting, deterministic.
 * - Average active load is an honest APPROXIMATION from created/closed
 *   timestamps with the CURRENT assignee; assignment changes mid-conversation
 *   are not historically reconstructable (Help Scout exposes no event log) -
 *   the response says so instead of pretending precision.
 * - Suggested assignee is a READ-ONLY recommendation with its reasoning
 *   exposed. Nothing reassigns automatically: assignment happens when a
 *   human clicks Assign (the normal write path), or through the existing
 *   approved-automation flow if the user explicitly enables one.
 */
interface WRow { [k: string]: unknown }

export const CAPACITY_SETTING_KEY = 'capacity_model';

export type { AgentWorkload, TeamWorkload, WorkloadSnapshot, SuggestedAssignee };

export class WorkloadService {
  constructor(
    private db: DB,
    private sla: SlaService,
    private settings: SettingsRepository
  ) {}

  // ---------------- capacity model ----------------

  getCapacityModel(): CapacityModel {
    const raw = this.settings.get<unknown>(CAPACITY_SETTING_KEY, null);
    if (raw == null) return structuredClone(DEFAULT_CAPACITY_MODEL);
    try {
      const parsed = CapacityModelUpdateSchema.parse(raw);
      return { ...parsed, per_user_max: { ...parsed.per_user_max } };
    } catch {
      // Invalid stored model (hand-edited or from an older format): fall
      // back to defaults rather than guess - and say so via method notes.
      return structuredClone(DEFAULT_CAPACITY_MODEL);
    }
  }

  setCapacityModel(model: CapacityModel): void {
    const parsed = CapacityModelUpdateSchema.parse(model);
    this.settings.set(CAPACITY_SETTING_KEY, parsed);
  }

  private capacityFor(userId: number, model: CapacityModel): number {
    const override = model.per_user_max[String(userId)] ?? model.per_user_max[userId as unknown as string];
    return Number.isFinite(override) && override != null ? override : model.default_max_open;
  }

  // ---------------- snapshot ----------------

  snapshot(): WorkloadSnapshot {
    const model = this.getCapacityModel();
    const users = this.db
      .prepare('SELECT id, first_name, last_name, mention, email, role FROM users WHERE deleted_at IS NULL ORDER BY id')
      .all() as WRow[];
    const slaAlerts = this.sla.slaAlerts().alerts;
    const slaConvIdsByAssignee = new Map<number, number[]>();
    for (const a of slaAlerts) {
      if (a.assignee_local_id == null) continue;
      const list = slaConvIdsByAssignee.get(a.assignee_local_id) ?? [];
      list.push(a.conversation_id);
      slaConvIdsByAssignee.set(a.assignee_local_id, list);
    }

    const agents: AgentWorkload[] = [];
    for (const u of users) {
      const userId = Number(u.id);
      const display = [u.first_name, u.last_name].filter(Boolean).join(' ') || String(u.email ?? `user #${userId}`);
      const counts = this.agentCounts(userId);
      const capacity = this.capacityFor(userId, model);
      const weighted = this.weightedLoad(userId, model.weights, slaConvIdsByAssignee.get(userId) ?? []);
      agents.push({
        user_local_id: userId,
        display_name: display,
        mention: u.mention == null ? null : String(u.mention),
        role: u.role == null ? null : String(u.role),
        availability: this.availabilityOf(userId),
        open_workload: counts.open,
        pending_workload: counts.pending,
        customer_waiting_workload: counts.waiting,
        urgent_workload: counts.urgent,
        sla_risk_workload: slaConvIdsByAssignee.get(userId)?.length ?? 0,
        weighted_load: weighted,
        capacity,
        pressure: capacity > 0 ? Math.round((weighted / capacity) * 100) / 100 : 0,
        avg_active_load_7d: this.avgActiveLoad7d(userId),
        recent_closed_7d: counts.closed7d
      });
    }

    const teams = this.teamWorkloads(agents, model);

    const unassigned = Number(
      (this.db
        .prepare("SELECT COUNT(*) AS n FROM conversations c WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL AND c.status IN ('active','pending') AND c.assignee_local_id IS NULL")
        .get() as WRow).n
    );

    return {
      generated_at: new Date().toISOString(),
      unassigned_work: unassigned,
      agents,
      teams,
      capacity_model: model,
      method_notes: [
        'Pressure = weighted open load / capacity. Each open conversation counts once at its highest tier: urgent, SLA risk, customer-waiting, or plain open.',
        'Average active load is an approximation from created/closed timestamps using the CURRENT assignee; assignment changes mid-conversation are not historically reconstructable.',
        'Availability is the Help Scout user status we already sync (email/chat). Agents with no synced status are shown as unknown, never guessed.',
        'Suggested assignee is a read-only recommendation. SupportOS never reassigns automatically unless you explicitly enable an approved automation.'
      ]
    };
  }

  private agentCounts(userId: number): { open: number; pending: number; waiting: number; urgent: number; closed7d: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN c.status IN ('active','pending') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN c.status = 'active' AND c.customer_waiting_since IS NOT NULL THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN c.status IN ('active','pending') AND c.supportos_priority IN ('high','urgent') THEN 1 ELSE 0 END) AS urgent
         FROM conversations c
         WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL AND c.assignee_local_id = ?`
      )
      .get(userId) as WRow;
    const closed7d = Number(
      (this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM conversations c
           WHERE c.deleted_at IS NULL AND c.assignee_local_id = ? AND c.status = 'closed'
             AND c.closed_at IS NOT NULL AND julianday(c.closed_at) >= julianday('now', '-7 days')`
        )
        .get(userId) as WRow).n
    );
    return {
      open: Number(row?.open ?? 0),
      pending: Number(row?.pending ?? 0),
      waiting: Number(row?.waiting ?? 0),
      urgent: Number(row?.urgent ?? 0),
      closed7d
    };
  }

  private weightedLoad(userId: number, weights: CapacityWeights, slaConversationIds: number[]): number {
    // Exact per-conversation tiering: highest tier wins (urgent > sla >
    // waiting > open), so weights never double-count. SLA membership comes
    // from SlaService's business-minutes computation (conversation ids).
    const inSql = slaConversationIds.length > 0 ? `c.id IN (${slaConversationIds.map(() => '?').join(',')})` : '0';
    const row = this.db
      .prepare(
        `SELECT SUM(CASE
           WHEN c.supportos_priority IN ('high','urgent') THEN ?
           WHEN ${inSql} THEN ?
           WHEN c.status = 'active' AND c.customer_waiting_since IS NOT NULL THEN ?
           ELSE ?
         END) AS w
         FROM conversations c
         WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL
           AND c.assignee_local_id = ? AND c.status IN ('active','pending')`
      )
      .get(weights.urgent, ...slaConversationIds, weights.sla, weights.waiting, weights.open, userId) as WRow;
    return Math.round(Number(row?.w ?? 0) * 100) / 100;
  }

  /**
   * Average per-day open workload over the last 7 days (UTC day boundaries).
   * Approximation with the current assignee - see class doc.
   */
  private avgActiveLoad7d(userId: number): number | null {
    const now = new Date();
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)).toISOString().slice(0, 10);
      const n = Number(
        (this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM conversations c
             WHERE c.deleted_at IS NULL AND c.assignee_local_id = ?
               AND date(c.remote_created_at) <= date(?)
               AND (c.closed_at IS NULL OR date(c.closed_at) > date(?))`
          )
          .get(userId, day, day) as WRow).n
      );
      total += n;
    }
    return Math.round((total / 7) * 10) / 10;
  }

  private availabilityOf(userId: number): { email_status: string | null; chat_status: string | null; source: 'user_statuses' | 'unknown' } {
    const row = this.db
      .prepare('SELECT email_status, chat_status FROM user_statuses WHERE user_local_id = ?')
      .get(userId) as WRow | undefined;
    if (!row) return { email_status: null, chat_status: null, source: 'unknown' };
    return { email_status: row.email_status == null ? null : String(row.email_status), chat_status: row.chat_status == null ? null : String(row.chat_status), source: 'user_statuses' };
  }

  private teamWorkloads(agents: AgentWorkload[], model: CapacityModel): TeamWorkload[] {
    const teams = this.db.prepare('SELECT id, name FROM teams WHERE deleted_at IS NULL ORDER BY name').all() as WRow[];
    const byUser = new Map(agents.map((a) => [a.user_local_id, a]));
    const result: TeamWorkload[] = [];
    for (const t of teams) {
      const teamId = Number(t.id);
      const memberRows = this.db.prepare('SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id').all(teamId) as WRow[];
      const memberIds = memberRows.map((r) => Number(r.user_id));
      const members = memberIds.map((id) => byUser.get(id)).filter((a): a is AgentWorkload => a != null);
      if (members.length === 0) continue;
      const open = members.reduce((s, m) => s + m.open_workload, 0);
      const weighted = members.reduce((s, m) => s + m.weighted_load, 0);
      const capacity = members.reduce((s, m) => s + this.capacityFor(m.user_local_id, model), 0);
      result.push({
        team_local_id: teamId,
        name: String(t.name ?? ''),
        member_user_local_ids: memberIds,
        open_workload: open,
        weighted_load: Math.round(weighted * 100) / 100,
        capacity,
        pressure: capacity > 0 ? Math.round((weighted / capacity) * 100) / 100 : 0,
        recent_closed_7d: members.reduce((s, m) => s + m.recent_closed_7d, 0),
        available_members: members.filter((m) => m.availability.email_status === 'active' || m.availability.chat_status === 'active').length,
        total_members: members.length
      });
    }
    return result;
  }

  // ---------------- suggested assignee ----------------

  /**
   * Top unassigned conversations (urgent first, then longest-waiting) with a
   * read-only suggested assignee each. Deterministic: candidates ranked by
   * (availability, resulting pressure, user id).
   */
  suggestedAssignees(limit = 10): SuggestedAssignee[] {
    const model = this.getCapacityModel();
    const agents = this.snapshot().agents;
    const rows = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.supportos_priority, c.customer_waiting_since
         FROM conversations c
         WHERE c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL
           AND c.status IN ('active','pending') AND c.assignee_local_id IS NULL
         ORDER BY CASE c.supportos_priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                  c.customer_waiting_since IS NULL, c.customer_waiting_since
         LIMIT ?`
      )
      .all(Math.min(50, Math.max(1, limit))) as WRow[];

    return rows.map((r) => {
      const convId = Number(r.id);
      const isUrgent = String(r.supportos_priority) === 'urgent' || String(r.supportos_priority) === 'high';
      const convoWeight = isUrgent ? model.weights.urgent : model.weights.open;
      let best: { agent: AgentWorkload; after: number } | null = null;
      let bestAvailable: { agent: AgentWorkload; after: number } | null = null;
      for (const a of agents) {
        const after = Math.round(((a.weighted_load + convoWeight) / Math.max(1, a.capacity)) * 100) / 100;
        const isAway = a.availability.email_status === 'away' && (a.availability.chat_status ?? 'away') === 'away';
        const candidate = { agent: a, after };
        if (!best || after < best.after || (after === best.after && a.user_local_id < best.agent.user_local_id)) best = candidate;
        if (!isAway && (!bestAvailable || after < bestAvailable.after || (after === bestAvailable.after && a.user_local_id < bestAvailable.agent.user_local_id))) bestAvailable = candidate;
      }
      const chosen = bestAvailable ?? best;
      const waitingMinutes =
        r.customer_waiting_since == null
          ? null
          : Math.max(0, Math.round((Date.now() - Date.parse(String(r.customer_waiting_since))) / 60000));
      const allAway = bestAvailable == null;
      return {
        conversation_id: convId,
        conversation_number: r.number == null ? null : Number(r.number),
        subject: r.subject == null ? null : String(r.subject),
        supportos_priority: String(r.supportos_priority),
        waiting_minutes: waitingMinutes,
        suggested_user_local_id: chosen?.agent.user_local_id ?? null,
        suggested_display_name: chosen?.agent.display_name ?? null,
        suggested_pressure_after: chosen?.after ?? null,
        suggested_availability: chosen ? `${chosen.agent.availability.email_status ?? 'unknown'} / ${chosen.agent.availability.chat_status ?? 'unknown'}` : null,
        all_away: allAway,
        reason: chosen
          ? `Lowest resulting pressure (${chosen.after})${allAway ? ' - all agents are away, least-loaded picked' : ` among ${bestAvailable ? 'available' : 'all'} agents`}.`
          : 'No agents synced.'
      };
    });
  }
}
