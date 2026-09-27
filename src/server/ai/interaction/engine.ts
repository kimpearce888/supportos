import type { DB } from '../../database/connection.js';
import { InteractionRepository } from '../../database/repositories/interactionRepo.js';
import { htmlToText } from '../../../shared/utils.js';
import {
  DETAIL_VALUES,
  DIRECTNESS_VALUES,
  EXPECTATION_VALUES,
  FRUSTRATION_VALUES,
  INTERACTION_CHANGE_SIGNIFICANCE_THRESHOLD,
  INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE,
  INTERACTION_RECENCY_HALF_LIFE_DAYS,
  QUESTION_STRUCTURE_VALUES,
  RESPONSE_PREFERENCE_VALUES,
  TECHNICAL_VALUES,
  TONE_VALUES,
  URGENCY_VALUES,
  type InteractionDimension
} from '../../../shared/constants.js';
import type {
  BehaviorBaseline,
  ClientInteractionProfile,
  ClientPlaybook,
  CurrentInteraction,
  InteractionCard,
  InteractionChange,
  InteractionSignal,
  SupportApproach,
  SupportOutcomeSummary
} from '../../../shared/types.js';
import { computeMessageStats, heuristicSignals, needsDeEscalation, explicitCurrentPreference, type MessageForAnalysis } from './heuristics.js';
import { sanitizeSignals } from './safety.js';

/**
 * Client Interaction Intelligence engine (interaction spec #60).
 * Deterministic core: baseline, change detection, outcomes, effort, friction,
 * and profile assembly all run WITHOUT any AI. AI stages only enrich signals
 * and recommendations; the engine degrades gracefully without LM Studio.
 */
export class InteractionEngine {
  readonly repo: InteractionRepository;
  /** Cache of closed-conversation ids for the customer being analyzed (baseline membership). */
  private closedConversations: Set<number> = new Set();

  constructor(private db: DB) {
    this.repo = new InteractionRepository(db);
  }

  // ---------------- thread loading ----------------

  /** Customer id for a conversation (used by evidence routes). */
  conversationCustomer(conversationId: number): number | null {
    return this.conversationInfo(conversationId)?.customer_local_id ?? null;
  }

  private customerMessages(conversationId: number): MessageForAnalysis[] {
    return (this.db
      .prepare("SELECT id, body_html, body_text, remote_created_at FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND type = 'customer' AND state = 'published' ORDER BY remote_created_at ASC")
      .all(conversationId) as { id: number; body_html: string | null; body_text: string | null; remote_created_at: string | null }[])
      .map((t) => ({
        text: htmlToText(t.body_html ?? t.body_text ?? ''),
        thread_local_id: t.id,
        conversation_local_id: conversationId,
        created_at: t.remote_created_at
      }))
      .filter((m) => m.text.trim().length > 0);
  }

  private conversationInfo(conversationId: number): { customer_local_id: number | null; subject: string | null; number: number; status: string } | null {
    return (this.db
      .prepare('SELECT customer_local_id, subject, number, status FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as { customer_local_id: number | null; subject: string | null; number: number; status: string } | undefined) ?? null;
  }

  // ---------------- current interaction (spec #3, #27) ----------------

  computeCurrentInteraction(conversationId: number): CurrentInteraction | null {
    const conv = this.conversationInfo(conversationId);
    if (!conv) return null;
    const messages = this.customerMessages(conversationId);
    const stats = computeMessageStats(messages);
    const signals = sanitizeSignals(heuristicSignals(messages, stats)).signals;
    const explicitPref = explicitCurrentPreference(messages);
    if (explicitPref) {
      signals.push({ dimension: 'response_preference', value: explicitPref.preference, confidence: 'high', evidence: explicitPref.evidence, source: 'heuristic' });
    }
    const history = conv.customer_local_id ? this.repo.getCustomerConversations(conv.customer_local_id, conversationId) : [];
    const goal = inferCustomerGoal(signals, conv.subject);
    return {
      conversation_local_id: conversationId,
      customer_local_id: conv.customer_local_id,
      is_returning_client: history.length > 0,
      signals,
      customer_goal: goal,
      message_stats: stats,
      generated_at: new Date().toISOString(),
      sources: 'heuristic'
    };
  }

  /** Persist current signals + record observations for the customer's history (spec #29, #30). */
  recordCurrentInteraction(conversationId: number): CurrentInteraction | null {
    const current = this.computeCurrentInteraction(conversationId);
    if (!current) return null;
    this.repo.saveCurrentInteraction({
      conversation_id: conversationId,
      customer_id: current.customer_local_id,
      signals: current.signals,
      message_stats: current.message_stats,
      customer_goal: current.customer_goal,
      sources: 'heuristic',
      analysis_version: 'heuristic_v1'
    });
    if (current.customer_local_id) {
      // Observations are dated by the CONVERSATION's actual date so recency
      // weighting (spec #23) reflects when the behavior happened, not when we
      // happened to compute it.
      const convDate = (this.db
        .prepare('SELECT remote_created_at FROM conversations WHERE id = ?')
        .get(conversationId) as { remote_created_at: string | null } | undefined)?.remote_created_at;
      const observedAt = (convDate ?? new Date().toISOString()).replace('T', ' ').slice(0, 19);
      const observations = current.signals
        .filter((s) => s.dimension !== 'response_preference' || s.confidence === 'high') // preferences need explicit request or repetition
        .map((s) => ({
          customer_id: current.customer_local_id!,
          conversation_id: conversationId,
          thread_local_id: s.evidence?.thread_local_id ?? null,
          dimension: s.dimension,
          value: s.value,
          confidence: s.confidence,
          evidence_excerpt: s.evidence?.excerpt ?? null,
          source: 'heuristic' as const,
          observed_at: observedAt
        }));
      if (observations.length) this.repo.insertObservations(observations);
      this.rebuildBaseline(current.customer_local_id);
    }
    return current;
  }

  // ---------------- baseline (spec #5, #10, #23, #40) ----------------

  /**
   * Observations from COMPLETED (closed) conversations form the baseline:
   * today's still-open ticket is "current", not "normal" (spec #5, #24).
   */
  private historicalObservations(customerId: number): { dimension: string; value: string; confidence: string; evidence_excerpt: string | null; conversation_id: number | null; thread_local_id: number | null; observed_at: string; source: string }[] {
    return this.repo
      .getObservationsForCustomer(customerId)
      .filter((o) => o.conversation_id != null && this.closedConversations.has(o.conversation_id));
  }

  private closedConversationsFor(customerId: number): Set<number> {
    const rows = this.repo
      .getCustomerConversations(customerId)
      .filter((c) => c.status === 'closed')
      .map((c) => c.id);
    return new Set(rows);
  }

  rebuildBaseline(customerId: number): BehaviorBaseline | null {
    this.closedConversations = this.closedConversationsFor(customerId);
    const observations = this.historicalObservations(customerId);
    if (!observations.length) return null;
    const convRows = this.repo.getCustomerConversations(customerId);
    const conversationCount = convRows.length;
    const now = Date.now();
    const byDimension = new Map<string, { value: string; weight: number; confidence: string; lastObserved: string | null; count: number }>();
    for (const o of observations) {
      // Recency weighting (spec #23): half-life decay
      const ageDays = o.observed_at ? Math.max(0, (now - Date.parse(o.observed_at.replace(' ', 'T') + 'Z')) / 86_400_000) : 999;
      const weight = Math.pow(0.5, ageDays / INTERACTION_RECENCY_HALF_LIFE_DAYS);
      const entry = byDimension.get(o.dimension) ?? { value: '', weight: 0, confidence: 'low', lastObserved: null, count: 0 };
      const rank = dimensionRank(o.dimension, o.value);
      if (rank != null) {
        const prevWeight = VALUE_WEIGHTS.get(o.value) ?? 0.5;
        const newValueWeight = entry.weight + weight * prevWeight;
        if (newValueWeight > 0) {
          entry.value = entry.weight === 0 ? o.value : entry.value; // first seen
          entry.weight = newValueWeight;
        }
      }
      entry.count += 1;
      if (!entry.lastObserved || o.observed_at > entry.lastObserved) entry.lastObserved = o.observed_at;
      const confRank = { high: 3, medium: 2, low: 1, unknown: 0 } as const;
      if (confRank[o.confidence as keyof typeof confRank] > confRank[entry.confidence as keyof typeof confRank]) entry.confidence = o.confidence;
      byDimension.set(o.dimension, entry);
    }
    const profileVersion = nextProfileVersion(this.db, customerId);
    const dimensions: BehaviorBaseline['dimensions'] = [];
    for (const [dimension, entry] of byDimension) {
      // Mode of weighted values: recompute from observations grouped by value
      const best = dominantValue(observations.filter((o) => o.dimension === dimension));
      if (!best) continue;
      this.repo.upsertBaseline(customerId, dimension, best.value, entry.count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE ? entry.confidence : 'low', entry.count, entry.lastObserved, profileVersion);
      dimensions.push({ dimension: dimension as InteractionDimension, typical_value: best.value, confidence: entry.count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE ? (entry.confidence as BehaviorBaseline['dimensions'][number]['confidence']) : 'low', observation_count: entry.count, last_observed: entry.lastObserved });
    }
    return { customer_local_id: customerId, conversation_count: conversationCount, observation_count: observations.length, dimensions, last_updated: new Date().toISOString().replace('T', ' ').slice(0, 19), profile_version: profileVersion };
  }

  /**
   * Comparison baseline for "today vs normal" (spec #5, #19): the customer's
   * typical values computed from every conversation EXCEPT the current one.
   * First-time clients therefore get null (no invented history, spec #3).
   */
  comparisonBaseline(customerId: number, excludeConversationId: number): BehaviorBaseline | null {
    this.closedConversations = this.closedConversationsFor(customerId);
    const observations = this.historicalObservations(customerId).filter((o) => o.conversation_id !== excludeConversationId);
    if (!observations.length) return null;
    const convRows = this.repo.getCustomerConversations(customerId);
    const dimensions: BehaviorBaseline['dimensions'] = [];
    for (const dim of new Set(observations.map((o) => o.dimension))) {
      const dimObs = observations.filter((o) => o.dimension === dim);
      const best = dominantValue(dimObs);
      if (!best) continue;
      const count = dimObs.length;
      const lastObserved = dimObs.reduce((acc, o) => (o.observed_at && (!acc || o.observed_at > acc) ? o.observed_at : acc), null as string | null);
      dimensions.push({
        dimension: dim as InteractionDimension,
        typical_value: best.value,
        confidence: count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE ? 'medium' : 'low',
        observation_count: count,
        last_observed: lastObserved
      });
    }
    return {
      customer_local_id: customerId,
      conversation_count: Math.max(0, convRows.length - 1),
      observation_count: observations.length,
      dimensions,
      last_updated: new Date().toISOString().replace('T', ' ').slice(0, 19),
      profile_version: 1
    };
  }

  // ---------------- change detection (spec #5, #19) ----------------

  computeChanges(current: CurrentInteraction, baseline: BehaviorBaseline | null): InteractionChange[] {
    if (!baseline) return [];
    const changes: InteractionChange[] = [];
    const currentByDim = new Map(current.signals.map((s) => [s.dimension, s.value]));
    for (const b of baseline.dimensions) {
      const cur = currentByDim.get(b.dimension) ?? null;
      if (!cur) continue;
      const bRank = dimensionRank(b.dimension, b.typical_value);
      const cRank = dimensionRank(b.dimension, cur);
      if (bRank == null || cRank == null) continue;
      const span = rankSpan(b.dimension);
      const rawDelta = (cRank - bRank) / span;
      const magnitude = Math.min(1, Math.abs(rawDelta));
      changes.push({
        dimension: b.dimension,
        baseline_value: b.typical_value,
        current_value: cur,
        direction: rawDelta > 0.08 ? 'increase' : rawDelta < -0.08 ? 'decrease' : 'same',
        magnitude: Number(magnitude.toFixed(2)),
        significant: magnitude >= INTERACTION_CHANGE_SIGNIFICANCE_THRESHOLD
      });
    }
    return changes.sort((a, b) => b.magnitude - a.magnitude);
  }

  // ---------------- outcomes, effort, friction (spec #16, #17, #52, #53) ----------------

  computeOutcome(conversationId: number): { effort_score: number | null; friction: 'none' | 'moderate' | 'high'; follow_up_count: number; clarification_count: number; escalated: boolean; resolved_after_first_response: boolean | null; response_style: string | null } | null {
    const conv = this.conversationInfo(conversationId);
    if (!conv?.customer_local_id) return null;
    const rows = (this.db
      .prepare("SELECT type, body_html, body_text, remote_created_at FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC")
      .all(conversationId) as { type: string | null; body_html: string | null; body_text: string | null; remote_created_at: string | null }[]);
    const customerMsgs = rows.filter((r) => r.type === 'customer');
    const replyMsgs = rows.filter((r) => r.type === 'reply');
    const noteMsgs = rows.filter((r) => r.type === 'note');
    const customerTexts = customerMsgs.map((m) => htmlToText(m.body_html ?? m.body_text ?? '').toLowerCase());
    const replyTexts = replyMsgs.map((m) => htmlToText(m.body_html ?? m.body_text ?? '').toLowerCase());

    // Follow-ups: customer messages after the first support reply
    let followUpCount = 0;
    let sawReply = false;
    for (const r of rows) {
      if (r.type === 'reply') sawReply = true;
      else if (r.type === 'customer' && sawReply) followUpCount += 1;
    }
    // Clarifications: customer asks for clarification or repeats issue phrasing
    const clarificationCount = customerTexts.slice(1).filter((t) => /still|again|re-?send|clarif|you didn'?t|that didn'?t|not what i|same issue|as i (said|mentioned|wrote)/.test(t)).length;
    const escalated = noteMsgs.some((n) => /escalat|urgent|priority|vip/i.test(htmlToText(n.body_html ?? n.body_text ?? ''))) || replyTexts.some((t) => /escalat/i.test(t));
    const resolvedAfterFirst = replyMsgs.length > 0 ? followUpCount === 0 && (conv.status === 'closed' || true) : null;

    // Effort score (spec #52): support friction, 0 (low) .. 10 (high)
    const effort = Math.min(10, customerMsgs.length * 1.2 + followUpCount * 1.5 + clarificationCount * 2 + (escalated ? 2 : 0));
    const effortScore = customerMsgs.length ? Number(effort.toFixed(1)) : null;
    const friction: 'none' | 'moderate' | 'high' = effortScore == null ? 'none' : effortScore >= 6 ? 'high' : effortScore >= 3.5 ? 'moderate' : 'none';

    // Response style classifier (spec #16)
    const responseStyle = replyMsgs.length
      ? replyTexts.join(' ').length / replyMsgs.length > 700
        ? 'detailed_explanation'
        : /\b(step|first|then|next|finally)\b|1\./.test(replyTexts.join(' '))
          ? 'step_by_step'
          : replyTexts.join(' ').length / replyMsgs.length < 200
            ? 'short_answer'
            : 'direct_answer_with_explanation'
      : null;

    this.repo.upsertOutcome({
      customer_id: conv.customer_local_id,
      conversation_id: conversationId,
      resolved_after_first_response: resolvedAfterFirst == null ? null : resolvedAfterFirst ? 1 : 0,
      follow_up_count: followUpCount,
      clarification_count: clarificationCount,
      escalated: escalated ? 1 : 0,
      effort_score: effortScore,
      response_style: responseStyle,
      friction: friction
    });
    return { effort_score: effortScore, friction, follow_up_count: followUpCount, clarification_count: clarificationCount, escalated, resolved_after_first_response: resolvedAfterFirst, response_style: responseStyle };
  }

  outcomeSummary(customerId: number): SupportOutcomeSummary | null {
    const outcomes = this.repo.getOutcomesForCustomer(customerId);
    if (!outcomes.length) return null;
    const total = outcomes.length;
    const resolved = outcomes.filter((o) => o.resolved_after_first_response === 1).length;
    const withFollowUps = outcomes.filter((o) => o.follow_up_count > 0).length;
    const withClarifications = outcomes.filter((o) => o.clarification_count > 0).length;
    const escalated = outcomes.filter((o) => o.escalated === 1).length;
    const avgEffort = outcomes.reduce((a, o) => a + (o.effort_score ?? 0), 0) / total;

    // Historically effective approaches (spec #18, #44): styles linked to resolution
    const styleGroups = new Map<string, { worked: number; total: number; example: number | null }>();
    for (const o of outcomes) {
      if (!o.response_style) continue;
      const g = styleGroups.get(o.response_style) ?? { worked: 0, total: 0, example: null };
      g.total += 1;
      if (o.resolved_after_first_response === 1) {
        g.worked += 1;
        if (g.example == null) g.example = o.conversation_id;
      }
      styleGroups.set(o.response_style, g);
    }
    const convNumbers = new Map(this.repo.getCustomerConversations(customerId).map((c) => [c.id, c.number]));
    const effectiveApproaches = [...styleGroups.entries()]
      .map(([approach, g]) => ({ approach: humanizeStyle(approach), worked_count: g.worked, example_conversation_local_id: g.example, example_number: g.example != null ? convNumbers.get(g.example) ?? null : null }))
      .sort((a, b) => b.worked_count - a.worked_count);
    const frictionFlags = outcomes
      .filter((o) => o.friction === 'high' || o.friction === 'moderate')
      .map((o) => ({ conversation_local_id: o.conversation_id, number: convNumbers.get(o.conversation_id) ?? 0, subject: this.repo.getCustomerConversations(customerId).find((c) => c.id === o.conversation_id)?.subject ?? null, friction: o.friction as 'moderate' | 'high' }));

    return {
      customer_local_id: customerId,
      total_conversations: total,
      first_response_resolution_rate: ratio(resolved, total),
      follow_up_rate: ratio(withFollowUps, total),
      clarification_rate: ratio(withClarifications, total),
      escalation_rate: ratio(escalated, total),
      avg_effort_score: Number(avgEffort.toFixed(1)),
      effective_approaches: effectiveApproaches,
      friction_flags: frictionFlags
    };
  }

  // ---------------- recommendation (deterministic fallback, spec #13) ----------------

  heuristicRecommendation(current: CurrentInteraction, changes: InteractionChange[], baseline: BehaviorBaseline | null, overrides: { field: string; human_value: string }[]): SupportApproach | null {
    const sig = new Map(current.signals.map((s) => [s.dimension, s.value]));
    const prefOverride = overrides.find((o) => o.field === 'response_preference');
    const explicitPref = current.signals.find((s) => s.dimension === 'response_preference' && s.source === 'heuristic' && s.confidence === 'high')?.value ?? null;
    const urgency = sig.get('urgency') ?? 'none';
    const frustration = sig.get('frustration') ?? 'none';
    const detail = sig.get('detail') ?? 'moderate';

    const avoid: string[] = [];
    if (frustration === 'strong' || frustration === 'moderate') avoid.push('repeating troubleshooting steps the customer already described');
    if (urgency === 'high') avoid.push('generic responses that do not address the reported impact');
    if (detail === 'low' || detail === 'very_low') avoid.push('long background explanations before the answer');
    if (current.message_stats.question_count > 1) avoid.push('answering only one of several questions');

    const strategy: string[] = [];
    strategy.push('Acknowledge the specific issue the customer reported');
    if (frustration !== 'none') strategy.push('Recognize the reported impact before troubleshooting');
    strategy.push('Answer the primary question directly');
    if (needsDeEscalation(current.signals)) strategy.push('Explain what is being checked and what happens next');
    strategy.push('State the concrete next action');
    if (urgency === 'high') strategy.push('Set expectations using only supported timeframes');

    const length: SupportApproach['length'] =
      prefOverride?.human_value === 'concise' || explicitPref === 'concise' || detail === 'low' || detail === 'very_low'
        ? 'concise'
        : detail === 'very_high' || explicitPref === 'detailed' || prefOverride?.human_value === 'detailed'
          ? 'detailed'
          : 'moderate';

    const why: string[] = [];
    if (baseline) why.push(`${baseline.observation_count} observations across ${baseline.conversation_count} conversations inform this approach`);
    const significant = changes.filter((c) => c.significant);
    if (significant.length) why.push(`today's interaction differs from the customer's norm: ${significant.map((c) => `${c.dimension.replace(/_/g, ' ')} ${c.direction}`).join(', ')}`);
    if (explicitPref) why.push('the customer explicitly requested this response style in the current message');
    if (prefOverride) why.push('a support rep manually set a preference that takes precedence over AI inference');
    if (!why.length) why.push('based on observable signals in the current message');

    return {
      tone: frustration !== 'none' || urgency === 'high' ? 'Calm and direct' : 'Direct and friendly',
      length,
      start_with: frustration !== 'none' ? 'Acknowledge the specific problem and its impact, then answer the primary question.' : 'Answer the primary question directly.',
      then: 'Explain the action being taken and what happens next.',
      avoid,
      response_strategy: strategy,
      de_escalation: needsDeEscalation(current.signals),
      escalation_recommendation: sig.get('expectation') === 'escalation' ? 'The customer is asking for escalation — review the linked previous cases before replying.' : null,
      why,
      source: prefOverride ? 'ai+human-override' : 'heuristic',
      confidence: baseline && baseline.observation_count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE ? 'medium' : 'low'
    };
  }

  // ---------------- repeat-issue detection (spec #50) ----------------

  detectRepeatIssue(conversationId: number): { detected: boolean; related_conversations: { local_id: number; number: number; subject: string | null }[] } | null {
    const conv = this.conversationInfo(conversationId);
    if (!conv?.customer_local_id) return null;
    const subjectTokens = new Set((conv.subject ?? '').toLowerCase().split(/\W+/).filter((t) => t.length > 3 && !STOPWORDS.has(t)));
    const currentTags = new Set(
      (this.db
        .prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?')
        .all(conversationId) as { name: string }[]).map((r) => r.name.toLowerCase())
    );
    const history = this.repo.getCustomerConversations(conv.customer_local_id, conversationId);
    const related = history
      .map((h) => {
        const tokens = (h.subject ?? '').toLowerCase().split(/\W+/).filter((t) => t.length > 3 && !STOPWORDS.has(t));
        const tokenOverlap = tokens.filter((t) => subjectTokens.has(t)).length / Math.max(1, Math.min(subjectTokens.size || 1, tokens.length || 1));
        const historyTags = new Set(
          (this.db
            .prepare('SELECT t.name FROM conversation_tags ct JOIN tags t ON t.id = ct.tag_local_id WHERE ct.conversation_id = ?')
            .all(h.id) as { name: string }[]).map((r) => r.name.toLowerCase())
        );
        const tagOverlap = [...currentTags].filter((t) => historyTags.has(t)).length / Math.max(1, Math.min(currentTags.size, historyTags.size));
        const score = Math.max(tokenOverlap, tagOverlap * 0.6);
        return { h, score };
      })
      .filter((x) => x.score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((x) => ({ local_id: x.h.id, number: x.h.number, subject: x.h.subject }));
    return { detected: related.length >= 2, related_conversations: related };
  }

  // ---------------- full card assembly (spec #26, #62) ----------------

  /**
   * Lazy history backfill: materialize observations for any of the customer's
   * conversations that lack them (fresh v1.1.0 install over an existing database,
   * or partial coverage). Deterministic; skips conversations already recorded.
   */
  private ensureHistoryBackfill(customerId: number | null): void {
    if (customerId == null) return;
    const convs = this.repo.getCustomerConversations(customerId);
    if (!convs.length) return;
    const covered = new Set(
      (this.db
        .prepare('SELECT DISTINCT conversation_id FROM client_behavior_observations WHERE customer_id = ? AND conversation_id IS NOT NULL')
        .all(customerId) as { conversation_id: number }[]).map((r) => r.conversation_id)
    );
    let added = false;
    for (const c of convs) {
      if (covered.has(c.id)) continue;
      try {
        this.recordCurrentInteraction(c.id);
        this.computeOutcome(c.id);
        added = true;
      } catch {
        /* skip broken conversations */
      }
    }
    if (added) this.rebuildBaseline(customerId);
  }

  buildCard(conversationId: number, aiEnrichment?: { signals: InteractionSignal[]; recommendation: SupportApproach | null; promptVersion: string | null; model: string | null }): InteractionCard | null {
    const conv = this.conversationInfo(conversationId);
    if (!conv) return null;
    this.ensureHistoryBackfill(conv.customer_local_id);
    const current = this.repo.getLatestCurrentInteraction(conversationId) as (ReturnType<InteractionRepository['getLatestCurrentInteraction']> extends infer R ? (R extends null ? never : R & { customer_goal: string | null }) : never) | null;
    let currentSignals: InteractionSignal[];
    let messageStats: CurrentInteraction['message_stats'];
    let goal: string | null;
    let sources: 'heuristic' | 'heuristic+ai' | 'ai' = 'heuristic';
    if (current && current.signals.length && !aiEnrichment) {
      currentSignals = sanitizeSignals(current.signals).signals;
      messageStats = current.message_stats ?? computeMessageStats([]);
      goal = current.customer_goal;
      sources = current.sources === 'ai' ? 'ai' : current.sources === 'heuristic+ai' ? 'heuristic+ai' : 'heuristic';
    } else {
      const computed = this.computeCurrentInteraction(conversationId);
      if (!computed) return null;
      if (aiEnrichment?.signals.length) {
        const merged = mergeSignals(computed.signals, aiEnrichment.signals);
        computed.signals = sanitizeSignals(merged).signals;
        computed.sources = 'heuristic+ai';
        sources = 'heuristic+ai';
      }
      currentSignals = computed.signals;
      messageStats = computed.message_stats;
      goal = computed.customer_goal;
    }
    const currentInteraction: CurrentInteraction = {
      conversation_local_id: conversationId,
      customer_local_id: conv.customer_local_id,
      is_returning_client: conv.customer_local_id ? this.repo.getCustomerConversations(conv.customer_local_id, conversationId).length > 0 : false,
      signals: currentSignals,
      customer_goal: goal,
      message_stats: messageStats,
      generated_at: current?.generated_at ?? new Date().toISOString(),
      sources
    };
    const customerId = conv.customer_local_id;
    const baseline = customerId ? this.comparisonBaseline(customerId, conversationId) : null;
    const changes = this.computeChanges(currentInteraction, baseline);
    const overrides = customerId ? this.repo.getActiveOverrides(customerId).map((o) => ({ field: o.field, human_value: o.human_value })) : [];
    const recommendation = aiEnrichment?.recommendation ?? this.heuristicRecommendation(currentInteraction, changes, baseline, overrides);
    const outcome = this.computeOutcome(conversationId);
    const repeatIssue = this.detectRepeatIssue(conversationId);
    return {
      conversation_local_id: conversationId,
      customer_local_id: conv.customer_local_id,
      client_kind: currentInteraction.is_returning_client ? 'returning' : 'first_time',
      current: currentInteraction,
      baseline,
      changes,
      recommendation,
      effort_score: outcome?.effort_score ?? null,
      friction: outcome?.friction ?? null,
      repeat_issue: repeatIssue,
      provenance: { ai_generated: !!aiEnrichment, prompt_version: aiEnrichment?.promptVersion ?? null, model: aiEnrichment?.model ?? null, generated_at: current?.generated_at ?? null }
    };
  }

  // ---------------- customer profile assembly (spec #25) ----------------

  buildProfile(customerId: number): ClientInteractionProfile | null {
    this.ensureHistoryBackfill(customerId);
    const convRows = this.repo.getCustomerConversations(customerId);
    const baseline = this.repo.getBaseline(customerId) as BehaviorBaseline | null;
    // Preferences with overfit guard (spec #39, #40)
    const observations = this.repo.getObservationsForCustomer(customerId);
    const prefObservations = observations.filter((o) => o.dimension === 'response_preference');
    const prefGroups = new Map<string, { count: number; first: string | null; last: string | null }>();
    for (const o of prefObservations) {
      const g = prefGroups.get(o.value) ?? { count: 0, first: o.observed_at, last: o.observed_at };
      g.count += 1;
      if (o.observed_at && (!g.last || o.observed_at > g.last)) g.last = o.observed_at;
      prefGroups.set(o.value, g);
    }
    const preferences = this.repo.getPreferences(customerId);
    for (const [value, g] of prefGroups) {
      if (g.count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE && !preferences.some((p) => p.preference === value && p.origin === 'human_entered')) {
        this.repo.upsertPreference(customerId, value, g.count, g.first, g.last, g.count >= 5 ? 'high' : 'medium', 'ai_inferred');
      }
    }
    const finalPreferences = this.repo.getPreferences(customerId).filter((p) => p.origin === 'human_entered' || p.evidence_count >= INTERACTION_MIN_OBSERVATIONS_FOR_PREFERENCE);

    // Timeline (spec #11)
    const timeline = buildTimeline(convRows);

    const outcomes = this.outcomeSummary(customerId);
    const playbook = this.buildPlaybook(customerId, baseline, outcomes);
    const overrides = this.repo.getActiveOverrides(customerId);
    return {
      customer_local_id: customerId,
      client_kind: convRows.length > 0 ? 'returning' : 'first_time',
      baseline,
      preferences: finalPreferences,
      timeline,
      outcomes,
      playbook,
      overrides
    };
  }

  buildPlaybook(customerId: number, baseline: BehaviorBaseline | null, outcomes: SupportOutcomeSummary | null): ClientPlaybook | null {
    if (!baseline && !outcomes) return null;
    const dims = new Map((baseline?.dimensions ?? []).map((d) => [d.dimension, d.typical_value]));
    const effective = outcomes?.effective_approaches.filter((a) => a.worked_count > 0) ?? [];
    const avoid: string[] = [];
    const frictionHigh = (outcomes?.friction_flags ?? []).some((f) => f.friction === 'high');
    if (dims.get('detail') === 'very_high' || dims.get('detail') === 'high') avoid.push('one-line answers with no context');
    if (dims.get('detail') === 'low' || dims.get('detail') === 'very_low') avoid.push('long background explanations');
    if (frictionHigh) avoid.push('asking for information the customer already provided');
    return {
      best_opening: dims.get('directness') === 'direct' || dims.get('directness') === 'highly_direct' ? 'Acknowledge the issue directly and answer the primary question first.' : 'Friendly greeting, then the answer with brief context.',
      best_explanation_style: dims.get('technical_language') === 'technical' || dims.get('technical_language') === 'highly_technical' ? 'Technical but concise.' : dims.get('detail') === 'low' || dims.get('detail') === 'very_low' ? 'Short paragraphs, plain language.' : 'Moderate detail with concrete examples.',
      best_troubleshooting_style: effective.some((e) => e.approach.includes('step')) ? 'Numbered steps.' : 'Direct fix with a short explanation.',
      likely_follow_up: (outcomes?.follow_up_rate ?? 0) > 0.4 ? 'Often asks follow-up questions — consider covering likely next questions proactively.' : null,
      historically_successful: effective.length ? effective.map((e) => `${e.approach} (worked in ${e.worked_count} cases)`).slice(0, 3).join('; ') : null,
      avoid
    };
  }
}

// ---------------- helpers ----------------

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'been', 'after', 'before', 'about', 'would', 'could', 'their', 'there', 'issue', 'problem', 'help', 'support', 'email']);

function ratio(n: number, d: number): number | null {
  return d > 0 ? Number((n / d).toFixed(2)) : null;
}

function humanizeStyle(style: string): string {
  return style.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const RANKED_DIMENSIONS: Partial<Record<InteractionDimension, readonly string[]>> = {
  tone: TONE_VALUES,
  directness: DIRECTNESS_VALUES,
  detail: DETAIL_VALUES,
  technical_language: TECHNICAL_VALUES,
  question_structure: QUESTION_STRUCTURE_VALUES,
  urgency: URGENCY_VALUES,
  frustration: FRUSTRATION_VALUES,
  expectation: EXPECTATION_VALUES,
  response_preference: RESPONSE_PREFERENCE_VALUES
};

function dimensionRank(dimension: string, value: string): number | null {
  const vocab = RANKED_DIMENSIONS[dimension as InteractionDimension];
  if (!vocab) return null;
  const idx = vocab.indexOf(value);
  return idx >= 0 ? idx : null;
}

function rankSpan(dimension: string): number {
  const vocab = RANKED_DIMENSIONS[dimension as InteractionDimension];
  return vocab ? Math.max(1, vocab.length - 1) : 1;
}

// Value weights for baseline dominance: higher = more "intense" signal
const VALUE_WEIGHTS = new Map<string, number>([
  ...URGENCY_VALUES.map((v, i) => [v, (i + 1) / URGENCY_VALUES.length] as [string, number]),
  ...FRUSTRATION_VALUES.map((v, i) => [v, (i + 1) / FRUSTRATION_VALUES.length] as [string, number]),
  ...DETAIL_VALUES.map((v, i) => [v, (i + 1) / DETAIL_VALUES.length] as [string, number]),
  ...DIRECTNESS_VALUES.map((v, i) => [v, (i + 1) / DIRECTNESS_VALUES.length] as [string, number]),
  ...TECHNICAL_VALUES.map((v, i) => [v, (i + 1) / TECHNICAL_VALUES.length] as [string, number])
]);

function dominantValue(observations: { value: string; observed_at: string }[]): { value: string } | null {
  if (!observations.length) return null;
  const now = Date.now();
  const scores = new Map<string, number>();
  for (const o of observations) {
    const ageDays = o.observed_at ? Math.max(0, (now - Date.parse(o.observed_at.replace(' ', 'T') + 'Z')) / 86_400_000) : 999;
    const weight = Math.pow(0.5, ageDays / INTERACTION_RECENCY_HALF_LIFE_DAYS);
    scores.set(o.value, (scores.get(o.value) ?? 0) + weight);
  }
  let best: { value: string; score: number } | null = null;
  for (const [value, score] of scores) {
    if (!best || score > best.score) best = { value, score };
  }
  return best ? { value: best.value } : null;
}

function nextProfileVersion(db: DB, customerId: number): number {
  const row = db.prepare('SELECT MAX(profile_version) AS v FROM client_behavior_baselines WHERE customer_id = ?').get(customerId) as { v: number | null };
  return (row.v ?? 0) + 1;
}

function inferCustomerGoal(signals: InteractionSignal[], subject: string | null): string | null {
  const sig = new Map(signals.map((s) => [s.dimension, s.value]));
  const expectation = sig.get('expectation');
  const goalMap: Record<string, string> = {
    immediate_resolution: 'Get the issue resolved immediately',
    action: 'Get a concrete action taken',
    escalation: 'Get the issue escalated',
    explanation: 'Understand why this is happening',
    information: 'Get specific information',
    troubleshooting: 'Get help troubleshooting',
    confirmation: 'Confirm a suspected behavior'
  };
  return expectation ? goalMap[expectation] ?? null : subject ? `Address: ${subject}` : null;
}

function mergeSignals(base: InteractionSignal[], enrichment: InteractionSignal[]): InteractionSignal[] {
  const byDim = new Map(base.map((s) => [s.dimension, s]));
  for (const e of enrichment) byDim.set(e.dimension, e); // AI enrichment overrides heuristic per dimension
  return [...byDim.values()];
}

function buildTimeline(convRows: { id: number; subject: string | null; status: string; remote_created_at: string | null; thread_count: number }[]): ClientInteractionProfile['timeline'] {
  const byMonth = new Map<string, { count: number; ids: number[]; subjects: string[]; statuses: string[] }>();
  for (const c of [...convRows].sort((a, b) => (a.remote_created_at ?? '').localeCompare(b.remote_created_at ?? ''))) {
    const month = (c.remote_created_at ?? '').slice(0, 7); // YYYY-MM
    const g = byMonth.get(month) ?? { count: 0, ids: [], subjects: [], statuses: [] };
    g.count += 1;
    g.ids.push(c.id);
    g.subjects.push(c.subject ?? '(no subject)');
    g.statuses.push(c.status);
    byMonth.set(month, g);
  }
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, g]) => ({
      month,
      conversation_count: g.count,
      summary: g.count === 1 ? (g.subjects[0] ?? null) : `${g.count} tickets: ${g.subjects.slice(0, 2).join(' · ')}${g.count > 2 ? ' …' : ''}`,
      conversation_local_ids: g.ids
    }));
}
