import type { DB } from '../database/connection.js';
import { createHash } from 'node:crypto';
import { htmlToText } from '../../shared/utils.js';
import { isClosingAcknowledgment } from './interaction/engine.js';
import { FrictionAnalyzer } from './friction.js';
import type { PostResolutionQa, QaAiLayer, QaDeterministic } from '../../shared/quality.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import type { ChatMessage } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * Injectable chat function (the CopilotService pattern) so tests can pass
 * deterministic fakes through the production constructor.
 */
export type QaChatFn = (opts: { messages: ChatMessage[]; temperature?: number; maxTokens?: number; jsonMode?: boolean }) => Promise<{ content: string | null; model: string; latencyMs: number }>;

/**
 * Post-resolution QA (v2.1.0, plan Phase 27).
 *
 * An after-close QA pipeline, deliberately SEPARATE from pre-send draft
 * verification (ai_verifications / AiPipeline.verifyDraft): different run
 * type ('post_resolution_qa'), different storage, different questions.
 *
 * Two layers, mirroring the attribute-layer design:
 * - deterministic: always computable from the local mirror (back-and-forth
 *   counts, repeated information, messages after close, handoffs, coarse
 *   question/reply counts) with honest method notes;
 * - AI (optional): local LM Studio analysis of whether the question was
 *   answered, whether responses were evidence-supported and whether the
 *   right issue was identified, plus improvement suggestions. The AI layer
 *   is opt-in per run; its absence is an honest null, never a guess.
 */

interface ThreadRow {
  id: number;
  type: string | null;
  body_html: string | null;
  body_text: string | null;
  remote_created_at: string | null;
}

const PROMPT_VERSION = 'post_resolution_qa_v1';

export class PostResolutionQaService {
  constructor(
    private db: DB,
    private chat: QaChatFn | null,
    private friction: FrictionAnalyzer
  ) {}

  /** Compute the deterministic layer for one conversation (persists it). */
  computeDeterministic(conversationId: number): QaDeterministic | null {
    const conv = this.db
      .prepare('SELECT id, number, status, closed_at, remote_created_at, first_response_at, customer_local_id, activity_history_complete FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as
      | { id: number; number: number; status: string; closed_at: string | null; remote_created_at: string | null; first_response_at: string | null; customer_local_id: number | null; activity_history_complete: number }
      | undefined;
    if (!conv) return null;
    const threads = (this.db
      .prepare("SELECT id, type, body_html, body_text, remote_created_at FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC")
      .all(conversationId) as ThreadRow[]);
    const customerMsgs = threads.filter((t) => t.type === 'customer');
    const replyMsgs = threads.filter((t) => t.type === 'reply');

    // Back-and-forth: customer messages after the first reply that are not
    // closing acknowledgments (same semantics as the interaction engine).
    let sawReply = false;
    let backAndForth = 0;
    for (const t of threads) {
      const text = htmlToText(t.body_html ?? t.body_text ?? '');
      if (t.type === 'reply') sawReply = true;
      else if (t.type === 'customer' && sawReply && !isClosingAcknowledgment(text)) backAndForth += 1;
    }

    // Repeated information: >= 6-word spans repeated across customer messages.
    const customerTexts = customerMsgs.map((m) => ({ threadId: m.id, text: htmlToText(m.body_html ?? m.body_text ?? '') }));
    const repeated: { thread_id: number; excerpt: string }[] = [];
    const seenSpans = new Set<string>();
    for (let i = 0; i < customerTexts.length; i++) {
      const words = customerTexts[i]!.text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1);
      for (let j = 0; j + 6 <= words.length; j++) {
        const span = words.slice(j, j + 6).join(' ');
        if (seenSpans.has(span)) continue;
        seenSpans.add(span);
        for (let k = i + 1; k < customerTexts.length; k++) {
          if (customerTexts[k]!.text.toLowerCase().includes(span)) {
            repeated.push({ thread_id: customerTexts[i]!.threadId, excerpt: span.slice(0, 120) });
            break;
          }
        }
      }
    }

    // Messages after close (observable avoidable-follow-up signal).
    let messagesAfterClose = 0;
    if (conv.closed_at != null) {
      for (const t of customerMsgs) {
        if (t.remote_created_at != null && t.remote_created_at > conv.closed_at) messagesAfterClose += 1;
      }
    }

    // Handoffs from the local event history.
    const handoffs = (this.db
      .prepare("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND event_type = 'assignment_changed'")
      .get(conversationId) as { n: number }).n;

    // Coarse question count (sentences ending in '?' in customer messages).
    const questionCount = customerTexts.reduce((a, m) => a + (m.text.match(/\?/g)?.length ?? 0), 0);

    // First response: prefer the maintained derived column; fall back to the
    // first reply thread timestamp (observable in the mirror either way).
    const firstReplyAt = replyMsgs.length > 0 ? replyMsgs[0]!.remote_created_at : null;
    const firstResponseStamp = conv.first_response_at ?? firstReplyAt;
    const firstResponseMinutes =
      firstResponseStamp != null && conv.remote_created_at != null
        ? Math.round((Date.parse(firstResponseStamp) - Date.parse(conv.remote_created_at)) / 60000)
        : null;
    const resolutionMinutes =
      conv.closed_at != null && conv.remote_created_at != null ? Math.round((Date.parse(conv.closed_at) - Date.parse(conv.remote_created_at)) / 60000) : null;

    const deterministic: QaDeterministic = {
      conversation_local_id: conversationId,
      closed: conv.status === 'closed',
      back_and_forth_count: backAndForth,
      repeated_information_count: repeated.length,
      repeated_information_evidence: repeated.slice(0, 5),
      messages_after_close: messagesAfterClose,
      handoff_count: handoffs,
      handoff_history_complete: conv.activity_history_complete === 1,
      customer_question_count: questionCount,
      agent_reply_count: replyMsgs.length,
      first_response_minutes: Number.isFinite(firstResponseMinutes) && firstResponseMinutes != null && firstResponseMinutes >= 0 ? firstResponseMinutes : null,
      resolution_minutes: Number.isFinite(resolutionMinutes) && resolutionMinutes != null && resolutionMinutes >= 0 ? resolutionMinutes : null,
      computed_honestly: [
        'Counts derive from the locally mirrored thread list; pre-sync edits are not reconstructable.',
        'Repeated information is a repeated 6-word-span heuristic, not semantic understanding.',
        'Handoff counts cover locally recorded events only' + (conv.activity_history_complete === 1 ? '' : ' (pre-sync history unknown)')
      ]
    };

    this.db
      .prepare(
        `INSERT INTO post_resolution_qa (conversation_id, deterministic, computed_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT (conversation_id) DO UPDATE SET deterministic = excluded.deterministic, recomputed_at = datetime('now')`
      )
      .run(conversationId, JSON.stringify(deterministic));
    return deterministic;
  }

  /** Optional AI layer via the local model (recorded in ai_runs). */
  async computeAiLayer(conversationId: number): Promise<{ qa: PostResolutionQa; ai: QaAiLayer | null; error: string | null }> {
    const deterministic = this.computeDeterministic(conversationId);
    if (!deterministic) throw new Error('conversation not found');
    if (this.chat == null) {
      const qa = this.get(conversationId)!;
      return { qa, ai: null, error: 'AI is not available (disabled or offline). The deterministic layer was computed; the AI layer stays honestly absent.' };
    }
    const threads = (this.db
      .prepare("SELECT id, type, body_html, body_text FROM threads WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published' ORDER BY remote_created_at ASC LIMIT 40")
      .all(conversationId) as ThreadRow[]);
    const transcript = threads
      .map((t) => `[${t.type === 'customer' ? 'customer' : t.type === 'reply' ? 'agent' : 'note'} #${t.id}] ${htmlToText(t.body_html ?? t.body_text ?? '').slice(0, 600)}`)
      .join('\n')
      .slice(0, 8000);
    const prompt = [
      'You are reviewing a CLOSED support conversation for quality insight. Answer strictly as JSON:',
      '{"answered":{"value":"yes|no|unclear","reasoning":"...","evidence_thread_ids":[1]},"evidence_supported":{"value":"yes|partially|no|unclear","reasoning":"..."},"correct_issue":{"value":"yes|no|unclear","reasoning":"..."},"suggestions":{"kb_improve":false,"kb_reason":"...","saved_reply_suggested":false,"saved_reply_title":null,"issue_association":null}}',
      'Rules: base every claim on the transcript; cite thread ids from the transcript; when uncertain answer "unclear"; never invent ids; suggestions are recommendations for humans, nothing auto-applies.',
      'Transcript:',
      transcript
    ].join('\n');

    const aiRepo = new AiRepository(this.db);
    const inputHash = createHash('sha256').update(prompt).digest('hex');
    const runId = aiRepo.startRun('post_resolution_qa', { conversationId, promptVersion: PROMPT_VERSION, inputHash });
    try {
      const result = await this.chat({
        messages: [
          { role: 'system', content: 'You are a careful support-quality reviewer. You output ONLY valid JSON matching the requested schema. You never fabricate evidence.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        maxTokens: 800,
        jsonMode: true
      });
      let parsed: QaAiLayer;
      try {
        if (result.content == null) throw new Error('empty model output');
        const raw = result.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        parsed = this.coerceAiJson(JSON.parse(raw));
      } catch {
        aiRepo.failRun(runId, 'unparseable model output');
        const qa = this.get(conversationId)!;
        return { qa, ai: null, error: 'The model returned unparseable output; the AI layer stays honestly absent.' };
      }
      const withModel: QaAiLayer = { ...parsed, model: result.model ?? null };
      aiRepo.completeRun(runId, withModel, result.latencyMs ?? 0);
      this.db
        .prepare("UPDATE post_resolution_qa SET ai = ?, ai_run_id = ?, recomputed_at = datetime('now') WHERE conversation_id = ?")
        .run(JSON.stringify(withModel), runId, conversationId);
      const qa = this.get(conversationId)!;
      return { qa, ai: withModel, error: null };
    } catch (err) {
      aiRepo.failRun(runId, err instanceof Error ? err.message : String(err));
      const qa = this.get(conversationId)!;
      return { qa, ai: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Validate + normalize the model's JSON into the closed QaAiLayer shape. */
  private coerceAiJson(raw: unknown): QaAiLayer {
    const r = raw as Record<string, unknown>;
    const val3 = (v: unknown): 'yes' | 'no' | 'unclear' => (v === 'yes' || v === 'no' ? v : 'unclear');
    const val4 = (v: unknown): 'yes' | 'partially' | 'no' | 'unclear' => (v === 'yes' || v === 'no' || v === 'partially' ? v : 'unclear');
    const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, 600) : fallback);
    const answered = r.answered as Record<string, unknown> | undefined;
    const evidenceSupported = r.evidence_supported as Record<string, unknown> | undefined;
    const correctIssue = r.correct_issue as Record<string, unknown> | undefined;
    const suggestions = r.suggestions as Record<string, unknown> | undefined;
    const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0).slice(0, 10) : []);
    return {
      model: null,
      answered: answered ? { value: val3(answered.value), reasoning: str(answered.reasoning), evidence_thread_ids: ids(answered.evidence_thread_ids) } : null,
      evidence_supported: evidenceSupported ? { value: val4(evidenceSupported.value), reasoning: str(evidenceSupported.reasoning) } : null,
      correct_issue: correctIssue ? { value: val3(correctIssue.value), reasoning: str(correctIssue.reasoning) } : null,
      suggestions: suggestions
        ? {
            kb_improve: suggestions.kb_improve === true,
            kb_reason: str(suggestions.kb_reason),
            saved_reply_suggested: suggestions.saved_reply_suggested === true,
            saved_reply_title: typeof suggestions.saved_reply_title === 'string' ? suggestions.saved_reply_title.slice(0, 200) : null,
            issue_association: typeof suggestions.issue_association === 'string' ? suggestions.issue_association.slice(0, 200) : null
          }
        : null
    };
  }

  /** Fetch stored QA (computing the deterministic layer lazily if absent). */
  get(conversationId: number): PostResolutionQa | null {
    let row = this.db.prepare('SELECT * FROM post_resolution_qa WHERE conversation_id = ?').get(conversationId) as
      | { conversation_id: number; deterministic: string; ai: string | null; ai_run_id: number | null; computed_at: string; recomputed_at: string | null }
      | undefined;
    if (!row) {
      const det = this.computeDeterministic(conversationId);
      if (!det) return null;
      row = this.db.prepare('SELECT * FROM post_resolution_qa WHERE conversation_id = ?').get(conversationId) as typeof row;
    }
    return {
      conversation_id: row!.conversation_id,
      deterministic: JSON.parse(row!.deterministic) as QaDeterministic,
      ai: row!.ai ? (JSON.parse(row!.ai) as QaAiLayer) : null,
      ai_available: this.chat != null,
      computed_at: row!.computed_at,
      recomputed_at: row!.recomputed_at
    };
  }

  /** Rebuild the deterministic layer over closed conversations. */
  rebuild(): { conversations: number } {
    const ids = (this.db.prepare("SELECT id FROM conversations WHERE deleted_at IS NULL AND status = 'closed'").all() as { id: number }[]).map((r) => r.id);
    for (const id of ids) this.computeDeterministic(id);
    return { conversations: ids.length };
  }

  /** Coverage snapshot for the QA overview. */
  overview(): { closed_conversations: number; qa_rows: number; with_ai_layer: number } {
    const closed = (this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL AND status = 'closed'").get() as { n: number }).n;
    const rows = (this.db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN ai IS NOT NULL THEN 1 ELSE 0 END) AS with_ai FROM post_resolution_qa').get() as { n: number; with_ai: number | null });
    return { closed_conversations: closed, qa_rows: rows.n, with_ai_layer: rows.with_ai ?? 0 };
  }

  /** Friction findings for the QA panel (recomputed lazily). */
  frictionFor(conversationId: number) {
    return this.friction.analyzeConversation(conversationId);
  }
}
