import type { DB } from '../database/connection.js';
import { SideThreadRepository } from '../database/repositories/sideThreadRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import type { NotificationSweep } from '../notifications/notificationSweep.js';
import { buildMentionDirectory, parseMentions } from './mentionParser.js';
import type { SideThreadCreateInput, SideThreadDetail } from '../../shared/collaboration.js';

/**
 * SideThreadService (v1.8.0, plan Phase 14): orchestration layer over the
 * side-thread repository - mention fan-out, notifications and audit history.
 *
 * Safety properties:
 * - Internal-only: no method here touches the Help Scout provider. Side
 *   threads live and die in the local database, never in the thread mirror.
 * - Audit: every create/message/participant/status change writes audit_log
 *   entries with before/after state (the same audit trail as customer-facing
 *   writes, so collaboration history is reviewable).
 * - Mentions notify immediately (not via the sweep): the actor just typed
 *   them, so the target should hear about it now. Dedup keys still make
 *   re-submission idempotent.
 */
interface SRow { [k: string]: unknown }

export class SideThreadService {
  private repo: SideThreadRepository;
  private auditLog: JobRepository;

  constructor(
    private db: DB,
    private sweep: NotificationSweep
  ) {
    this.repo = new SideThreadRepository(db);
    this.auditLog = new JobRepository(db);
  }

  /** The acting user: the connected Help Scout user, else the first synced user. */
  meUserLocalId(): number | null {
    const row = this.db
      .prepare(`SELECT u.id FROM users u WHERE u.remote_id = (SELECT CAST(json_extract(value, '$') AS INTEGER) FROM application_settings WHERE key = 'me_remote_id')`)
      .get() as SRow | undefined;
    if (row) return Number(row.id);
    const fallback = this.db.prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get() as SRow | undefined;
    return fallback ? Number(fallback.id) : null;
  }

  listThreads(conversationId: number) {
    return this.repo.listThreads(conversationId);
  }

  getThread(id: number): SideThreadDetail | null {
    return this.repo.getThread(id);
  }

  createThread(conversationId: number, input: SideThreadCreateInput, actorUserLocalId: number | null): SideThreadDetail | null {
    const conv = this.db.prepare('SELECT id, number FROM conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId) as SRow | undefined;
    if (!conv) return null;
    const threadId = this.repo.createThread({
      conversation_id: conversationId,
      title: input.title,
      team_local_id: input.team_local_id ?? null,
      created_by_user_local_id: actorUserLocalId,
      participant_user_ids: input.participant_user_ids ?? []
    });
    this.auditLog.audit({
      actor: 'user',
      action: 'side_thread_created',
      conversation_id: conversationId,
      before_state: null,
      after_state: { side_thread_id: threadId, title: input.title, team_local_id: input.team_local_id ?? null }
    });
    if (input.first_message != null && input.first_message.length > 0) {
      this.addMessage(threadId, input.first_message, actorUserLocalId);
    }
    return this.repo.getThread(threadId) ?? null;
  }

  addMessage(threadId: number, body: string, actorUserLocalId: number | null): { thread: SideThreadDetail | null; message_id: number } {
    const thread = this.repo.getThread(threadId);
    if (!thread) return { thread: null, message_id: 0 };
    const directory = buildMentionDirectory(this.db);
    const mentions = parseMentions(body, directory);
    const { message_id } = this.repo.addMessage({
      side_thread_id: threadId,
      author_user_local_id: actorUserLocalId,
      body,
      mentions
    });
    this.auditLog.audit({
      actor: 'user',
      action: 'side_thread_message',
      conversation_id: thread.conversation_id,
      before_state: null,
      after_state: { side_thread_id: threadId, message_id, mention_count: mentions.length }
    });
    // Mention fan-out (immediate - the actor just typed it).
    const authorName = this.userDisplay(actorUserLocalId);
    for (const m of mentions) {
      if (m.user_local_id != null && m.user_local_id !== actorUserLocalId) {
        this.sweep.notify({
          type: 'mentioned',
          title: `${authorName} mentioned you in "${thread.title}" (#${thread.conversation_number ?? thread.conversation_id})`,
          body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
          target_user_local_id: m.user_local_id,
          actor_user_local_id: actorUserLocalId,
          conversation_id: thread.conversation_id,
          conversation_number: thread.conversation_number,
          side_thread_id: threadId,
          dedup_key: `n:stm:${message_id}:${m.user_local_id}`
        });
      }
      if (m.team_local_id != null) {
        for (const member of this.teamMembers(m.team_local_id)) {
          if (member === actorUserLocalId) continue;
          this.sweep.notify({
            type: 'team_mentioned',
            title: `${authorName} mentioned @${m.display || 'the team'} (you are a member) in "${thread.title}" (#${thread.conversation_number ?? thread.conversation_id})`,
            body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
            target_user_local_id: member,
            actor_user_local_id: actorUserLocalId,
            conversation_id: thread.conversation_id,
            conversation_number: thread.conversation_number,
            side_thread_id: threadId,
            dedup_key: `n:stm:${message_id}:team${m.team_local_id}:${member}`
          });
        }
      }
    }
    return { thread: this.repo.getThread(threadId), message_id };
  }

  addParticipants(threadId: number, userIds: number[], actorUserLocalId: number | null): number[] {
    const thread = this.repo.getThread(threadId);
    if (!thread) return [];
    const added = this.repo.addParticipants(threadId, userIds, actorUserLocalId);
    if (added.length > 0) {
      this.auditLog.audit({
        actor: 'user',
        action: 'side_thread_participants_added',
        conversation_id: thread.conversation_id,
        before_state: { participants: thread.participants.map((p) => p.user_local_id) },
        after_state: { side_thread_id: threadId, added }
      });
    }
    return added;
  }

  setStatus(threadId: number, status: 'open' | 'resolved', actorUserLocalId: number | null): boolean {
    const thread = this.repo.getThread(threadId);
    if (!thread) return false;
    const changed = this.repo.setStatus(threadId, status);
    if (changed) {
      this.auditLog.audit({
        actor: 'user',
        action: status === 'resolved' ? 'side_thread_resolved' : 'side_thread_reopened',
        conversation_id: thread.conversation_id,
        before_state: { status: thread.status },
        after_state: { side_thread_id: threadId, status, actor_user_local_id: actorUserLocalId }
      });
    }
    return changed;
  }

  private teamMembers(teamLocalId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(teamLocalId) as SRow[]).map((r) => Number(r.user_id));
  }

  private userDisplay(userLocalId: number | null): string {
    if (userLocalId == null) return 'Someone';
    const row = this.db.prepare('SELECT first_name, last_name, email FROM users WHERE id = ?').get(userLocalId) as SRow | undefined;
    if (!row) return `user #${userLocalId}`;
    return [row.first_name, row.last_name].filter(Boolean).join(' ') || String(row.email ?? `user #${userLocalId}`);
  }
}
