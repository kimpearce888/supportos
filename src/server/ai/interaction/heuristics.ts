import {
  DETAIL_VALUES,
  DIRECTNESS_VALUES,
  EXPECTATION_VALUES,
  FRUSTRATION_VALUES,
  INTERACTION_DIMENSIONS,
  QUESTION_STRUCTURE_VALUES,
  RESPONSE_PREFERENCE_VALUES,
  TECHNICAL_VALUES,
  TONE_VALUES,
  URGENCY_VALUES,
  type InteractionDimension
} from '../../../shared/constants.js';
import type { InteractionSignal } from '../../../shared/types.js';

/**
 * Deterministic interaction-signal heuristics (interaction spec #6).
 * Pure functions over customer-authored message text. These run with ZERO AI:
 * the feature stays useful when LM Studio is unavailable (spec #10).
 * Values are always drawn from the fixed observable-dimension vocabulary.
 */

export interface MessageForAnalysis {
  text: string;
  thread_local_id: number | null;
  conversation_local_id: number | null;
  created_at: string | null;
}

export interface MessageStats {
  customer_messages: number;
  avg_message_length: number;
  question_count: number;
  exclamation_ratio: number;
  caps_ratio: number;
}

const TECHNICAL_VOCAB = [
  'api', 'endpoint', 'webhook', 'payload', 'json', 'oauth', 'token', 'http', 'https', 'ssl', 'tls', 'dns',
  'timezone', 'utc', 'cron', 'queue', 'cache', 'latency', 'http status', '401', '403', '404', '500',
  'console', 'log', 'stack trace', 'exception', 'database', 'sql', 'index', 'migration', 'deploy', 'build',
  'header', 'request', 'response', 'callback', 'integration', 'sdk', 'environment variable', 'rate limit'
];
const URGENCY_MARKERS = ['urgent', 'asap', 'immediately', 'right now', 'today', 'as soon as possible', 'deadline', 'before our', 'blocking', 'production is down', 'outage', 'critical'];
const FRUSTRATION_MARKERS = ['again', 'still', 'already', 'third time', 'multiple times', 'repeatedly', 'frustrat', 'unacceptable', 'ridiculous', 'seriously', 'not working', 'never works', 'every time', 'tired of', 'disappointed', 'kept', 'nobody', 'no one', 'still not'];
const DIRECT_MARKERS = ['need you to', 'fix', 'tell me', 'send me', 'do not', 'stop', 'require', 'must', 'want', 'instead of'];
const INDIRECT_MARKERS = ['i was wondering', 'if possible', 'could you perhaps', 'when you have a moment', 'sorry to bother', 'not sure if', 'might be able', 'hopefully', 'any chance'];
const ACTION_EXPECTATION_MARKERS = ['fix', 'resolve', 'restore', 'refund', 'escalate', 'asap', 'immediately', 'compensation'];
const ESCALATION_MARKERS = ['escalate', 'manager', 'supervisor', 'complaint', 'legal', 'cancel our', 'terminate', 'switching to'];
const DE_ESCALATION_TRIGGER_LEVELS = { frustration: 'strong', urgency: 'high' } as const;

function excerpt(text: string, maxLen = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 3)}…`;
}

function findEvidence(messages: MessageForAnalysis[], predicate: (t: string) => boolean): { excerpt: string; thread_local_id: number | null; conversation_local_id: number | null } | null {
  for (const m of messages) {
    if (predicate(m.text.toLowerCase())) {
      return { excerpt: excerpt(m.text), thread_local_id: m.thread_local_id, conversation_local_id: m.conversation_local_id };
    }
  }
  return null;
}

/** Word-boundary marker match: "against" must not match "again". */
function hasMarker(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function countMarkers(text: string, markers: readonly string[]): number {
  return markers.filter((m) => hasMarker(text, m)).length;
}

export function computeMessageStats(messages: MessageForAnalysis[]): MessageStats {
  const texts = messages.map((m) => m.text);
  const totalLen = texts.reduce((a, t) => a + t.length, 0);
  const all = texts.join('\n');
  const questionCount = (all.match(/\?/g) ?? []).length;
  const exclamations = (all.match(/!/g) ?? []).length;
  const letters = all.replace(/[^a-zA-Z]/g, '');
  const capsLetters = all.replace(/[^A-Z]/g, '');
  const repeatedPunctuation = (all.match(/([!?])\1{1,}/g) ?? []).length;
  return {
    customer_messages: messages.length,
    avg_message_length: messages.length ? Math.round(totalLen / messages.length) : 0,
    question_count: questionCount,
    exclamation_ratio: texts.length ? Number(((exclamations + repeatedPunctuation * 2) / texts.length).toFixed(2)) : 0,
    caps_ratio: letters.length ? Number((capsLetters.length / letters.length).toFixed(3)) : 0
  };
}

/** Deterministic current-ticket signals (spec #6). Confidence reflects heuristic reliability. */
export function heuristicSignals(messages: MessageForAnalysis[], stats: MessageStats): InteractionSignal[] {
  if (!messages.length) return [];
  const all = messages.map((m) => m.text).join('\n').toLowerCase();
  const signals: InteractionSignal[] = [];
  const avgLen = stats.avg_message_length;

  const push = (dimension: InteractionDimension, value: string, confidence: 'high' | 'medium' | 'low', evidence: InteractionSignal['evidence']): void => {
    if (isValidValue(dimension, value)) signals.push({ dimension, value, confidence, evidence, source: 'heuristic' });
  };

  // Tone (spec #6): observable markers only
  const tone: string = FRUSTRATION_MARKERS.some((m) => hasMarker(all, m))
    ? 'frustrated'
    : URGENCY_MARKERS.some((m) => hasMarker(all, m))
      ? 'urgent'
      : /thank(s| you)? for|appreciate|great (work|job|support|help)|awesome|excellent/.test(all)
        ? 'appreciative'
        : 'neutral';
  push('tone', tone, tone === 'neutral' ? 'low' : 'medium', findEvidence(messages, (t) => FRUSTRATION_MARKERS.some((m) => hasMarker(t, m)) || URGENCY_MARKERS.some((m) => hasMarker(t, m)) || /thank(s| you)? for|appreciate/i.test(t)));

  // Directness
  const directHits = countMarkers(all, DIRECT_MARKERS);
  const indirectHits = countMarkers(all, INDIRECT_MARKERS);
  const directness: string = directHits >= 2 ? 'highly_direct' : directHits === 1 && indirectHits === 0 ? 'direct' : indirectHits >= 1 ? 'conversational' : 'conversational';
  // Evidence must point at whichever marker class drove the classification
  // (a 'conversational' verdict derived from indirect markers had no evidence).
  push('directness', directness, directHits + indirectHits >= 1 ? 'medium' : 'low', findEvidence(messages, (t) => DIRECT_MARKERS.some((m) => hasMarker(t, m)) || INDIRECT_MARKERS.some((m) => hasMarker(t, m))));

  // Detail level from average message length
  const detail: string = avgLen > 900 ? 'very_high' : avgLen > 450 ? 'high' : avgLen > 150 ? 'moderate' : avgLen > 60 ? 'low' : 'very_low';
  const firstMsg = messages[0];
  push('detail', detail, avgLen > 150 ? 'medium' : 'low', firstMsg ? { excerpt: excerpt(firstMsg.text), thread_local_id: firstMsg.thread_local_id, conversation_local_id: firstMsg.conversation_local_id } : null);

  // Technical language vocabulary
  const techHits = countMarkers(all, TECHNICAL_VOCAB);
  const technical: string = techHits >= 4 ? 'highly_technical' : techHits >= 2 ? 'technical' : techHits === 1 ? 'mixed' : 'non_technical';
  push('technical_language', technical, techHits >= 1 ? 'medium' : 'low', findEvidence(messages, (t) => TECHNICAL_VOCAB.some((v) => hasMarker(t, v))));

  // Question structure
  const questionStructure: string =
    stats.question_count >= 3 ? 'multiple_questions' : stats.question_count === 2 ? 'multiple_questions' : stats.question_count === 1 ? 'single_question' : /error|broken|failing|not work|issue|problem/.test(all) ? 'troubleshooting_oriented' : 'explanation_oriented';
  push('question_structure', questionStructure, stats.question_count >= 1 ? 'medium' : 'low', findEvidence(messages, (t) => t.includes('?')));

  // Urgency
  const urgencyHits = countMarkers(all, URGENCY_MARKERS);
  const urgency: string = urgencyHits >= 3 || /production is down|outage|emergency/.test(all) ? 'high' : urgencyHits >= 1 ? 'moderate' : 'none';
  push('urgency', urgency, urgencyHits >= 1 ? 'medium' : 'low', findEvidence(messages, (t) => URGENCY_MARKERS.some((m) => hasMarker(t, m))));

  // Frustration
  const frustrationHits = countMarkers(all, FRUSTRATION_MARKERS);
  const frustration: string = frustrationHits >= 3 ? 'strong' : frustrationHits >= 1 ? 'moderate' : 'none';
  push('frustration', frustration, frustrationHits >= 1 ? 'medium' : 'low', findEvidence(messages, (t) => FRUSTRATION_MARKERS.some((m) => hasMarker(t, m))));

  // Expectation — confidence follows whether an actual marker/phrase drove the
  // classification (the plain 'information' fallback without any marker is low
  // confidence, and low-confidence signals carry no evidence requirement).
  const expectationMarkerHit =
    ESCALATION_MARKERS.some((m) => hasMarker(all, m)) ||
    countMarkers(all, ACTION_EXPECTATION_MARKERS) >= 1 ||
    /how do i|how can i|what is|when will|where is|which|why|explain|reason|cause/.test(all);
  const expectation: string = ESCALATION_MARKERS.some((m) => hasMarker(all, m))
    ? 'escalation'
    : countMarkers(all, ACTION_EXPECTATION_MARKERS) >= 2 || (urgency === 'high' && ACTION_EXPECTATION_MARKERS.some((m) => hasMarker(all, m)))
      ? 'immediate_resolution'
      : ACTION_EXPECTATION_MARKERS.some((m) => hasMarker(all, m))
        ? 'action'
        : /how do i|how can i|what is|when will|where is|which/.test(all)
          ? 'information'
          : /why|explain|reason|cause/.test(all)
            ? 'explanation'
            : 'information';
  push('expectation', expectation, expectationMarkerHit ? 'medium' : 'low', findEvidence(messages, (t) => ACTION_EXPECTATION_MARKERS.some((m) => hasMarker(t, m)) || ESCALATION_MARKERS.some((m) => hasMarker(t, m)) || /why|explain|how do|how can|when will|where is|which|what is/i.test(t)));

  return signals;
}

/** Response preference needs repeated evidence (spec #39): heuristics NEVER emit it from one ticket. */
export function heuristicResponsePreference(messages: MessageForAnalysis[]): InteractionSignal | null {
  const all = messages.map((m) => m.text).join('\n').toLowerCase();
  // Every trigger phrase must also be findable by the evidence predicate below
  // it: a preference signal with no evidence excerpt violates the spec's
  // evidence mandate.
  if (/keep (it |this )?(short|brief)|concise|short answer|no lengthy|brief answer|be brief/.test(all)) {
    return { dimension: 'response_preference', value: 'concise', confidence: 'high', evidence: findEvidence(messages, (t) => /keep (it |this )?(short|brief)|concise|short answer|no lengthy|brief answer|be brief/i.test(t)), source: 'heuristic' };
  }
  if (/step by step|step-by-step|walk me through|instructions/.test(all)) {
    return { dimension: 'response_preference', value: 'step_by_step', confidence: 'high', evidence: findEvidence(messages, (t) => /step by step|step-by-step|walk me through|instructions/i.test(t)), source: 'heuristic' };
  }
  if (/detailed|thorough|in depth|in-depth|full explanation|comprehensive/.test(all)) {
    return { dimension: 'response_preference', value: 'detailed', confidence: 'high', evidence: findEvidence(messages, (t) => /detailed|thorough|in depth|in-depth|full explanation|comprehensive/i.test(t)), source: 'heuristic' };
  }
  return null;
}

/** Explicit in-message preference requests — top of the precedence chain (spec #56). */
export function explicitCurrentPreference(messages: MessageForAnalysis[]): { preference: string; evidence: { excerpt: string; thread_local_id: number | null; conversation_local_id: number | null } | null } | null {
  const p = heuristicResponsePreference(messages);
  return p ? { preference: p.value, evidence: p.evidence } : null;
}

export function needsDeEscalation(signals: InteractionSignal[]): boolean {
  return signals.some((s) => (s.dimension === 'frustration' && s.value === DE_ESCALATION_TRIGGER_LEVELS.frustration) || (s.dimension === 'urgency' && s.value === DE_ESCALATION_TRIGGER_LEVELS.urgency && signals.some((x) => x.dimension === 'frustration' && (x.value === 'moderate' || x.value === 'strong'))));
}

const VALUE_VOCAB: Record<InteractionDimension, readonly string[]> = {
  tone: TONE_VALUES,
  directness: DIRECTNESS_VALUES,
  detail: DETAIL_VALUES,
  technical_language: TECHNICAL_VALUES,
  question_structure: QUESTION_STRUCTURE_VALUES,
  urgency: URGENCY_VALUES,
  frustration: FRUSTRATION_VALUES,
  expectation: EXPECTATION_VALUES,
  response_preference: RESPONSE_PREFERENCE_VALUES
};

/** Enum guard: heuristic values must always be in the observable vocabulary. */
export function isValidValue(dimension: InteractionDimension, value: string): boolean {
  const vocab = VALUE_VOCAB[dimension];
  return vocab ? vocab.includes(value) : false;
}

export function allDimensions(): readonly InteractionDimension[] {
  return INTERACTION_DIMENSIONS;
}
