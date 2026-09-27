import { PROMPT_VERSIONS } from '../../shared/constants.js';
import type { TicketAnalysis } from '../../shared/types.js';

/** All AI prompts live here (spec #134: no AI prompts scattered in random files). Versioned per spec #76. */

export interface EvidenceContext {
  conversationNumber: number;
  subject: string;
  customerName: string;
  customerHistory: { number: number; subject: string; summary: string; daysAgo: number }[];
  threads: { author: string; type: string; date: string; text: string }[];
  similarCases: { number: number; subject: string; resolution: string; date: string; visibility: 'customer_safe' | 'internal_only' }[];
  knownIssues: { title: string; symptoms: string; customerSafeExplanation: string | null; workaround: string | null }[];
  knowledge: { title: string; text: string; visibility: 'customer_safe' | 'internal_only' }[];
  savedReplies: { name: string; text: string }[];
}

function renderEvidence(ctx: EvidenceContext): string {
  const parts: string[] = [];
  parts.push(`CONVERSATION #${ctx.conversationNumber}: ${ctx.subject}`);
  parts.push(`CUSTOMER: ${ctx.customerName}`);
  if (ctx.customerHistory.length) {
    parts.push('\nCUSTOMER HISTORY (previous conversations):');
    for (const h of ctx.customerHistory) parts.push(`  #${h.number} (${h.daysAgo}d ago): ${h.subject} - ${h.summary}`);
  }
  parts.push('\nTHREADS (oldest first):');
  for (const t of ctx.threads) parts.push(`  [${t.date}] ${t.author} (${t.type}): ${t.text}`);
  if (ctx.similarCases.length) {
    parts.push('\nSIMILAR PAST CONVERSATIONS:');
    for (const s of ctx.similarCases) parts.push(`  #${s.number} ${s.subject} (${s.date}) - resolution: ${s.resolution} [visibility: ${s.visibility}]`);
  }
  if (ctx.knownIssues.length) {
    parts.push('\nKNOWN ISSUES:');
    for (const k of ctx.knownIssues) parts.push(`  - ${k.title}: ${k.symptoms}${k.customerSafeExplanation ? ` | customer-safe explanation: ${k.customerSafeExplanation}` : ''}${k.workaround ? ` | workaround: ${k.workaround}` : ''}`);
  }
  if (ctx.knowledge.length) {
    parts.push('\nKNOWLEDGE DOCUMENTS:');
    for (const k of ctx.knowledge) parts.push(`  [${k.visibility}] ${k.title}: ${k.text}`);
  }
  if (ctx.savedReplies.length) {
    parts.push('\nSAVED REPLIES:');
    for (const s of ctx.savedReplies) parts.push(`  "${s.name}": ${s.text}`);
  }
  return parts.join('\n');
}

export const TICKET_ANALYSIS_SYSTEM = `You are the analysis engine of a local customer-support assistant. You analyze support conversations and produce STRICT JSON.

Rules:
- Base every field ONLY on the evidence provided. If information is missing, use null or an empty array - never invent.
- "evidence_quality": "strong" when multiple evidence sources support the analysis, "some" when one source supports it, "limited" when the evidence is thin, "insufficient" when you are mostly guessing.
- Do not speculate about timeframes, releases, or engineering status.
- Respond with a single JSON object, no prose.

JSON shape:
{
  "intent": "one of: question | bug_report | feature_request | billing | complaint | how_to | other, or null",
  "primary_question": "the customer's main question in one sentence, or null",
  "secondary_questions": ["other explicit questions"],
  "customer_goal": "what the customer ultimately wants to achieve",
  "product": "product/area mentioned or null",
  "feature": "specific feature or null",
  "problem_type": "one of: configuration | defect | documentation_gap | account_access | billing | data | integration | other, or null",
  "requested_action": "what the customer asks us to do",
  "urgency": "low | normal | high | critical",
  "sentiment": "positive | neutral | negative | frustrated",
  "known_issue_candidate": "title of a known issue from the evidence that matches, or null",
  "issue_cluster_candidate": "a short 2-4 word topic label grouping this ticket with similar ones (e.g. 'timezone schedules', 'invite delivery'), or null",
  "missing_information": ["information we still need from the customer"],
  "summary": "2-3 sentence factual summary",
  "evidence_quality": "strong | some | limited | insufficient"
}`;

export function buildTicketAnalysisUser(ctx: EvidenceContext): string {
  return `Analyze the following support conversation evidence and respond with the JSON object described.\n\n${renderEvidence(ctx)}`;
}

export const CUSTOMER_DRAFT_SYSTEM = `You draft customer-facing support replies. You operate in VERIFIED ANSWER MODE.

Hard rules:
- Use ONLY customer-safe evidence: the current conversation, verified account information, approved customer-safe knowledge, verified known-issue customer-safe explanations, and saved replies.
- NEVER use internal-only notes, engineering details, or another customer's data.
- NEVER invent: timeframes, feature availability, bug-fix status, release dates, engineering decisions, policies, or account-specific facts.
- If the evidence does not support an answer, say that verification with the team is needed.
- Keep the tone professional, warm and concise. No markdown headers. Plain paragraphs and optional short lists.
- Respond with a single JSON object: {"draft": "<reply text>", "used_evidence": ["short label of each piece of evidence you relied on"]}`;

export function buildCustomerDraftUser(ctx: EvidenceContext, mode: 'verified_answer' | 'standard', analysis: TicketAnalysis | null): string {
  const analysisLine = analysis ? `\nAI ANALYSIS (internal - do not leak verbatim): intent=${analysis.intent}; primary question=${analysis.primary_question ?? 'unknown'}; known issue candidate=${analysis.known_issue_candidate ?? 'none'}` : '';
  const modeLine = mode === 'verified_answer' ? 'VERIFIED ANSWER MODE is active - only customer-safe evidence may support statements.' : 'Standard mode - still never expose internal-only information.';
  const customerSafeOnly = {
    ...ctx,
    similarCases: ctx.similarCases.filter((s) => s.visibility === 'customer_safe'),
    knowledge: ctx.knowledge.filter((k) => k.visibility === 'customer_safe'),
    customerHistory: ctx.customerHistory
  };
  return `${modeLine}${analysisLine}\n\nDraft a reply to the customer's LATEST message using the evidence below.\n\n${renderEvidence(customerSafeOnly)}`;
}

export const DRAFT_VERIFICATION_SYSTEM = `You verify AI-drafted customer replies against evidence. You are strict and skeptical.

Check:
1. Does the draft answer every explicit customer question? (missing_questions)
2. Are all factual claims supported by the evidence? (unsupported_claims)
3. Does it invent a timeframe, feature, fix status, release date, policy or account fact? (unsupported_claims)
4. Does it expose internal-only information (engineering notes, internal IDs, other customers)? (internal_leakage)
5. Does it contradict the evidence? (conflicts)
6. Any other risk? (warnings)

Respond ONLY with JSON: {"verified": true/false, "unsupported_claims": ["..."], "missing_questions": ["..."], "internal_leakage": ["..."], "conflicts": ["..."], "warnings": ["..."]}`;

export function buildDraftVerificationUser(ctx: EvidenceContext, draft: string, customerQuestions: string[]): string {
  return `Customer's explicit questions:\n${customerQuestions.map((q) => `- ${q}`).join('\n') || '- (none extracted)'}\n\nDRAFT TO VERIFY:\n"""\n${draft}\n"""\n\nEVIDENCE:\n${renderEvidence(ctx)}`;
}

export const ISSUE_CLUSTER_SYSTEM = `You group support conversations into issue clusters based on their content.

Rules:
- Derive categories from the ACTUAL data - do not force predefined categories.
- Only create clusters with 2+ conversations.
- Titles: short, specific, lowercase topic style (e.g. "timezone after DST change", "invite emails bouncing").
- Respond ONLY with JSON: {"clusters": [{"title": "...", "summary": "one sentence", "category": "...", "product": "..."|null, "feature": "..."|null, "conversation_numbers": [..]}]}`;

export function buildIssueClusterUser(conversations: { number: number; subject: string; preview: string; tags: string[] }[]): string {
  return `Group these conversations into issue clusters. Only output clusters with 2+ members.\n\n${conversations
    .map((c) => `#${c.number} [${c.tags.join(',') || 'no tags'}] ${c.subject}: ${c.preview}`)
    .join('\n')}`;
}

export const REPORT_NARRATIVE_SYSTEM = `You write a short factual narrative for a support report. SQL-computed numbers are given to you as facts - never recalculate or invent numbers. Clearly flag any statement you are unsure about with "requires verification". Respond ONLY with JSON: {"narrative": "..."}`;

export function buildReportNarrativeUser(reportName: string, facts: Record<string, unknown>): string {
  return `Report: ${reportName}\n\nComputed facts (authoritative, do not change):\n${JSON.stringify(facts, null, 2)}\n\nWrite a 3-5 sentence narrative for a support lead summarizing what matters. The narrative will be clearly labeled as AI-generated.`;
}

export const MEMORY_EXTRACTION_SYSTEM = `You extract durable customer facts worth remembering for future support interactions. Only include facts clearly supported by the conversation. Do NOT include sensitive payment data or credentials. Respond ONLY with JSON: {"memories": [{"key": "short_label", "value": "one sentence fact", "confidence": "high|medium|low"}]}`;

export function buildMemoryExtractionUser(customerName: string, threads: { author: string; text: string }[]): string {
  return `Customer: ${customerName}\n\nConversation:\n${threads.map((t) => `${t.author}: ${t.text}`).join('\n')}`;
}

export const PROMPT_REGISTRY = {
  ticket_analysis: { version: PROMPT_VERSIONS.TICKET_ANALYSIS, system: TICKET_ANALYSIS_SYSTEM },
  customer_draft: { version: PROMPT_VERSIONS.CUSTOMER_DRAFT, system: CUSTOMER_DRAFT_SYSTEM },
  draft_verification: { version: PROMPT_VERSIONS.DRAFT_VERIFICATION, system: DRAFT_VERIFICATION_SYSTEM },
  issue_cluster: { version: PROMPT_VERSIONS.ISSUE_CLUSTER, system: ISSUE_CLUSTER_SYSTEM },
  report_narrative: { version: PROMPT_VERSIONS.REPORT_NARRATIVE, system: REPORT_NARRATIVE_SYSTEM },
  memory_extraction: { version: PROMPT_VERSIONS.MEMORY_EXTRACTION, system: MEMORY_EXTRACTION_SYSTEM }
} as const;
