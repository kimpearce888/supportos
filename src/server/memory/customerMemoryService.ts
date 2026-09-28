import type { DB } from '../database/connection.js';
import {
  MEMORY_ENTRY_KINDS, MEMORY_SECTION_LABELS, MEMORY_SECTIONS,
  MEMORY_QUARANTINE_PATTERNS, MEMORY_FRESH_DAYS, MEMORY_AGING_DAYS,
  type CustomerMemoryProfile, type MemoryEntry, type MemoryEvidence, type MemoryFreshness, type MemoryQuarantinedEntry, type MemoryEntryKind
} from '../../shared/memory.js';

/**
 * Customer support memory (v2.2.0 / M6, plan Phase 36).
 *
 * Memory is COMPOSED AT READ TIME from the tables that already hold each
 * fact: interactions, outcomes, links, campaigns, events, profiles. The
 * composition can never drift from its sources, and every entry carries the
 * source's own timestamp / confidence / evidence instead of a stale copy.
 * Only HUMAN-written entries are persisted rows (customer_memories with
 * source='human') - a human note is information the database does not
 * already contain.
 *
 * RED LINE (plan Phase 36: "Do not store sensitive psychological/personality
 * judgments"): a deterministic quarantine scanner matches stored memory
 * keys/values against a closed pattern list. Matching entries are pulled OUT
 * of the usable profile - listed with a reason and deletable - never
 * surfaced as memory an agent should act on. Human writes matching the
 * patterns are refused outright.
 */

function freshnessFrom(lastSeen: string | null): MemoryFreshness {
  if (lastSeen == null) return 'unknown';
  const seen = Date.parse(lastSeen.includes('T') ? lastSeen : `${lastSeen.replace(' ', 'T')}Z`);
  if (!Number.isFinite(seen)) return 'unknown';
  const days = (Date.now() - seen) / 86_400_000;
  if (days <= MEMORY_FRESH_DAYS) return 'fresh';
  if (days <= MEMORY_AGING_DAYS) return 'aging';
  return 'stale';
}

function isQuarantined(key: string, value: string | null): boolean {
  const text = value == null ? key : `${key} ${value}`;
  return MEMORY_QUARANTINE_PATTERNS.some((re) => re.test(key) || re.test(text));
}

export class CustomerMemoryService {
  constructor(private db: DB) {}

  /** The composed memory profile (plan Phase 36). Null = unknown customer. */
  profile(customerId: number): CustomerMemoryProfile | null {
    const customer = this.db
      .prepare(`SELECT cu.id, cu.first_name, cu.last_name, cu.background, cu.location, cu.remote_created_at,
                   o.name AS organization_name, o.domains AS organization_domains
                FROM customers cu LEFT JOIN organizations o ON o.id = cu.organization_id
                WHERE cu.id = ? AND cu.deleted_at IS NULL`)
      .get(customerId) as
      | { id: number; first_name: string | null; last_name: string | null; background: string | null; location: string | null; remote_created_at: string | null; organization_name: string | null; organization_domains: string | null }
      | undefined;
    if (!customer) return null;

    const sections: CustomerMemoryProfile['sections'] = [];
    const push = (section: (typeof MEMORY_SECTIONS)[number], entries: MemoryEntry[]): void => {
      sections.push({ section, label: MEMORY_SECTION_LABELS[section], entries });
    };

    // ---- known issue history ----
    const issues = (this.db
      .prepare(`SELECT ki.id, ki.title, ki.status, ki.first_seen_at, ki.last_seen_at, ki.provenance,
                   MIN(kic.linked_at) AS first_link, MAX(kic.linked_at) AS last_link,
                   (SELECT GROUP_CONCAT(c.number) FROM known_issue_conversations kic2
                      JOIN conversations c ON c.id = kic2.conversation_id
                     WHERE kic2.known_issue_id = ki.id AND c.customer_local_id = ? LIMIT 5) AS my_numbers
                FROM known_issue_conversations kic
                  JOIN known_issues ki ON ki.id = kic.known_issue_id
                  JOIN conversations c ON c.id = kic.conversation_id
                WHERE c.customer_local_id = ?
                GROUP BY ki.id ORDER BY COALESCE(ki.last_seen_at, kic.linked_at) DESC LIMIT 25`)
      .all(customerId, customerId) as { id: number; title: string; status: string; first_seen_at: string | null; last_seen_at: string | null; provenance: string; first_link: string | null; last_link: string | null; my_numbers: string | null }[]);
    push('issue_history', issues.map((i) => ({
      section: 'issue_history' as const,
      title: i.title,
      value: `status: ${i.status}`,
      source: 'deterministic_local' as const,
      origin: i.provenance,
      first_seen_at: i.first_seen_at ?? i.first_link,
      last_seen_at: i.last_seen_at ?? i.last_link,
      confidence: 'medium' as const,
      freshness: freshnessFrom(i.last_seen_at ?? i.last_link),
      evidence: (i.my_numbers ?? '').split(',').filter(Boolean).slice(0, 5).map((n) => ({ description: 'their conversation', conversation_number: Number(n) })),
      editable: false
    })));

    // ---- previous resolutions ----
    const resolutions = (this.db
      .prepare(`SELECT c.id, c.number, c.subject, c.closed_at, o.resolved_after_first_response, o.follow_up_count, o.effort_score, o.friction
                FROM conversations c
                  LEFT JOIN client_support_outcomes o ON o.conversation_id = c.id
                WHERE c.customer_local_id = ? AND c.deleted_at IS NULL AND c.status = 'closed' AND c.closed_at IS NOT NULL
                ORDER BY c.closed_at DESC LIMIT 25`)
      .all(customerId) as { id: number; number: number; subject: string | null; closed_at: string; resolved_after_first_response: number | null; follow_up_count: number | null; effort_score: number | null; friction: string | null }[]);
    push('previous_resolutions', resolutions.map((r) => ({
      section: 'previous_resolutions' as const,
      title: `#${r.number} ${r.subject ?? '(no subject)'}`,
      value: [
        r.resolved_after_first_response === 1 ? 'resolved after first response' : r.resolved_after_first_response === 0 ? 'needed follow-ups' : null,
        r.follow_up_count != null ? `${r.follow_up_count} follow-up(s)` : null,
        r.effort_score != null ? `customer effort ${r.effort_score}/10` : null,
        r.friction && r.friction !== 'none' ? `friction: ${r.friction}` : null
      ].filter(Boolean).join(', ') || 'closed',
      source: 'deterministic_local' as const,
      origin: 'client_support_outcomes',
      first_seen_at: r.closed_at,
      last_seen_at: r.closed_at,
      confidence: 'medium' as const,
      freshness: freshnessFrom(r.closed_at),
      evidence: [{ description: 'closed conversation', conversation_id: r.id, conversation_number: r.number }],
      editable: false
    })));

    // ---- communication preferences (with human override state) ----
    const prefs = (this.db
      .prepare(`SELECT preference, evidence_count, first_observed, last_observed, confidence, origin,
                   human_override_value, human_override_reason, overridden_at
                FROM client_communication_preferences WHERE customer_id = ?
                ORDER BY CASE WHEN human_override_value IS NOT NULL THEN 0 ELSE 1 END, evidence_count DESC LIMIT 10`)
      .all(customerId) as { preference: string; evidence_count: number; first_observed: string | null; last_observed: string | null; confidence: string; origin: string; human_override_value: string | null; human_override_reason: string | null; overridden_at: string | null }[]);
    push('communication_preferences', prefs.map((p) => ({
      section: 'communication_preferences' as const,
      title: `Prefers ${p.human_override_value ?? p.preference} replies`,
      value: p.human_override_value != null
        ? `human override active${p.human_override_reason ? ` (${p.human_override_reason})` : ''} - observed value was "${p.preference}"`
        : `${p.evidence_count} supporting conversation(s), observed since ${p.first_observed ?? 'unknown'}`,
      source: (p.human_override_value != null ? 'human_local' : p.origin === 'human_entered' ? 'human_local' : 'ai_derived') as MemoryEntry['source'],
      origin: p.origin,
      first_seen_at: p.first_observed,
      last_seen_at: p.overridden_at ?? p.last_observed,
      confidence: (p.human_override_value != null ? 'high' : p.confidence === 'high' || p.confidence === 'medium' || p.confidence === 'low' ? p.confidence : 'unknown') as MemoryEntry['confidence'],
      freshness: freshnessFrom(p.overridden_at ?? p.last_observed),
      evidence: [{ description: `observed in ${p.evidence_count} conversation(s)` }],
      editable: false
    })));

    // ---- recurring support patterns (evidence-pinned heuristics) ----
    const patterns = (this.db
      .prepare(`SELECT f.kind, COUNT(*) AS n, MAX(f.computed_at) AS last_at,
                   (SELECT GROUP_CONCAT(c.number) FROM friction_findings f2
                      JOIN conversations c ON c.id = f2.conversation_id
                     WHERE f2.customer_local_id = f.customer_local_id AND f2.kind = f.kind LIMIT 5) AS sample_numbers
                FROM friction_findings f
                WHERE f.customer_local_id = ? AND julianday(f.computed_at) >= julianday('now', '-90 days')
                GROUP BY f.kind HAVING n >= 2 ORDER BY n DESC LIMIT 10`)
      .all(customerId) as { kind: string; n: number; last_at: string; sample_numbers: string | null }[]);
    push('recurring_patterns', patterns.map((p) => ({
      section: 'recurring_patterns' as const,
      title: p.kind.replaceAll('_', ' '),
      value: `${p.n} conversation(s) in the last 90 days`,
      source: 'deterministic_local' as const,
      origin: 'friction heuristics',
      first_seen_at: p.last_at,
      last_seen_at: p.last_at,
      confidence: 'low' as const,
      freshness: freshnessFrom(p.last_at),
      evidence: (p.sample_numbers ?? '').split(',').filter(Boolean).slice(0, 5).map((n) => ({ description: 'conversation with this pattern', conversation_number: Number(n) })),
      editable: false
    })));

    // ---- support outcomes (aggregate, deterministic) ----
    const outcomes = (this.db
      .prepare(`SELECT COUNT(*) AS total,
                   SUM(CASE WHEN resolved_after_first_response = 1 THEN 1 ELSE 0 END) AS first_response_resolved,
                   SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) AS escalated,
                   AVG(effort_score) AS avg_effort,
                   SUM(CASE WHEN friction = 'high' THEN 1 ELSE 0 END) AS high_friction
                FROM client_support_outcomes o
                  JOIN conversations c ON c.id = o.conversation_id
                WHERE o.customer_id = ? AND c.deleted_at IS NULL`)
      .get(customerId) as { total: number; first_response_resolved: number | null; escalated: number | null; avg_effort: number | null; high_friction: number | null });
    const outcomeEntries: MemoryEntry[] = [];
    if (outcomes.total > 0) {
      outcomeEntries.push({
        section: 'support_outcomes',
        title: `${outcomes.total} analyzed conversation(s)`,
        value: [
          outcomes.first_response_resolved != null ? `${outcomes.first_response_resolved} resolved after first response` : null,
          outcomes.escalated != null ? `${outcomes.escalated} escalated` : null,
          outcomes.avg_effort != null ? `average effort ${outcomes.avg_effort.toFixed(1)}/10` : null,
          outcomes.high_friction != null ? `${outcomes.high_friction} with high friction` : null
        ].filter(Boolean).join(', '),
        source: 'deterministic_local',
        origin: 'client_support_outcomes',
        first_seen_at: null,
        last_seen_at: null,
        confidence: 'medium',
        freshness: 'unknown',
        evidence: [],
        editable: false
      });
    }
    push('support_outcomes', outcomeEntries);

    // ---- campaign history ----
    const campaigns = (this.db
      .prepare(`SELECT oc.name, oc.status, ore.state, ore.sent_at, ore.replied_at, ore.hs_conversation_number
                FROM outreach_recipients ore JOIN outreach_campaigns oc ON oc.id = ore.campaign_id
                WHERE ore.customer_local_id = ? ORDER BY COALESCE(ore.sent_at, oc.created_at) DESC LIMIT 20`)
      .all(customerId) as { name: string; status: string; state: string; sent_at: string | null; replied_at: string | null; hs_conversation_number: number | null }[]);
    push('campaign_history', campaigns.map((c) => ({
      section: 'campaign_history' as const,
      title: c.name,
      value: `${c.state}${c.replied_at ? ' - replied' : ''}${c.hs_conversation_number ? ` (conversation #${c.hs_conversation_number})` : ''}`,
      source: 'helpscout_mirror' as const,
      origin: 'outreach',
      first_seen_at: c.sent_at,
      last_seen_at: c.replied_at ?? c.sent_at,
      confidence: 'high' as const,
      freshness: freshnessFrom(c.replied_at ?? c.sent_at),
      evidence: c.hs_conversation_number != null ? [{ description: 'campaign-generated conversation', conversation_number: c.hs_conversation_number }] : [],
      editable: false
    })));

    // ---- product & account facts ----
    const accountEntries: MemoryEntry[] = [];
    if (customer.organization_name != null) {
      accountEntries.push({
        section: 'account_facts', title: `Organization: ${customer.organization_name}`,
        value: customer.organization_domains ?? null,
        source: 'helpscout_mirror', origin: 'organization membership',
        first_seen_at: null, last_seen_at: null, confidence: 'high', freshness: 'unknown', evidence: [], editable: false
      });
    }
    const emailCount = (this.db.prepare('SELECT COUNT(*) AS n FROM customer_emails WHERE customer_id = ?').get(customerId) as { n: number }).n;
    if (emailCount > 0) {
      accountEntries.push({
        section: 'account_facts', title: `${emailCount} known email address(es)`,
        value: null, source: 'helpscout_mirror', origin: 'customer emails',
        first_seen_at: null, last_seen_at: null, confidence: 'high', freshness: 'unknown', evidence: [], editable: false
      });
    }
    if (customer.background != null && customer.background.trim() !== '') {
      accountEntries.push({
        section: 'account_facts', title: 'Background (Help Scout property)',
        value: customer.background, source: 'helpscout_mirror', origin: 'customers.background',
        first_seen_at: null, last_seen_at: null, confidence: 'high', freshness: 'unknown', evidence: [], editable: false
      });
    }
    if (customer.location != null && customer.location.trim() !== '') {
      accountEntries.push({
        section: 'account_facts', title: 'Location (Help Scout property)',
        value: customer.location, source: 'helpscout_mirror', origin: 'customers.location',
        first_seen_at: null, last_seen_at: null, confidence: 'high', freshness: 'unknown', evidence: [], editable: false
      });
    }
    if (customer.remote_created_at != null) {
      accountEntries.push({
        section: 'account_facts', title: 'Customer since',
        value: customer.remote_created_at, source: 'helpscout_mirror', origin: 'customers.remote_created_at',
        first_seen_at: customer.remote_created_at, last_seen_at: null, confidence: 'high', freshness: 'unknown', evidence: [], editable: false
      });
    }
    const products = (this.db
      .prepare(`SELECT DISTINCT p.name FROM products p
                  WHERE p.name COLLATE NOCASE IN (
                    SELECT TRIM(product) FROM known_issues WHERE id IN (
                      SELECT kic.known_issue_id FROM known_issue_conversations kic
                        JOIN conversations c ON c.id = kic.conversation_id WHERE c.customer_local_id = ?))
                     OR p.name COLLATE NOCASE IN (
                    SELECT TRIM(i.product) FROM incidents i WHERE i.id IN (
                      SELECT ic.incident_id FROM incident_conversations ic
                        JOIN conversations c ON c.id = ic.conversation_id WHERE c.customer_local_id = ?))
                  LIMIT 10`)
      .all(customerId, customerId) as { name: string }[]);
    for (const p of products) {
      accountEntries.push({
        section: 'account_facts', title: `Product in support history: ${p.name}`,
        value: null, source: 'deterministic_local', origin: 'linked issues/incidents',
        first_seen_at: null, last_seen_at: null, confidence: 'medium', freshness: 'unknown',
        evidence: [{ description: 'derived from their linked known issues / incidents' }], editable: false
      });
    }
    push('account_facts', accountEntries);

    // ---- persisted memory rows (human + AI), with the red-line quarantine ----
    const rows = (this.db
      .prepare(`SELECT id, key, value, source, origin, conversation_id, first_seen_at, last_seen_at, confidence, provenance, kind
                FROM customer_memories WHERE customer_id = ? ORDER BY COALESCE(last_seen_at, first_seen_at) DESC LIMIT 200`)
      .all(customerId) as { id: number; key: string; value: string | null; source: string; origin: string | null; conversation_id: number | null; first_seen_at: string | null; last_seen_at: string | null; confidence: string | null; provenance: string; kind: string }[]);
    const quarantined: MemoryQuarantinedEntry[] = [];
    const humanEntries: MemoryEntry[] = [];
    const aiEntries: MemoryEntry[] = [];
    for (const row of rows) {
      const evidence: MemoryEvidence[] = [];
      if (row.conversation_id != null) {
        const conv = this.db.prepare('SELECT id, number FROM conversations WHERE id = ?').get(row.conversation_id) as { id: number; number: number } | undefined;
        if (conv) evidence.push({ description: 'observed in conversation', conversation_id: conv.id, conversation_number: conv.number });
      }
      const entry: MemoryEntry = {
        section: row.source === 'human' ? 'human_entries' : 'ai_entries',
        title: row.key,
        value: row.value,
        source: row.source === 'human' ? 'human_local' : 'ai_derived',
        origin: row.origin ?? row.provenance,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
        confidence: (row.confidence === 'high' || row.confidence === 'medium' || row.confidence === 'low' ? row.confidence : 'unknown'),
        freshness: freshnessFrom(row.last_seen_at ?? row.first_seen_at),
        evidence,
        entry_id: row.id,
        kind: (MEMORY_ENTRY_KINDS.includes(row.kind as MemoryEntryKind) ? row.kind : 'fact') as MemoryEntryKind,
        editable: row.source === 'human'
      };
      if (isQuarantined(row.key, row.value)) {
        quarantined.push({ entry_id: row.id, key: row.key, reason: 'matches the psychological/personality pattern list (SupportOS policy: such judgments are never usable memory)', last_seen_at: row.last_seen_at ?? row.first_seen_at });
        continue;
      }
      if (row.source === 'human') humanEntries.push(entry);
      else aiEntries.push(entry);
    }
    push('human_entries', humanEntries);
    push('ai_entries', aiEntries);

    // Compose every declared section (even when empty) so the profile shape
    // is stable and honest about absences.
    const ordered: CustomerMemoryProfile['sections'] = MEMORY_SECTIONS
      .map((s) => sections.find((x) => x.section === s))
      .filter((s): s is CustomerMemoryProfile['sections'][number] => s != null);

    return {
      customer_local_id: customerId,
      customer: { first_name: customer.first_name, last_name: customer.last_name, organization_name: customer.organization_name },
      generated_at: new Date().toISOString(),
      sections: ordered,
      quarantined,
      notes: [
        'Composed live from the local mirror - memory can never drift from its sources. Human-written entries are the only persisted rows.',
        'Every entry carries source, timestamps, confidence, freshness and evidence where available; "unknown" means no observation, never a guess.',
        'Recurring patterns are evidence-pinned heuristics - patterns, not judgments about a person.',
        quarantined.length > 0
          ? `${quarantined.length} stored entr${quarantined.length === 1 ? 'y' : 'ies'} matched the psychological/personality quarantine list and is excluded from usable memory (deletable below).`
          : 'No stored memory matched the psychological/personality quarantine list.'
      ]
    };
  }

  /**
   * Upsert a HUMAN memory entry. Refuses red-line keys/values outright
   * (plan Phase 36: psychological/personality judgments are never stored).
   */
  upsertHumanEntry(customerId: number, input: {
    key: string;
    value: string | null;
    kind: MemoryEntryKind;
    conversation_id: number | null;
  }): { ok: true; entry_id: number } | { ok: false; code: 'customer_not_found' | 'conversation_not_found' | 'quarantine' } {
    const customer = this.db.prepare('SELECT 1 AS x FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId);
    if (!customer) return { ok: false, code: 'customer_not_found' };
    if (input.conversation_id != null) {
      const conv = this.db.prepare('SELECT 1 AS x FROM conversations WHERE id = ? AND deleted_at IS NULL').get(input.conversation_id);
      if (!conv) return { ok: false, code: 'conversation_not_found' };
    }
    if (isQuarantined(input.key, input.value)) {
      return { ok: false, code: 'quarantine' };
    }
    const info = this.db
      .prepare(`INSERT INTO customer_memories (customer_id, key, value, source, origin, conversation_id, first_seen_at, last_seen_at, confidence, provenance, kind)
                VALUES (?, ?, ?, 'human', 'manual', ?, datetime('now'), datetime('now'), 'high', 'human_local', ?)
                ON CONFLICT (customer_id, key) DO UPDATE SET
                  value = excluded.value,
                  source = 'human',
                  origin = 'manual',
                  conversation_id = excluded.conversation_id,
                  last_seen_at = datetime('now'),
                  confidence = 'high',
                  provenance = 'human_local',
                  kind = excluded.kind`)
      .run(customerId, input.key, input.value, input.conversation_id, input.kind);
    return { ok: true, entry_id: Number(info.lastInsertRowid) };
  }

  /**
   * Delete a memory row. Human rows are always deletable; AI rows are
   * immutable through this path EXCEPT quarantined ones (red-line entries
   * can always be purged by a human).
   */
  deleteEntry(customerId: number, memoryId: number): { ok: true } | { ok: false; code: 'not_found' | 'ai_immutable' } {
    const row = this.db
      .prepare('SELECT id, source, key, value FROM customer_memories WHERE id = ? AND customer_id = ?')
      .get(memoryId, customerId) as { id: number; source: string; key: string; value: string | null } | undefined;
    if (!row) return { ok: false, code: 'not_found' };
    if (row.source !== 'human' && !isQuarantined(row.key, row.value)) {
      return { ok: false, code: 'ai_immutable' };
    }
    this.db.prepare('DELETE FROM customer_memories WHERE id = ? AND customer_id = ?').run(memoryId, customerId);
    return { ok: true };
  }
}

export { MEMORY_ENTRY_KINDS, MEMORY_SECTION_LABELS };
