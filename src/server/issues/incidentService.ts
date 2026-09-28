import type { DB } from '../database/connection.js';
import { IncidentRepository } from '../database/repositories/incidentRepo.js';
import type { NotificationSweep } from '../notifications/notificationSweep.js';

/**
 * IncidentService (plan Phase 18): mutations on the incident workspace with
 * Notification Center fan-out. The repository owns data + timeline events;
 * this service is the thin layer that decides what deserves an
 * incident_update notification (create, status/severity change, new linked
 * conversation, resolution) - the same single-funnel notify() pattern as
 * side threads and known issues.
 */
export class IncidentService {
  private repo: IncidentRepository;
  constructor(private db: DB, private sweep: NotificationSweep) {
    this.repo = new IncidentRepository(db);
  }

  private notify(incidentId: number, title: string, body: string, severity: 'info' | 'warning' | 'critical', actorUserId: number | null): void {
    const inc = this.repo.get(incidentId);
    if (!inc) return;
    this.sweep.notify({
      type: 'incident_update',
      severity,
      title: `${inc.code}: ${title}`,
      body,
      actor_user_local_id: actorUserId,
      dedup_key: `incident_update:${incidentId}:${title}:${new Date().toISOString().slice(0, 16)}`
    });
  }

  create(input: Parameters<IncidentRepository['create']>[0]): ReturnType<IncidentRepository['create']> {
    const incident = this.repo.create(input);
    const body = input.conversationIds?.length
      ? `Severity ${incident.severity}, status ${incident.status}, ${input.conversationIds.length} linked conversation(s).`
      : `Severity ${incident.severity}, status ${incident.status}.`;
    this.notify(incident.id, 'incident declared', body, 'warning', input.actorUserId ?? null);
    return incident;
  }

  patch(id: number, changes: Record<string, unknown>, actorUserId: number | null): ReturnType<IncidentRepository['patch']> {
    const before = this.repo.get(id);
    const after = this.repo.patch(id, changes, actorUserId);
    if (before && after) {
      if (changes.status != null && changes.status !== before.status) {
        this.notify(id, `status changed to ${changes.status}`,
          changes.status === 'resolved' ? 'Incident resolved.' : `Status moved from ${before.status} to ${String(changes.status)}.`,
          changes.status === 'resolved' ? 'info' : 'warning', actorUserId);
      }
      if (changes.severity != null && changes.severity !== before.severity) {
        this.notify(id, `severity changed to ${changes.severity}`, `Severity moved from ${before.severity} to ${String(changes.severity)}.`, 'critical', actorUserId);
      }
    }
    return after;
  }

  linkConversation(incidentId: number, conversationId: number, conversationNumber: number | null, actorUserId: number | null): boolean {
    const created = this.repo.linkConversation(incidentId, conversationId, 'human', actorUserId);
    if (created) {
      this.notify(incidentId, 'conversation linked',
        conversationNumber ? `Conversation #${conversationNumber} is now counted in this incident.` : 'A conversation was linked to this incident.',
        'info', actorUserId);
    }
    return created;
  }

  unlinkConversation(incidentId: number, conversationId: number, actorUserId: number | null): boolean {
    return this.repo.unlinkConversation(incidentId, conversationId, actorUserId);
  }

  /** All repository reads pass straight through (no notification concerns). */
  get repoRef(): IncidentRepository { return this.repo; }
}
