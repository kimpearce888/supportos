import { RESPONSE_STATE_SQL } from '../inbox/responseState.js';
import type { OperationsTileKey } from '../../shared/collaboration.js';

/**
 * Tile fragments (v1.8.0, plan Phase 10): ONE source of truth for every
 * conversation-scoped Operations Center tile.
 *
 * The SAME parameterized fragment is used by:
 * - operationsCenter.ts for the tile COUNT, and
 * - GET /api/conversations?ops=<tileKey> for the drill-down list,
 *
 * so a tile number can never disagree with the inbox list it links to (the
 * v1.7.0 lesson: the badge must be computed by the same expression as the
 * filter). All user input is whitelisted to the closed tile-key union; the
 * SQL identifiers here are literals, values are bound parameters.
 */

export interface TileFragment {
  whereSql: string;
  params: unknown[];
}

export const OPS_TILE_WHITELIST = [
  'unassigned',
  'needs_first_response',
  'customer_waiting',
  'waiting_over_threshold',
  'urgent',
  'high_effort',
  'repeated_issue',
  'known_issue',
  'ai_escalation'
] as const;
export type ConversationOpsTileKey = (typeof OPS_TILE_WHITELIST)[number];

/** Conversations this account has closed as spam are never operational. */
const NOT_DELETED = "c.deleted_at IS NULL AND c.merged_into_conversation_id IS NULL";

/**
 * Build the fragment for a tile key. `waitingThresholdMinutes` only affects
 * waiting_over_threshold (configurable, default 240).
 */
export function tileFragment(key: ConversationOpsTileKey, waitingThresholdMinutes = 240): TileFragment {
  switch (key) {
    case 'unassigned':
      return { whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND c.assignee_local_id IS NULL`, params: [] };
    case 'needs_first_response':
      return { whereSql: `${NOT_DELETED} AND (${RESPONSE_STATE_SQL}) = 'needs_first_response'`, params: [] };
    case 'customer_waiting':
      return { whereSql: `${NOT_DELETED} AND (${RESPONSE_STATE_SQL}) = 'customer_waiting'`, params: [] };
    case 'waiting_over_threshold':
      // business-minutes honesty note: the threshold here is WALL minutes
      // (customer_waiting_since is a wall timestamp); the tile says so.
      return {
        whereSql: `${NOT_DELETED} AND (${RESPONSE_STATE_SQL}) = 'customer_waiting' AND c.customer_waiting_since IS NOT NULL AND (julianday('now') - julianday(c.customer_waiting_since)) * 1440 >= ?`,
        params: [Math.max(1, Math.trunc(waitingThresholdMinutes))]
      };
    case 'urgent':
      return { whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND c.supportos_priority IN ('high','urgent')`, params: [] };
    case 'high_effort':
      // Honest heuristic (labeled in the UI): strong frustration signal OR
      // the customer had to write >= 5 messages in this conversation.
      return {
        whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND EXISTS (
          SELECT 1 FROM client_current_signals s
          WHERE s.conversation_id = c.id
            AND (
              EXISTS (SELECT 1 FROM json_each(s.signals_json) je
                      WHERE json_extract(je.value, '$.dimension') = 'frustration'
                        AND json_extract(je.value, '$.value') = 'strong')
              OR CAST(json_extract(s.message_stats_json, '$.customer_messages') AS INTEGER) >= 5
            )
        )`,
        params: []
      };
    case 'repeated_issue':
      // Same customer has >= 2 conversations linked to the SAME known issue.
      return {
        whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND EXISTS (
          SELECT 1 FROM known_issue_conversations kic
          WHERE kic.conversation_id = c.id
            AND (SELECT COUNT(*) FROM known_issue_conversations kic2
                 JOIN conversations c2 ON c2.id = kic2.conversation_id
                 WHERE kic2.known_issue_id = kic.known_issue_id
                   AND c2.customer_local_id = c.customer_local_id
                   AND c2.deleted_at IS NULL) >= 2
        )`,
        params: []
      };
    case 'known_issue':
      // Open conversation linked to an UNRESOLVED known issue.
      return {
        whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND EXISTS (
          SELECT 1 FROM known_issue_conversations kic
          JOIN known_issues ki ON ki.id = kic.known_issue_id
          WHERE kic.conversation_id = c.id AND ki.status != 'resolved'
        )`,
        params: []
      };
    case 'ai_escalation':
      // Latest completed ticket analysis flags urgency high/critical or
      // frustrated sentiment, with medium/high confidence, ticket still open.
      return {
        whereSql: `${NOT_DELETED} AND c.status IN ('active','pending') AND EXISTS (
          SELECT 1 FROM ai_runs a
          WHERE a.conversation_id = c.id AND a.type = 'ticket_analysis' AND a.status = 'completed'
            AND a.id = (SELECT MAX(a2.id) FROM ai_runs a2
                        WHERE a2.conversation_id = c.id AND a2.type = 'ticket_analysis' AND a2.status = 'completed')
            AND (json_extract(a.output, '$.urgency') IN ('high','critical')
                 OR json_extract(a.output, '$.sentiment') = 'frustrated')
            AND json_extract(a.output, '$.confidence') IN ('medium','high')
        )`,
        params: []
      };
  }
}

export function isConversationOpsTile(key: string): key is ConversationOpsTileKey {
  return (OPS_TILE_WHITELIST as readonly string[]).includes(key);
}

export function tileKeyOf(key: string): OperationsTileKey | null {
  const all: readonly OperationsTileKey[] = [
    ...OPS_TILE_WHITELIST,
    'sla_at_risk',
    'sla_breached',
    'issue_spike',
    'automation_approvals',
    'failed_jobs',
    'sync_problems',
    'campaign_activity'
  ];
  return all.includes(key as OperationsTileKey) ? (key as OperationsTileKey) : null;
}
