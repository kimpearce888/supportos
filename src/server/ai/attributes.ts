import type { DB } from '../database/connection.js';
import type { AiProvider } from './provider.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { AttributeRepository } from '../database/repositories/attributeRepo.js';
import { InteractionEngine } from './interaction/engine.js';
import { PROMPT_VERSIONS, AI_INTENT_VALUES, RESPONSE_PREFERENCE_VALUES, AI_ATTRIBUTE_CATALOG, type AiAttributeKey } from '../../shared/constants.js';
import type { AiAttributeEvidence, ConversationAttributeSnapshot, InteractionSignal, CurrentInteraction } from '../../shared/types.js';
import { htmlToText } from '../../shared/utils.js';

interface AttributeRecord {
  conversation_id: number;
  attribute: AiAttributeKey;
  value: string;
  value_type: 'enum' | 'number' | 'boolean' | 'text';
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source: 'deterministic' | 'ai';
  evidence: AiAttributeEvidence[];
  run_id?: number | null;
}

/**
 * General AI Attribute Layer (v1.9.0 / M3, plan Phase 16).
 *
 * Two layers, one snapshot:
 * 1. DETERMINISTIC (zero AI, always available): observable urgency /
 *    frustration / technical-language / question count / escalation intent /
 *    risk composite from the stored interaction card, plus known-issue and
 *    issue-cluster membership from the local tables.
 * 2. AI (LM Studio only, cached by input hash + prompt version): intent,
 *    product, feature, issue type, customer goal, response style - each with
 *    evidence excerpt + thread reference, enum-closed where applicable.
 *
 * Merge policy: deterministic keys are authoritative for their catalog slots;
 * AI fills the AI-designated slots. Anything without a record stays ABSENT =
 * honest 'unknown'. Attributes never overwrite Help Scout source data.
 */
export class AiAttributeService {
  private ai: AiRepository;
  private attributes: AttributeRepository;
  private interaction: InteractionEngine;

  constructor(
    private db: DB,
    private provider: AiProvider
  ) {
    this.ai = new AiRepository(db);
    this.attributes = new AttributeRepository(db);
    this.interaction = new InteractionEngine(db);
  }

  repo(): AttributeRepository {
    return this.attributes;
  }

  /** Current snapshot with honest unknown keys listed separately. */
  snapshot(conversationId: number): ConversationAttributeSnapshot | null {
    const conv = this.db
      .prepare('SELECT id, number FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as { id: number; number: number } | undefined;
    if (!conv) return null;
    const rows = this.attributes.currentForConversation(conversationId);
    const knownKeys = new Set(rows.map((r) => r.attribute));
    const unknown = AI_ATTRIBUTE_CATALOG.map((d) => d.key).filter((k) => !knownKeys.has(k));
    const firstRow = rows.length > 0 ? rows[0] : undefined;
    const computedAt = rows.length ? rows.reduce((a, r) => (r.computed_at > a ? r.computed_at : a), firstRow!.computed_at) : null;
    return { conversation_id: conv.id, conversation_number: conv.number, attributes: rows.map((r) => ({ ...r, status: 'known' as const })), unknown, computed_at: computedAt ?? null };
  }

  /**
   * Compute + persist the attribute snapshot for one conversation.
   * Deterministic layer always runs; the AI layer runs only when the provider
   * is enabled, with run caching. Returns the fresh snapshot.
   */
  async compute(conversationId: number, opts: { force?: boolean } = {}): Promise<ConversationAttributeSnapshot> {
    const conv = this.db
      .prepare('SELECT id, number FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as { id: number; number: number } | undefined;
    if (!conv) throw new Error('Conversation not found');

    const records: AttributeRecord[] = [];
    // ---- Layer 1: deterministic (zero AI) ----
    records.push(...this.deterministicRecords(conversationId));

    // ---- Layer 2: AI extraction (LM Studio only, cached) ----
    let aiRunId: number | null = null;
    if (this.provider.available && this.provider.kind !== 'disabled') {
      const messages = this.customerMessages(conversationId);
      if (messages.length > 0) {
        const signature = this.ai.getAnalysisSignature(conversationId);
        const inputHash = this.ai.inputHash(conversationId, `attributes:${signature}`);
        let extracted: { attributes: { attribute: string; value: string; confidence: 'high' | 'medium' | 'low' | 'unknown'; evidence_excerpt: string | null; evidence_thread_local_id: number | null }[] } | null = null;
        if (!opts.force) {
          const cached = this.ai.findCachedRun('attribute_extraction', inputHash, PROMPT_VERSIONS.ATTRIBUTE_EXTRACTION);
          if (cached) {
            try {
              const parsed = JSON.parse(cached.output) as { attributes: { attribute: string; value: string; confidence: 'high' | 'medium' | 'low' | 'unknown'; evidence_excerpt: string | null; evidence_thread_local_id: number | null }[] };
              if (Array.isArray(parsed.attributes)) {
                extracted = parsed;
                aiRunId = cached.id;
              }
            } catch {
              extracted = null;
            }
          }
        }
        if (!extracted) {
          const runId = this.ai.startRun('attribute_extraction', { conversationId, promptVersion: PROMPT_VERSIONS.ATTRIBUTE_EXTRACTION, inputHash, inputRefs: [conversationId] });
          try {
            const subject = (this.db.prepare('SELECT subject FROM conversations WHERE id = ?').get(conversationId) as { subject: string | null }).subject;
            const res = await this.provider.extractAttributes({ subject: subject ?? '', messages });
            this.ai.completeRun(runId, { attributes: res.attributes }, res.latencyMs);
            extracted = { attributes: res.attributes };
            aiRunId = runId;
          } catch (e) {
            this.ai.failRun(runId, e instanceof Error ? e.message : String(e));
            // Honest degradation: deterministic-only snapshot.
          }
        }
        if (extracted) {
          for (const a of extracted.attributes) {
            if (!this.isAiSlot(a.attribute)) continue; // deterministic slots are authoritative
            const value = this.normalizeAiValue(a.attribute, a.value);
            if (value == null) continue; // enum violation = do not store (honest)
            let confidence = a.confidence;
            // Evidence mandate: medium/high confidence requires an evidence excerpt.
            if ((confidence === 'high' || confidence === 'medium') && !a.evidence_excerpt) confidence = 'low';
            records.push({
              conversation_id: conversationId,
              attribute: a.attribute as AiAttributeKey,
              value,
              value_type: this.valueTypeFor(a.attribute),
              confidence,
              source: 'ai',
              evidence: a.evidence_excerpt ? [{ excerpt: a.evidence_excerpt.slice(0, 500), thread_local_id: a.evidence_thread_local_id ?? null }] : [],
              run_id: aiRunId
            });
          }
        }
      }
    }

    this.attributes.saveSnapshot(conversationId, records, aiRunId);
    return this.snapshot(conversationId)!;
  }

  /** Deterministic attributes from stored local facts (zero AI). */
  private deterministicRecords(conversationId: number): AttributeRecord[] {
    const out: AttributeRecord[] = [];
    // Normalize the two possible sources (stored card vs freshly computed) into one shape.
    const stored = this.interaction.repo.getLatestCurrentInteraction(conversationId);
    const computed = stored ? null : this.interaction.computeCurrentInteraction(conversationId);
    const card: { conversation_local_id: number; signals: InteractionSignal[]; message_stats: CurrentInteraction['message_stats'] | null; customer_goal: string | null; sources: string } | null = stored
      ? { conversation_local_id: conversationId, signals: stored.signals, message_stats: stored.message_stats, customer_goal: stored.customer_goal, sources: stored.sources }
      : computed
        ? { conversation_local_id: computed.conversation_local_id, signals: computed.signals, message_stats: computed.message_stats, customer_goal: computed.customer_goal, sources: computed.sources }
        : null;
    const mk = (attribute: AiAttributeKey, value: string, confidence: 'high' | 'medium' | 'low', evidence: AiAttributeEvidence[]): void => {
      out.push({ conversation_id: conversationId, attribute, value, value_type: this.valueTypeFor(attribute), confidence, source: 'deterministic', evidence, run_id: null });
    };

    if (card) {
      const sig = (dimension: string): { value: string; confidence: 'high' | 'medium' | 'low' | 'unknown'; evidence: AiAttributeEvidence[] } | undefined => {
        const s = card.signals.find((x) => x.dimension === dimension);
        if (!s) return undefined;
        const evidence: AiAttributeEvidence[] = s.evidence?.excerpt ? [{ excerpt: s.evidence.excerpt.slice(0, 500), thread_local_id: s.evidence.thread_local_id ?? null }] : [];
        return { value: s.value, confidence: s.confidence, evidence };
      };
      const urgency = sig('urgency');
      if (urgency) mk('urgency', urgency.value, urgency.confidence === 'unknown' ? 'low' : urgency.confidence, urgency.evidence);
      const frustration = sig('frustration');
      if (frustration) mk('frustration_cues', frustration.value, frustration.confidence === 'unknown' ? 'low' : frustration.confidence, frustration.evidence);
      const technical = sig('technical_language');
      if (technical) mk('technical_familiarity', technical.value, technical.confidence === 'unknown' ? 'low' : technical.confidence, technical.evidence);
      const expectation = sig('expectation');
      if (expectation) {
        const isEscalation = expectation.value === 'escalation';
        const escConf = expectation.confidence === 'unknown' ? 'low' : expectation.confidence;
        mk('escalation_signal', isEscalation ? 'true' : 'false', isEscalation ? escConf : 'low', isEscalation ? expectation.evidence : []);
      }
      // question_count is a deterministic message statistic
      const qc = card.message_stats?.question_count;
      if (qc != null && Number.isFinite(qc)) mk('question_count', String(Math.max(0, Math.trunc(qc))), 'high', []);
      // response_style: deterministic when the stored card carries an explicit
      // response_preference signal; otherwise the AI layer may fill it.
      const pref = sig('response_preference');
      if (pref) mk('response_style', pref.value, pref.confidence === 'unknown' ? 'low' : pref.confidence, pref.evidence);
      // risk: composite of observable signals (never a personality claim)
      const risk = this.computeRisk(card);
      if (risk) mk('risk', risk.value, risk.confidence, risk.evidence);

      if (card.customer_goal && card.customer_goal.trim()) {
        mk('customer_goal', card.customer_goal.trim().slice(0, 300), stored?.sources === 'heuristic+ai' ? 'medium' : 'low', []);
      }
    }

    // Known issue membership: a stored local fact
    const ki = this.db
      .prepare(
        `SELECT ki.title FROM known_issue_conversations kic JOIN known_issues ki ON ki.id = kic.known_issue_id WHERE kic.conversation_id = ? ORDER BY kic.linked_at DESC LIMIT 1`
      )
      .get(conversationId) as { title: string } | undefined;
    if (ki) mk('known_issue', 'true', 'high', []);
    else mk('known_issue', 'false', 'high', []);

    // Issue cluster membership: derived from stored cluster rows
    const cluster = this.db
      .prepare(
        `SELECT ic.title FROM issue_cluster_conversations icc JOIN issue_clusters ic ON ic.id = icc.cluster_id WHERE icc.conversation_id = ? ORDER BY icc.assigned_at DESC LIMIT 1`
      )
      .get(conversationId) as { title: string } | undefined;
    if (cluster) mk('issue_cluster', cluster.title.slice(0, 300), 'medium', []);

    return out;
  }

  /** Composite churn/escalation risk from OBSERVABLE signals only. */
  private computeRisk(card: { conversation_local_id: number; signals: InteractionSignal[] }): { value: 'high' | 'medium' | 'low'; confidence: 'high' | 'medium' | 'low'; evidence: AiAttributeEvidence[] } | null {
    if (!card.signals.length) return null;
    const val = (d: string): string | undefined => card.signals.find((s) => s.dimension === d)?.value;
    const evidence = card.signals
      .filter((s) => ['urgency', 'frustration', 'expectation'].includes(s.dimension) && s.evidence?.excerpt)
      .slice(0, 3)
      .map((s) => ({ excerpt: s.evidence!.excerpt.slice(0, 500), thread_local_id: s.evidence!.thread_local_id ?? null }));
    const repeat = this.interaction.detectRepeatIssue(card.conversation_local_id)?.detected ?? false;
    const urgency = val('urgency') ?? 'none';
    const frustration = val('frustration') ?? 'none';
    const escalation = val('expectation') === 'escalation';
    if (escalation || (urgency === 'high' && (frustration === 'moderate' || frustration === 'strong'))) {
      return { value: 'high', confidence: 'medium', evidence };
    }
    if (urgency === 'moderate' || urgency === 'high' || frustration === 'moderate' || frustration === 'strong' || repeat) {
      return { value: 'medium', confidence: 'low', evidence };
    }
    return { value: 'low', confidence: 'low', evidence: [] };
  }

  private customerMessages(conversationId: number): { text: string; thread_local_id: number }[] {
    return (this.db
      .prepare(
        "SELECT id, body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND type = 'customer' AND state = 'published' ORDER BY remote_created_at ASC LIMIT 30"
      )
      .all(conversationId) as { id: number; body_html: string | null; body_text: string | null }[])
      .map((t) => ({ text: htmlToText(t.body_html ?? t.body_text ?? '').slice(0, 1200), thread_local_id: t.id }))
      .filter((m) => m.text.trim().length > 0);
  }

  /** AI may only fill these catalog slots (deterministic slots are authoritative). */
  private isAiSlot(attribute: string): attribute is 'intent' | 'product' | 'feature' | 'issue' | 'customer_goal' | 'response_style' {
    return ['intent', 'product', 'feature', 'issue', 'customer_goal', 'response_style'].includes(attribute);
  }

  private valueTypeFor(attribute: AiAttributeKey): 'enum' | 'number' | 'boolean' | 'text' {
    return AI_ATTRIBUTE_CATALOG.find((d) => d.key === attribute)?.value_type ?? 'text';
  }

  /** Enum-closed normalization; null = do not store (honest unknown). */
  private normalizeAiValue(attribute: string, value: string): string | null {
    const v = value.trim();
    if (!v) return null;
    if (attribute === 'intent') return (AI_INTENT_VALUES as readonly string[]).includes(v) ? v : null;
    if (attribute === 'response_style') return (RESPONSE_PREFERENCE_VALUES as readonly string[]).includes(v) ? v : null;
    return v.slice(0, 300);
  }
}

export type { AttributeRecord };
