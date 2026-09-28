import type { DB } from '../database/connection.js';
import type { ParsedMention } from '../../shared/collaboration.js';

/**
 * Mention parser (v1.8.0, plan Phase 13).
 *
 * Resolves @tokens in plain-text bodies against the identities Help Scout
 * itself knows about:
 * - users: their Help Scout mention name (users.mention, e.g. "alex"), plus
 *   deterministic fallbacks - first name, "first last", "first.last",
 *   "firstlast" - because synced users may lack a mention name.
 * - teams: exact team name (case-insensitive, spaces allowed after @).
 *
 * Honesty rules:
 * - UNKNOWN tokens stay plain text (no guessed identity, no notification).
 * - Matching is exact (case-insensitive); we do NOT do prefix/substring
 *   matching, so "@al" never silently notifies Alex.
 * - Emails are not mentionable (agents are addressed by name here).
 *
 * The regex accepts [A-Za-z0-9._-]+ tokens; a token boundary is the first
 * character that is not in that class. Team names may contain spaces, so a
 * second pass tries the longest following text against team names.
 */

const TOKEN_RE = /@([A-Za-z0-9._-]+)/g;

export interface MentionDirectory {
  /** Exact mentionable names (lowercased) -> user local id. */
  userByName: Map<string, number>;
  /** Lowercased team names -> team local id. */
  teamByName: Map<string, number>;
  /** Display names for users. */
  displayByUser: Map<number, string>;
}

export function buildMentionDirectory(db: DB): MentionDirectory {
  const userByName = new Map<string, number>();
  const displayByUser = new Map<number, string>();
  const users = db
    .prepare('SELECT id, first_name, last_name, mention, email FROM users WHERE deleted_at IS NULL')
    .all() as { id: number; first_name: string | null; last_name: string | null; mention: string | null; email: string | null }[];
  for (const u of users) {
    const display = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || `user #${u.id}`;
    displayByUser.set(u.id, display);
    const candidates = new Set<string>();
    if (u.mention) candidates.add(u.mention);
    if (u.first_name) candidates.add(u.first_name);
    const full = [u.first_name, u.last_name].filter(Boolean).join(' ');
    if (full) {
      candidates.add(full);
      candidates.add(full.replace(/\s+/g, ''));
      candidates.add(full.replace(/\s+/g, '.'));
    }
    for (const c of candidates) {
      const key = c.trim().toLowerCase();
      if (key.length > 0 && !userByName.has(key)) userByName.set(key, u.id);
    }
  }
  const teamByName = new Map<string, number>();
  const teams = db.prepare('SELECT id, name FROM teams WHERE deleted_at IS NULL').all() as { id: number; name: string }[];
  for (const t of teams) {
    const key = t.name.trim().toLowerCase();
    if (key.length > 0) teamByName.set(key, t.id);
  }
  return { userByName, teamByName, displayByUser };
}

/**
 * Parse @mentions in a body. Team mentions are resolved greedily: for every
 * @-position we first try to extend the match across spaces (team names may
 * contain spaces), then fall back to the single token.
 */
export function parseMentions(body: string, directory: MentionDirectory): ParsedMention[] {
  const mentions: ParsedMention[] = [];
  const seenUsers = new Set<number>();
  const seenTeams = new Set<number>();
  const teamMaxLen = Math.max(0, ...[...directory.teamByName.keys()].map((k) => k.length));
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(body)) !== null) {
    const at = m.index;
    const token = m[1] ?? '';
    const lower = token.toLowerCase();
    // 1) single-token user match (exact, case-insensitive)
    const userId = directory.userByName.get(lower);
    if (userId != null) {
      if (!seenUsers.has(userId)) {
        seenUsers.add(userId);
        mentions.push({ token, offset: at, user_local_id: userId, team_local_id: null, display: directory.displayByUser.get(userId) ?? token });
      }
      continue;
    }
    // 2) team match, possibly spanning spaces: take up to ~60 chars after '@'
    //    and try progressively shorter prefixes against known team names.
    if (directory.teamByName.size > 0) {
      const window = body.slice(at + 1, at + 1 + Math.min(60, Math.max(teamMaxLen, token.length)));
      let matched: { teamId: number; matchedLength: number; raw: string } | null = null;
      for (let len = Math.min(window.length, teamMaxLen + 12); len >= lower.length; len--) {
        const candidateRaw = window.slice(0, len);
        const candidate = candidateRaw.trim().toLowerCase().replace(/\s+/g, ' ');
        if (candidate.length === 0) continue;
        const teamId = directory.teamByName.get(candidate);
        if (teamId != null && !seenTeams.has(teamId)) {
          // require the consumed span to end at a word boundary
          const nextChar = window[len] ?? '';
          if (nextChar === '' || /[^A-Za-z0-9._-]/.test(nextChar)) {
            matched = { teamId, matchedLength: len, raw: candidateRaw };
            break;
          }
        }
      }
      if (matched) {
        seenTeams.add(matched.teamId);
        mentions.push({ token: matched.raw.trim(), offset: at, user_local_id: null, team_local_id: matched.teamId, display: matched.raw.trim() });
        TOKEN_RE.lastIndex = at + 1 + matched.matchedLength;
        continue;
      }
    }
    // 3) unknown token: stays plain text, no mention row, no notification
  }
  return mentions;
}

/** HTML-free highlighting segments for rendering a body with mentions. */
export function splitMentionSegments(body: string, mentions: ParsedMention[]): { text: string; mention: ParsedMention | null }[] {
  if (mentions.length === 0) return [{ text: body, mention: null }];
  const sorted = [...mentions].sort((a, b) => a.offset - b.offset);
  const segments: { text: string; mention: ParsedMention | null }[] = [];
  let cursor = 0;
  for (const men of sorted) {
    const start = men.offset;
    if (start < cursor) continue; // overlapping (should not happen) - skip
    if (start > cursor) segments.push({ text: body.slice(cursor, start), mention: null });
    const end = start + 1 + men.token.length;
    segments.push({ text: body.slice(start, end), mention: men });
    cursor = end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor), mention: null });
  return segments;
}
