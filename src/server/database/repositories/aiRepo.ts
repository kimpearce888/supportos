import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import crypto from 'node:crypto';
import type { TicketAnalysis, DraftVerification, AiSourceRef, AiDraftRecord, AiJobRecord, CustomerMemory, OperationalConfidence } from '../../../shared/types.js';

/** AI runs, drafts, verification, feedback, customer memories. */
export class AiRepository {
  constructor(private db: DB) {}

  startRun(type: string, opts: { conversationId?: number | null; model?: string | null; promptVersion?: string | null; inputHash?: string | null; inputRefs?: unknown[] }): number {
    const r = this.db
      .prepare(
        `INSERT INTO ai_runs (type, conversation_id, status, model, prompt_version, input_hash, input_refs, created_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?, datetime('now'))`
      )
      .run(type, opts.conversationId ?? null, opts.model ?? null, opts.promptVersion ?? null, opts.inputHash ?? null, JSON.stringify(opts.inputRefs ?? []));
    return Number(r.lastInsertRowid);
  }

  completeRun(id: number, output: unknown, latencyMs: number, tokenUsage?: unknown): void {
    this.db
      .prepare("UPDATE ai_runs SET status='completed', output=?, latency_ms=?, token_usage=?, completed_at=datetime('now') WHERE id=?")
      .run(JSON.stringify(output), latencyMs, tokenUsage ? JSON.stringify(tokenUsage) : null, id);
  }

  failRun(id: number, error: string): void {
    this.db.prepare("UPDATE ai_runs SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(error.slice(0, 2000), id);
  }

  /** Cache lookup: same type + input hash + prompt version => reuse (section 124). */
  findCachedRun(type: string, inputHash: string, promptVersion: string): { id: number; output: string; created_at: string } | undefined {
    return this.db
      .prepare("SELECT id, output, created_at FROM ai_runs WHERE type=? AND input_hash=? AND prompt_version=? AND status='completed' ORDER BY id DESC LIMIT 1")
      .get(type, inputHash, promptVersion) as { id: number; output: string; created_at: string } | undefined;
  }

  inputHash(conversationId: number, contentSignature: string): string {
    return crypto.createHash('sha256').update(`${conversationId}:${contentSignature}`).digest('hex');
  }

  getLatestAnalysis(conversationId: number): { run: { id: number; model: string | null; prompt_version: string | null; latency_ms: number | null; created_at: string }; analysis: TicketAnalysis; sources: AiSourceRef[] } | undefined {
    const row = this.db
      .prepare("SELECT id, output, model, prompt_version, latency_ms, created_at FROM ai_runs WHERE conversation_id=? AND type='ticket_analysis' AND status='completed' ORDER BY id DESC LIMIT 1")
      .get(conversationId) as { id: number; output: string; model: string | null; prompt_version: string | null; latency_ms: number | null; created_at: string } | undefined;
    if (!row) return undefined;
    const analysis = JSON.parse(row.output) as TicketAnalysis;
    const sources = (this.db.prepare('SELECT source_type, source_id, title, relevance, visibility, timestamp FROM ai_sources WHERE run_id = ?').all(row.id) as AiSourceRef[]) ?? [];
    return { run: { id: row.id, model: row.model, prompt_version: row.prompt_version, latency_ms: row.latency_ms, created_at: row.created_at }, analysis, sources };
  }

  hasAnyAnalysis(conversationId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM ai_runs WHERE conversation_id=? AND type='ticket_analysis' AND status='completed' LIMIT 1").get(conversationId);
  }

  getAnalysisSignature(conversationId: number): string {
    // Signature of analyzed content: thread count + last thread id + last thread body hash (change detection, section 125)
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(t.id),0) AS maxId, COALESCE((SELECT raw_json_hash FROM threads WHERE conversation_id = ? ORDER BY remote_created_at DESC, id DESC LIMIT 1), '') AS lastHash
         FROM threads t WHERE t.conversation_id = ? AND t.deleted_at IS NULL`
      )
      .get(conversationId, conversationId) as { n: number; maxId: number; lastHash: string };
    return `${row.n}:${row.maxId}:${row.lastHash}`;
  }

  saveAnalysis(runId: number, conversationId: number, analysis: TicketAnalysis, sources: AiSourceRef[]): void {
    const tx = this.db.transaction(() => {
      const stmt = this.db.prepare('INSERT INTO ai_extracted_facts (conversation_id, run_id, key, value, confidence) VALUES (?, ?, ?, ?, ?)');
      const entries: [string, string | null][] = [
        ['intent', analysis.intent],
        ['primary_question', analysis.primary_question],
        ['customer_goal', analysis.customer_goal],
        ['product', analysis.product],
        ['feature', analysis.feature],
        ['problem_type', analysis.problem_type],
        ['requested_action', analysis.requested_action],
        ['summary', analysis.summary]
      ];
      for (const [k, v] of entries) if (v) stmt.run(conversationId, runId, k, v, analysis.confidence);
      const srcStmt = this.db.prepare('INSERT INTO ai_sources (run_id, source_type, source_id, title, relevance, visibility, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const s of sources) srcStmt.run(runId, s.source_type, s.source_id, s.title, s.relevance, s.visibility, s.timestamp);
      this.db
        .prepare('INSERT INTO fts_ai_analyses (summary, primary_question, intent, conversation_id, run_id) VALUES (?, ?, ?, ?, ?)')
        .run(analysis.summary ?? '', analysis.primary_question ?? '', analysis.intent ?? '', conversationId, runId);
    });
    tx();
  }

  // ---------------- Drafts ----------------
  createDraft(conversationId: number, content: string, opts: { runId?: number; mode?: 'verified_answer' | 'standard'; model?: string | null; promptVersion?: string; verification?: DraftVerification | null; sources?: AiSourceRef[] }): number {
    const r = this.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, run_id, content, mode, model, prompt_version, state, verification, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'generated', ?, ?, datetime('now'))`
      )
      .run(conversationId, opts.runId ?? null, content, opts.mode ?? 'standard', opts.model ?? null, opts.promptVersion ?? null, opts.verification ? JSON.stringify(opts.verification) : null, JSON.stringify(opts.sources ?? []));
    const id = Number(r.lastInsertRowid);
    if (opts.verification) {
      this.db
        .prepare('INSERT INTO ai_verifications (draft_id, run_id, verified, unsupported_claims, missing_questions, internal_leakage, conflicts, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, opts.runId ?? null, opts.verification.verified ? 1 : 0, JSON.stringify(opts.verification.unsupported_claims), JSON.stringify(opts.verification.missing_questions), JSON.stringify(opts.verification.internal_leakage), JSON.stringify(opts.verification.conflicts), JSON.stringify(opts.verification.warnings));
    }
    return id;
  }

  getDraft(id: number): AiDraftRecord | undefined {
    const row = this.db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      conversation_id: Number(row.conversation_id),
      content: String(row.content),
      mode: (row.mode as AiDraftRecord['mode']) ?? 'standard',
      model: (row.model as string | null) ?? null,
      prompt_version: (row.prompt_version as string) ?? '',
      created_at: String(row.created_at),
      verification: row.verification ? JSON.parse(String(row.verification)) : null,
      sources: row.sources ? JSON.parse(String(row.sources)) : [],
      state: (row.state as AiDraftRecord['state']) ?? 'generated'
    };
  }

  getDraftsForConversation(conversationId: number): AiDraftRecord[] {
    const rows = this.db.prepare('SELECT id FROM ai_drafts WHERE conversation_id = ? ORDER BY id DESC').all(conversationId) as { id: number }[];
    return rows.map((r) => this.getDraft(r.id)!).filter(Boolean);
  }

  setDraftState(id: number, state: AiDraftRecord['state']): void {
    this.db.prepare('UPDATE ai_drafts SET state = ? WHERE id = ?').run(state, id);
  }

  recordFeedback(draftId: number, original: string, final: string, wasSent: boolean): void {
    const editDistance = this.levenshtein(original, final);
    this.db
      .prepare('INSERT INTO ai_feedback (draft_id, original_content, final_content, edit_distance, was_sent, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(draftId, original, final, editDistance, wasSent ? 1 : 0, wasSent ? nowIso() : null);
  }

  private levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n] ?? 0;
  }

  listJobs(limit = 100): AiJobRecord[] {
    return this.db
      .prepare('SELECT id, type, status, conversation_id, model, prompt_version, error, created_at, started_at, completed_at, latency_ms FROM ai_runs ORDER BY id DESC LIMIT ?')
      .all(limit) as AiJobRecord[];
  }

  aiAnalytics(): { tickets_analyzed: number; analysis_completed: number; analysis_failed: number; draft_count: number; drafts_accepted: number; drafts_rejected: number; drafts_edited: number; drafts_sent: number; verification_warnings: number; unsupported_claims: number } {
    const r = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(DISTINCT conversation_id) FROM ai_runs WHERE type='ticket_analysis' AND status='completed') AS tickets_analyzed,
          (SELECT COUNT(*) FROM ai_runs WHERE type='ticket_analysis' AND status='completed') AS analysis_completed,
          (SELECT COUNT(*) FROM ai_runs WHERE type='ticket_analysis' AND status='failed') AS analysis_failed,
          (SELECT COUNT(*) FROM ai_drafts) AS draft_count,
          (SELECT COUNT(*) FROM ai_drafts WHERE state='accepted') AS drafts_accepted,
          (SELECT COUNT(*) FROM ai_drafts WHERE state='rejected') AS drafts_rejected,
          (SELECT COUNT(DISTINCT f.draft_id) FROM ai_feedback f JOIN ai_drafts d ON d.id = f.draft_id WHERE f.edit_distance > 20) AS drafts_edited,
          (SELECT COUNT(*) FROM ai_feedback WHERE was_sent=1) AS drafts_sent,
          (SELECT COUNT(*) FROM ai_verifications v WHERE v.verified=1 AND (v.warnings != '[]')) AS verification_warnings,
          (SELECT COUNT(*) FROM ai_verifications v WHERE v.unsupported_claims != '[]') AS unsupported_claims`
      )
      .get() as Record<string, number>;
    return {
      tickets_analyzed: r.tickets_analyzed ?? 0,
      analysis_completed: r.analysis_completed ?? 0,
      analysis_failed: r.analysis_failed ?? 0,
      draft_count: r.draft_count ?? 0,
      drafts_accepted: r.drafts_accepted ?? 0,
      drafts_rejected: r.drafts_rejected ?? 0,
      drafts_edited: r.drafts_edited ?? 0,
      drafts_sent: r.drafts_sent ?? 0,
      verification_warnings: r.verification_warnings ?? 0,
      unsupported_claims: r.unsupported_claims ?? 0
    };
  }

  // ---------------- Customer memories ----------------
  upsertMemory(customerId: number, key: string, value: string, opts: { source?: 'ai' | 'human'; origin?: 'conversation' | 'manual'; conversationId?: number | null; confidence?: OperationalConfidence } = {}): void {
    const source = opts.source ?? 'ai';
    // Source-aware conflict handling: a row must never be MISLABELED. Without
    // updating source/provenance, an AI extraction landing on a human-written
    // key would silently swap the human's value while still claiming
    // source='human'. AI writes are additionally refused outright when the
    // existing row is human-authored (human judgment is never overwritten by
    // the model); human writes always win and relabel the row honestly.
    this.db
      .prepare(
        `INSERT INTO customer_memories (customer_id, key, value, source, origin, conversation_id, first_seen_at, last_seen_at, confidence, provenance)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?)
         ON CONFLICT(customer_id, key) DO UPDATE SET value=excluded.value, last_seen_at=datetime('now'),
           confidence=excluded.confidence, origin=excluded.origin, conversation_id=COALESCE(excluded.conversation_id, conversation_id),
           source=excluded.source, provenance=excluded.provenance
         WHERE customer_memories.source != 'human' OR excluded.source = 'human'`
      )
      .run(customerId, key, value, source, opts.origin ?? 'conversation', opts.conversationId ?? null, opts.confidence ?? 'unknown', source === 'human' ? 'human_local' : 'ai_generated');
  }

  getMemories(customerId: number): CustomerMemory[] {
    return this.db.prepare('SELECT * FROM customer_memories WHERE customer_id = ? ORDER BY last_seen_at DESC').all(customerId) as CustomerMemory[];
  }

  // ---------------- Golden test set ----------------
  listGoldenTests(): { id: number; name: string; category: string; payload: string }[] {
    return this.db.prepare('SELECT id, name, category, payload FROM golden_test_set ORDER BY id').all() as { id: number; name: string; category: string; payload: string }[];
  }

  insertGoldenTest(name: string, category: string, payload: unknown): void {
    this.db
      .prepare(`CREATE TABLE IF NOT EXISTS golden_test_set (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT, payload TEXT, created_at TEXT DEFAULT (datetime('now')))`)
      .run();
    this.db.prepare('INSERT INTO golden_test_set (name, category, payload) VALUES (?, ?, ?)').run(name, category, JSON.stringify(payload));
  }
}
