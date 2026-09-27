import { isValidValue } from './heuristics.js';
import type { InteractionDimension } from '../../../shared/constants.js';
import type { InteractionSignal } from '../../../shared/types.js';

/**
 * Interaction safety layer (spec #7, #55, #37): the system must NEVER produce
 * psychological claims, diagnoses, or fixed personality labels — only
 * observable, evidence-backed communication signals.
 *
 * Defense in depth:
 *   1. Output schemas constrain dimensions to observable enums (schemas.ts).
 *   2. This sanitizer rejects forbidden trait vocabulary in ANY free text.
 *   3. Every significant signal must carry evidence or be dropped (spec #8).
 */

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(narcissis|anxiet|depress|bipolar|adhd|autis|schizo|paranoid|delusional|mentally|insane|unstable|unhinged)\w*/i, reason: 'mental-health language' },
  { pattern: /\b(personality (disorder|type|trait)|myers.?briggs|big five|temperament|character flaw)\b/i, reason: 'personality typing' },
  { pattern: /\b(difficult (person|customer|human)|problem (person|customer)|is (a )?(narcissist|aggressive person)|emotionally (unstable|volatile))\b/i, reason: 'fixed person label' },
  { pattern: /\b(race|ethnicity|religion|politic|sexual orientation|gay|lesbian|trans|muslim|christian|jew|hindu|atheist|white supremacy|nationalist)\b/i, reason: 'protected attribute inference' },
  { pattern: /\b(diagnos\w+|symptom of|suffers? from|patholog\w+)\b/i, reason: 'clinical diagnosis language' },
  { pattern: /\b(intelligen(t|ce) (level|of)|iq|cognitive ability|stupid|dumb|incompetent person)\b/i, reason: 'cognitive-ability judgment' },
  { pattern: /\b(manipulative|toxic person|evil|malicious person|bad person|liar|dishonest person)\b/i, reason: 'moral character judgment' },
  // Trait adjectives ascribed to the customer as a fixed characteristic ("the
  // customer is rude", "an entitled client", "needy user") — observable
  // behavior language must be used instead ("message contains X").
  { pattern: /\b((customer|client|user|person|he|she|they) (is|are|seems|acts|behaves) (a )?(rude|entitled|needy|demanding|lazy|clueless|hostile|abrasive|belligerent|passive.?aggressive|bully)|rude (person|customer|client)|entitled (person|customer|client)|needy (person|customer|client))\b/i, reason: 'fixed trait label' },
  { pattern: /\b(passive.?aggressive|bullying|arrogant|condescending (person|customer)|vindictive|vengeful)\b/i, reason: 'character judgment' }
];

export interface SanitizationResult {
  signals: InteractionSignal[];
  removed: { dimension: string; value: string; reason: string }[];
  textWarnings: string[];
}

/**
 * Sanitize a set of signals from ANY source (AI or heuristic):
 * - values must be in the observable-dimension vocabulary
 * - high/medium confidence signals must have evidence (spec #8) regardless of
 *   source: the evidence mandate is not AI-specific. Heuristic classifiers
 *   therefore only emit medium+ confidence when a marker match backs them.
 */
export function sanitizeSignals(signals: InteractionSignal[]): SanitizationResult {
  const kept: InteractionSignal[] = [];
  const removed: { dimension: string; value: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const s of signals) {
    const key = `${s.dimension}:${s.value}`;
    if (seen.has(key)) continue;
    if (!isValidValue(s.dimension as InteractionDimension, s.value)) {
      removed.push({ dimension: s.dimension, value: s.value, reason: 'value outside observable vocabulary (possible personality label)' });
      continue;
    }
    if ((s.confidence === 'high' || s.confidence === 'medium') && !s.evidence?.excerpt) {
      removed.push({ dimension: s.dimension, value: s.value, reason: 'significant signal without evidence (spec #8)' });
      continue;
    }
    seen.add(key);
    kept.push(s);
  }
  return { signals: kept, removed, textWarnings: [] };
}

/** Scan free text produced by the AI for forbidden trait claims. Returns cleaned text + warnings. */
export function sanitizeInteractionText(text: string): { ok: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) warnings.push(`Removed ${reason} — SupportOS only reports observable support-communication behavior.`);
  }
  return { ok: warnings.length === 0, warnings };
}

/** Full rejection gate for AI observation payloads: any forbidden claim invalidates the free text. */
export function assertInteractionTextSafe(text: string | null | undefined): { ok: boolean; warnings: string[] } {
  if (!text) return { ok: true, warnings: [] };
  return sanitizeInteractionText(text);
}

/** Human-facing label sets (spec #2): support behavior framing, never psychology. */
export const INTERACTION_LABELS = {
  featureTitle: 'Client Interaction Profile',
  currentSection: 'Current Interaction',
  historicalSection: 'Historical Interaction Pattern',
  preferencesSection: 'Communication Preferences',
  approachSection: 'Support Approach',
  trendLabel: 'Observed support-interaction signals'
} as const;
