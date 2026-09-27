import type { Migration } from '../migrator.js';

/**
 * Client Interaction Intelligence (interaction spec #29-#31, #58):
 * observable communication behavior storage. All rows are DERIVED data —
 * they never overwrite Help Scout source data and are marked ai_generated
 * when produced by a model, heuristic when computed locally.
 */
export const migration005: Migration = {
  id: 5,
  name: 'client_interaction_intelligence',
  up: (db) => {
    db.exec(`
      CREATE TABLE client_current_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        signals_json TEXT NOT NULL,
        message_stats_json TEXT,
        customer_goal TEXT,
        sources TEXT NOT NULL DEFAULT 'heuristic',
        analysis_version TEXT,
        generated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'heuristic'
      );
      CREATE INDEX idx_client_current_signals_conversation ON client_current_signals(conversation_id);
      CREATE INDEX idx_client_current_signals_customer ON client_current_signals(customer_id);

      CREATE TABLE client_behavior_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        thread_local_id INTEGER,
        dimension TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'low',
        evidence_excerpt TEXT,
        source TEXT NOT NULL DEFAULT 'heuristic',
        observed_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'heuristic'
      );
      CREATE INDEX idx_client_observations_customer ON client_behavior_observations(customer_id, dimension);
      CREATE INDEX idx_client_observations_conversation ON client_behavior_observations(conversation_id);

      CREATE TABLE client_behavior_baselines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        dimension TEXT NOT NULL,
        typical_value TEXT NOT NULL,
        confidence TEXT NOT NULL DEFAULT 'low',
        observation_count INTEGER NOT NULL DEFAULT 0,
        last_observed TEXT,
        profile_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (customer_id, dimension)
      );

      CREATE TABLE client_communication_preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        preference TEXT NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        first_observed TEXT,
        last_observed TEXT,
        confidence TEXT NOT NULL DEFAULT 'low',
        origin TEXT NOT NULL DEFAULT 'ai_inferred',
        human_override_value TEXT,
        human_override_reason TEXT,
        overridden_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'ai_generated',
        UNIQUE (customer_id, preference)
      );
      CREATE INDEX idx_client_preferences_customer ON client_communication_preferences(customer_id);

      CREATE TABLE client_human_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        ai_value TEXT,
        human_value TEXT NOT NULL,
        reason TEXT,
        created_by TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_client_overrides_customer ON client_human_overrides(customer_id, active);

      CREATE TABLE client_support_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        resolved_after_first_response INTEGER,
        follow_up_count INTEGER NOT NULL DEFAULT 0,
        clarification_count INTEGER NOT NULL DEFAULT 0,
        escalated INTEGER NOT NULL DEFAULT 0,
        effort_score REAL,
        response_style TEXT,
        friction TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id)
      );
      CREATE INDEX idx_client_outcomes_customer ON client_support_outcomes(customer_id);
    `);
  }
};
