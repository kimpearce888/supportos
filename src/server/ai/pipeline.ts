import type { DB } from '../database/connection.js';
import type { AiProvider } from './provider.js';
import { EvidenceBuilder } from './evidence.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { ConversationRepository } from '../database/repositories/conversationRepo.js';
import { PROMPT_VERSIONS } from '../../shared/constants.js';
import type { TicketAnalysis, AiSourceRef, AiDraftRecord, DraftVerification } from '../../shared/types.js';
import { htmlToText } from '../../shared/utils.js';

/**
 * Multi-stage AI pipeline (spec #31, #32, #74): analysis -> evidence -> draft ->
 * verification -> note -> memory. Each stage is a separate AI run with caching
 * (input hash + prompt version), and everything is stored structurally.
 */
export class AiPipeline {
  private evidence: EvidenceBuilder;
  private ai: AiRepository;
  private jobs: JobRepository;
  private issues: IssueRepository;
  private settings: SettingsRepository;
  private conv: ConversationRepository;

  constructor(
    private db: DB,
    private provider: AiProvider
  ) {
    this.evidence = new EvidenceBuilder(db);
    this.ai = new AiRepository(db);
    this.jobs = new JobRepository(db);
    this.issues = new IssueRepository(db);
    this.settings = new SettingsRepository(db);
    this.conv = new ConversationRepository(db);
  }

  settingsRepo(): SettingsRepository {
    return this.settings;
  }

  /**
   * Full ticket analysis with caching. Returns the analysis (fresh or cached).
   * Change detection (spec #125): reanalyzes only when thread content changed.
   */
  async analyzeTicket(conversationLocalId: number, opts: { force?: boolean } = {}): Promise<{ analysis: TicketAnalysis; sources: AiSourceRef[]; cached: boolean; runId: number }> {
    const signature = this.ai.getAnalysisSignature(conversationLocalId);
    const inputHash = this.ai.inputHash(conversationLocalId, signature);
    if (!opts.force) {
      const cached = this.ai.findCachedRun('ticket_analysis', inputHash, PROMPT_VERSIONS.TICKET_ANALYSIS);
      if (cached) {
        const existing = this.ai.getLatestAnalysis(conversationLocalId);
        if (existing) return { analysis: existing.analysis, sources: existing.sources, cached: true, runId: cached.id };
      }
    }
    const ctx = this.evidence.build(conversationLocalId, { includeInternal: true });
    if (!ctx) throw new Error('Conversation not found');
    const runId = this.ai.startRun('ticket_analysis', { conversationId: conversationLocalId, model: this.provider.modelInfo().chat_model, promptVersion: PROMPT_VERSIONS.TICKET_ANALYSIS, inputHash, inputRefs: [conversationLocalId] });
    try {
      const result = await this.provider.analyzeTicket(ctx);
      this.ai.completeRun(runId, result.analysis, result.latencyMs);
      const sources = this.evidence.sourcesFor(ctx);
      this.ai.saveAnalysis(runId, conversationLocalId, result.analysis, sources);
      // Save extracted facts as support intelligence
      return { analysis: result.analysis, sources, cached: false, runId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.ai.failRun(runId, msg);
      throw e;
    }
  }

  /** Generate + verify a customer-safe draft (never auto-sent, spec #14/#15). */
  async generateDraft(conversationLocalId: number, opts: { mode?: 'verified_answer' | 'standard'; force?: boolean; analysis?: TicketAnalysis | null }): Promise<{ draft: AiDraftRecord; verification: DraftVerification | null }> {
    const analysis = opts.analysis ?? (await this.analyzeTicket(conversationLocalId, { force: opts.force })).analysis;
    const ctx = this.evidence.build(conversationLocalId, { includeInternal: false });
    if (!ctx) throw new Error('Conversation not found');
    const runId = this.ai.startRun('customer_draft', { conversationId: conversationLocalId, promptVersion: PROMPT_VERSIONS.CUSTOMER_DRAFT });
    let draftText: string;
    let model: string;
    try {
      const res = await this.provider.generateDraft(ctx, opts.mode ?? 'verified_answer', analysis);
      draftText = res.draft;
      model = res.model;
      this.ai.completeRun(runId, { draft: res.draft, usedEvidence: res.usedEvidence }, res.latencyMs);
    } catch (e) {
      this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
      throw e;
    }
    // Verification pass (spec #35)
    let verification: DraftVerification | null = null;
    try {
      const v = await this.verifyDraftInternal(conversationLocalId, draftText, analysis);
      verification = v;
    } catch {
      verification = {
        verified: false,
        unsupported_claims: [],
        missing_questions: [],
        internal_leakage: [],
        conflicts: [],
        warnings: ['Verification pass failed - treat this draft as unverified']
      };
    }
    const sources = this.evidence.sourcesFor(ctx);
    const draftId = this.ai.createDraft(conversationLocalId, draftText, { runId, mode: opts.mode ?? 'verified_answer', model, promptVersion: PROMPT_VERSIONS.CUSTOMER_DRAFT, verification, sources });
    const draft = this.ai.getDraft(draftId)!;
    return { draft, verification };
  }

  async verifyDraftInternal(conversationLocalId: number, draftText: string, analysis: TicketAnalysis | null): Promise<DraftVerification> {
    const ctx = this.evidence.build(conversationLocalId, { includeInternal: true });
    if (!ctx) throw new Error('Conversation not found');
    const runId = this.ai.startRun('draft_verification', { conversationId: conversationLocalId, promptVersion: PROMPT_VERSIONS.DRAFT_VERIFICATION });
    try {
      const questions = [analysis?.primary_question, ...(analysis?.secondary_questions ?? [])].filter((q): q is string => !!q);
      const res = await this.provider.verifyDraft(ctx, draftText, questions);
      this.ai.completeRun(runId, res.verification, res.latencyMs);
      return res.verification;
    } catch (e) {
      this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Compose the internal AI note (clearly marked as AI-generated, spec #36). */
  buildAiNote(conversationLocalId: number, analysis: TicketAnalysis, similar: { number: number; subject: string; resolution: string }[], knownIssueTitle: string | null): string {
    const parts: string[] = ['[AI Analysis - generated locally by SupportOS AI, not written by a human]'];
    if (analysis.customer_goal) parts.push(`Customer goal: ${analysis.customer_goal}`);
    if (analysis.primary_question) parts.push(`Main question: ${analysis.primary_question}`);
    if (analysis.secondary_questions.length) parts.push(`Secondary questions: ${analysis.secondary_questions.join(' | ')}`);
    if (analysis.problem_type) parts.push(`Detected issue type: ${analysis.problem_type}${analysis.feature ? ` (${analysis.feature})` : ''}`);
    if (analysis.urgency) parts.push(`Urgency: ${analysis.urgency}`);
    if (analysis.sentiment) parts.push(`Sentiment: ${analysis.sentiment}`);
    if (similar.length) {
      parts.push('Similar past tickets:');
      for (const s of similar.slice(0, 3)) parts.push(`  #${s.number} ${s.subject} - ${(s.resolution || '(no resolution recorded)').slice(0, 160)}`);
    }
    if (knownIssueTitle) parts.push(`Known issue: ${knownIssueTitle}`);
    if (analysis.missing_information.length) parts.push(`Missing information: ${analysis.missing_information.join('; ')}`);
    parts.push(`Confidence: ${analysis.confidence} (operational confidence based on evidence quality, not a probability)`);
    if (analysis.summary) parts.push(`Summary: ${analysis.summary}`);
    return parts.join('\n');
  }

  /** Rewrite a draft without ever touching the user's composer (spec #37). */
  async rewriteDraft(draftId: number, instruction: 'shorten' | 'expand' | 'warmer' | 'more_direct'): Promise<string> {
    const draft = this.ai.getDraft(draftId);
    if (!draft) throw new Error('Draft not found');
    const res = await this.provider.rewriteDraft(draft.content, instruction);
    return res.text;
  }

  /** Extract durable customer memories (spec #38) - always marked AI-derived. */
  async extractMemories(conversationLocalId: number): Promise<{ extracted: number }> {
    const conv = this.db
      .prepare('SELECT c.id, c.customer_local_id, c.number, (SELECT TRIM(COALESCE(cu.first_name,\'\') || \' \' || COALESCE(cu.last_name,\'\')) FROM customers cu WHERE cu.id = c.customer_local_id) AS customer_name FROM conversations c WHERE c.id = ?')
      .get(conversationLocalId) as { id: number; customer_local_id: number | null; number: number; customer_name: string | null } | undefined;
    if (!conv?.customer_local_id) return { extracted: 0 };
    const threads = (this.db
      .prepare("SELECT type, from_name, body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY remote_created_at ASC")
      .all(conversationLocalId) as { type: string | null; from_name: string | null; body_html: string | null; body_text: string | null }[]).map((t) => ({
      author: t.from_name ?? t.type ?? 'unknown',
      text: htmlToText(t.body_html ?? t.body_text ?? '').slice(0, 1200)
    }));
    const runId = this.ai.startRun('memory_extraction', { conversationId: conversationLocalId, promptVersion: PROMPT_VERSIONS.MEMORY_EXTRACTION });
    try {
      const res = await this.provider.extractMemories(conv.customer_name ?? 'Customer', threads);
      this.ai.completeRun(runId, { memories: res.memories }, res.latencyMs);
      for (const m of res.memories) {
        this.ai.upsertMemory(conv.customer_local_id, m.key, m.value, { source: 'ai', origin: 'conversation', conversationId: conversationLocalId, confidence: m.confidence === 'high' ? 'high' : m.confidence === 'medium' ? 'medium' : 'low' });
      }
      return { extracted: res.memories.length };
    } catch (e) {
      this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
      return { extracted: 0 };
    }
  }

  /** Issue clustering over recent conversations (spec #40) - AI discovers clusters from actual data. */
  async clusterIssues(days = 60): Promise<{ clusters: { title: string; summary: string; category: string | null; product: string | null; feature: string | null; conversation_ids: number[] }[] }> {
    const conversations = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.preview,
           (SELECT GROUP_CONCAT(t.name) FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = c.id) AS tags
         FROM conversations c WHERE c.deleted_at IS NULL AND c.remote_created_at >= datetime('now', '-' || @days || ' days') ORDER BY c.number`
      )
      .all({ days }) as { id: number; number: number; subject: string | null; preview: string | null; tags: string | null }[];
    if (conversations.length < 3) return { clusters: [] };
    const runId = this.ai.startRun('issue_cluster', { promptVersion: PROMPT_VERSIONS.ISSUE_CLUSTER });
    try {
      const res = await this.provider.clusterIssues(conversations.map((c) => ({ number: c.number, subject: c.subject ?? '', preview: (c.preview ?? '').slice(0, 200), tags: (c.tags ?? '').split(',').filter(Boolean) })));
      this.ai.completeRun(runId, res.clusters, res.latencyMs);
      const out = res.clusters
        .filter((c) => c.conversation_numbers.length >= 2)
        .map((c) => {
          const ids = conversations.filter((x) => c.conversation_numbers.includes(x.number)).map((x) => x.id);
          this.issues.upsertCluster({ title: c.title, summary: c.summary, category: c.category, product: c.product, feature: c.feature, conversation_ids: ids, ai_generated: true });
          return { title: c.title, summary: c.summary, category: c.category, product: c.product, feature: c.feature, conversation_ids: ids };
        });
      this.issues.computeTrends();
      return { clusters: out };
    } catch (e) {
      this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  async reportNarrative(reportName: string, facts: Record<string, unknown>): Promise<string> {
    const runId = this.ai.startRun('report_narrative', { promptVersion: PROMPT_VERSIONS.REPORT_NARRATIVE });
    try {
      const res = await this.provider.generateReportNarrative(reportName, facts);
      this.ai.completeRun(runId, { narrative: res.narrative }, res.latencyMs);
      return res.narrative;
    } catch (e) {
      this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** Automatic new-ticket flow (spec #31): analysis + optional note/draft creation per settings. */
  async processNewTicket(conversationLocalId: number): Promise<{ analysis: TicketAnalysis | null; noteCreated: boolean; draftCreated: boolean; error?: string }> {
    try {
      const { analysis } = await this.analyzeTicket(conversationLocalId);
      let noteCreated = false;
      let draftCreated = false;
      const settings = this.settings.getAllSettings();
      if (settings.automatic_note_enabled) {
        const similar = this.evidence.findSimilar(conversationLocalId, 3);
        const note = this.buildAiNote(conversationLocalId, analysis, similar, analysis.known_issue_candidate);
        this.jobs.enqueue('ai', 'create_ai_note', { conversationId: conversationLocalId, text: note }, 2, 1);
        noteCreated = true;
      }
      if (settings.automatic_draft_enabled) {
        await this.generateDraft(conversationLocalId, { mode: 'verified_answer', analysis });
        draftCreated = true;
      }
      // Extract memories in the background of the same job
      void this.extractMemories(conversationLocalId).catch(() => undefined);
      return { analysis, noteCreated, draftCreated };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.jobs.logError('ai', `Ticket analysis failed for conversation ${conversationLocalId}: ${msg}`);
      return { analysis: null, noteCreated: false, draftCreated: false, error: msg };
    }
  }
}
