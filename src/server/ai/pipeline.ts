import type { DB } from '../database/connection.js';
import type { AiProvider } from './provider.js';
import { EvidenceBuilder } from './evidence.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { IssueRepository } from '../database/repositories/issueRepo.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { ConversationRepository } from '../database/repositories/conversationRepo.js';
import { InteractionEngine } from './interaction/engine.js';
import { sanitizeSignals } from './interaction/safety.js';
import { INTERACTION_STRATEGY_BLOCK } from './prompts.js';
import { PROMPT_VERSIONS, RESPONSE_PREFERENCE_VALUES } from '../../shared/constants.js';
import type { TicketAnalysis, AiSourceRef, AiDraftRecord, DraftVerification, InteractionSignal, InteractionChange, BehaviorBaseline, CurrentInteraction } from '../../shared/types.js';
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
  private interaction: InteractionEngine;

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
    this.interaction = new InteractionEngine(db);
  }

  /**
   * Deterministic interaction strategy for the draft prompt (spec #36 stage 3 + #51).
   * Built from the stored interaction card; degrades to null when no data exists.
   */
  private buildInteractionStrategyBlock(conversationLocalId: number): string | null {
    try {
      const card = this.interaction.buildCard(conversationLocalId);
      if (!card || !card.recommendation) return null;
      const customerId = card.customer_local_id;
      const validPrefs = new Set<string>(RESPONSE_PREFERENCE_VALUES);
      const preferences = customerId
        ? this.interaction.repo
            .getPreferences(customerId)
            .filter((p) => p.origin === 'human_entered' || p.evidence_count >= 3)
            .map((p) => p.human_override?.value ?? p.preference)
            .filter((v) => validPrefs.has(v))
        : [];
      // Already-provided info (spec #51): customer messages in this thread
      const alreadyProvided = this.db
        .prepare("SELECT body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND type = 'customer' AND state = 'published' ORDER BY remote_created_at ASC")
        .all(conversationLocalId) as { body_html: string | null; body_text: string | null }[];
      const providedFacts = alreadyProvided
        .map((t) => extractProvidedFacts(htmlToText(t.body_html ?? t.body_text ?? '')))
        .flat()
        .slice(0, 10);
      const r = card.recommendation;
      return INTERACTION_STRATEGY_BLOCK({
        tone: r.tone,
        length: r.length,
        response_strategy: r.response_strategy,
        avoid: r.avoid,
        preferences,
        alreadyProvided: providedFacts
      });
    } catch {
      return null;
    }
  }

  settingsRepo(): SettingsRepository {
    return this.settings;
  }

  interactionEngine(): InteractionEngine {
    return this.interaction;
  }

  // ---------------- Client Interaction Intelligence (interaction spec #35, #36) ----------------

  /**
   * Two-stage interaction analysis. Stage 1 (observation) + Stage 2 (recommendation)
   * run only when the AI provider is enabled; the deterministic engine covers
   * baseline/change/outcomes with zero AI. AI failure degrades gracefully.
   */
  async analyzeInteraction(conversationLocalId: number): Promise<{ ai_enriched: boolean; error?: string }> {
    const conv = (this.db
      .prepare('SELECT id, customer_local_id FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationLocalId) as { id: number; customer_local_id: number | null } | undefined) ?? null;
    if (!conv) throw new Error('Conversation not found');
    // Deterministic base: current signals + observations + baseline (spec: works without AI)
    this.interaction.recordCurrentInteraction(conversationLocalId);
    if (!this.provider.available || this.provider.kind === 'disabled') {
      return { ai_enriched: false };
    }
    const customerId = conv.customer_local_id;
    if (!customerId) return { ai_enriched: false };
    const customerName = (this.db
      .prepare("SELECT TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) AS name FROM customers WHERE id = ?")
      .get(customerId) as { name: string | null } | undefined)?.name ?? 'Customer';
    const messages = (this.db
      .prepare("SELECT id, body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND type = 'customer' AND state = 'published' ORDER BY remote_created_at ASC")
      .all(conversationLocalId) as { id: number; body_html: string | null; body_text: string | null }[])
      .map((t) => ({ text: htmlToText(t.body_html ?? t.body_text ?? ''), thread_local_id: t.id }))
      .filter((m) => m.text.trim().length > 0);
    if (!messages.length) return { ai_enriched: false };
    const history = this.interaction.repo.getCustomerConversations(customerId, conversationLocalId);
    const baseline = this.interaction.repo.getBaseline(customerId) as BehaviorBaseline | null;
    const baselineSummary = baseline
      ? baseline.dimensions.map((d) => `${d.dimension}: usually ${d.typical_value.replace(/_/g, ' ')} (${d.observation_count} observations)`).join('\n')
      : null;
    const recentHistory = history.slice(0, 5).map((h) => {
      const firstMsg = (this.db
        .prepare("SELECT body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND type = 'customer' ORDER BY remote_created_at ASC LIMIT 1")
        .get(h.id) as { body_html: string | null; body_text: string | null } | undefined);
      return { number: h.number, subject: h.subject, excerpt: htmlToText(firstMsg?.body_html ?? firstMsg?.body_text ?? '').slice(0, 240) };
    });

    // Stage 1: observation
    const runId1 = this.ai.startRun('interaction_observation', { conversationId: conversationLocalId, promptVersion: PROMPT_VERSIONS.INTERACTION_OBSERVATION });
    let aiSignals: InteractionSignal[] = [];
    let aiGoal: string | null = null;
    try {
      const obs = await this.provider.observeInteraction({
        customerName,
        clientKind: history.length > 0 ? 'returning' : 'first_time',
        currentMessages: messages.map((m) => ({ text: m.text, thread_local_id: m.thread_local_id })),
        baselineSummary,
        recentHistory
      });
      aiSignals = obs.signals;
      aiGoal = obs.customerGoal;
      this.ai.completeRun(runId1, { signals: obs.signals, customer_goal: obs.customerGoal, notes: obs.notes }, obs.latencyMs);
    } catch (e) {
      this.ai.failRun(runId1, e instanceof Error ? e.message : String(e));
      return { ai_enriched: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Merge AI signals over the heuristic set and PERSIST the merged card so
    // GET /api/interaction/:id surfaces the AI result (not just a flipped
    // 'sources' label on heuristic-only data).
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (aiSignals.length) {
      const heuristic = this.interaction.computeCurrentInteraction(conversationLocalId);
      const mergedSignals = heuristic
        ? sanitizeSignals([...heuristic.signals.reduce((acc, s) => acc.set(s.dimension, s), new Map<string, InteractionSignal>()), ...aiSignals.map((s) => [s.dimension, s] as const)].values() as unknown as InteractionSignal[]).signals
        : sanitizeSignals(aiSignals).signals;
      this.interaction.repo.saveCurrentInteraction({
        conversation_id: conversationLocalId,
        customer_id: customerId,
        signals: mergedSignals,
        message_stats: heuristic?.message_stats ?? { customer_messages: 0, avg_message_length: 0, question_count: 0, exclamation_ratio: 0, caps_ratio: 0 },
        customer_goal: aiGoal ?? heuristic?.customer_goal ?? null,
        sources: 'heuristic+ai',
        analysis_version: PROMPT_VERSIONS.INTERACTION_OBSERVATION
      });
      this.interaction.repo.insertObservations(
        aiSignals.map((s) => ({
          customer_id: customerId,
          conversation_id: conversationLocalId,
          thread_local_id: s.evidence?.thread_local_id ?? null,
          dimension: s.dimension,
          value: s.value,
          confidence: s.confidence,
          evidence_excerpt: s.evidence?.excerpt ?? null,
          source: 'ai' as const,
          observed_at: nowIso
        }))
      );
      this.interaction.rebuildBaseline(customerId);
    }

    // Stage 2: recommendation. Inputs come from the STORED (merged) signals,
    // and the baseline EXCLUDES the current conversation - refreshing a closed
    // ticket must not compare it against a baseline that contains itself.
    const stored = this.interaction.repo.getLatestCurrentInteraction(conversationLocalId);
    const cardCurrent = this.interaction.computeCurrentInteraction(conversationLocalId);
    const freshBaseline = customerId ? this.interaction.comparisonBaseline(customerId, conversationLocalId) : null;
    const stageCurrent: CurrentInteraction | null = stored?.signals.length
      ? cardCurrent
        ? { ...cardCurrent, signals: stored.signals }
        : { conversation_local_id: conversationLocalId, customer_local_id: customerId, is_returning_client: history.length > 0, signals: stored.signals, customer_goal: stored.customer_goal, message_stats: stored.message_stats ?? { customer_messages: 0, avg_message_length: 0, question_count: 0, exclamation_ratio: 0, caps_ratio: 0 }, generated_at: new Date().toISOString(), sources: 'heuristic+ai' }
      : cardCurrent;
    const changes: InteractionChange[] = stageCurrent ? this.interaction.computeChanges(stageCurrent, freshBaseline) : [];
    const preferences = this.interaction.repo.getPreferences(customerId).map((p) => ({ preference: p.preference, origin: p.origin }));
    const outcome = this.interaction.computeOutcome(conversationLocalId);
    const repeatIssue = this.interaction.detectRepeatIssue(conversationLocalId);
    const runId2 = this.ai.startRun('interaction_recommendation', { conversationId: conversationLocalId, promptVersion: PROMPT_VERSIONS.INTERACTION_RECOMMENDATION });
    try {
      const rec = await this.provider.recommendSupportApproach({
        clientKind: history.length > 0 ? 'returning' : 'first_time',
        currentSignals: (stageCurrent?.signals ?? []).map((s) => ({ dimension: s.dimension, value: s.value, confidence: s.confidence })),
        changes: changes.map((c) => ({ dimension: c.dimension, baseline_value: c.baseline_value, current_value: c.current_value, significant: c.significant })),
        baselineSummary: freshBaseline
          ? freshBaseline.dimensions.map((d) => `${d.dimension}: usually ${d.typical_value.replace(/_/g, ' ')} (${d.observation_count} observations)`).join('\n')
          : baselineSummary,
        preferences,
        repeatIssue: repeatIssue?.detected ?? false,
        effortScore: outcome?.effort_score ?? null
      });
      this.ai.completeRun(runId2, rec.recommendation, rec.latencyMs);
      // Persist so later GETs (and the draft prompt strategy block) use the
      // AI recommendation instead of silently falling back to heuristics.
      this.interaction.repo.saveRecommendation(conversationLocalId, rec.recommendation, PROMPT_VERSIONS.INTERACTION_RECOMMENDATION, rec.model);
      return { ai_enriched: true };
    } catch (e) {
      this.ai.failRun(runId2, e instanceof Error ? e.message : String(e));
      return { ai_enriched: false, error: e instanceof Error ? e.message : String(e) };
    }
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
    // Interaction strategy injection (interaction spec #36, #51): communication approach
    // + what the customer already provided, so the draft never makes them repeat themselves.
    ctx.interactionStrategy = this.buildInteractionStrategyBlock(conversationLocalId);
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
         FROM conversations c WHERE c.deleted_at IS NULL AND julianday(c.remote_created_at) >= julianday('now', '-' || @days || ' days') ORDER BY c.number`
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

/** Extract "what the customer already provided" so drafts never ask for it again (spec #51). */
function extractProvidedFacts(text: string): string[] {
  const facts: string[] = [];
  const lower = text.toLowerCase();
  const patterns: { re: RegExp; label: string }[] = [
    { re: /(screenshot|screenshot attached|attached (screenshot|image|file|log))/, label: 'screenshots/attachments' },
    { re: /(browser (is )?(chrome|firefox|safari|edge)|using (chrome|firefox|safari|edge))/, label: 'browser details' },
    { re: /(version [0-9.]+|v[0-9]+\.[0-9]+)/, label: 'version numbers' },
    { re: /(error (message|code)[:\s]*.{0,80}|error [0-9]{3})/, label: 'error messages' },
    { re: /(api key|token|workspace id|account id|email address)/, label: 'account identifiers' },
    { re: /(already (tried|did|re-?installed|restarted|cleared)|we already|we have already)/, label: 'troubleshooting already performed' },
    { re: /(timezone|utc[+-][0-9])/, label: 'timezone information' },
    { re: /(invoice|receipt|payment|card (was )?declined|billing)/, label: 'billing details' }
  ];
  for (const { re, label } of patterns) {
    if (re.test(lower)) facts.push(label);
  }
  return facts;
}
