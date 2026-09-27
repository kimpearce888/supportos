import type { Migration } from '../migrator.js';

/** Sync state, job queue, outbound write queue, webhook events, audit, settings, secrets. */
export const migration002: Migration = {
  id: 2,
  name: 'sync_jobs_outbound_audit',
  up: (db) => {
    db.exec(`
      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        resources_done INTEGER DEFAULT 0,
        resources_total INTEGER DEFAULT 0,
        records_processed INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        detail TEXT
      );
      CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);

      CREATE TABLE sync_checkpoints (
        resource TEXT PRIMARY KEY,
        last_success_at TEXT,
        remote_cursor TEXT,
        page_state TEXT,
        records_processed INTEGER DEFAULT 0,
        records_failed INTEGER DEFAULT 0,
        last_error TEXT,
        retry_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'idle'
      );

      CREATE TABLE sync_cursors (
        resource TEXT PRIMARY KEY,
        cursor TEXT,
        updated_at TEXT
      );

      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        queue TEXT NOT NULL,
        type TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        status TEXT NOT NULL DEFAULT 'queued',
        payload TEXT,
        attempt INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 3,
        error TEXT,
        run_at TEXT,
        locked_by TEXT,
        locked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX idx_jobs_status ON jobs(status, priority, run_at);
      CREATE INDEX idx_jobs_queue ON jobs(queue, status);

      CREATE TABLE outbound_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        thread_id INTEGER REFERENCES threads(id) ON DELETE SET NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 1,
        error TEXT,
        remote_result TEXT,
        requires_confirmation INTEGER DEFAULT 0,
        confirmed_at TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_outbound_status ON outbound_jobs(status);

      CREATE TABLE outbound_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outbound_job_id INTEGER NOT NULL REFERENCES outbound_jobs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL,
        request_summary TEXT,
        status_code INTEGER,
        response_body TEXT,
        latency_ms INTEGER,
        at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        event_hash TEXT UNIQUE NOT NULL,
        event_type TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processing_state TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        payload TEXT NOT NULL,
        processing_error TEXT
      );
      CREATE INDEX idx_webhook_state ON webhook_events(processing_state);

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        conversation_id INTEGER,
        before_state TEXT,
        after_state TEXT,
        remote_operation TEXT,
        remote_result TEXT,
        ai_involvement INTEGER DEFAULT 0,
        job_id INTEGER,
        correlation_id TEXT
      );
      CREATE INDEX idx_audit_conversation ON audit_log(conversation_id);
      CREATE INDEX idx_audit_time ON audit_log(timestamp DESC);

      CREATE TABLE application_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        service TEXT,
        message TEXT,
        stack TEXT,
        context TEXT
      );

      CREATE TABLE application_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE oauth_tokens (
        account TEXT PRIMARY KEY DEFAULT 'default',
        access_token TEXT,
        refresh_token TEXT,
        token_type TEXT,
        expires_at TEXT,
        obtained_at TEXT,
        scope TEXT,
        revoked INTEGER DEFAULT 0
      );

      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Safe defaults (section 112): automatic reply sending OFF, automation writes OFF
    const defaults: [string, string][] = [
      ['sync_interval_minutes', '5'],
      ['api_concurrency', '2'],
      ['ai_enabled', 'true'],
      ['automatic_analysis_enabled', 'true'],
      ['automatic_note_enabled', 'false'],
      ['automatic_draft_enabled', 'false'],
      ['automation_enabled', 'false'],
      ['automation_write_actions_enabled', 'false'],
      ['qdrant_enabled', 'true'],
      ['attachment_auto_download', 'true'],
      ['automatic_reply_sending', 'false'],
      ['retention_days', 'null'],
      ['backup_interval_hours', '24'],
      ['log_level', 'info'],
      ['display_timezone', 'system'],
      ['redaction_enabled', 'true'],
      ['ai_evaluation_mode', 'false'],
      ['first_run_completed', 'false'],
      ['onboarding_step', 'welcome']
    ];
    const ins = db.prepare('INSERT INTO application_settings (key, value) VALUES (?, ?)');
    for (const [k, v] of defaults) ins.run(k, v);
  }
};
