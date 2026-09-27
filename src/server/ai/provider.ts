import type { TicketAnalysis, DraftVerification, AiSourceRef } from '../../shared/types.js';
import type { EvidenceContext } from './prompts.js';

/**
 * AI provider interface (spec #28): business logic never depends on the AI backend.
 * LM Studio is the initial (and default) implementation; no cloud providers.
 */
export interface AiProvider {
  readonly kind: string;
  readonly available: boolean;
  lastError(): string | null;
  modelInfo(): { chat_model: string | null; embedding_model: string | null; base_url: string };

  analyzeTicket(ctx: EvidenceContext): Promise<{ analysis: TicketAnalysis; latencyMs: number; model: string }>;
  generateDraft(ctx: EvidenceContext, mode: 'verified_answer' | 'standard', analysis: TicketAnalysis | null): Promise<{ draft: string; usedEvidence: string[]; latencyMs: number; model: string }>;
  verifyDraft(ctx: EvidenceContext, draft: string, customerQuestions: string[]): Promise<{ verification: DraftVerification; latencyMs: number; model: string }>;
  clusterIssues(conversations: { number: number; subject: string; preview: string; tags: string[] }[]): Promise<{ clusters: { title: string; summary: string; category: string | null; product: string | null; feature: string | null; conversation_numbers: number[] }[]; latencyMs: number }>;
  generateReportNarrative(reportName: string, facts: Record<string, unknown>): Promise<{ narrative: string; latencyMs: number }>;
  extractMemories(customerName: string, threads: { author: string; text: string }[]): Promise<{ memories: { key: string; value: string; confidence: 'high' | 'medium' | 'low' }[]; latencyMs: number }>;
  embed(texts: string[]): Promise<number[][]>;
  rewriteDraft(draft: string, instruction: 'shorten' | 'expand' | 'warmer' | 'more_direct'): Promise<{ text: string; latencyMs: number }>;
}

export type { AiSourceRef };
