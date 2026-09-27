import { describe, it, expect } from 'vitest';
import { openTestDatabase, closeDatabase } from '../../src/server/database/connection.js';
import { applyMigrations, migrations } from '../../src/server/database/migrations/index.js';
import { runMigrations } from '../../src/server/database/migrator.js';

describe('database migrations (spec #143)', () => {
  it('creates the full schema with all core tables', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const expected of [
      'accounts', 'mailboxes', 'folders', 'users', 'system_users', 'teams', 'tags', 'inbox_fields', 'inbox_field_options',
      'customer_property_definitions', 'organization_property_definitions', 'customers', 'customer_emails', 'customer_phones',
      'customer_addresses', 'customer_websites', 'customer_social_profiles', 'customer_properties', 'organizations',
      'organization_properties', 'conversations', 'conversation_tags', 'conversation_fields', 'threads', 'thread_participants',
      'thread_recipients', 'attachments', 'ratings', 'saved_replies', 'workflows', 'routing_configurations', 'user_statuses',
      'webhook_configs', 'sync_runs', 'sync_checkpoints', 'sync_cursors', 'webhook_events', 'jobs', 'outbound_jobs',
      'outbound_attempts', 'audit_log', 'application_errors', 'application_settings', 'oauth_tokens', 'secrets',
      'ai_runs', 'ai_extracted_facts', 'ai_sources', 'ai_drafts', 'ai_verifications', 'ai_feedback', 'customer_memories',
      'knowledge_sources', 'knowledge_documents', 'knowledge_chunks', 'issue_clusters', 'issue_cluster_conversations',
      'known_issues', 'known_issue_conversations', 'known_issue_refs', 'support_cases', 'report_snapshots', 'daily_metrics',
      'metric_definitions', 'release_events', 'automation_rules', 'automation_runs'
    ]) {
      expect(tables).toContain(expected);
    }
    closeDatabase();
  });

  it('creates FTS5 virtual tables', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const fts of ['fts_conversations', 'fts_threads', 'fts_knowledge', 'fts_known_issues', 'fts_saved_replies', 'fts_ai_analyses']) {
      expect(tables).toContain(fts);
    }
    closeDatabase();
  });

  it('is idempotent - re-running applies nothing', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const result = runMigrations(db, migrations);
    expect(result.applied).toBe(0);
    closeDatabase();
  });

  it('records migration history', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const rows = db.prepare('SELECT id, name FROM schema_migrations ORDER BY id').all() as { id: number; name: string }[];
    expect(rows.length).toBe(migrations.length);
    expect(rows[0]?.name).toBe('core_helpscout_mirror');
    closeDatabase();
  });

  it('enables WAL mode and foreign keys', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const journal = db.pragma('journal_mode', { simple: true });
    expect(journal === 'wal' || journal === 'memory').toBe(true); // in-memory DBs use memory journal
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    closeDatabase();
  });

  it('seeds safe defaults: automatic reply sending OFF, automation writes OFF (spec #112)', () => {
    const db = openTestDatabase();
    applyMigrations(db);
    const get = (k: string): string => (db.prepare('SELECT value FROM application_settings WHERE key=?').get(k) as { value: string }).value;
    expect(JSON.parse(get('automatic_reply_sending'))).toBe(false);
    expect(JSON.parse(get('automation_write_actions_enabled'))).toBe(false);
    expect(JSON.parse(get('ai_enabled'))).toBe(true);
    closeDatabase();
  });
});
