import type { DB } from '../database/connection.js';
import { createHash } from 'node:crypto';
import { htmlToText } from '../../shared/utils.js';
import {
  COACHING_CHECK_LABELS, COACHING_CHECK_LAYER,
  type CoachingReview, type CoachingCheckResult, type CoachingFinding, type CoachingAiLayer, type CoachingCheckKind
} from '../../shared/coaching.js';
import { AiRepository } from '../database/repositories/aiRepo.js';
import type { ChatMessage } from '../integrations/lmstudio/lmStudioClient.js';

/**
 * Injectable chat function (the CopilotService / PostResolutionQaService
 * pattern) so tests can pass deterministic fakes through the production
 * constructor.
 */
export type CoachingChatFn = (opts: { messages: ChatMessage[]; temperature?: number; maxTokens?: number; jsonMode?: boolean }) => Promise<{ content: string | null; model: string; latencyMs: number }>;

/**
 * Pre-send agent coaching (v2.2.0 / M6, plan Phase 35).
 *
 * Evidence-based, OPTIONAL, ADVISORY ONLY: no code path here blocks, delays
 * or annotates the actual send. The agent asks for a review, reads it, and
 * decides. Nine deterministic checks are always computable from the local
 * mirror; two AI checks (unsupported claims, wrong context) run only through
 * the local LM Studio provider and are recorded as ai_runs type
 * 'agent_coaching' - deliberately separate from draft verification.
 *
 * Every check reports pass / flagged / not_applicable so the panel shows the
 * full checklist, and every finding cites the draft excerpt plus the local
 * evidence that triggered it (thread ids, incident codes, preference rows).
 */

const PROMPT_VERSION = 'agent_coaching_v1';

interface ThreadRow {
  id: number;
  type: string | null;
  body_html: string | null;
  body_text: string | null;
  created_by_user_id: number | null;
  remote_created_at: string | null;
}

interface ConvRow {
  id: number;
  number: number;
  subject: string | null;
  status: string;
  customer_local_id: number | null;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
  'our', 'their', 'his', 'its', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'as', 'about', 'into', 'over', 'after', 'before', 'again', 'there', 'here', 'what', 'when',
  'where', 'who', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so', 'too', 'very', 'just', 'now'
]);

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Light suffix stemmer so retries/retry and automatically/automatic compare equal. */
function stem(word: string): string {
  if (word.length > 6 && word.endsWith('ically')) return word.slice(0, -6);
  if (word.length > 5 && word.endsWith('ally')) return word.slice(0, -4);
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Token overlap with light stemming + conservative prefix matching (>= 5 chars). */
function tokenCovered(token: string, against: Set<string>): boolean {
  const st = stem(token);
  if (against.has(st)) return true;
  for (const other of against) {
    if (st.length >= 5 && other.length >= 5 && (st.startsWith(other) || other.startsWith(st))) return true;
  }
  return false;
}

function contentTokens(text: string): Set<string> {
  return new Set(normalizeWords(text).filter((w) => !STOPWORDS.has(w) && w.length > 2).map(stem));
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 60);
}

function isQuestion(sentence: string): boolean {
  if (sentence.includes('?')) return true;
  return /^(what|why|how|when|where|who|which|can|could|should|would|is|are|does|do|did|will|has|have)\b/i.test(sentence.trim());
}

function isClosingAck(sentence: string): boolean {
  return /^(ok|okay|got it|thanks|thank you|great|perfect|sounds good|appreciate it)[.!]?\s*$/i.test(sentence.trim());
}

const ACK_MARKERS = /\b(sorry|apolog\w*|understand\w*|appreciate\w*|thank you|thanks for|patience|hear you|frustrat\w*)\b/i;

const TIMEFRAME_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(within|in|before|after)\s+(?:the\s+)?(?:next\s+)?(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|business\s+days?)\b/i, label: 'relative timeframe' },
  { re: /\bby\s+(tomorrow|today|tonight|eod|end\s+of\s+(?:the\s+)?(?:day|week|month|quarter)|next\s+(?:monday|tuesday|wednesday|thursday|friday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, label: 'deadline' },
  { re: /\b(as soon as possible|asap|right away|immediately)\b/i, label: 'urgency commitment' }
];

const FRUSTRATION_MARKERS = /\b(frustrat\w*|unacceptable|ridiculous|again\?|still not working|third time|last time i|fed up|not happy|disappointed|worst)\b/i;

export class CoachingService {
  constructor(
    private db: DB,
    private chat: CoachingChatFn | null
  ) {}

  /** Last persisted review for a conversation (null = never reviewed). */
  get(conversationId: number): CoachingReview | null {
    const row = this.db
      .prepare(`SELECT draft_sha256, draft_excerpt, deterministic, ai, draft_chars, draft_words, created_at
                  FROM coaching_reviews WHERE conversation_id = ?`)
      .get(conversationId) as
      | { draft_sha256: string; draft_excerpt: string; deterministic: string; ai: string | null; draft_chars: number; draft_words: number; created_at: string }
      | undefined;
    if (!row) return null;
    let checks: CoachingCheckResult[] = [];
    let ai: CoachingReview['ai'] = { available: false, model: null, error: null };
    try {
      checks = JSON.parse(row.deterministic) as CoachingCheckResult[];
    } catch {
      checks = [];
    }
    if (row.ai != null) {
      try {
        const parsed = JSON.parse(row.ai) as CoachingAiLayer & { error?: string };
        if (parsed.error != null) {
          ai = { available: false, model: parsed.model ?? null, error: parsed.error };
        } else {
          ai = { available: true, model: parsed.model ?? null, error: null };
          checks = checks.concat(this.aiChecks(parsed));
        }
      } catch {
        ai = { available: false, model: null, error: 'stored AI layer was unparseable' };
      }
    }
    return {
      conversation_id: conversationId,
      draft_sha256: row.draft_sha256,
      draft_chars: row.draft_chars,
      draft_words: row.draft_words,
      checks,
      ai,
      summary: summarize(checks),
      note: 'Advisory only - coaching never blocks or modifies the send. Every finding cites its evidence; heuristics are labeled as heuristics.',
      reviewed_at: row.created_at
    };
  }

  /**
   * Review a draft (plan Phase 35). Deterministic checks always run; the AI
   * layer runs only when requested AND a chat fn exists AND AI is enabled
   * (the route enforces the setting; the service honors the chat fn).
   */
  async reviewDraft(conversationId: number, draft: string, opts: { includeAi?: boolean } = {}): Promise<
    { ok: true; review: CoachingReview } | { ok: false; code: 'not_found' | 'empty_draft' }
  > {
    const conv = this.db
      .prepare('SELECT id, number, subject, status, customer_local_id FROM conversations WHERE id = ? AND deleted_at IS NULL')
      .get(conversationId) as ConvRow | undefined;
    if (!conv) return { ok: false, code: 'not_found' };
    const trimmed = draft.trim();
    if (trimmed.length === 0) return { ok: false, code: 'empty_draft' };

    const threads = (this.db
      .prepare(`SELECT id, type, body_html, body_text, created_by_user_id, remote_created_at FROM threads
                  WHERE conversation_id = ? AND deleted_at IS NULL AND state = 'published'
                  ORDER BY remote_created_at ASC`)
      .all(conversationId) as ThreadRow[]);
    const customer = conv.customer_local_id
      ? (this.db.prepare('SELECT id, first_name, last_name, organization_id FROM customers WHERE id = ?').get(conv.customer_local_id) as { id: number; first_name: string | null; last_name: string | null; organization_id: number | null } | undefined)
      : undefined;
    const signals = this.latestSignals(conversationId);
    const preference = conv.customer_local_id ? this.customerPreference(conv.customer_local_id) : null;

    const checks: CoachingCheckResult[] = [
      this.checkUnansweredQuestions(conv, threads, trimmed),
      this.checkDuplicatedQuestions(threads, trimmed),
      this.checkTimeframe(conv, trimmed),
      this.checkAcknowledgment(threads, signals, trimmed),
      this.checkWording(preference, trimmed),
      this.checkDetail(signals, threads, trimmed),
      this.checkInternalLeakage(conv, threads, trimmed),
      this.checkWrongContext(conv, customer ?? null, trimmed),
      this.checkPreferenceMismatch(preference, threads, trimmed)
    ];

    let ai: CoachingReview['ai'] = { available: false, model: null, error: null };
    let aiStored: string | null = null;
    if (opts.includeAi === true) {
      const aiResult = await this.computeAiLayer(conv, threads, trimmed);
      if (aiResult.error != null) {
        ai = { available: false, model: null, error: aiResult.error };
        aiStored = JSON.stringify({ error: aiResult.error, model: null });
      } else if (aiResult.layer != null) {
        ai = { available: true, model: aiResult.layer.model ?? null, error: null };
        aiStored = JSON.stringify(aiResult.layer);
        checks.push(...this.aiChecks(aiResult.layer));
      }
    }

    const draftWords = wordCount(trimmed);
    const review: CoachingReview = {
      conversation_id: conversationId,
      draft_sha256: createHash('sha256').update(trimmed).digest('hex'),
      draft_chars: trimmed.length,
      draft_words: draftWords,
      checks,
      ai,
      summary: summarize(checks),
      note: 'Advisory only - coaching never blocks or modifies the send. Every finding cites its evidence; heuristics are labeled as heuristics.',
      reviewed_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
    };

    // Persist the last review (audit trail of what the agent was told).
    this.db
      .prepare(`INSERT INTO coaching_reviews (conversation_id, draft_sha256, draft_excerpt, deterministic, ai, draft_chars, draft_words, created_at, provenance)
                VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), 'deterministic_local')
                ON CONFLICT (conversation_id) DO UPDATE SET
                  draft_sha256 = excluded.draft_sha256,
                  draft_excerpt = excluded.draft_excerpt,
                  deterministic = excluded.deterministic,
                  ai = excluded.ai,
                  draft_chars = excluded.draft_chars,
                  draft_words = excluded.draft_words,
                  created_at = datetime('now')`)
      .run(
        conversationId,
        review.draft_sha256,
        trimmed.slice(0, 300),
        JSON.stringify(checks.filter((c) => COACHING_CHECK_LAYER[c.kind] === 'deterministic')),
        aiStored,
        review.draft_chars,
        review.draft_words
      );

    return { ok: true, review };
  }

  // ---------------- deterministic checks ----------------

  private checkUnansweredQuestions(conv: ConvRow, threads: ThreadRow[], draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'unanswered_customer_questions';
    const customerMsgs = threads.filter((t) => t.type === 'customer').slice(-30);
    const questions: { text: string; threadId: number }[] = [];
    for (const m of customerMsgs) {
      const text = htmlToText(m.body_html ?? m.body_text ?? '');
      for (const sentence of splitSentences(text)) {
        if (isQuestion(sentence) && !isClosingAck(sentence)) questions.push({ text: sentence, threadId: m.id });
      }
    }
    if (questions.length === 0) {
      return result(kind, 'not_applicable', 'No open customer questions detected in this conversation.', []);
    }
    const draftTokens = contentTokens(draft);
    const findings: CoachingFinding[] = [];
    const seen = new Set<string>();
    for (const q of questions) {
      const key = normalizeWords(q.text).join(' ');
      if (seen.has(key)) continue;
      seen.add(key);
      const qTokens = [...contentTokens(q.text)];
      if (qTokens.length === 0) continue;
      const covered = qTokens.filter((t) => tokenCovered(t, draftTokens)).length;
      const ratio = covered / qTokens.length;
      if (ratio < 0.4 && qTokens.length >= 2) {
        findings.push({
          draft_excerpt: '(the draft does not appear to address this)',
          evidence: [{ description: 'customer question', excerpt: q.text.slice(0, 240), thread_id: q.threadId, conversation_id: conv.id }],
          advice: 'Answer it directly, or explicitly say the answer is unknown / needs more time.'
        });
      }
    }
    return result(kind, findings.length > 0 ? 'flagged' : 'pass',
      findings.length > 0
        ? `${findings.length} customer question(s) show no matching coverage in the draft (token-overlap heuristic, < 40% key-token coverage).`
        : `All ${questions.length} detected customer question(s) appear addressed (token-overlap heuristic).`,
      findings);
  }

  private checkDuplicatedQuestions(threads: ThreadRow[], draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'duplicated_questions';
    const priorAgentQuestions = new Set<string>();
    const priorByText: { text: string; threadId: number }[] = [];
    for (const m of threads.filter((t) => t.type === 'reply')) {
      const text = htmlToText(m.body_html ?? m.body_text ?? '');
      for (const sentence of splitSentences(text)) {
        if (isQuestion(sentence)) {
          const key = normalizeWords(sentence).join(' ');
          if (!priorAgentQuestions.has(key)) {
            priorAgentQuestions.add(key);
            priorByText.push({ text: sentence, threadId: m.id });
          }
        }
      }
    }
    if (priorAgentQuestions.size === 0) {
      return result(kind, 'not_applicable', 'No earlier agent questions to duplicate.', []);
    }
    const findings: CoachingFinding[] = [];
    for (const sentence of splitSentences(draft)) {
      if (!isQuestion(sentence)) continue;
      const draftTokens = new Set(contentTokens(sentence));
      if (draftTokens.size === 0) continue;
      for (const prior of priorByText) {
        const priorTokens = contentTokens(prior.text);
        if (priorTokens.size === 0) continue;
        const overlap = [...draftTokens].filter((t) => priorTokens.has(t)).length / draftTokens.size;
        if (overlap >= 0.7) {
          findings.push({
            draft_excerpt: sentence.slice(0, 240),
            evidence: [{ description: 'earlier agent question in this conversation', excerpt: prior.text.slice(0, 240), thread_id: prior.threadId }],
            advice: 'The customer already received this question. Check their answer above instead of asking again.'
          });
          break;
        }
      }
    }
    return result(kind, findings.length > 0 ? 'flagged' : 'pass',
      findings.length > 0
        ? `${findings.length} draft question(s) repeat a question already asked in this conversation.`
        : 'No draft question repeats an earlier agent question.',
      findings);
  }

  private checkTimeframe(conv: ConvRow, draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'unsupported_timeframe';
    const activeIncidents = (this.db
      .prepare(`SELECT i.code, i.status, i.title FROM incident_conversations ic JOIN incidents i ON i.id = ic.incident_id
                  WHERE ic.conversation_id = ? AND i.status != 'resolved'`)
      .all(conv.id) as { code: string; status: string; title: string }[]);
    const promises: { sentence: string; label: string }[] = [];
    for (const sentence of splitSentences(draft)) {
      for (const p of TIMEFRAME_PATTERNS) {
        if (p.re.test(sentence)) {
          promises.push({ sentence: sentence.slice(0, 240), label: p.label });
          break;
        }
      }
    }
    if (promises.length === 0) {
      return result(kind, 'pass', 'No explicit timeframe commitments found in the draft.', []);
    }
    const findings: CoachingFinding[] = promises.map((p) => {
      const evidence: CoachingFinding['evidence'] = [{
        description: 'draft sentence',
        excerpt: p.sentence,
        conversation_id: conv.id,
        ...(activeIncidents[0] ? { incident_code: activeIncidents[0].code } : {})
      }];
      if (activeIncidents.length > 0) {
        evidence.push({
          description: `linked ACTIVE incident${activeIncidents.length > 1 ? 's' : ''} (${activeIncidents.map((i) => `${i.code} [${i.status}]`).join(', ')})`,
          excerpt: activeIncidents.map((i) => `${i.code}: ${i.title} (status: ${i.status})`).join('; ').slice(0, 240)
        });
        return {
          draft_excerpt: p.sentence,
          evidence,
          advice: 'A timeframe is promised while an active incident is linked to this conversation. Confirm the incident owner expects resolution inside this window before committing.'
        };
      }
      return {
        draft_excerpt: p.sentence,
        evidence,
        advice: 'Explicit time commitment - verify it is supported by evidence (SLA, incident status, owner confirmation) before sending.'
      };
    });
    return result(kind, 'flagged',
      `${promises.length} explicit timeframe commitment(s)${activeIncidents.length > 0 ? ` and ${activeIncidents.length} linked active incident(s)` : ''}.`,
      findings);
  }

  private checkAcknowledgment(threads: ThreadRow[], signals: string, draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'missing_acknowledgment';
    let frustrationEvidence: { description: string; excerpt: string; threadId?: number } | null = null;
    if (/frustration[":\s]*(moderate|strong)/i.test(signals)) {
      frustrationEvidence = { description: 'interaction signals (deterministic layer)', excerpt: signals.slice(0, 240) };
    } else {
      for (const m of threads.filter((t) => t.type === 'customer').slice(-8)) {
        const text = htmlToText(m.body_html ?? m.body_text ?? '');
        if (FRUSTRATION_MARKERS.test(text)) {
          frustrationEvidence = { description: 'customer message (frustration markers)', excerpt: text.slice(0, 240), threadId: m.id };
          break;
        }
      }
    }
    if (!frustrationEvidence) {
      return result(kind, 'not_applicable', 'No frustration cues detected in recent customer messages or interaction signals.', []);
    }
    if (ACK_MARKERS.test(draft)) {
      return result(kind, 'pass', 'Frustration cues present and the draft acknowledges them.', []);
    }
    return result(kind, 'flagged', 'Frustration cues detected but the draft contains no acknowledgment markers.', [
      {
        draft_excerpt: '(no sorry / understand / appreciate / patience wording found)',
        evidence: [{ description: frustrationEvidence.description, excerpt: frustrationEvidence.excerpt, ...(frustrationEvidence.threadId != null ? { thread_id: frustrationEvidence.threadId } : {}) }],
        advice: 'Acknowledge the experience before diving into the technical answer (one sentence is enough).'
      }
    ]);
  }

  private checkWording(preference: { preference: string; confidence: string } | null, draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'excessive_wording';
    const words = wordCount(draft);
    const paragraphs = draft.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
    const concise = preference?.preference === 'concise';
    const threshold = concise ? 250 : 500;
    if (words > threshold) {
      return result(kind, 'flagged',
        `Draft is ${words} words across ${paragraphs} paragraph(s)${concise ? `; this customer's observed preference is concise (confidence ${preference?.confidence})` : ''}.`,
        [{
          draft_excerpt: draft.slice(0, 240),
          evidence: [{ description: concise ? 'communication preference: concise' : 'length threshold', excerpt: concise ? `preference: concise (confidence ${preference?.confidence})` : `${words} words, ${paragraphs} paragraphs` }],
          advice: concise
            ? 'Trim to the essentials - this customer historically prefers concise answers.'
            : 'Consider trimming: very long replies correlate with lower resolution-after-first-response in the effectiveness report (an association, not causation).'
        }]);
    }
    return result(kind, 'pass', `Draft length is reasonable (${words} words, ${paragraphs} paragraph(s)).`, []);
  }

  private checkDetail(signals: string, threads: ThreadRow[], draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'insufficient_detail';
    const words = wordCount(draft);
    const questionCount = threads
      .filter((t) => t.type === 'customer')
      .slice(-10)
      .reduce((n, m) => n + splitSentences(htmlToText(m.body_html ?? m.body_text ?? '')).filter((s) => isQuestion(s) && !isClosingAck(s)).length, 0);
    const technical = /technical_language[":\s]*(technical|highly_technical)/i.test(signals);
    if (words < 15 && (questionCount > 0 || technical)) {
      return result(kind, 'flagged',
        `Draft is only ${words} words while ${questionCount} open customer question(s)${technical ? ' and technical-language signals' : ''} exist.`,
        [{
          draft_excerpt: draft.slice(0, 240),
          evidence: [{ description: 'conversation context', excerpt: `${questionCount} open question(s)${technical ? ', technical familiarity signals' : ''}` }],
          advice: 'Expand with the concrete steps or answer - one-line replies on substantive questions correlate with follow-up loops.'
        }]);
    }
    return result(kind, 'pass', `Draft detail is proportionate (${words} words vs ${questionCount} open question(s)).`, []);
  }

  private checkInternalLeakage(conv: ConvRow, threads: ThreadRow[], draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'internal_information_leakage';
    // Internal corpus (bounded): this conversation's agent notes, linked
    // incidents' internal fields, linked known issues' internal fields, and
    // internal-only knowledge docs cited by this conversation's AI runs.
    const corpus: { description: string; text: string }[] = [];
    for (const note of threads.filter((t) => t.type === 'note').slice(-100)) {
      const text = htmlToText(note.body_html ?? note.body_text ?? '');
      if (text.trim()) corpus.push({ description: `internal note (thread #${note.id})`, text });
    }
    const incidents = (this.db
      .prepare(`SELECT i.code, i.internal_explanation, i.known_cause, i.description FROM incident_conversations ic
                  JOIN incidents i ON i.id = ic.incident_id WHERE ic.conversation_id = ?`)
      .all(conv.id) as { code: string; internal_explanation: string | null; known_cause: string | null; description: string | null }[]);
    for (const inc of incidents) {
      for (const [field, value] of [['internal_explanation', inc.internal_explanation], ['known_cause', inc.known_cause]] as const) {
        if (value && value.trim()) corpus.push({ description: `incident ${inc.code} ${field} (internal)`, text: value });
      }
    }
    const knownIssues = (this.db
      .prepare(`SELECT ki.title, ki.internal_explanation, ki.known_cause FROM known_issue_conversations kic
                  JOIN known_issues ki ON ki.id = kic.known_issue_id WHERE kic.conversation_id = ?`)
      .all(conv.id) as { title: string; internal_explanation: string | null; known_cause: string | null }[]);
    for (const ki of knownIssues) {
      for (const [field, value] of [['internal_explanation', ki.internal_explanation], ['known_cause', ki.known_cause]] as const) {
        if (value && value.trim()) corpus.push({ description: `known issue "${ki.title}" ${field} (internal)`, text: value });
      }
    }
    const citedInternalDocs = (this.db
      .prepare(`SELECT DISTINCT kd.title, kd.content FROM ai_sources s
                  JOIN ai_runs r ON r.id = s.run_id
                  JOIN knowledge_documents kd ON kd.id = s.source_id
                  WHERE r.conversation_id = ? AND s.source_type = 'knowledge_document' AND kd.visibility = 'internal_only'`)
      .all(conv.id) as { title: string; content: string | null }[]);
    for (const doc of citedInternalDocs.slice(0, 10)) {
      if (doc.content && doc.content.trim()) corpus.push({ description: `internal knowledge document "${doc.title}"`, text: doc.content.slice(0, 8000) });
    }

    if (corpus.length === 0) {
      return result(kind, 'not_applicable', 'No internal-only material is linked to this conversation (notes, incident internals, internal docs).', []);
    }

    // >= 6 consecutive shared normalized words = a verbatim span leak.
    const draftWords = normalizeWords(draft);
    const draftGrams = new Set<string>();
    for (let i = 0; i + 6 <= draftWords.length; i++) draftGrams.add(draftWords.slice(i, i + 6).join(' '));
    const findings: CoachingFinding[] = [];
    for (const source of corpus) {
      const sourceWords = normalizeWords(source.text);
      let hit: string | null = null;
      for (let i = 0; i + 6 <= sourceWords.length && hit == null; i++) {
        const gram = sourceWords.slice(i, i + 6).join(' ');
        if (draftGrams.has(gram)) hit = gram;
      }
      if (hit != null) {
        findings.push({
          draft_excerpt: draft.slice(0, 240),
          evidence: [{ description: source.description, excerpt: source.text.slice(0, 240) }],
          advice: 'This draft shares a verbatim span with internal-only material. Rewrite that passage in customer-safe language before sending.'
        });
      }
    }
    return result(kind, findings.length > 0 ? 'flagged' : 'pass',
      findings.length > 0
        ? `${findings.length} verbatim span(s) shared with internal-only material (6+ consecutive words).`
        : `No verbatim overlap with ${corpus.length} internal source(s) (6-gram shingle check).`,
      findings);
  }

  private checkWrongContext(conv: ConvRow, customer: { id: number; first_name: string | null; last_name: string | null } | null, draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'wrong_customer_context';
    const findings: CoachingFinding[] = [];

    // Conversation number references must belong to this customer.
    const numberRefs = [...draft.matchAll(/#(\d{3,8})\b/g)].map((m) => Number(m[1])).slice(0, 10);
    for (const ref of numberRefs) {
      const row = this.db
        .prepare('SELECT c.id, c.customer_local_id FROM conversations c WHERE c.number = ? AND c.deleted_at IS NULL')
        .get(ref) as { id: number; customer_local_id: number | null } | undefined;
      if (!row) {
        findings.push({
          draft_excerpt: `#${ref}`,
          evidence: [{ description: 'conversation lookup by number', excerpt: `No conversation #${ref} exists in the local mirror.` }],
          advice: `#${ref} does not match any known conversation - verify the number before sending.`
        });
      } else if (conv.customer_local_id != null && row.customer_local_id !== conv.customer_local_id) {
        findings.push({
          draft_excerpt: `#${ref}`,
          evidence: [{ description: 'conversation lookup by number', excerpt: `Conversation #${ref} belongs to a different customer (local id ${row.customer_local_id}).`, conversation_id: row.id }],
          advice: `#${ref} belongs to another customer - referencing it here may leak cross-customer context.`
        });
      }
    }

    // Greeting name should match this customer.
    const greeting = draft.match(/^(?:hi|hello|hey|dear)\s+([a-z][a-z'-]{1,30})\b/im);
    if (greeting && customer?.first_name) {
      const greeted = greeting[1]!.toLowerCase();
      const firstName = customer.first_name.toLowerCase();
      const generic = ['team', 'support', 'there', 'all', 'everyone', 'sir', 'madam', 'folks'];
      if (!generic.includes(greeted) && greeted !== firstName && !firstName.startsWith(greeted)) {
        findings.push({
          draft_excerpt: greeting[0]!.slice(0, 240),
          evidence: [{ description: 'customer record', excerpt: `This customer is ${customer.first_name} ${customer.last_name ?? ''}.` }],
          advice: 'The greeting names someone else - confirm you are replying in the right conversation with the right customer.'
        });
      }
    }

    return result(kind, findings.length > 0 ? 'flagged' : 'pass',
      findings.length > 0 ? `${findings.length} context mismatch(es) detected (conversation references / greeting name).` : 'No cross-customer context mismatches detected.',
      findings);
  }

  private checkPreferenceMismatch(preference: { preference: string; confidence: string; overridden: boolean; evidence_count: number } | null, threads: ThreadRow[], draft: string): CoachingCheckResult {
    const kind: CoachingCheckKind = 'preference_mismatch';
    if (!preference) {
      return result(kind, 'not_applicable', 'No communication preference on record for this customer (honest unknown - at least 3 distinct conversations are required before one is inferred).', []);
    }
    const words = normalizeWords(draft).length;
    const hasSteps = /\b(step|first|then|next|finally)\b|\d\./i.test(draft);
    const openQuestion = threads
      .filter((t) => t.type === 'customer')
      .slice(-10)
      .some((m) => splitSentences(htmlToText(m.body_html ?? m.body_text ?? '')).some((s) => isQuestion(s) && !isClosingAck(s)));
    let mismatch: string | null = null;
    if (preference.preference === 'concise' && words > 250) mismatch = `concise preference, ${words}-word draft`;
    else if (preference.preference === 'detailed' && words < 60 && openQuestion) mismatch = `detailed preference, ${words}-word draft on an open question`;
    else if (preference.preference === 'step_by_step' && !hasSteps && words > 80 && openQuestion) mismatch = 'step_by_step preference, no step/list structure detected';

    const evidence = [{
      description: `communication preference: ${preference.preference}${preference.overridden ? ' (human override active)' : ''}`,
      excerpt: `preference ${preference.preference}, confidence ${preference.confidence}, ${preference.evidence_count} supporting conversation(s)`
    }];
    if (mismatch) {
      return result(kind, 'flagged', `Draft shape does not match the observed preference (${mismatch}). This is an observed preference, not a rule.`, [
        { draft_excerpt: draft.slice(0, 240), evidence, advice: `This customer's observed preference is "${preference.preference}". Reshaping the draft may land better - your call.` }
      ]);
    }
    return result(kind, 'pass', `Draft shape matches the observed preference (${preference.preference}, confidence ${preference.confidence}${preference.overridden ? ', human override active' : ''}).`, []);
  }

  // ---------------- AI layer ----------------

  private async computeAiLayer(conv: ConvRow, threads: ThreadRow[], draft: string): Promise<{ layer: CoachingAiLayer | null; error: string | null }> {
    if (this.chat == null) {
      return { layer: null, error: 'AI coaching is unavailable (no local model configured). The deterministic checks were computed.' };
    }
    const recent = threads.slice(-8).map((t) => {
      const text = htmlToText(t.body_html ?? t.body_text ?? '').slice(0, 700);
      return `${t.type === 'customer' ? 'CUSTOMER' : t.type === 'reply' ? 'AGENT' : 'NOTE'}: ${text}`;
    });
    const system = [
      'You are a pre-send review assistant for a support agent. You see one draft reply and the recent conversation.',
      'Check exactly two things:',
      '1. unsupported_claims: does the draft assert specific facts (version numbers, causes, guarantees, policy statements) that are NOT supported by the conversation evidence?',
      '2. wrong_context: does the draft answer the wrong question, an outdated question, or a different customer issue?',
      'Answer strictly as JSON: {"unsupported_claims":{"verdict":"none|possible|likely","reasoning":"...","excerpt":"..."},"wrong_context":{"verdict":"no|possible|yes","reasoning":"...","excerpt":"..."}}.',
      'Be conservative: "none"/"no" unless the mismatch is clear. Quote the draft verbatim in excerpt (max 200 chars).'
    ].join('\n');
    const user = [
      `CONVERSATION #${conv.number} SUBJECT: ${conv.subject ?? '(none)'}`,
      'RECENT MESSAGES:',
      ...recent,
      'DRAFT TO REVIEW:',
      draft.slice(0, 6000),
      'Respond with the JSON object only.'
    ].join('\n');

    const aiRepo = new AiRepository(this.db);
    const inputHash = createHash('sha256').update(user).digest('hex');
    const runId = aiRepo.startRun('agent_coaching', { conversationId: conv.id, promptVersion: PROMPT_VERSION, inputHash });
    try {
      const res = await this.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.1, maxTokens: 700, jsonMode: true });
      const parsed = this.coerceAiLayer(res.content ?? '');
      if (parsed == null) {
        aiRepo.failRun(runId, 'unparseable coaching output');
        return { layer: null, error: 'The local model returned an unparseable coaching result; nothing was guessed. The deterministic checks were computed.' };
      }
      const layer: CoachingAiLayer = { ...parsed, model: res.model };
      aiRepo.completeRun(runId, res.model, res.latencyMs ?? 0);
      return { layer, error: null };
    } catch (e) {
      aiRepo.failRun(runId, e instanceof Error ? e.message : String(e));
      return { layer: null, error: `${e instanceof Error ? e.message : String(e)} The deterministic checks were computed and stored.` };
    }
  }

  private coerceAiLayer(content: string): Omit<CoachingAiLayer, 'model'> | null {
    try {
      const raw = JSON.parse(content.trim()) as Record<string, unknown>;
      const claims = raw.unsupported_claims as Record<string, unknown> | undefined;
      const context = raw.wrong_context as Record<string, unknown> | undefined;
      const verdictOf = (v: unknown, allowed: string[]): string | null => (typeof v === 'string' && allowed.includes(v) ? v : null);
      return {
        unsupported_claims: claims
          ? {
              verdict: (verdictOf(claims.verdict, ['none', 'possible', 'likely']) ?? 'possible') as 'none' | 'possible' | 'likely',
              reasoning: String(claims.reasoning ?? '').slice(0, 500),
              excerpt: String(claims.excerpt ?? '').slice(0, 240)
            }
          : null,
        wrong_context: context
          ? {
              verdict: (verdictOf(context.verdict, ['no', 'possible', 'yes']) ?? 'possible') as 'no' | 'possible' | 'yes',
              reasoning: String(context.reasoning ?? '').slice(0, 500),
              excerpt: String(context.excerpt ?? '').slice(0, 240)
            }
          : null
      };
    } catch {
      return null;
    }
  }

  private aiChecks(layer: CoachingAiLayer): CoachingCheckResult[] {
    const out: CoachingCheckResult[] = [];
    if (layer.unsupported_claims != null) {
      const c = layer.unsupported_claims;
      out.push(result('unsupported_claims', c.verdict === 'none' ? 'pass' : 'flagged',
        `AI review verdict: ${c.verdict}. ${c.reasoning}`,
        c.verdict === 'none' ? [] : [{ draft_excerpt: c.excerpt || '(see reasoning)', evidence: [{ description: 'local model reasoning', excerpt: c.reasoning }], advice: 'Verify the claim against conversation or knowledge evidence, or soften it ("typically", "in most cases").' }]));
    }
    if (layer.wrong_context != null) {
      const c = layer.wrong_context;
      out.push(result('wrong_customer_context', c.verdict === 'no' ? 'pass' : 'flagged',
        `AI context review verdict: ${c.verdict}. ${c.reasoning}`,
        c.verdict === 'no' ? [] : [{ draft_excerpt: c.excerpt || '(see reasoning)', evidence: [{ description: 'local model reasoning', excerpt: c.reasoning }], advice: 'Re-read the customer\'s last message - the draft may be answering a different question than the one asked.' }], true));
    }
    return out;
  }

  // ---------------- helpers ----------------

  private latestSignals(conversationId: number): string {
    const row = this.db
      .prepare('SELECT signals_json FROM client_current_signals WHERE conversation_id = ?')
      .get(conversationId) as { signals_json: string } | undefined;
    return row?.signals_json ?? '';
  }

  private customerPreference(customerId: number): { preference: string; confidence: string; overridden: boolean; evidence_count: number } | null {
    const row = this.db
      .prepare(`SELECT preference, confidence, evidence_count, human_override_value FROM client_communication_preferences
                  WHERE customer_id = ? ORDER BY CASE WHEN human_override_value IS NOT NULL THEN 0 ELSE 1 END, evidence_count DESC LIMIT 1`)
      .get(customerId) as { preference: string; confidence: string; evidence_count: number; human_override_value: string | null } | undefined;
    if (!row) return null;
    return {
      preference: row.human_override_value ?? row.preference,
      confidence: row.human_override_value != null ? 'human' : row.confidence,
      overridden: row.human_override_value != null,
      evidence_count: row.evidence_count
    };
  }
}

function result(kind: CoachingCheckKind, status: CoachingCheckResult['status'], detail: string, findings: CoachingFinding[], aiSuffix = false): CoachingCheckResult {
  return { kind, label: aiSuffix ? `${COACHING_CHECK_LABELS[kind]} (AI)` : COACHING_CHECK_LABELS[kind], layer: COACHING_CHECK_LAYER[kind], status, detail, findings };
}

function summarize(checks: CoachingCheckResult[]): { flagged: number; checks_run: number; checks_unavailable: number } {
  return {
    flagged: checks.filter((c) => c.status === 'flagged').length,
    checks_run: checks.filter((c) => c.status === 'pass' || c.status === 'flagged').length,
    checks_unavailable: checks.filter((c) => c.status === 'unavailable').length
  };
}

export { COACHING_CHECK_LABELS };
