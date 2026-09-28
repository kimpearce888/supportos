import { describe, it, expect } from 'vitest';
import { parseMentions, splitMentionSegments, type MentionDirectory } from '../../src/server/collaboration/mentionParser.js';
import { tileFragment, isConversationOpsTile, OPS_TILE_WHITELIST } from '../../src/server/operations/tileFragments.js';

/**
 * v1.8.0 unit tests: the mention parser (pure functions - no database) and
 * the Operations Center tile fragment whitelist.
 *
 * Honesty rules under test:
 * - exact, case-insensitive identity matching only - never prefix/substring
 * - unknown @tokens stay plain text
 * - team names may span spaces, but only with a word boundary after
 * - duplicate mentions of the same identity collapse to one
 */
function directory(): MentionDirectory {
  const userByName = new Map<string, number>([
    ['alex', 1],
    ['priya', 3],
    ['grace', 7],
    ['grace hopper', 7],
    ['gracehopper', 7],
    ['grace.hopper', 7]
  ]);
  const teamByName = new Map<string, number>([
    ['tier 1', 501],
    ['escalations', 502]
  ]);
  const displayByUser = new Map<number, string>([[1, 'Alex Rivera'], [3, 'Priya Nair'], [7, 'Grace Hopper']]);
  return { userByName, teamByName, displayByUser };
}

describe('parseMentions', () => {
  it('matches users by exact mention name (case-insensitive)', () => {
    const m = parseMentions('hey @Alex can you look?', directory());
    expect(m).toHaveLength(1);
    expect(m[0]!.user_local_id).toBe(1);
    expect(m[0]!.team_local_id).toBeNull();
    expect(m[0]!.offset).toBe(4);
    expect(m[0]!.token).toBe('Alex');
  });

  it('matches full-name and punctuation variants', () => {
    for (const token of ['grace', 'Grace Hopper', 'gracehopper', 'grace.hopper']) {
      const m = parseMentions(`ping @${token} please`, directory());
      expect(m, `token ${token}`).toHaveLength(1);
      expect(m[0]!.user_local_id).toBe(7);
    }
  });

  it('never prefix-matches: "@al" must NOT notify Alex', () => {
    const m = parseMentions('@al and @alexx and @pri', directory());
    expect(m).toHaveLength(0);
  });

  it('unknown tokens stay plain text (no guessed identity)', () => {
    const m = parseMentions('@nobody-here @42 @Zoë', directory());
    expect(m).toHaveLength(0);
  });

  it('collapses duplicate mentions of the same user', () => {
    const m = parseMentions('@alex then @Alex then @ALEX', directory());
    expect(m).toHaveLength(1);
  });

  it('matches team names containing spaces, with word boundaries', () => {
    const m = parseMentions('routing to @Tier 1 now', directory());
    expect(m).toHaveLength(1);
    expect(m[0]!.team_local_id).toBe(501);
    expect(m[0]!.user_local_id).toBeNull();
    expect(m[0]!.token.toLowerCase()).toBe('tier 1');
  });

  it('does not eat the word after a team name', () => {
    const m = parseMentions('ask @Tier 1members later', directory());
    // "Tier 1members" is not a team; no team mention resolves
    expect(m.filter((x) => x.team_local_id != null)).toHaveLength(0);
  });

  it('single-token team (no spaces) matches too', () => {
    const m = parseMentions('cc @Escalations on this', directory());
    expect(m).toHaveLength(1);
    expect(m[0]!.team_local_id).toBe(502);
  });

  it('team mention at end of string resolves', () => {
    const m = parseMentions('please loop in @Tier 1', directory());
    expect(m).toHaveLength(1);
    expect(m[0]!.team_local_id).toBe(501);
  });

  it('users take priority over teams for the same single token', () => {
    const dir = directory();
    dir.teamByName.set('alex', 999);
    const m = parseMentions('hi @alex', dir);
    expect(m[0]!.user_local_id).toBe(1);
  });

  it('multiple distinct mentions all resolve', () => {
    const m = parseMentions('@alex and @priya and @Tier 1', directory());
    expect(m).toHaveLength(3);
    expect(m.map((x) => x.user_local_id ?? x.team_local_id).sort((a, b) => a - b)).toEqual([1, 3, 501]);
  });

  it('emails are not mentionable tokens', () => {
    const m = parseMentions('write to alex@zylker.io please', directory());
    expect(m).toHaveLength(0);
  });
});

describe('splitMentionSegments', () => {
  it('splits a body into text and mention segments', () => {
    const dir = directory();
    const body = 'hey @alex look at @Tier 1 please';
    const mentions = parseMentions(body, dir);
    const segments = splitMentionSegments(body, mentions);
    expect(segments.filter((s) => s.mention != null)).toHaveLength(2);
    expect(segments.filter((s) => s.mention == null).map((s) => s.text).join('|')).toBe('hey | look at | please');
    expect(segments.find((s) => s.mention != null)!.text).toBe('@alex');
  });

  it('returns the whole body when no mentions', () => {
    const segments = splitMentionSegments('plain text', []);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.mention).toBeNull();
  });
});

describe('buildMentionDirectory shape', () => {
  it('is safe on empty maps', () => {
    const m = parseMentions('@anyone', { userByName: new Map(), teamByName: new Map(), displayByUser: new Map() });
    expect(m).toHaveLength(0);
  });
});

describe('tile fragments whitelist', () => {
  it('accepts exactly the 9 conversation-scoped tile keys', () => {
    expect([...OPS_TILE_WHITELIST].sort()).toEqual(
      ['ai_escalation', 'customer_waiting', 'high_effort', 'known_issue', 'needs_first_response', 'repeated_issue', 'unassigned', 'urgent', 'waiting_over_threshold'].sort()
    );
    for (const key of OPS_TILE_WHITELIST) {
      expect(isConversationOpsTile(key)).toBe(true);
    }
    expect(isConversationOpsTile('sla_at_risk')).toBe(false);
    expect(isConversationOpsTile('sync_problems')).toBe(false);
    expect(isConversationOpsTile('bogus')).toBe(false);
    expect(isConversationOpsTile('1=1')).toBe(false);
  });

  it('waiting_over_threshold binds the threshold as a parameter', () => {
    const frag = tileFragment('waiting_over_threshold', 240);
    expect(frag.params).toEqual([240]);
    expect(frag.whereSql).not.toContain('240');
    // every other fragment is parameter-free
    for (const key of OPS_TILE_WHITELIST.filter((k) => k !== 'waiting_over_threshold')) {
      expect(tileFragment(key).params).toEqual([]);
    }
  });

  it('clamps nothing at the fragment layer (route/service clamp upstream)', () => {
    const frag = tileFragment('waiting_over_threshold', 1);
    expect(frag.params).toEqual([1]);
  });
});
