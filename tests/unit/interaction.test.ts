import { describe, it, expect } from 'vitest';
import { computeMessageStats, heuristicSignals, heuristicResponsePreference, needsDeEscalation, isValidValue } from '../../src/server/ai/interaction/heuristics.js';
import { sanitizeSignals, sanitizeInteractionText } from '../../src/server/ai/interaction/safety.js';

/**
 * Client Interaction Intelligence unit tests (interaction spec #6-#9, #39, #55):
 * observable dimensions only, evidence requirement, bias protection.
 */
const msg = (text: string): { text: string; thread_local_id: number | null; conversation_local_id: number | null; created_at: string | null } => ({
  text,
  thread_local_id: 1,
  conversation_local_id: 1,
  created_at: null
});

describe('interaction heuristics (spec #6)', () => {
  it('classifies an urgent, frustrated, direct message from observable markers', () => {
    const messages = [msg('This is the THIRD time I have reported this and I have already explained it repeatedly. Still broken. I need this fixed immediately - production is down for our webinar today!')];
    const stats = computeMessageStats(messages);
    const signals = heuristicSignals(messages, stats);
    const byDim = new Map(signals.map((s) => [s.dimension, s.value]));
    expect(byDim.get('frustration')).toBe('strong');
    expect(byDim.get('urgency')).toBe('high');
    expect(byDim.get('tone')).toBe('frustrated');
    // every heuristic value is inside the fixed vocabulary
    for (const s of signals) expect(isValidValue(s.dimension, s.value)).toBe(true);
  });

  it('classifies a calm, detailed, technical message', () => {
    const long = 'Hello, I have a question about the webhook payload format after the v2.4 upgrade. Our receiver validates against a strict JSON schema and returns HTTP 422 before the handler runs. I captured the failing delivery from the integrations log. The event type field changed and the payload is now base64 encoded. Is there a changelog entry describing the new contract, and is the legacy format supported during a transition period? We process about 4000 events per day through this endpoint. Thanks.';
    const messages = [msg(long)];
    const stats = computeMessageStats(messages);
    const signals = heuristicSignals(messages, stats);
    const byDim = new Map(signals.map((s) => [s.dimension, s.value]));
    expect(byDim.get('technical_language')).toBe('highly_technical');
    expect(['high', 'very_high']).toContain(byDim.get('detail'));
    expect(byDim.get('tone')).toBe('neutral');
    expect(byDim.get('urgency')).toBe('none');
  });

  it('detects an explicit response preference request (spec #56 top of precedence)', () => {
    const p = heuristicResponsePreference([msg('Please keep the explanation short - a concise answer is fine.')]);
    expect(p?.value).toBe('concise');
    expect(p?.confidence).toBe('high');
    expect(p?.evidence?.excerpt).toBeTruthy();
    const none = heuristicResponsePreference([msg('The export fails every night.')]);
    expect(none).toBeNull();
  });

  it('never infers a preference from one short message (spec #39 anti-overfitting)', () => {
    const messages = [msg('Please fix this.')];
    const stats = computeMessageStats(messages);
    const signals = heuristicSignals(messages, stats);
    // response_preference is only emitted when explicitly requested
    expect(signals.some((s) => s.dimension === 'response_preference')).toBe(false);
  });

  it('flags de-escalation only for strong frustration or high urgency + frustration (spec #48)', () => {
    const angry = heuristicSignals([msg('Unacceptable - third time, still not working, I already explained this repeatedly!')], computeMessageStats([msg('Unacceptable - third time, still not working, I already explained this repeatedly!')]));
    expect(needsDeEscalation(angry)).toBe(true);
    const calm = heuristicSignals([msg('Could you help me understand the export schedule?')], computeMessageStats([msg('Could you help me understand the export schedule?')]));
    expect(needsDeEscalation(calm)).toBe(false);
  });
});

describe('interaction safety (spec #7, #8, #55)', () => {
  it('rejects values outside the observable vocabulary (personality labels impossible)', () => {
    const result = sanitizeSignals([
      { dimension: 'tone', value: 'narcissistic', confidence: 'high', evidence: { excerpt: 'x', thread_local_id: 1, conversation_local_id: 1 }, source: 'ai' },
      { dimension: 'urgency', value: 'high', confidence: 'high', evidence: { excerpt: 'needed today', thread_local_id: 1, conversation_local_id: 1 }, source: 'ai' }
    ]);
    expect(result.signals.length).toBe(1);
    expect(result.signals[0]?.value).toBe('high');
    expect(result.removed.length).toBe(1);
    expect(result.removed[0]?.reason).toContain('vocabulary');
  });

  it('drops significant AI signals without evidence (spec #8)', () => {
    const result = sanitizeSignals([{ dimension: 'frustration', value: 'strong', confidence: 'high', evidence: null, source: 'ai' }]);
    expect(result.signals.length).toBe(0);
    expect(result.removed[0]?.reason).toContain('evidence');
  });

  it('scans free text for forbidden psychological and protected-attribute claims', () => {
    expect(sanitizeInteractionText('This customer appears anxious and emotionally unstable.').ok).toBe(false);
    expect(sanitizeInteractionText('The person is a narcissist.').ok).toBe(false);
    expect(sanitizeInteractionText('Customer prefers concise answers based on 8 resolved conversations.').ok).toBe(true);
    expect(sanitizeInteractionText('Across previous conversations, this customer frequently requests detailed explanations.').ok).toBe(true);
  });
});
