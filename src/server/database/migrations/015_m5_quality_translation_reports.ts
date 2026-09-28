import type { Migration } from '../migrator.js';

/**
 * v2.0.0 -> v2.1.0 (M5: knowledge gap engine, post-resolution QA,
 * historical response effectiveness, conversation friction enhancement,
 * local translation, advanced contact segmentation, outreach enhancements,
 * custom report builder - plan phases 26-33).
 *
 * 1. Knowledge candidates (plan Phase 26): persisted gap candidates with a
 *    CLOSED kind union and stable dedup keys (kind + normalized question).
 *    Rebuilds are idempotent INSERT-OR-IGNORE-style upserts; a human
 *    approve/reject decision is never overwritten by a later rebuild.
 *    NOTHING auto-publishes into knowledge_documents - approval only marks
 *    the candidate; drafting remains a human action.
 *
 * 2. Post-resolution QA (plan Phase 27): one row per closed conversation
 *    (conversation_id PRIMARY KEY). `deterministic` JSON is always computable
 *    (back-and-forth counts, repeated information, handoffs, reopening);
 *    `ai` JSON is the OPTIONAL local-LLM layer (answered? evidence-supported?
 *    correct issue?) recorded via ai_runs type 'post_resolution_qa'. This is
 *    deliberately SEPARATE from pre-send draft verification (ai_verifications).
 *
 * 3. Friction findings (plan Phase 29): one row per (conversation, kind) with
 *    a CLOSED six-kind union matching the plan's detections. `evidence` JSON
 *    pins every finding to exact thread rows (message ids + excerpts), so no
 *    finding can exist without conversation evidence.
 *
 * 4. Translation cache (plan Phase 30): LM Studio translations cached by
 *    sha256(source|target|purpose|text) so identical re-requests never re-run
 *    the model. Detection is deterministic (script ranges + stopword
 *    frequencies) and needs no storage. No cloud service ever participates.
 *
 * 5. Report definitions (plan Phase 33): saved custom report configs
 *    (Zod-validated JSON: metric / dimension / filters / date + comparison
 *    range / sorting). The builder compiles from whitelisted catalogs only -
 *    user input selects catalog entries and parameter VALUES, never SQL text.
 *
 * No backfill: gap candidates, QA rows, friction findings and translations
 * are computed on demand (rebuild endpoints / first use); report definitions
 * are user-created. Absence stays absent - honest.
 */
export const migration015: Migration = {
  id: 15,
  name: 'm5_quality_translation_reports',
  up: (db) => {
    db.exec(`
      -- ------------------------------------------------------------------
      -- Phase 26: knowledge gap candidates
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS knowledge_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedup_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL
          CHECK (kind IN (
            'repeated_question_uncovered',
            'repeated_question_unsolved',
            'conflicting_knowledge',
            'missing_troubleshooting_steps',
            'new_issue_undocumented'
          )),
        question TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        evidence_conversation_ids TEXT NOT NULL DEFAULT '[]',
        related_document_ids TEXT NOT NULL DEFAULT '[]',
        detail TEXT,
        status TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('candidate','approved','rejected','superseded')),
        decided_at TEXT,
        decided_by_user_local_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decision_note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'deterministic_local'
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_kind
        ON knowledge_candidates(kind, status);
      CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status
        ON knowledge_candidates(status, updated_at DESC);

      -- ------------------------------------------------------------------
      -- Phase 27: post-resolution QA (one row per conversation)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS post_resolution_qa (
        conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        deterministic TEXT NOT NULL DEFAULT '{}',
        ai TEXT,
        ai_run_id INTEGER,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        recomputed_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'deterministic_local'
      );
      CREATE INDEX IF NOT EXISTS idx_post_resolution_qa_computed
        ON post_resolution_qa(computed_at DESC);

      -- ------------------------------------------------------------------
      -- Phase 29: friction findings (one row per conversation x kind)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS friction_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        customer_local_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        kind TEXT NOT NULL
          CHECK (kind IN (
            'repeated_customer_explanations',
            'repeated_agent_questions',
            'troubleshooting_loop',
            'repeated_handoffs',
            'repeated_unresolved_interactions',
            'duplicated_information_requests'
          )),
        severity TEXT NOT NULL DEFAULT 'low'
          CHECK (severity IN ('low','moderate','high')),
        evidence TEXT NOT NULL DEFAULT '[]',
        detail TEXT,
        computed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_friction_findings_kind
        ON friction_findings(kind, severity);
      CREATE INDEX IF NOT EXISTS idx_friction_findings_customer
        ON friction_findings(customer_local_id);

      -- ------------------------------------------------------------------
      -- Phase 30: translation cache (LM Studio results only)
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS translation_cache (
        cache_key TEXT PRIMARY KEY,
        source_lang TEXT NOT NULL,
        target_lang TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'general'
          CHECK (purpose IN ('customer_inbound','agent_draft','general')),
        source_text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_translation_cache_created
        ON translation_cache(created_at DESC);

      -- ------------------------------------------------------------------
      -- Phase 33: saved custom report definitions
      -- ------------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS report_definitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'human_local'
      );
    `);
  }
};
