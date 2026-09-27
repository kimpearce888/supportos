import type { Migration } from '../migrator.js';

/** FTS5 full-text index tables, maintained by repositories (delete+insert pattern). */
export const migration004: Migration = {
  id: 4,
  name: 'fts_search_indexes',
  up: (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversations USING fts5(
        subject, preview, customer, tags, numbers,
        conversation_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_threads USING fts5(
        body,
        thread_id UNINDEXED, conversation_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_knowledge USING fts5(
        title, content,
        chunk_id UNINDEXED, document_id UNINDEXED, visibility UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_known_issues USING fts5(
        title, symptoms, workaround, customer_safe_explanation,
        known_issue_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_saved_replies USING fts5(
        name, preview, text,
        saved_reply_id UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_ai_analyses USING fts5(
        summary, primary_question, intent,
        conversation_id UNINDEXED, run_id UNINDEXED
      );
    `);
  }
};
