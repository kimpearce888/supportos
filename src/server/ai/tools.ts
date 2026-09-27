import type { DB } from '../database/connection.js';
import { SearchEngine } from '../search/searchEngine.js';
import type { ChatTool } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * Controlled AI read tools (spec #29). The AI never gets arbitrary SQL access;
 * every tool is an allowlisted, parameter-validated, read-only operation.
 */
export class AiToolRegistry {
  private search: SearchEngine;
  constructor(private db: DB) {
    this.search = new SearchEngine(db);
  }

  definitions(): ChatTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'search_conversations',
          description: 'Search the local conversation archive by keyword. Returns matching tickets with subject and preview.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'Keywords to search for' }, limit: { type: 'number', description: 'Max results (default 5, max 10)' } },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_knowledge',
          description: 'Search local knowledge documents.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_known_issues',
          description: 'Search known issues by keywords.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_saved_replies',
          description: 'Search saved replies by keywords.',
          parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_conversation',
          description: 'Get a conversation summary by conversation number.',
          parameters: { type: 'object', properties: { number: { type: 'number' } }, required: ['number'] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_support_metrics',
          description: 'Get local support volume metrics for the last N days.',
          parameters: { type: 'object', properties: { days: { type: 'number', description: 'Look-back window in days (default 30)' } } }
        }
      }
    ];
  }

  /** Server-side permission validation + execution. Read-only, bounded results. */
  async execute(name: string, argsJson: string): Promise<unknown> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson || '{}');
    } catch {
      return { error: 'Invalid tool arguments' };
    }
    const limit = Math.min(10, Math.max(1, Number(args.limit) || 5));
    switch (name) {
      case 'search_conversations': {
        const q = String(args.query ?? '').slice(0, 200);
        const hits = this.search.searchConversations(q, {}, limit);
        return hits.map((h) => ({ number: parseInt(h.title.split(' ')[0]?.replace('#', '') || '0', 10) || h.id, title: h.title, snippet: h.snippet.slice(0, 300) }));
      }
      case 'search_knowledge': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchKnowledge(q).slice(0, limit);
      }
      case 'search_known_issues': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchKnownIssues(q).slice(0, limit);
      }
      case 'search_saved_replies': {
        const q = String(args.query ?? '').slice(0, 200);
        return this.search.searchSavedReplies(q).slice(0, limit);
      }
      case 'get_conversation': {
        const num = Number(args.number);
        if (!Number.isFinite(num)) return { error: 'Invalid number' };
        const row = this.db.prepare('SELECT id, number, subject, preview, status, remote_created_at FROM conversations WHERE number = ?').get(num) as Record<string, unknown> | undefined;
        if (!row) return { error: 'Conversation not found' };
        const threads = this.db.prepare("SELECT type, body_text, remote_created_at FROM threads WHERE conversation_id = ? ORDER BY remote_created_at DESC LIMIT 3").all(row.id as number) as Record<string, unknown>[];
        return { ...row, recent_threads: threads.map((t) => ({ type: t.type, text: String(t.body_text ?? '').slice(0, 400), date: t.remote_created_at })) };
      }
      case 'get_support_metrics': {
        const days = Math.min(365, Math.max(1, Number(args.days) || 30));
        const r = this.db
          .prepare(
            `SELECT COUNT(*) AS conversations,
              SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed
             FROM conversations WHERE deleted_at IS NULL AND julianday(remote_created_at) >= julianday('now', '-' || ? || ' days')`
          )
          .get(days) as Record<string, number>;
        return { window_days: days, ...r };
      }
      default:
        return { error: `Unknown tool ${name} - allowed tools are read-only search tools` };
    }
  }
}
