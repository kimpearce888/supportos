import type { Migration } from '../migrator.js';

/** AI pipeline, knowledge base, issue intelligence, support cases, analytics. */
export const migration003: Migration = {
  id: 3,
  name: 'ai_knowledge_issues_analytics',
  up: (db) => {
    db.exec(`
      CREATE TABLE ai_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        model TEXT,
        prompt_version TEXT,
        input_hash TEXT,
        input_refs TEXT,
        output TEXT,
        error TEXT,
        latency_ms INTEGER,
        token_usage TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        provenance TEXT NOT NULL DEFAULT 'ai_generated'
      );
      CREATE INDEX idx_ai_runs_conversation ON ai_runs(conversation_id);
      CREATE INDEX idx_ai_runs_type ON ai_runs(type, status);
      CREATE INDEX idx_ai_runs_cache ON ai_runs(type, input_hash, prompt_version);

      CREATE TABLE ai_extracted_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES ai_runs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        confidence TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_ai_facts_conversation ON ai_extracted_facts(conversation_id);

      CREATE TABLE ai_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES ai_runs(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        title TEXT,
        relevance REAL,
        visibility TEXT,
        timestamp TEXT
      );

      CREATE TABLE ai_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES ai_runs(id),
        content TEXT NOT NULL,
        mode TEXT DEFAULT 'standard',
        model TEXT,
        prompt_version TEXT,
        state TEXT DEFAULT 'generated',
        verification TEXT,
        sources TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT NOT NULL DEFAULT 'ai_generated'
      );
      CREATE INDEX idx_ai_drafts_conversation ON ai_drafts(conversation_id);

      CREATE TABLE ai_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
        run_id INTEGER REFERENCES ai_runs(id),
        verified INTEGER NOT NULL,
        unsupported_claims TEXT,
        missing_questions TEXT,
        internal_leakage TEXT,
        conflicts TEXT,
        warnings TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE ai_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER NOT NULL REFERENCES ai_drafts(id) ON DELETE CASCADE,
        original_content TEXT,
        final_content TEXT,
        edit_distance INTEGER,
        was_sent INTEGER DEFAULT 0,
        sent_at TEXT,
        rating_after TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE customer_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        source TEXT NOT NULL DEFAULT 'ai',
        origin TEXT DEFAULT 'conversation',
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        confidence TEXT DEFAULT 'unknown',
        provenance TEXT DEFAULT 'ai_generated',
        UNIQUE (customer_id, key)
      );
      CREATE INDEX idx_customer_memories_customer ON customer_memories(customer_id);

      CREATE TABLE knowledge_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT DEFAULT 'local_file',
        visibility TEXT NOT NULL DEFAULT 'internal_only',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'internal_only',
        version INTEGER DEFAULT 1,
        checksum TEXT,
        content TEXT,
        format TEXT DEFAULT 'markdown',
        last_indexed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT DEFAULT 'human_local'
      );
      CREATE INDEX idx_knowledge_documents_source ON knowledge_documents(source_id);

      CREATE TABLE knowledge_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        fts_indexed INTEGER DEFAULT 0,
        embedding_state TEXT DEFAULT 'not_indexed',
        embedding_model TEXT,
        embedding BLOB,
        chunk_version INTEGER DEFAULT 2,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (document_id, chunk_index)
      );
      CREATE INDEX idx_knowledge_chunks_doc ON knowledge_chunks(document_id);

      CREATE TABLE issue_clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        summary TEXT,
        category TEXT,
        product TEXT,
        feature TEXT,
        conversation_count INTEGER DEFAULT 0,
        customer_count INTEGER DEFAULT 0,
        first_seen_at TEXT,
        last_seen_at TEXT,
        trend TEXT DEFAULT 'new',
        known_issue_id INTEGER REFERENCES known_issues(id) ON DELETE SET NULL,
        ai_generated INTEGER DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT DEFAULT 'ai_generated'
      );

      CREATE TABLE issue_cluster_conversations (
        cluster_id INTEGER NOT NULL REFERENCES issue_clusters(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (cluster_id, conversation_id)
      );

      CREATE TABLE known_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        symptoms TEXT,
        product TEXT,
        feature TEXT,
        known_cause TEXT,
        workaround TEXT,
        customer_safe_explanation TEXT,
        internal_explanation TEXT,
        status TEXT DEFAULT 'investigating',
        first_seen_at TEXT,
        last_seen_at TEXT,
        conversation_count INTEGER DEFAULT 0,
        provenance TEXT DEFAULT 'human_local',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE known_issue_conversations (
        known_issue_id INTEGER NOT NULL REFERENCES known_issues(id) ON DELETE CASCADE,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT DEFAULT 'human',
        PRIMARY KEY (known_issue_id, conversation_id)
      );

      CREATE TABLE known_issue_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        known_issue_id INTEGER NOT NULL REFERENCES known_issues(id) ON DELETE CASCADE,
        system TEXT,
        reference_id TEXT,
        url TEXT,
        title TEXT,
        status TEXT,
        notes TEXT
      );

      CREATE TABLE support_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id),
        problem TEXT,
        root_question TEXT,
        resolution TEXT,
        answer TEXT,
        product TEXT,
        feature TEXT,
        tags TEXT,
        fields TEXT,
        agent_user_id INTEGER REFERENCES users(id),
        resolution_time_min REAL,
        rating TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        provenance TEXT DEFAULT 'local_derived'
      );
      CREATE INDEX idx_support_cases_conversation ON support_cases(conversation_id);

      CREATE TABLE report_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_key TEXT NOT NULL,
        params TEXT,
        generated_at TEXT NOT NULL,
        data_version TEXT,
        result TEXT NOT NULL
      );
      CREATE INDEX idx_report_snapshots ON report_snapshots(report_key, generated_at DESC);

      CREATE TABLE daily_metrics (
        metric_key TEXT NOT NULL,
        date TEXT NOT NULL,
        value REAL NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (metric_key, date)
      );

      CREATE TABLE metric_definitions (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        formula TEXT,
        source TEXT NOT NULL DEFAULT 'local',
        limitations TEXT
      );

      CREATE TABLE release_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version TEXT,
        occurred_at TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE automation_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        trigger TEXT NOT NULL,
        conditions TEXT NOT NULL DEFAULT '[]',
        actions TEXT NOT NULL DEFAULT '[]',
        priority INTEGER DEFAULT 100,
        requires_approval INTEGER DEFAULT 1,
        last_run_at TEXT,
        run_count INTEGER DEFAULT 0
      );

      CREATE TABLE automation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
        status TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX idx_automation_runs_rule ON automation_runs(rule_id);
    `);

    // Metric definitions (section 120): every local metric is defined
    const defs: [string, string, string, string, string, string][] = [
      ['new_conversations', 'New conversations', 'Count of conversations whose remote_created_at falls in range', 'COUNT(conversations) WHERE remote_created_at IN range', 'local', 'Depends on sync coverage; conversations created before first sync are counted at their remote date'],
      ['active_conversations', 'Active conversations', 'Count of conversations with status=active at query time', 'COUNT WHERE status=active', 'local', 'Point-in-time snapshot, not historical'],
      ['pending_conversations', 'Pending conversations', 'Count of conversations with status=pending at query time', 'COUNT WHERE status=pending', 'local', 'Point-in-time snapshot'],
      ['closed_conversations', 'Closed conversations', 'Count of conversations closed (closed_at) in range', 'COUNT WHERE closed_at IN range', 'local', 'Requires closed_at present in sync data'],
      ['unassigned', 'Unassigned conversations', 'Count of active conversations with no assignee', 'COUNT WHERE status IN (active,pending) AND assignee IS NULL', 'local', 'Point-in-time snapshot'],
      ['backlog', 'Backlog', 'Active conversations with no activity for 7+ days', 'COUNT WHERE days_since(last_activity_at) >= 7', 'local', 'Based on last_activity_at maintained locally'],
      ['first_response_time_local', 'First response time (local)', 'Average minutes between conversation first activity and first agent reply thread', 'AVG(first_reply.created_at - first_activity_at)', 'local', 'Calculated per local implementation; may differ from Help Scout reports'],
      ['resolution_time_local', 'Resolution time (local)', 'Average minutes between first activity and closed_at', 'AVG(closed_at - first_activity_at)', 'local', 'Calculated per local implementation'],
      ['replies_sent', 'Replies sent', 'Count of published reply threads by users in range', 'COUNT(threads) WHERE type=reply AND created_at IN range', 'local', 'Only includes threads present in local mirror'],
      ['ratings', 'Ratings', 'Count of satisfaction ratings by value', 'COUNT(ratings) GROUP BY rating', 'local', 'Only ratings synced locally'],
      ['ai_draft_acceptance', 'AI draft acceptance', 'Accepted drafts / total drafts with feedback', 'accepted / (accepted + rejected + edited)', 'local', 'AI-derived operational metric']
    ];
    const ins = db.prepare(
      'INSERT INTO metric_definitions (key, name, description, formula, source, limitations) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const d of defs) ins.run(...d);
  }
};
