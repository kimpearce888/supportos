import type { Migration } from '../migrator.js';

/**
 * v1.1.0 -> v1.2.0 data-integrity upgrade (interaction intelligence):
 *
 * 1. Observations are made IDEMPOTENT per (conversation_id, dimension, source).
 *    v1.1.0 inserted a fresh row on every refresh / sync event / worker tick,
 *    which (a) inflated observation counts and confidence, (b) multiplied the
 *    weight of frequently-refreshed conversations in recency-weighted
 *    baselines, and (c) let a SINGLE ticket reach the 3-observation
 *    preference threshold (spec #39's repeated-evidence rule). Existing
 *    duplicates are collapsed to the LATEST row per key before the unique
 *    index is created.
 *
 * 2. client_current_signals is capped at ONE row per conversation (it was
 *    append-per-refresh, growing without bound). Older rows beyond the latest
 *    per conversation are dropped.
 *
 * Safe to re-run: dedup deletes are no-ops when there is nothing to collapse,
 * and the indexes use IF NOT EXISTS.
 */
export const migration006: Migration = {
  id: 6,
  name: 'interaction_integrity',
  up: (db) => {
    db.exec(`
      -- Collapse duplicate observations: keep the newest row per
      -- (conversation_id, dimension, source).
      DELETE FROM client_behavior_observations
       WHERE id NOT IN (
         SELECT MAX(id) FROM client_behavior_observations
          WHERE conversation_id IS NOT NULL
          GROUP BY conversation_id, dimension, source
       )
       AND conversation_id IS NOT NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_observations_unique
        ON client_behavior_observations(conversation_id, dimension, source);

      -- Keep only the newest current-signals row per conversation.
      DELETE FROM client_current_signals
       WHERE id NOT IN (
         SELECT MAX(id) FROM client_current_signals GROUP BY conversation_id
       );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_current_signals_unique
        ON client_current_signals(conversation_id);

      -- Stage-2 AI support-approach recommendation, persisted so the card
      -- (GET /api/interaction/:id) actually surfaces the AI result instead of
      -- recomputing the heuristic fallback.
      ALTER TABLE client_current_signals ADD COLUMN recommendation_json TEXT;
    `);
  }
};
