import type { DB } from '../connection.js';
import type { IssueCluster } from '../../../shared/types.js';

export type ClusterRecord = IssueCluster;

export interface KnownIssueRecord {
  id: number;
  title: string;
  symptoms: string | null;
  product: string | null;
  feature: string | null;
  known_cause: string | null;
  workaround: string | null;
  customer_safe_explanation: string | null;
  internal_explanation: string | null;
  status: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  conversation_count: number;
  provenance: string;
  created_at: string;
  updated_at: string;
}
export interface KnownIssueRefRecord {
  id: number;
  known_issue_id: number;
  system: string;
  reference_id: string;
  url: string | null;
  title: string | null;
  status: string | null;
  notes: string | null;
}
export interface SupportCaseRecord {
  id: number;
  conversation_id: number;
  customer_id: number | null;
  problem: string | null;
  root_question: string | null;
  resolution: string | null;
  answer: string | null;
  product: string | null;
  feature: string | null;
  tags: string[];
  agent_user_id: number | null;
  resolution_time_min: number | null;
  rating: string | null;
  created_at: string;
}

/** Issue clusters, known issues, support cases, doc gaps. */
export class IssueRepository {
  constructor(private db: DB) {}

  // ---------------- Clusters ----------------
  upsertCluster(c: { title: string; summary: string; category?: string | null; product?: string | null; feature?: string | null; conversation_ids: number[]; known_issue_id?: number | null; ai_generated?: boolean }): number {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM issue_clusters WHERE title = ?').get(c.title) as { id: number } | undefined;
      let clusterId: number;
      if (existing) {
        this.db
          .prepare("UPDATE issue_clusters SET summary = ?, category = ?, product = ?, feature = ?, known_issue_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(c.summary, c.category ?? null, c.product ?? null, c.feature ?? null, c.known_issue_id ?? null, existing.id);
        clusterId = existing.id;
      } else {
        const r = this.db
          .prepare('INSERT INTO issue_clusters (title, summary, category, product, feature, known_issue_id, ai_generated) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(c.title, c.summary, c.category ?? null, c.product ?? null, c.feature ?? null, c.known_issue_id ?? null, c.ai_generated === false ? 0 : 1);
        clusterId = Number(r.lastInsertRowid);
      }
      const ins = this.db.prepare('INSERT OR IGNORE INTO issue_cluster_conversations (cluster_id, conversation_id) VALUES (?, ?)');
      for (const convId of c.conversation_ids) ins.run(clusterId, convId);
      this.db
        .prepare(
          `UPDATE issue_clusters SET
             conversation_count = (SELECT COUNT(*) FROM issue_cluster_conversations WHERE cluster_id = ?),
             customer_count = (SELECT COUNT(DISTINCT c.customer_local_id) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ? AND c.customer_local_id IS NOT NULL),
             first_seen_at = (SELECT MIN(c.remote_created_at) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ?),
             last_seen_at = (SELECT MAX(c.remote_created_at) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ?)
           WHERE id = ?`
        )
        .run(clusterId, clusterId, clusterId, clusterId, clusterId);
    });
    tx();
    return (this.db.prepare('SELECT id FROM issue_clusters WHERE title = ?').get(c.title) as { id: number }).id;
  }

  listClusters(): (ClusterRecord & { conversation_ids: number[] })[] {
    const rows = this.db.prepare('SELECT * FROM issue_clusters ORDER BY conversation_count DESC').all() as ClusterRecord[];
    const convStmt = this.db.prepare('SELECT conversation_id FROM issue_cluster_conversations WHERE cluster_id = ?');
    return rows.map((r) => ({ ...r, conversation_ids: (convStmt.all(r.id) as { conversation_id: number }[]).map((x) => x.conversation_id) }));
  }

  getCluster(id: number): (ClusterRecord & { conversation_ids: number[] }) | undefined {
    const row = this.db.prepare('SELECT * FROM issue_clusters WHERE id = ?').get(id) as ClusterRecord | undefined;
    if (!row) return undefined;
    const convs = this.db.prepare('SELECT conversation_id FROM issue_cluster_conversations WHERE cluster_id = ?').all(id) as { conversation_id: number }[];
    return { ...row, conversation_ids: convs.map((c) => c.conversation_id) };
  }

  /** Compute trend: compare conversations in last 14 days vs previous 14 days (deterministic, section 153). */
  computeTrends(): void {
    this.db.exec(`
      UPDATE issue_clusters SET trend = CASE
        WHEN julianday(first_seen_at) >= julianday('now', '-14 days') THEN 'new'
        ELSE 'stable'
      END
    `);
    const clusters = this.db
      .prepare(
        `SELECT ic.id,
          (SELECT COUNT(*) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ic.id AND julianday(c.remote_created_at) >= julianday('now', '-14 days')) AS recent,
          (SELECT COUNT(*) FROM issue_cluster_conversations icc JOIN conversations c ON c.id = icc.conversation_id WHERE icc.cluster_id = ic.id AND julianday(c.remote_created_at) >= julianday('now', '-28 days') AND julianday(c.remote_created_at) < julianday('now', '-14 days')) AS previous
         FROM issue_clusters ic`
      )
      .all() as { id: number; recent: number; previous: number }[];
    const upd = this.db.prepare('UPDATE issue_clusters SET trend = ? WHERE id = ?');
    const tx = this.db.transaction(() => {
      for (const c of clusters) {
        if (c.recent > c.previous * 1.3 && c.recent >= 3) upd.run('rising', c.id);
        else if (c.previous > 0 && c.recent < c.previous * 0.7) upd.run('falling', c.id);
        else if (c.previous === 0 && c.recent > 0) upd.run('new', c.id);
        else upd.run('stable', c.id);
      }
    });
    tx();
  }

  deleteCluster(id: number): void {
    this.db.prepare('DELETE FROM issue_clusters WHERE id = ?').run(id);
  }

  // ---------------- Known issues ----------------
  createKnownIssue(ki: { title: string; symptoms?: string; product?: string | null; feature?: string | null; known_cause?: string | null; workaround?: string | null; customer_safe_explanation?: string | null; internal_explanation?: string | null; status?: string; conversation_ids?: number[]; provenance?: 'human_local' | 'ai_generated' }): number {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `INSERT INTO known_issues (title, symptoms, product, feature, known_cause, workaround, customer_safe_explanation, internal_explanation, status, provenance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ki.title, ki.symptoms ?? '', ki.product ?? null, ki.feature ?? null, ki.known_cause ?? null, ki.workaround ?? null, ki.customer_safe_explanation ?? null, ki.internal_explanation ?? null, ki.status ?? 'investigating', ki.provenance ?? 'human_local');
      const id = Number(r.lastInsertRowid);
      const ins = this.db.prepare('INSERT OR IGNORE INTO known_issue_conversations (known_issue_id, conversation_id, source) VALUES (?, ?, ?)');
      for (const c of ki.conversation_ids ?? []) ins.run(id, c, ki.provenance === 'ai_generated' ? 'ai' : 'human');
      this.refreshKnownIssueCounts(id);
      this.db.prepare('INSERT INTO fts_known_issues (title, symptoms, workaround, customer_safe_explanation, known_issue_id) VALUES (?, ?, ?, ?, ?)').run(ki.title, ki.symptoms ?? '', ki.workaround ?? '', ki.customer_safe_explanation ?? '', id);
    });
    tx();
    return (this.db.prepare('SELECT id FROM known_issues WHERE title = ? ORDER BY id DESC').get(ki.title) as { id: number }).id;
  }

  refreshKnownIssueCounts(id: number): void {
    this.db
      .prepare(
        `UPDATE known_issues SET
           conversation_count = (SELECT COUNT(*) FROM known_issue_conversations WHERE known_issue_id = ?),
           first_seen_at = (SELECT MIN(c.remote_created_at) FROM known_issue_conversations kic JOIN conversations c ON c.id = kic.conversation_id WHERE kic.known_issue_id = ?),
           last_seen_at = (SELECT MAX(c.remote_created_at) FROM known_issue_conversations kic JOIN conversations c ON c.id = kic.conversation_id WHERE kic.known_issue_id = ?)
         WHERE id = ?`
      )
      .run(id, id, id, id);
  }

  updateKnownIssue(id: number, patch: Partial<{ title: string; symptoms: string; product: string | null; feature: string | null; known_cause: string | null; workaround: string | null; customer_safe_explanation: string | null; internal_explanation: string | null; status: string }>): void {
    const fields: string[] = [];
    const args: Record<string, unknown> = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) {
        fields.push(`${k} = @${k}`);
        args[k] = v;
      }
    }
    if (fields.length === 0) return;
    this.db.prepare(`UPDATE known_issues SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(args);
    if (patch.title || patch.symptoms || patch.workaround || patch.customer_safe_explanation) {
      const row = this.db.prepare('SELECT title, symptoms, workaround, customer_safe_explanation FROM known_issues WHERE id = ?').get(id) as { title: string; symptoms: string; workaround: string; customer_safe_explanation: string } | undefined;
      if (row) {
        this.db.prepare('DELETE FROM fts_known_issues WHERE known_issue_id = ?').run(id);
        this.db.prepare('INSERT INTO fts_known_issues (title, symptoms, workaround, customer_safe_explanation, known_issue_id) VALUES (?, ?, ?, ?, ?)').run(row.title, row.symptoms, row.workaround, row.customer_safe_explanation, id);
      }
    }
  }

  linkConversation(knownIssueId: number, conversationId: number, source: 'human' | 'ai'): void {
    this.db.prepare('INSERT OR IGNORE INTO known_issue_conversations (known_issue_id, conversation_id, source) VALUES (?, ?, ?)').run(knownIssueId, conversationId, source);
    this.refreshKnownIssueCounts(knownIssueId);
  }

  unlinkConversation(knownIssueId: number, conversationId: number): void {
    this.db.prepare('DELETE FROM known_issue_conversations WHERE known_issue_id = ? AND conversation_id = ?').run(knownIssueId, conversationId);
    this.refreshKnownIssueCounts(knownIssueId);
  }

  listKnownIssues(): (KnownIssueRecord & { conversation_ids: number[]; engineering_refs: KnownIssueRefRecord[] })[] {
    const rows = this.db.prepare('SELECT * FROM known_issues ORDER BY last_seen_at DESC').all() as KnownIssueRecord[];
    const convStmt = this.db.prepare('SELECT conversation_id FROM known_issue_conversations WHERE known_issue_id = ?');
    const refStmt = this.db.prepare('SELECT * FROM known_issue_refs WHERE known_issue_id = ?');
    return rows.map((r) => ({
      ...r,
      conversation_ids: (convStmt.all(r.id) as { conversation_id: number }[]).map((c) => c.conversation_id),
      engineering_refs: (refStmt.all(r.id) as KnownIssueRefRecord[]) ?? []
    }));
  }

  getKnownIssue(id: number): (KnownIssueRecord & { conversation_ids: number[]; engineering_refs: KnownIssueRefRecord[] }) | undefined {
    const row = this.db.prepare('SELECT * FROM known_issues WHERE id = ?').get(id) as KnownIssueRecord | undefined;
    if (!row) return undefined;
    const convs = this.db.prepare('SELECT conversation_id FROM known_issue_conversations WHERE known_issue_id = ?').all(id) as { conversation_id: number }[];
    const refs = this.db.prepare('SELECT * FROM known_issue_refs WHERE known_issue_id = ?').all(id) as KnownIssueRefRecord[];
    return { ...row, conversation_ids: convs.map((c) => c.conversation_id), engineering_refs: refs };
  }

  searchKnownIssues(query: string): { id: number; title: string; snippet: string }[] {
    const ftsQuery = query
      .replace(/["*()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .slice(0, 8)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!ftsQuery) return [];
    return this.db
      .prepare(
        `SELECT ki.id AS id, ki.title AS title, snippet(fts_known_issues, 0, '[', ']', '…', 12) AS snippet
         FROM fts_known_issues f JOIN known_issues ki ON ki.id = f.known_issue_id
         WHERE fts_known_issues MATCH ? ORDER BY rank LIMIT 20`
      )
      .all(ftsQuery) as { id: number; title: string; snippet: string }[];
  }

  addEngineeringRef(knownIssueId: number, ref: { system: string; reference_id: string; url?: string | null; title?: string | null; status?: string | null; notes?: string | null }): void {
    this.db
      .prepare('INSERT INTO known_issue_refs (known_issue_id, system, reference_id, url, title, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(knownIssueId, ref.system, ref.reference_id, ref.url ?? null, ref.title ?? null, ref.status ?? null, ref.notes ?? null);
  }

  deleteKnownIssue(id: number): void {
    this.db.prepare('DELETE FROM fts_known_issues WHERE known_issue_id = ?').run(id);
    this.db.prepare('DELETE FROM known_issue_refs WHERE known_issue_id = ?').run(id);
    this.db.prepare('DELETE FROM known_issue_conversations WHERE known_issue_id = ?').run(id);
    this.db.prepare('DELETE FROM known_issues WHERE id = ?').run(id);
  }

  // ---------------- Support cases ----------------
  upsertSupportCase(caseData: { conversation_id: number; customer_id?: number | null; problem?: string; root_question?: string; resolution?: string; answer?: string; product?: string | null; feature?: string | null; tags?: string[]; agent_user_id?: number | null; resolution_time_min?: number | null; rating?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO support_cases (conversation_id, customer_id, problem, root_question, resolution, answer, product, feature, tags, agent_user_id, resolution_time_min, rating)
         VALUES (@conv, @customer, @problem, @rq, @resolution, @answer, @product, @feature, @tags, @agent, @rt, @rating)
         ON CONFLICT(conversation_id) DO UPDATE SET
           customer_id=excluded.customer_id, problem=excluded.problem, root_question=excluded.root_question,
           resolution=excluded.resolution, answer=excluded.answer, product=excluded.product, feature=excluded.feature,
           tags=excluded.tags, agent_user_id=excluded.agent_user_id, resolution_time_min=excluded.resolution_time_min, rating=excluded.rating`
      )
      .run({
        conv: caseData.conversation_id,
        customer: caseData.customer_id ?? null,
        problem: caseData.problem ?? null,
        rq: caseData.root_question ?? null,
        resolution: caseData.resolution ?? null,
        answer: caseData.answer ?? null,
        product: caseData.product ?? null,
        feature: caseData.feature ?? null,
        tags: JSON.stringify(caseData.tags ?? []),
        agent: caseData.agent_user_id ?? null,
        rt: caseData.resolution_time_min ?? null,
        rating: caseData.rating ?? null
      });
  }

  listSupportCases(limit = 500): SupportCaseRecord[] {
    return (this.db.prepare('SELECT * FROM support_cases ORDER BY created_at DESC LIMIT ?').all(limit) as (SupportCaseRecord & { tags: string })[]).map((r) => ({
      ...r,
      tags: JSON.parse(r.tags || '[]')
    }));
  }

  getSupportCaseForConversation(conversationId: number): SupportCaseRecord | undefined {
    const r = this.db.prepare('SELECT * FROM support_cases WHERE conversation_id = ?').get(conversationId) as (SupportCaseRecord & { tags: string }) | undefined;
    return r ? { ...r, tags: JSON.parse(r.tags || '[]') } : undefined;
  }
}
