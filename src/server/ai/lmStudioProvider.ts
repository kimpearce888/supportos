import type { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { LmStudioClient, LmStudioError, type ChatMessage } from '../integrations/lmstudio/lmStudioClient.js';
import type { AiProvider, AttributeExtractionInput, ExtractedAttribute } from './provider.js';
import { buildTicketAnalysisUser, buildCustomerDraftUser, buildDraftVerificationUser, buildIssueClusterUser, buildReportNarrativeUser, buildMemoryExtractionUser, buildInteractionObservationUser, buildInteractionRecommendationUser, buildAttributeExtractionUser, TICKET_ANALYSIS_SYSTEM, CUSTOMER_DRAFT_SYSTEM, DRAFT_VERIFICATION_SYSTEM, ISSUE_CLUSTER_SYSTEM, REPORT_NARRATIVE_SYSTEM, MEMORY_EXTRACTION_SYSTEM, INTERACTION_OBSERVATION_SYSTEM, INTERACTION_RECOMMENDATION_SYSTEM, ATTRIBUTE_EXTRACTION_SYSTEM, type EvidenceContext, type InteractionObservationInput, type InteractionRecommendationInput } from './prompts.js';
import { ticketAnalysisOutputSchema, draftVerificationOutputSchema, clusteringOutputSchema, interactionObservationOutputSchema, interactionRecommendationOutputSchema, attributeExtractionOutputSchema } from '../../shared/schemas.js';
import type { TicketAnalysis, DraftVerification, InteractionSignal, SupportApproach } from '../../shared/types.js';
import { redactText } from '../security/redaction.js';
import { sanitizeSignals, assertInteractionTextSafe, sanitizeInteractionText } from './interaction/safety.js';
import { isValidValue } from './interaction/heuristics.js';
import type { InteractionDimension } from '../../shared/constants.js';

function extractJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text.replace(/```json\s*/gi, '```').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** LM Studio implementation of the AI provider (local-only, OpenAI-compatible). */
export class LmStudioProvider implements AiProvider {
  readonly kind = 'lmstudio';
  private client: LmStudioClient;
  private lastErr: string | null = null;

  constructor(private settings: SettingsRepository) {
    this.client = new LmStudioClient(settings);
  }

  get available(): boolean {
    return true; // reachability is only knowable per-request; health() is used for status
  }

  lastError(): string | null {
    return this.lastErr;
  }

  modelInfo(): { chat_model: string | null; embedding_model: string | null; base_url: string } {
    const s = this.settings.getLmStudio();
    return { chat_model: s.chat_model, embedding_model: s.embedding_model, base_url: s.base_url };
  }

  private async chatJson(system: string, user: string, opts: { redact: boolean; maxTokens?: number }): Promise<{ json: Record<string, unknown> | null; raw: string | null; latencyMs: number; model: string }> {
    this.client.refreshFromSettings();
    const redactionEnabled = this.settings.get('redaction_enabled', true);
    const safeUser = opts.redact ? redactText(user, redactionEnabled).text : user;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: safeUser }
    ];
    const res = await this.client.chat({ messages, jsonMode: true, temperature: 0.15, maxTokens: opts.maxTokens ?? 2048 });
    this.lastErr = null;
    return { json: extractJson(res.content), raw: res.content, latencyMs: res.latencyMs, model: res.model };
  }

  async analyzeTicket(ctx: EvidenceContext): Promise<{ analysis: TicketAnalysis; latencyMs: number; model: string }> {
    const res = await this.chatJson(TICKET_ANALYSIS_SYSTEM, buildTicketAnalysisUser(ctx), { redact: true });
    const parsed = ticketAnalysisOutputSchema.safeParse(res.json ?? {});
    if (!parsed.success) {
      this.lastErr = 'AI analysis returned an unparseable structure';
      throw new LmStudioError('The local model did not return a valid analysis JSON. Try a stronger model or retry.', false);
    }
    const d = parsed.data;
    const evidenceToConfidence = { strong: 'high', some: 'medium', limited: 'low', insufficient: 'unknown' } as const;
    const analysis: TicketAnalysis = {
      intent: d.intent ?? null,
      primary_question: d.primary_question ?? null,
      secondary_questions: d.secondary_questions ?? [],
      customer_goal: d.customer_goal ?? null,
      product: d.product ?? null,
      feature: d.feature ?? null,
      problem_type: d.problem_type ?? null,
      requested_action: d.requested_action ?? null,
      urgency: d.urgency ?? null,
      sentiment: d.sentiment ?? null,
      known_issue_candidate: d.known_issue_candidate ?? null,
      issue_cluster_candidate: d.issue_cluster_candidate ?? null,
      missing_information: d.missing_information ?? [],
      summary: d.summary ?? null,
      confidence: evidenceToConfidence[d.evidence_quality ?? 'insufficient'] ?? 'unknown'
    };
    return { analysis, latencyMs: res.latencyMs, model: res.model };
  }

  async generateDraft(ctx: EvidenceContext, mode: 'verified_answer' | 'standard', analysis: TicketAnalysis | null): Promise<{ draft: string; usedEvidence: string[]; latencyMs: number; model: string }> {
    const res = await this.chatJson(CUSTOMER_DRAFT_SYSTEM, buildCustomerDraftUser(ctx, mode, analysis), { redact: true, maxTokens: 1600 });
    const json = res.json;
    const draft = typeof json?.draft === 'string' ? json.draft : (res.raw ?? '').trim();
    if (!draft) {
      this.lastErr = 'AI draft generation returned empty content';
      throw new LmStudioError('The local model returned an empty draft. Retry or use a different model.', false);
    }
    const usedEvidence = Array.isArray(json?.used_evidence) ? (json.used_evidence as string[]).map(String) : [];
    return { draft, usedEvidence, latencyMs: res.latencyMs, model: res.model };
  }

  async verifyDraft(ctx: EvidenceContext, draft: string, customerQuestions: string[]): Promise<{ verification: DraftVerification; latencyMs: number; model: string }> {
    const res = await this.chatJson(DRAFT_VERIFICATION_SYSTEM, buildDraftVerificationUser(ctx, draft, customerQuestions), { redact: true });
    const parsed = draftVerificationOutputSchema.safeParse(res.json ?? { verified: false, warnings: ['Verification output could not be parsed'] });
    const v = parsed.success ? parsed.data : { verified: false, unsupported_claims: [], missing_questions: [], internal_leakage: [], conflicts: [], warnings: ['Verification output could not be parsed - treat as unverified'] };
    return {
      verification: {
        verified: v.verified,
        unsupported_claims: v.unsupported_claims ?? [],
        missing_questions: v.missing_questions ?? [],
        internal_leakage: v.internal_leakage ?? [],
        conflicts: v.conflicts ?? [],
        warnings: v.warnings ?? []
      },
      latencyMs: res.latencyMs,
      model: res.model
    };
  }

  async clusterIssues(conversations: { number: number; subject: string; preview: string; tags: string[] }[]): Promise<{ clusters: { title: string; summary: string; category: string | null; product: string | null; feature: string | null; conversation_numbers: number[] }[]; latencyMs: number }> {
    const res = await this.chatJson(ISSUE_CLUSTER_SYSTEM, buildIssueClusterUser(conversations), { redact: true, maxTokens: 3000 });
    const parsed = clusteringOutputSchema.safeParse(res.json ?? {});
    const clusters = (parsed.success ? parsed.data.clusters : []).map((c) => ({
      title: c.title,
      summary: c.summary,
      category: c.category ?? null,
      product: c.product ?? null,
      feature: c.feature ?? null,
      conversation_numbers: c.conversation_numbers ?? []
    }));
    return { clusters, latencyMs: res.latencyMs };
  }

  async generateReportNarrative(reportName: string, facts: Record<string, unknown>): Promise<{ narrative: string; latencyMs: number }> {
    const res = await this.chatJson(REPORT_NARRATIVE_SYSTEM, buildReportNarrativeUser(reportName, facts), { redact: true });
    const narrative = typeof res.json?.narrative === 'string' ? res.json.narrative : (res.raw ?? '').trim();
    return { narrative, latencyMs: res.latencyMs };
  }

  async extractMemories(customerName: string, threads: { author: string; text: string }[]): Promise<{ memories: { key: string; value: string; confidence: 'high' | 'medium' | 'low' }[]; latencyMs: number }> {
    const res = await this.chatJson(MEMORY_EXTRACTION_SYSTEM, buildMemoryExtractionUser(customerName, threads), { redact: true });
    const json = res.json;
    const memories = Array.isArray(json?.memories)
      ? (json.memories as Record<string, unknown>[])
          .filter((m) => typeof m.key === 'string' && typeof m.value === 'string')
          .map((m) => ({ key: String(m.key), value: String(m.value), confidence: (m.confidence === 'high' || m.confidence === 'medium' || m.confidence === 'low' ? m.confidence : 'low') as 'high' | 'medium' | 'low' }))
          .slice(0, 10)
      : [];
    return { memories, latencyMs: res.latencyMs };
  }

  /** v1.9.0 (M3, plan Phase 16): evidence-backed attribute extraction. */
  async extractAttributes(input: AttributeExtractionInput): Promise<{ attributes: ExtractedAttribute[]; latencyMs: number; model: string }> {
    const res = await this.chatJson(ATTRIBUTE_EXTRACTION_SYSTEM, buildAttributeExtractionUser(input), { redact: true, maxTokens: 1200 });
    const parsed = attributeExtractionOutputSchema.safeParse(res.json ?? {});
    if (!parsed.success) {
      this.lastErr = 'Attribute extraction returned an unparseable structure';
      throw new LmStudioError('The local model did not return a valid attribute extraction JSON.', false);
    }
    // Evidence integrity (same policy as interaction observation): thread ids
    // must be ids that were actually in the prompt; excerpts must pass the
    // forbidden-claim scan - a hallucinated citation must never be stored.
    const validThreadIds = new Set(input.messages.map((m) => m.thread_local_id));
    const attributes = parsed.data.attributes
      .map((a) => ({
        attribute: a.attribute,
        value: a.value.trim(),
        confidence: a.confidence,
        evidence_excerpt: a.evidence_excerpt && assertInteractionTextSafe(a.evidence_excerpt).ok ? a.evidence_excerpt : null,
        evidence_thread_local_id: a.evidence_thread_local_id != null && validThreadIds.has(a.evidence_thread_local_id) ? a.evidence_thread_local_id : null
      }))
      .filter((a) => a.value.length > 0);
    return { attributes, latencyMs: res.latencyMs, model: res.model };
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.client.refreshFromSettings();
    const results = await this.client.embed(texts);
    return results.map((r) => r.vector);
  }

  /** Stage 1 (interaction spec #35): evidence-backed observation signals only. */
  async observeInteraction(input: InteractionObservationInput): Promise<{ signals: InteractionSignal[]; customerGoal: string | null; notes: string[]; latencyMs: number; model: string }> {
    const res = await this.chatJson(INTERACTION_OBSERVATION_SYSTEM, buildInteractionObservationUser(input), { redact: true, maxTokens: 1400 });
    const parsed = interactionObservationOutputSchema.safeParse(res.json ?? {});
    if (!parsed.success) {
      this.lastErr = 'Interaction observation returned an unparseable structure';
      throw new LmStudioError('The local model did not return a valid interaction observation JSON.', false);
    }
    // Safety gate: enum vocabulary + evidence requirement + forbidden-claim scan (spec #7, #8, #55)
    // Evidence integrity: a hallucinated thread id would become a stored citation
    // to an unrelated message - only ids that were actually in the prompt survive.
    const validThreadIds = new Set(input.currentMessages.map((m) => m.thread_local_id).filter((id) => id != null));
    const signals: InteractionSignal[] = parsed.data.signals
      .filter((s) => isValidValue(s.dimension as InteractionDimension, s.value))
      .map((s) => {
        // Evidence excerpts are model-authored free text: scan them like every
        // other free-text field so forbidden claims cannot ride in as "evidence".
        const excerptSafe = s.evidence_excerpt ? assertInteractionTextSafe(s.evidence_excerpt).ok : false;
        const threadId = s.evidence_thread_local_id != null && validThreadIds.has(s.evidence_thread_local_id) ? s.evidence_thread_local_id : null;
        return {
          dimension: s.dimension,
          value: s.value,
          confidence: s.confidence,
          evidence: excerptSafe && s.evidence_excerpt ? { excerpt: s.evidence_excerpt, thread_local_id: threadId, conversation_local_id: null } : null,
          source: 'ai' as const
        };
      });
    const sanitized = sanitizeSignals(signals);
    const goalCheck = assertInteractionTextSafe(parsed.data.customer_goal);
    const notes = parsed.data.notes.filter((n) => assertInteractionTextSafe(n).ok).slice(0, 6);
    if (!goalCheck.ok) this.lastErr = 'Interaction goal text contained forbidden claims and was removed';
    return {
      signals: sanitized.signals,
      customerGoal: goalCheck.ok ? parsed.data.customer_goal ?? null : null,
      notes,
      latencyMs: res.latencyMs,
      model: res.model
    };
  }

  /** Stage 2 (interaction spec #35): support-approach recommendation from observations. */
  async recommendSupportApproach(input: InteractionRecommendationInput): Promise<{ recommendation: SupportApproach; latencyMs: number; model: string }> {
    const res = await this.chatJson(INTERACTION_RECOMMENDATION_SYSTEM, buildInteractionRecommendationUser(input), { redact: true, maxTokens: 900 });
    const parsed = interactionRecommendationOutputSchema.safeParse(res.json ?? {});
    if (!parsed.success) {
      this.lastErr = 'Interaction recommendation returned an unparseable structure';
      throw new LmStudioError('The local model did not return a valid support-approach JSON.', false);
    }
    const d = parsed.data;
    const clean = (text: string | null | undefined): string | null => (text ? sanitizeInteractionText(text).ok ? text : null : null);
    const recommendation: SupportApproach = {
      tone: clean(d.tone),
      length: d.length ?? null,
      start_with: clean(d.start_with),
      then: clean(d.then),
      avoid: d.avoid.filter((a) => assertInteractionTextSafe(a).ok).slice(0, 8),
      response_strategy: d.response_strategy.filter((s) => assertInteractionTextSafe(s).ok).slice(0, 8),
      de_escalation: d.de_escalation,
      escalation_recommendation: clean(d.escalation_recommendation),
      why: d.why.filter((w) => assertInteractionTextSafe(w).ok).slice(0, 6),
      source: 'ai',
      confidence: 'medium'
    };
    return { recommendation, latencyMs: res.latencyMs, model: res.model };
  }

  async rewriteDraft(draft: string, instruction: 'shorten' | 'expand' | 'warmer' | 'more_direct'): Promise<{ text: string; latencyMs: number }> {
    this.client.refreshFromSettings();
    const instructions: Record<typeof instruction, string> = {
      shorten: 'Rewrite the reply to be roughly half as long while keeping every essential fact.',
      expand: 'Rewrite the reply with a little more context and a warmer structure, without adding any new facts.',
      warmer: 'Rewrite the reply with a warmer, friendlier tone. Keep facts identical.',
      more_direct: 'Rewrite the reply to be more direct and concise. Keep facts identical.'
    };
    const res = await this.client.chat({
      messages: [
        { role: 'system', content: 'You rewrite customer support replies. Preserve all facts exactly; never add new facts. Output only the rewritten reply text.' },
        { role: 'user', content: `${instructions[instruction]}\n\nReply to rewrite:\n"""\n${draft}\n"""` }
      ],
      temperature: 0.3,
      maxTokens: 1600
    });
    const text = (res.content ?? '').trim();
    if (!text) throw new LmStudioError('The local model returned an empty rewrite.', false);
    return { text, latencyMs: res.latencyMs };
  }
}

/** No-op provider used when AI is disabled - the app stays fully useful without AI (spec #10). */
export class DisabledAiProvider implements AiProvider {
  readonly kind = 'disabled';
  readonly available = false;
  private readonly err = 'AI is disabled in Settings. Enable LM Studio in Settings > LM Studio to use AI features.';
  lastError(): string | null {
    return this.err;
  }
  modelInfo(): { chat_model: null; embedding_model: null; base_url: '' } {
    return { chat_model: null, embedding_model: null, base_url: '' };
  }
  private reject(): never {
    throw new LmStudioError(this.err, false);
  }
  async analyzeTicket(): Promise<never> {
    this.reject();
  }
  async generateDraft(): Promise<never> {
    this.reject();
  }
  async verifyDraft(): Promise<never> {
    this.reject();
  }
  async clusterIssues(): Promise<never> {
    this.reject();
  }
  async generateReportNarrative(): Promise<never> {
    this.reject();
  }
  async extractMemories(): Promise<never> {
    this.reject();
  }
  async observeInteraction(): Promise<never> {
    this.reject();
  }
  async recommendSupportApproach(): Promise<never> {
    this.reject();
  }
  async extractAttributes(): Promise<never> {
    this.reject();
  }
  async embed(): Promise<never> {
    this.reject();
  }
  async rewriteDraft(): Promise<never> {
    this.reject();
  }
}
