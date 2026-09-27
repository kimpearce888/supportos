import type { ResponseState } from '../../shared/activity.js';

/**
 * Response-state engine (v1.7.0): a single deterministic SQL CASE expression
 * over conversations columns. The SAME expression is used by the Inbox list
 * filter, the saved-view engine and the detail API, so a badge in the list
 * can never disagree with the detail view. No LLM, no heuristics.
 *
 * Precedence (first match wins - part of the public contract, mirrored in
 * shared/activity.ts RESPONSE_STATE_LABELS docs):
 *   closed               status = 'closed'
 *   snoozed              active AND snoozed_until in the future
 *   needs_first_response active, customer wrote, first_response_at IS NULL
 *   customer_waiting     active, last customer reply newer than last agent reply
 *   agent_waiting        active/pending, last agent reply newer than last customer reply
 *   recently_responded   agent replied within 24h, not waiting
 *   never_responded      first_response_at IS NULL (no agent reply ever)
 *   unknown              history incomplete AND no customer message AND no response
 *
 * 'unknown' is the honest fallback for pre-sync conversations whose threads
 * were never mirrored (activity_history_complete = 0): we cannot claim
 * "never responded" without the thread history.
 */
export const RESPONSE_STATE_SQL = `CASE
  WHEN c.status = 'closed' THEN 'closed'
  WHEN c.status = 'spam' THEN 'closed'
  WHEN c.status = 'active' AND c.snoozed_until IS NOT NULL AND c.snoozed_until > datetime('now') THEN 'snoozed'
  WHEN c.status = 'active' AND c.first_customer_message_at IS NOT NULL AND c.first_response_at IS NULL THEN 'needs_first_response'
  WHEN c.status = 'active'
       AND c.last_customer_reply_at IS NOT NULL
       AND (c.last_human_agent_response_at IS NULL OR c.last_customer_reply_at > c.last_human_agent_response_at) THEN 'customer_waiting'
  WHEN c.status IN ('active', 'pending')
       AND c.last_human_agent_response_at IS NOT NULL
       AND (c.last_customer_reply_at IS NULL OR c.last_human_agent_response_at > c.last_customer_reply_at)
       AND (julianday('now') - julianday(c.last_human_agent_response_at)) * 1440 <= 1440 THEN 'recently_responded'
  WHEN c.status IN ('active', 'pending')
       AND c.last_human_agent_response_at IS NOT NULL
       AND (c.last_customer_reply_at IS NULL OR c.last_human_agent_response_at > c.last_customer_reply_at) THEN 'agent_waiting'
  WHEN c.activity_history_complete = 0
       AND c.first_customer_message_at IS NULL
       AND c.first_response_at IS NULL THEN 'unknown'
  ELSE 'never_responded'
END`;

/** Response-state for one row, typed (single-row convenience for detail routes). */
export function responseStateOf(row: { status: string; snoozed_until: string | null; first_customer_message_at: string | null; first_response_at: string | null; last_customer_reply_at: string | null; last_human_agent_response_at: string | null; activity_history_complete: number }): ResponseState {
  const now = Date.now();
  const minSince = (iso: string | null): number => (iso ? (now - Date.parse(iso)) / 60000 : Infinity);
  if (row.status === 'closed' || row.status === 'spam') return 'closed';
  if (row.status === 'active' && row.snoozed_until != null && Date.parse(row.snoozed_until) > now) return 'snoozed';
  if (row.status === 'active' && row.first_customer_message_at != null && row.first_response_at == null) return 'needs_first_response';
  if (row.status === 'active' && row.last_customer_reply_at != null && (row.last_human_agent_response_at == null || row.last_customer_reply_at > row.last_human_agent_response_at)) return 'customer_waiting';
  if (row.status !== 'closed' && row.status !== 'spam' && row.last_human_agent_response_at != null && (row.last_customer_reply_at == null || row.last_human_agent_response_at > row.last_customer_reply_at)) {
    return minSince(row.last_human_agent_response_at) <= 1440 ? 'recently_responded' : 'agent_waiting';
  }
  if (row.activity_history_complete === 0 && row.first_customer_message_at == null && row.first_response_at == null) return 'unknown';
  return 'never_responded';
}

/** Response-age values for one conversation row (all in minutes; null = unknown). */
export function responseAgesOf(row: {
  remote_created_at: string | null;
  first_response_at: string | null;
  last_customer_reply_at: string | null;
  last_human_agent_response_at: string | null;
  customer_waiting_since: string | null;
  closed_at: string | null;
}): Record<string, number | null> {
  const now = Date.now();
  const minSince = (iso: string | null): number | null => (iso && Number.isFinite(Date.parse(iso)) ? Math.max(0, (now - Date.parse(iso)) / 60000) : null);
  const minBetween = (a: string | null, b: string | null): number | null => (a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000) : null);
  return {
    time_since_customer_reply: minSince(row.last_customer_reply_at),
    time_since_agent_response: minSince(row.last_human_agent_response_at),
    customer_waiting_duration: minSince(row.customer_waiting_since),
    first_response_delay: minBetween(row.remote_created_at, row.first_response_at),
    resolution_duration: minBetween(row.remote_created_at, row.closed_at),
    conversation_age: minSince(row.remote_created_at)
  };
}
