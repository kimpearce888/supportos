import type { DB } from '../connection.js';
import {
  type SideThread,
  type SideThreadDetail,
  type SideThreadMessage,
  type SideThreadStatus,
  type ParsedMention
} from '../../../shared/collaboration.js';

/**
 * SideThreadRepository (v1.8.0, plan Phase 14): internal-only collaboration
 * threads attached to a conversation (Support / Engineering / Billing style).
 *
 * Hard rules encoded here:
 * - LOCAL ONLY: no table here ever syncs to Help Scout; nothing is
 *   customer-visible by construction (the tables have no provider path).
 * - Participants are explicit rows; @mentioning someone in a message
 *   auto-joins them as a participant (observable behavior, not inference).
 * - Mentions are stored resolved (user or team) per message - the backing
 *   store for "mentions for me" and for rendering highlights.
 */
interface SRow { [k: string]: unknown }

export class SideThreadRepository {
  constructor(private db: DB) {}

  createThread(input: {
    conversation_id: number;
    title: string;
    team_local_id?: number | null;
    created_by_user_local_id?: number | null;
    participant_user_ids?: number[];
  }): number {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO side_threads (conversation_id, title, team_local_id, created_by_user_local_id) VALUES (?, ?, ?, ?)')
        .run(input.conversation_id, input.title, input.team_local_id ?? null, input.created_by_user_local_id ?? null);
      const threadId = Number(r.lastInsertRowid);
      const participants = new Set<number>(input.participant_user_ids ?? []);
      if (input.created_by_user_local_id != null) participants.add(input.created_by_user_local_id);
      for (const uid of participants) {
        this.db
          .prepare('INSERT INTO side_thread_participants (side_thread_id, user_local_id, added_by_user_local_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(threadId, uid, input.created_by_user_local_id ?? null);
      }
      return threadId;
    });
    return tx();
  }

  listThreads(conversationId: number): SideThread[] {
    const rows = this.db
      .prepare(
        `SELECT st.id, st.conversation_id, st.title, st.team_local_id, st.status, st.created_by_user_local_id,
                st.created_at, st.updated_at, st.resolved_at,
                c.number AS conversation_number,
                t.name AS team_name,
                (SELECT COUNT(*) FROM side_thread_messages m WHERE m.side_thread_id = st.id) AS message_count,
                (SELECT MAX(m.created_at) FROM side_thread_messages m WHERE m.side_thread_id = st.id) AS last_message_at
         FROM side_threads st
         JOIN conversations c ON c.id = st.conversation_id
         LEFT JOIN teams t ON t.id = st.team_local_id
         WHERE st.conversation_id = ?
         ORDER BY st.status = 'resolved', st.updated_at DESC`
      )
      .all(conversationId) as SRow[];
    return rows.map(mapThread);
  }

  getThread(id: number): SideThreadDetail | null {
    const row = this.db
      .prepare(
        `SELECT st.id, st.conversation_id, st.title, st.team_local_id, st.status, st.created_by_user_local_id,
                st.created_at, st.updated_at, st.resolved_at,
                c.number AS conversation_number,
                t.name AS team_name,
                (SELECT COUNT(*) FROM side_thread_messages m WHERE m.side_thread_id = st.id) AS message_count,
                (SELECT MAX(m.created_at) FROM side_thread_messages m WHERE m.side_thread_id = st.id) AS last_message_at
         FROM side_threads st
         JOIN conversations c ON c.id = st.conversation_id
         LEFT JOIN teams t ON t.id = st.team_local_id
         WHERE st.id = ?`
      )
      .get(id) as SRow | undefined;
    if (!row) return null;
    const participants = (
      this.db
        .prepare(
          `SELECT p.user_local_id, u.first_name, u.last_name, u.mention, p.added_at, p.added_by_user_local_id
           FROM side_thread_participants p JOIN users u ON u.id = p.user_local_id
           WHERE p.side_thread_id = ? ORDER BY p.added_at, p.user_local_id`
        )
        .all(id) as SRow[]
    ).map((p) => ({
      user_local_id: Number(p.user_local_id),
      first_name: p.first_name == null ? null : String(p.first_name),
      last_name: p.last_name == null ? null : String(p.last_name),
      mention: p.mention == null ? null : String(p.mention),
      added_at: String(p.added_at ?? ''),
      added_by_user_local_id: p.added_by_user_local_id == null ? null : Number(p.added_by_user_local_id)
    }));
    const messages = this.listMessages(id);
    return { ...mapThread(row), participants, messages };
  }

  listMessages(threadId: number): SideThreadMessage[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.side_thread_id, m.author_user_local_id, m.body, m.created_at,
                u.first_name AS author_first_name, u.last_name AS author_last_name
         FROM side_thread_messages m LEFT JOIN users u ON u.id = m.author_user_local_id
         WHERE m.side_thread_id = ? ORDER BY m.created_at, m.id`
      )
      .all(threadId) as SRow[];
    const mentions = this.db
      .prepare('SELECT message_id, user_local_id, team_local_id FROM side_thread_mentions WHERE side_thread_id = ?')
      .all(threadId) as SRow[];
    const byMessage = new Map<number, { user_local_id: number | null; team_local_id: number | null }[]>();
    for (const m of mentions) {
      const mid = Number(m.message_id);
      if (!byMessage.has(mid)) byMessage.set(mid, []);
      byMessage.get(mid)!.push({ user_local_id: m.user_local_id == null ? null : Number(m.user_local_id), team_local_id: m.team_local_id == null ? null : Number(m.team_local_id) });
    }
    return rows.map((r) => ({
      id: Number(r.id),
      side_thread_id: Number(r.side_thread_id),
      author_user_local_id: r.author_user_local_id == null ? null : Number(r.author_user_local_id),
      author_first_name: r.author_first_name == null ? null : String(r.author_first_name),
      author_last_name: r.author_last_name == null ? null : String(r.author_last_name),
      body: String(r.body ?? ''),
      created_at: String(r.created_at ?? ''),
      mentions: byMessage.get(Number(r.id)) ?? []
    }));
  }

  /**
   * Add a message: inserts the row, stores RESOLVED mentions, auto-joins
   * mentioned users as participants and bumps the thread's updated_at.
   * Returns the message id + the parsed mentions (for notification fan-out).
   */
  addMessage(input: {
    side_thread_id: number;
    author_user_local_id: number | null;
    body: string;
    mentions: ParsedMention[];
  }): { message_id: number; joined_participant_ids: number[] } {
    const tx = this.db.transaction(() => {
      const thread = this.db.prepare('SELECT id, status FROM side_threads WHERE id = ?').get(input.side_thread_id) as { id: number; status: string } | undefined;
      if (!thread) throw new Error('Side thread not found');
      if (thread.status !== 'open') throw new Error('Side thread is resolved - reopen it to add messages');
      const r = this.db
        .prepare('INSERT INTO side_thread_messages (side_thread_id, author_user_local_id, body) VALUES (?, ?, ?)')
        .run(input.side_thread_id, input.author_user_local_id ?? null, input.body);
      const messageId = Number(r.lastInsertRowid);
      const joined: number[] = [];
      for (const men of input.mentions) {
        this.db
          .prepare('INSERT INTO side_thread_mentions (side_thread_id, message_id, user_local_id, team_local_id) VALUES (?, ?, ?, ?)')
          .run(input.side_thread_id, messageId, men.user_local_id ?? null, men.team_local_id ?? null);
        if (men.user_local_id != null) {
          const added = this.db
            .prepare('INSERT INTO side_thread_participants (side_thread_id, user_local_id, added_by_user_local_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
            .run(input.side_thread_id, men.user_local_id, input.author_user_local_id ?? null);
          if (added.changes > 0) joined.push(men.user_local_id);
        }
      }
      this.db.prepare("UPDATE side_threads SET updated_at = datetime('now') WHERE id = ?").run(input.side_thread_id);
      return { message_id: messageId, joined_participant_ids: joined };
    });
    return tx();
  }

  addParticipants(sideThreadId: number, userIds: number[], addedBy: number | null): number[] {
    const addedIds: number[] = [];
    const tx = this.db.transaction(() => {
      for (const uid of userIds) {
        const r = this.db
          .prepare('INSERT INTO side_thread_participants (side_thread_id, user_local_id, added_by_user_local_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(sideThreadId, uid, addedBy);
        if (r.changes > 0) addedIds.push(uid);
      }
      if (addedIds.length > 0) this.db.prepare("UPDATE side_threads SET updated_at = datetime('now') WHERE id = ?").run(sideThreadId);
    });
    tx();
    return addedIds;
  }

  setStatus(sideThreadId: number, status: SideThreadStatus): boolean {
    const r = this.db
      .prepare(
        status === 'resolved'
          ? "UPDATE side_threads SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'open'"
          : "UPDATE side_threads SET status = 'open', resolved_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'resolved'"
      )
      .run(sideThreadId);
    return r.changes > 0;
  }

  /** Mentions targeting a user across side threads (for the mentions queue). */
  mentionsForUser(userLocalId: number, limit = 100): { message: SideThreadMessage; thread_id: number; thread_title: string; conversation_id: number; conversation_number: number | null; team_local_id: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT sm.id, sm.side_thread_id, sm.author_user_local_id, sm.body, sm.created_at,
                u.first_name AS author_first_name, u.last_name AS author_last_name,
                st.conversation_id, st.title AS thread_title, c.number AS conversation_number, m.team_local_id
         FROM side_thread_mentions m
         JOIN side_thread_messages sm ON sm.id = m.message_id
         JOIN side_threads st ON st.id = m.side_thread_id
         JOIN conversations c ON c.id = st.conversation_id
         LEFT JOIN users u ON u.id = sm.author_user_local_id
         WHERE m.user_local_id = ?
         ORDER BY sm.created_at DESC, sm.id DESC
         LIMIT ?`
      )
      .all(userLocalId, Math.min(200, limit)) as SRow[];
    if (rows.length === 0) return [];
    // batch the mention rows for exactly these messages (one extra query)
    const messageIds = rows.map((r) => Number(r.id));
    const placeholders = messageIds.map(() => '?').join(',');
    const mentionRows = this.db
      .prepare(`SELECT message_id, user_local_id, team_local_id FROM side_thread_mentions WHERE message_id IN (${placeholders})`)
      .all(...messageIds) as SRow[];
    const byMessage = new Map<number, { user_local_id: number | null; team_local_id: number | null }[]>();
    for (const mr of mentionRows) {
      const mid = Number(mr.message_id);
      if (!byMessage.has(mid)) byMessage.set(mid, []);
      byMessage.get(mid)!.push({ user_local_id: mr.user_local_id == null ? null : Number(mr.user_local_id), team_local_id: mr.team_local_id == null ? null : Number(mr.team_local_id) });
    }
    return rows.map((r) => ({
      message: {
        id: Number(r.id),
        side_thread_id: Number(r.side_thread_id),
        author_user_local_id: r.author_user_local_id == null ? null : Number(r.author_user_local_id),
        author_first_name: r.author_first_name == null ? null : String(r.author_first_name),
        author_last_name: r.author_last_name == null ? null : String(r.author_last_name),
        body: String(r.body ?? ''),
        created_at: String(r.created_at ?? ''),
        mentions: byMessage.get(Number(r.id)) ?? []
      },
      thread_id: Number(r.side_thread_id),
      thread_title: String(r.thread_title ?? ''),
      conversation_id: Number(r.conversation_id),
      conversation_number: r.conversation_number == null ? null : Number(r.conversation_number),
      team_local_id: r.team_local_id == null ? null : Number(r.team_local_id)
    }));
  }
}

function mapThread(r: SRow): SideThread {
  return {
    id: Number(r.id),
    conversation_id: Number(r.conversation_id),
    conversation_number: r.conversation_number == null ? null : Number(r.conversation_number),
    title: String(r.title ?? ''),
    team_local_id: r.team_local_id == null ? null : Number(r.team_local_id),
    team_name: r.team_name == null ? null : String(r.team_name),
    status: String(r.status ?? 'open') as SideThreadStatus,
    created_by_user_local_id: r.created_by_user_local_id == null ? null : Number(r.created_by_user_local_id),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
    resolved_at: r.resolved_at == null ? null : String(r.resolved_at),
    message_count: Number(r.message_count ?? 0),
    last_message_at: r.last_message_at == null ? null : String(r.last_message_at)
  };
}
