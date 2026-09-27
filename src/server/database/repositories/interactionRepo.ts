import type { DB } from '../connection.js';
import type { InteractionSignal, CurrentInteraction, CommunicationPreference } from '../../../shared/types.js';

/**
 * Client Interaction Intelligence storage (migration 005).
 * All writes are DERIVED data (heuristic or ai) — never Help Scout source data.
 */
export class InteractionRepository {
  constructor(private db: DB) {}

  // ---------------- current interaction (per conversation) ----------------

  saveCurrentInteraction(row: {
    conversation_id: number;
    customer_id: number | null;
    signals: InteractionSignal[];
    message_stats: CurrentInteraction['message_stats'];
    customer_goal: string | null;
    sources: 'heuristic' | 'heuristic+ai' | 'ai';
    analysis_version: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO client_current_signals (conversation_id, customer_id, signals_json, message_stats_json, customer_goal, sources, analysis_version, generated_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        row.conversation_id,
        row.customer_id,
        JSON.stringify(row.signals),
        JSON.stringify(row.message_stats),
        row.customer_goal,
        row.sources,
        row.analysis_version,
        row.sources === 'heuristic' ? 'heuristic' : 'ai_generated'
      );
  }

  getLatestCurrentInteraction(conversationId: number): { signals: InteractionSignal[]; message_stats: CurrentInteraction['message_stats'] | null; customer_goal: string | null; sources: string; generated_at: string } | null {
    const row = this.db
      .prepare('SELECT signals_json, message_stats_json, customer_goal, sources, generated_at FROM client_current_signals WHERE conversation_id = ? ORDER BY id DESC LIMIT 1')
      .get(conversationId) as { signals_json: string; message_stats_json: string | null; customer_goal: string | null; sources: string; generated_at: string } | undefined;
    if (!row) return null;
    return {
      signals: safeParseSignals(row.signals_json),
      message_stats: row.message_stats_json ? (JSON.parse(row.message_stats_json) as CurrentInteraction['message_stats']) : null,
      customer_goal: row.customer_goal,
      sources: row.sources,
      generated_at: row.generated_at
    };
  }

  // ---------------- longitudinal observations ----------------

  insertObservations(observations: { customer_id: number; conversation_id: number | null; thread_local_id: number | null; dimension: string; value: string; confidence: string; evidence_excerpt: string | null; source: 'heuristic' | 'ai'; observed_at: string }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO client_behavior_observations (customer_id, conversation_id, thread_local_id, dimension, value, confidence, evidence_excerpt, source, observed_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = this.db.transaction((rows: typeof observations) => {
      for (const o of rows) stmt.run(o.customer_id, o.conversation_id, o.thread_local_id, o.dimension, o.value, o.confidence, o.evidence_excerpt, o.source, o.observed_at, o.source === 'ai' ? 'ai_generated' : 'heuristic');
    });
    tx(observations);
  }

  /** Recency-weighted aggregation of observations per customer (spec #23, #41). */
  getObservationsForCustomer(customerId: number): { dimension: string; value: string; confidence: string; evidence_excerpt: string | null; conversation_id: number | null; thread_local_id: number | null; observed_at: string; source: string }[] {
    return (this.db
      .prepare(
        `SELECT dimension, value, confidence, evidence_excerpt, conversation_id, thread_local_id, observed_at, source
           FROM client_behavior_observations
          WHERE customer_id = ?
          ORDER BY observed_at DESC`
      )
      .all(customerId) as { dimension: string; value: string; confidence: string; evidence_excerpt: string | null; conversation_id: number | null; thread_local_id: number | null; observed_at: string; source: string }[]);
  }

  countObservations(customerId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM client_behavior_observations WHERE customer_id = ?').get(customerId) as { n: number }).n;
  }

  // ---------------- baseline ----------------

  upsertBaseline(customerId: number, dimension: string, typicalValue: string, confidence: string, observationCount: number, lastObserved: string | null, profileVersion: number): void {
    this.db
      .prepare(
        `INSERT INTO client_behavior_baselines (customer_id, dimension, typical_value, confidence, observation_count, last_observed, profile_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (customer_id, dimension) DO UPDATE SET
           typical_value = excluded.typical_value,
           confidence = excluded.confidence,
           observation_count = excluded.observation_count,
           last_observed = excluded.last_observed,
           profile_version = excluded.profile_version,
           updated_at = datetime('now')`
      )
      .run(customerId, dimension, typicalValue, confidence, observationCount, lastObserved, profileVersion);
  }

  getBaseline(customerId: number): { conversation_count: number; observation_count: number; dimensions: { dimension: string; typical_value: string; confidence: string; observation_count: number; last_observed: string | null }[]; last_updated: string | null; profile_version: number } | null {
    const rows = this.db
      .prepare('SELECT dimension, typical_value, confidence, observation_count, last_observed, profile_version, updated_at FROM client_behavior_baselines WHERE customer_id = ?')
      .all(customerId) as { dimension: string; typical_value: string; confidence: string; observation_count: number; last_observed: string | null; profile_version: number; updated_at: string }[];
    if (!rows.length || !rows[0]) return null;
    const lastUpdated = rows.reduce((acc, r) => (r.updated_at > acc ? r.updated_at : acc), rows[0].updated_at);
    const observationCount = rows.reduce((acc, r) => acc + r.observation_count, 0);
    const conversationCount = (this.db
      .prepare('SELECT COUNT(DISTINCT conversation_id) AS n FROM client_behavior_observations WHERE customer_id = ? AND conversation_id IS NOT NULL')
      .get(customerId) as { n: number }).n;
    return {
      conversation_count: conversationCount,
      observation_count: observationCount,
      dimensions: rows.map((r) => ({ dimension: r.dimension, typical_value: r.typical_value, confidence: r.confidence, observation_count: r.observation_count, last_observed: r.last_observed })),
      last_updated: lastUpdated,
      profile_version: Math.max(...rows.map((r) => r.profile_version))
    };
  }

  // ---------------- preferences + human overrides ----------------

  upsertPreference(customerId: number, preference: string, evidenceCount: number, firstObserved: string | null, lastObserved: string | null, confidence: string, origin: 'ai_inferred' | 'human_entered'): void {
    this.db
      .prepare(
        `INSERT INTO client_communication_preferences (customer_id, preference, evidence_count, first_observed, last_observed, confidence, origin, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (customer_id, preference) DO UPDATE SET
           evidence_count = MAX(evidence_count, excluded.evidence_count),
           last_observed = excluded.last_observed,
           confidence = excluded.confidence,
           origin = CASE WHEN client_communication_preferences.origin = 'human_entered' THEN 'human_entered' ELSE excluded.origin END`
      )
      .run(customerId, preference, evidenceCount, firstObserved, lastObserved, confidence, origin, origin === 'human_entered' ? 'human' : 'ai_generated');
  }

  getPreferences(customerId: number): CommunicationPreference[] {
    return (this.db
      .prepare('SELECT preference, evidence_count, first_observed, last_observed, confidence, origin, human_override_value, human_override_reason, overridden_at FROM client_communication_preferences WHERE customer_id = ? ORDER BY evidence_count DESC')
      .all(customerId) as { preference: string; evidence_count: number; first_observed: string | null; last_observed: string | null; confidence: string; origin: string; human_override_value: string | null; human_override_reason: string | null; overridden_at: string | null }[])
      .map((r) => ({
        preference: r.preference,
        evidence_count: r.evidence_count,
        first_observed: r.first_observed,
        last_observed: r.last_observed,
        confidence: (r.confidence as CommunicationPreference['confidence']) ?? 'unknown',
        origin: r.origin === 'human_entered' ? 'human_entered' : 'ai_inferred',
        human_override: r.human_override_value ? { value: r.human_override_value, reason: r.human_override_reason, overridden_at: r.overridden_at ?? '' } : null
      }));
  }

  setHumanOverride(customerId: number, field: string, aiValue: string | null, humanValue: string, reason: string | null): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE client_human_overrides SET active = 0 WHERE customer_id = ? AND field = ? AND active = 1')
        .run(customerId, field);
      this.db
        .prepare(`INSERT INTO client_human_overrides (customer_id, field, ai_value, human_value, reason, active, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`)
        .run(customerId, field, aiValue, humanValue, reason);
      // Materialize onto the preference row so precedence is queryable (spec #22, #56)
      this.db
        .prepare(
          `INSERT INTO client_communication_preferences (customer_id, preference, evidence_count, first_observed, last_observed, confidence, origin, human_override_value, human_override_reason, overridden_at, provenance)
           VALUES (?, ?, 0, NULL, datetime('now'), 'high', 'human_entered', ?, ?, datetime('now'), 'human')
           ON CONFLICT (customer_id, preference) DO UPDATE SET
             human_override_value = excluded.human_override_value,
             human_override_reason = excluded.human_override_reason,
             overridden_at = datetime('now')`
        )
        .run(customerId, field, humanValue, reason);
    });
    tx();
  }

  clearHumanOverride(customerId: number, field: string): void {
    this.db
      .prepare('UPDATE client_human_overrides SET active = 0 WHERE customer_id = ? AND field = ? AND active = 1')
      .run(customerId, field);
    this.db
      .prepare('UPDATE client_communication_preferences SET human_override_value = NULL, human_override_reason = NULL, overridden_at = NULL WHERE customer_id = ? AND preference = ?')
      .run(customerId, field);
  }

  getActiveOverrides(customerId: number): { id: number; field: string; ai_value: string | null; human_value: string; reason: string | null; created_at: string; active: boolean }[] {
    return (this.db
      .prepare('SELECT id, field, ai_value, human_value, reason, created_at, active FROM client_human_overrides WHERE customer_id = ? AND active = 1 ORDER BY created_at DESC')
      .all(customerId) as { id: number; field: string; ai_value: string | null; human_value: string; reason: string | null; created_at: string; active: number }[])
      .map((r) => ({ id: r.id, field: r.field, ai_value: r.ai_value, human_value: r.human_value, reason: r.reason, created_at: r.created_at, active: r.active === 1 }));
  }

  // ---------------- support outcomes (spec #16, #17, #52) ----------------

  upsertOutcome(row: { customer_id: number; conversation_id: number; resolved_after_first_response: number | null; follow_up_count: number; clarification_count: number; escalated: number; effort_score: number | null; response_style: string | null; friction: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO client_support_outcomes (customer_id, conversation_id, resolved_after_first_response, follow_up_count, clarification_count, escalated, effort_score, response_style, friction, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (conversation_id) DO UPDATE SET
           resolved_after_first_response = excluded.resolved_after_first_response,
           follow_up_count = excluded.follow_up_count,
           clarification_count = excluded.clarification_count,
           escalated = excluded.escalated,
           effort_score = excluded.effort_score,
           response_style = excluded.response_style,
           friction = excluded.friction,
           computed_at = datetime('now')`
      )
      .run(row.customer_id, row.conversation_id, row.resolved_after_first_response, row.follow_up_count, row.clarification_count, row.escalated, row.effort_score, row.response_style, row.friction);
  }

  getOutcomesForCustomer(customerId: number): { conversation_id: number; resolved_after_first_response: number | null; follow_up_count: number; clarification_count: number; escalated: number; effort_score: number | null; response_style: string | null; friction: string | null }[] {
    return (this.db
      .prepare(
        `SELECT o.conversation_id, o.resolved_after_first_response, o.follow_up_count, o.clarification_count, o.escalated, o.effort_score, o.response_style, o.friction
           FROM client_support_outcomes o JOIN conversations c ON c.id = o.conversation_id
          WHERE o.customer_id = ? AND c.deleted_at IS NULL ORDER BY c.remote_created_at DESC`
      )
      .all(customerId) as { conversation_id: number; resolved_after_first_response: number | null; follow_up_count: number; clarification_count: number; escalated: number; effort_score: number | null; response_style: string | null; friction: string | null }[]);
  }

  // ---------------- customer conversation history (for timeline) ----------------

  getCustomerConversations(customerId: number, excludeConversationId?: number): { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; thread_count: number }[] {
    return (this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.status, c.remote_created_at,
           (SELECT COUNT(*) FROM threads t WHERE t.conversation_id = c.id AND t.deleted_at IS NULL) AS thread_count
           FROM conversations c WHERE c.customer_local_id = ? AND c.deleted_at IS NULL AND c.id != ? ORDER BY c.remote_created_at DESC`
      )
      .all(customerId, excludeConversationId ?? -1) as { id: number; number: number; subject: string | null; status: string; remote_created_at: string | null; thread_count: number }[]);
  }
}

function safeParseSignals(json: string): InteractionSignal[] {
  try {
    const parsed = JSON.parse(json) as InteractionSignal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
