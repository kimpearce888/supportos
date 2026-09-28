import type { DB } from '../database/connection.js';
import type { AiToolRegistry } from './tools.js';
import { JobRepository } from '../database/repositories/jobRepo.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import { SettingsRepository } from '../database/repositories/settingsRepo.js';
import { COPILOT_MAX_TOOL_CALLS, COPILOT_MAX_TOOL_ROUNDS, COPILOT_TOOL_RESULT_MAX_CHARS, PROMPT_VERSIONS } from '../../shared/constants.js';
import type { CopilotChatResult, CopilotCitation, CopilotMessage, CopilotSession } from '../../shared/types.js';
import { COPILOT_SYSTEM, buildCopilotContextBlock } from './prompts.js';
import type { ChatMessage, ChatTool } from '../integrations/lmstudio/lmStudioClient.js';
import { LmStudioError } from '../integrations/lmstudio/lmStudioClient.js';

/** The chat dependency is injectable so tests drive the tool loop deterministically. */
export type CopilotChatFn = (opts: { messages: ChatMessage[]; tools?: ChatTool[]; temperature?: number; maxTokens?: number }) => Promise<{ content: string | null; model: string; toolCalls?: { id: string; name: string; arguments: string }[]; latencyMs: number }>;

interface ExecutedToolCall {
  name: string;
  args: string;
  result: unknown;
}

/**
 * Local Copilot (v1.9.0 / M3, plan Phase 15).
 *
 * An interactive, READ-ONLY assistant for support reps:
 * - The model never sees SQL; it can only call the allowlisted read tools and
 *   every tool result is server-validated, bounded and redacted.
 * - The tool loop is bounded (max rounds + max calls); a model that keeps
 *   calling tools gets a hard stop and must answer from what it has.
 * - CITATIONS ARE MACHINE-GENERATED: the citation list is built from the tools
 *   the server actually executed - the model cannot fabricate a source that
 *   survives, because only real executions produce entries.
 * - Sessions + messages are persisted (copilot_sessions / copilot_messages)
 *   and audited with ai_involvement=true. The Copilot performs zero writes to
 *   Help Scout by construction: there is no write path anywhere in it.
 */
export class CopilotService {
  private jobs: JobRepository;
  private ai: AiRepository;
  private settings: SettingsRepository;

  constructor(
    private db: DB,
    private registry: AiToolRegistry,
    private chatFn: CopilotChatFn
  ) {
    this.jobs = new JobRepository(db);
    this.ai = new AiRepository(db);
    this.settings = new SettingsRepository(db);
  }

  aiEnabled(): boolean {
    return this.settings.get('ai_enabled', true);
  }

  /** One copilot turn: persist the question, run the bounded tool loop, persist the answer. */
  async chat(input: { question: string; conversationId?: number | null; sessionId?: number | null }): Promise<CopilotChatResult> {
    const question = input.question.trim().slice(0, 4000);
    if (!question) throw new LmStudioError('The question is empty.', false);

    // Resolve / create the session
    let session = input.sessionId ? this.getSession(input.sessionId) : null;
    if (input.sessionId && !session) throw new LmStudioError('Copilot session not found.', false);
    if (!session) {
      const conv = input.conversationId
        ? (this.db.prepare('SELECT id, number FROM conversations WHERE id = ? AND deleted_at IS NULL').get(input.conversationId) as { id: number; number: number } | undefined)
        : undefined;
      if (input.conversationId && !conv) throw new LmStudioError('Conversation not found.', false);
      const title = question.length > 80 ? `${question.slice(0, 77)}...` : question;
      const r = this.db.prepare('INSERT INTO copilot_sessions (title, conversation_id) VALUES (?, ?)').run(title, conv?.id ?? null);
      session = this.getSession(Number(r.lastInsertRowid))!;
    }

    const history = this.listMessages(session.id);
    const userMessage = this.insertMessage(session.id, 'user', question, [], null, 0, null);

    // ---- Build the model conversation ----
    const contextBlock = this.contextBlock(session.conversation_id);
    const messages: ChatMessage[] = [
      { role: 'system', content: `${COPILOT_SYSTEM}\n\n${contextBlock}` },
      // Replay only a bounded window of prior turns (cheap context, no unbounded growth).
      ...history.slice(-8).map((m) => ({ role: m.role === 'tool' ? ('user' as const) : (m.role as 'user' | 'assistant'), content: m.content.slice(0, 2000) })),
      { role: 'user', content: question }
    ];
    const tools = this.registry.definitions();

    const executed: ExecutedToolCall[] = [];
    const started = Date.now();
    let rounds = 0;
    let answer: string | null = null;
    let model = 'unknown';

    while (rounds < COPILOT_MAX_TOOL_ROUNDS) {
      rounds++;
      const res = await this.chatFn({ messages, tools, temperature: 0.2, maxTokens: 1600 });
      model = res.model;
      if (res.toolCalls && res.toolCalls.length > 0) {
        // Execute every requested tool call (bounded per turn + globally).
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: res.content ?? '',
          tool_calls: res.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } }))
        };
        messages.push(assistantMsg);
        for (const tc of res.toolCalls.slice(0, COPILOT_MAX_TOOL_CALLS - executed.length)) {
          const result = await this.registry.execute(tc.name, tc.arguments);
          executed.push({ name: tc.name, args: tc.arguments, result });
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.name,
            content: JSON.stringify(this.boundResult(result)).slice(0, COPILOT_TOOL_RESULT_MAX_CHARS)
          } as ChatMessage);
        }
        if (executed.length >= COPILOT_MAX_TOOL_CALLS) {
          messages.push({ role: 'user', content: 'Tool budget reached. Answer now from the evidence you already have, and say plainly which parts you could not verify.' });
          const final = await this.chatFn({ messages, temperature: 0.2, maxTokens: 1600 });
          model = final.model;
          answer = (final.content ?? '').trim();
          break;
        }
        continue;
      }
      answer = (res.content ?? '').trim();
      break;
    }
    if (answer == null || answer.length === 0) {
      answer = rounds >= COPILOT_MAX_TOOL_ROUNDS
        ? 'I reached the tool-call limit before producing an answer. Please rephrase the question more specifically.'
        : 'The local model returned an empty answer. Try rephrasing or check the LM Studio connection.';
    }

    const citations = this.citationsFrom(executed);
    const latencyMs = Date.now() - started;

    // Persist: assistant message with machine-generated citations; tool trace as a tool message.
    if (executed.length > 0) {
      this.insertMessage(
        session.id,
        'tool',
        JSON.stringify(executed.map((e) => ({ tool: e.name, args: e.args.slice(0, 300) }))).slice(0, 8000),
        [],
        executed.map((e) => e.name).join(','),
        executed.length,
        null
      );
    }
    const assistantMessage = this.insertMessage(session.id, 'assistant', answer, citations, null, executed.length, latencyMs);
    this.db.prepare("UPDATE copilot_sessions SET updated_at = datetime('now') WHERE id = ?").run(session.id);

    // AI-run accounting (latency/model stats feed the existing AI analytics).
    const runId = this.ai.startRun('copilot_chat', { conversationId: session.conversation_id, model, promptVersion: PROMPT_VERSIONS.COPILOT_CHAT });
    this.ai.completeRun(runId, { question: question.slice(0, 500), tool_calls: executed.length, tool_rounds: rounds, model }, latencyMs);
    this.jobs.audit({ actor: 'user', action: 'copilot_chat', ai_involvement: true, conversation_id: session.conversation_id });

    const fresh = this.getSession(session.id)!;
    return { session: fresh, user_message: userMessage, assistant_message: assistantMessage, tool_rounds: rounds, citations, model, latency_ms: latencyMs };
  }

  /** Machine-generated citations: ONLY real tool executions produce entries. */
  private citationsFrom(executed: ExecutedToolCall[]): CopilotCitation[] {
    const out: CopilotCitation[] = [];
    for (const e of executed) {
      const r = e.result;
      const label = this.citationLabel(e.name, r);
      const ref = this.conversationRef(e.name, r);
      out.push({ index: out.length + 1, tool: e.name, label, conversation_id: ref?.conversation_id ?? null, conversation_number: ref?.number ?? null, customer_id: null });
    }
    return out;
  }

  private citationLabel(tool: string, result: unknown): string {
    if (result == null || typeof result !== 'object') return tool;
    const r = result as Record<string, unknown>;
    if (typeof r.error === 'string') return `${tool} (no result: ${r.error})`;
    if (typeof r.number === 'number') return `${tool} — conversation #${r.number}`;
    if (typeof r.analysis === 'object' && r.analysis != null) return `${tool} — AI analysis`;
    if (Array.isArray(r)) {
      const first = r[0] as Record<string, unknown> | undefined;
      if (first && typeof first.number === 'number') return `${tool} — ${r.length} conversation(s)`;
      if (first && typeof first.title === 'string') return `${tool} — ${r.length} match(es)`;
      return `${tool} — ${r.length} result(s)`;
    }
    if (typeof r.total_previous_tickets === 'number') return `${tool} — ${r.total_previous_tickets} previous ticket(s)`;
    if (Array.isArray(r.attributes)) return `${tool} — AI attributes`;
    return tool;
  }

  private conversationRef(tool: string, result: unknown): { conversation_id: number | null; number: number | null } | null {
    void tool;
    if (result == null || typeof result !== 'object') return null;
    const r = result as Record<string, unknown>;
    if (typeof r.conversation_id === 'number') return { conversation_id: r.conversation_id, number: typeof r.number === 'number' ? r.number : null };
    // Conversation-shaped tool results carry id + number (e.g. get_conversation_context).
    if (typeof r.id === 'number' && typeof r.number === 'number') return { conversation_id: r.id, number: r.number };
    if (Array.isArray(r)) {
      const first = r[0] as Record<string, unknown> | undefined;
      if (first && typeof first.conversation_id === 'number') return { conversation_id: first.conversation_id, number: typeof first.number === 'number' ? first.number : null };
      if (first && typeof first.id === 'number' && typeof first.number === 'number') return { conversation_id: first.id, number: first.number };
      if (first && typeof first.number === 'number') return { conversation_id: this.idForNumber(first.number), number: first.number };
    }
    if (typeof r.number === 'number') return { conversation_id: this.idForNumber(r.number), number: r.number };
    return null;
  }

  /** Resolve a conversation number to its local id (for citation deep-links). */
  private idForNumber(number: number): number | null {
    const row = this.db.prepare('SELECT id FROM conversations WHERE number = ?').get(number) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private boundResult(result: unknown): unknown {
    try {
      const s = JSON.stringify(result);
      if (s.length <= COPILOT_TOOL_RESULT_MAX_CHARS) return result;
      return { truncated: true, preview: s.slice(0, COPILOT_TOOL_RESULT_MAX_CHARS) };
    } catch {
      return { error: 'Tool result could not be serialized' };
    }
  }

  private contextBlock(conversationId: number | null): string {
    let subject: string | null = null;
    let customerName: string | null = null;
    let number: number | null = null;
    if (conversationId != null) {
      const conv = this.db
        .prepare(
          `SELECT c.number, c.subject, (SELECT TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) FROM customers cu WHERE cu.id = c.customer_local_id) AS customer
           FROM conversations c WHERE c.id = ? AND c.deleted_at IS NULL`
        )
        .get(conversationId) as { number: number; subject: string | null; customer: string | null } | undefined;
      if (conv) {
        number = conv.number;
        subject = conv.subject;
        customerName = conv.customer;
      }
    }
    return buildCopilotContextBlock({ conversationNumber: number, subject, customerName, today: new Date().toISOString().slice(0, 10) });
  }

  // ---------------- Persistence ----------------

  private getSession(id: number): CopilotSession | null {
    const row = this.db
      .prepare(
        `SELECT s.id, s.title, s.conversation_id, s.created_at, s.updated_at, c.number AS conversation_number,
           (SELECT COUNT(*) FROM copilot_messages m WHERE m.session_id = s.id) AS message_count
         FROM copilot_sessions s LEFT JOIN conversations c ON c.id = s.conversation_id WHERE s.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      title: String(row.title),
      conversation_id: row.conversation_id == null ? null : Number(row.conversation_id),
      conversation_number: row.conversation_number == null ? null : Number(row.conversation_number),
      message_count: Number(row.message_count ?? 0),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  listSessions(limit = 50): CopilotSession[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.conversation_id, s.created_at, s.updated_at, c.number AS conversation_number,
           (SELECT COUNT(*) FROM copilot_messages m WHERE m.session_id = s.id) AS message_count
         FROM copilot_sessions s LEFT JOIN conversations c ON c.id = s.conversation_id
         ORDER BY s.updated_at DESC LIMIT ?`
      )
      .all(Math.min(200, Math.max(1, limit))) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id),
      title: String(row.title),
      conversation_id: row.conversation_id == null ? null : Number(row.conversation_id),
      conversation_number: row.conversation_number == null ? null : Number(row.conversation_number),
      message_count: Number(row.message_count ?? 0),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    }));
  }

  listMessages(sessionId: number): CopilotMessage[] {
    const rows = this.db
      .prepare('SELECT id, session_id, role, content, citations, tool_name, tool_calls, latency_ms, created_at FROM copilot_messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      session_id: Number(r.session_id),
      role: r.role as CopilotMessage['role'],
      content: String(r.content),
      citations: this.parseCitations(r.citations),
      tool_name: r.tool_name == null ? null : String(r.tool_name),
      tool_calls: Number(r.tool_calls ?? 0),
      latency_ms: r.latency_ms == null ? null : Number(r.latency_ms),
      created_at: String(r.created_at)
    }));
  }

  private parseCitations(v: unknown): CopilotCitation[] {
    if (typeof v !== 'string' || !v) return [];
    try {
      const parsed = JSON.parse(v) as CopilotCitation[];
      return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
    } catch {
      return [];
    }
  }

  deleteSession(id: number): boolean {
    const r = this.db.prepare('DELETE FROM copilot_sessions WHERE id = ?').run(id);
    return r.changes > 0;
  }

  private insertMessage(sessionId: number, role: 'user' | 'assistant' | 'tool', content: string, citations: CopilotCitation[], toolName: string | null, toolCalls: number, latencyMs: number | null): CopilotMessage {
    const r = this.db
      .prepare('INSERT INTO copilot_messages (session_id, role, content, citations, tool_name, tool_calls, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, role, content, JSON.stringify(citations), toolName, toolCalls, latencyMs);
    return {
      id: Number(r.lastInsertRowid),
      session_id: sessionId,
      role,
      content,
      citations,
      tool_name: toolName,
      tool_calls: toolCalls,
      latency_ms: latencyMs,
      created_at: new Date().toISOString()
    };
  }

  /**
   * Deterministic starter questions (plan Phase 15's question list), personalized
   * from actual local facts: history presence, known-issue link, analysis state.
   */
  starterQuestions(conversationId: number): { question: string; why: string }[] {
    const conv = this.db
      .prepare(
        `SELECT c.id, c.number, c.subject, c.customer_local_id,
           (SELECT COUNT(*) FROM conversations c2 WHERE c2.customer_local_id = c.customer_local_id AND c2.deleted_at IS NULL AND c2.id != c.id) AS prior_tickets,
           (SELECT COUNT(*) FROM known_issue_conversations kic WHERE kic.conversation_id = c.id) AS known_issue_links,
           (SELECT COUNT(*) FROM ai_runs ar WHERE ar.conversation_id = c.id AND ar.type = 'ticket_analysis' AND ar.status = 'completed') AS analyses,
           (SELECT COUNT(*) FROM ai_attributes a WHERE a.conversation_id = c.id AND a.superseded_at IS NULL) AS attributes
         FROM conversations c WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(conversationId) as { id: number; number: number; subject: string | null; customer_local_id: number | null; prior_tickets: number; known_issue_links: number; analyses: number; attributes: number } | undefined;
    if (!conv) return [];
    const out: { question: string; why: string }[] = [
      { question: 'What is this customer asking?', why: 'Summarizes the current conversation' },
      { question: 'What should I check before replying?', why: 'Pre-reply checklist from local evidence' },
      { question: 'What information has already been provided?', why: 'Avoids asking the customer twice' },
      { question: 'Why is this ticket currently considered urgent?', why: 'Explains urgency from AI attributes + analysis' }
    ];
    if (conv.prior_tickets > 0) {
      out.push({ question: 'What happened in their previous tickets?', why: `${conv.prior_tickets} previous ticket(s) in the local archive` });
      out.push({ question: 'What changed since the last interaction?', why: 'Compares with the last conversation' });
      out.push({ question: 'Summarize the last three conversations.', why: 'Recent history digest' });
    }
    out.push({ question: 'Have we seen this issue before?', why: 'Searches similar conversations' });
    out.push({ question: 'What solved the previous cases?', why: 'Resolutions from similar tickets' });
    out.push({ question: 'Has another customer had the same problem?', why: 'Cross-customer search' });
    out.push({ question: 'What documentation applies?', why: 'Local knowledge base search' });
    out.push({ question: 'Show evidence for that answer.', why: 'Citations from real tool results' });
    return out;
  }
}
