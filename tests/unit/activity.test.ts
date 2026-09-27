import { describe, it, expect } from 'vitest';
import { resolveDateRange, resolveTimezone, isValidTimezone, formatAgeMinutes } from '../../src/server/services/dateRange.js';
import { responseStateOf, responseAgesOf } from '../../src/server/inbox/responseState.js';
import { viewDefinitionSchema, viewConditionSchema, RESPONSE_STATES, ACTIVITY_FIELDS, DATE_MODES } from '../../src/shared/activity.js';

/**
 * v1.7.0 unit tests: the date-range resolver across DST transitions, the
 * deterministic response-state classifier, age formatting and the view
 * definition schemas (the boundary that keeps user input out of SQL).
 */

const T0 = Date.UTC(2024, 2, 10, 12, 0, 0); // 2024-03-10T12:00Z - the US spring-forward day

describe('dateRange resolver: calendar modes across timezones', () => {
  it('resolves "today" in the user timezone (UTC vs New York differ by the local offset)', () => {
    const utc = resolveDateRange({ mode: 'today', timezone: 'UTC', now: T0 })!;
    expect(utc.from).toBe('2024-03-10T00:00:00.000Z');
    expect(utc.to).toBe('2024-03-11T00:00:00.000Z');
    expect(utc.kind).toBe('calendar');

    const ny = resolveDateRange({ mode: 'today', timezone: 'America/New_York', now: T0 })!;
    // Midnight NY on 2024-03-10 is 05:00Z (EST); midnight on 03-11 is 04:00Z (EDT - the boundary CROSSED the DST jump)
    expect(ny.from).toBe('2024-03-10T05:00:00.000Z');
    expect(ny.to).toBe('2024-03-11T04:00:00.000Z');
  });

  it('spring-forward day still covers exactly one local day (23 hours)', () => {
    const ny = resolveDateRange({ mode: 'today', timezone: 'America/New_York', now: T0 })!;
    const hours = (Date.parse(ny.to) - Date.parse(ny.from)) / 3600000;
    expect(hours).toBe(23); // 2024-03-10 in New York is a 23h day
  });

  it('fall-back day covers 25 local hours without double-counting', () => {
    const t1 = Date.UTC(2024, 10, 3, 12, 0, 0); // 2024-11-03 - US fall-back day
    const ny = resolveDateRange({ mode: 'today', timezone: 'America/New_York', now: t1 })!;
    const hours = (Date.parse(ny.to) - Date.parse(ny.from)) / 3600000;
    expect(hours).toBe(25);
    expect(ny.from).toBe('2024-11-03T04:00:00.000Z'); // EDT boundary
    expect(ny.to).toBe('2024-11-04T05:00:00.000Z'); // EST boundary (clock went back)
  });

  it('handles non-quarter-hour offsets (Kathmandu UTC+5:45)', () => {
    const ktm = resolveDateRange({ mode: 'today', timezone: 'Asia/Kathmandu', now: T0 })!;
    expect(ktm.from).toBe('2024-03-09T18:15:00.000Z');
    expect(ktm.to).toBe('2024-03-10T18:15:00.000Z');
  });

  it('handles 30-minute DST shifts (Lord Howe Island)', () => {
    const t = Date.UTC(2024, 3, 7, 12, 0, 0); // 2024-04-07 - Lord Howe DST ends 02:00->01:30
    const lhi = resolveDateRange({ mode: 'today', timezone: 'Australia/Lord_Howe', now: t })!;
    const hours = (Date.parse(lhi.to) - Date.parse(lhi.from)) / 3600000;
    // Day starts at 00:00 +11:00 (DST), ends at 00:00 next day +10:30 (standard)
    expect(lhi.from).toBe('2024-04-06T13:00:00.000Z');
    expect(lhi.to).toBe('2024-04-07T13:30:00.000Z');
    expect(hours).toBe(24.5);
  });

  it('resolves weeks starting Sunday (dayjs convention) consistently', () => {
    const t = Date.UTC(2024, 2, 13, 12, 0, 0); // Wednesday 2024-03-13
    const utc = resolveDateRange({ mode: 'this_week', timezone: 'UTC', now: t })!;
    expect(utc.from).toBe('2024-03-10T00:00:00.000Z'); // Sunday
    expect(utc.to).toBe('2024-03-17T00:00:00.000Z');
  });

  it('"yesterday" and "tomorrow" are exact adjacent local days', () => {
    const y = resolveDateRange({ mode: 'yesterday', timezone: 'UTC', now: T0 })!;
    expect(y.from).toBe('2024-03-09T00:00:00.000Z');
    const t = resolveDateRange({ mode: 'tomorrow', timezone: 'UTC', now: T0 })!;
    expect(t.from).toBe('2024-03-11T00:00:00.000Z');
  });

  it('rolling modes are exact now-minus windows, kind=rolling', () => {
    const r = resolveDateRange({ mode: 'last_24h', timezone: 'UTC', now: T0 })!;
    expect(r.from).toBe('2024-03-09T12:00:00.000Z');
    expect(r.to).toBe('2024-03-10T12:00:00.000Z');
    expect(r.kind).toBe('rolling');
    const d7 = resolveDateRange({ mode: 'last_7d', timezone: 'America/New_York', now: T0 })!;
    expect(Date.parse(d7.to) - Date.parse(d7.from)).toBe(7 * 24 * 3600000);
  });

  it('exact_date resolves the local calendar date in the given timezone', () => {
    const r = resolveDateRange({ mode: 'exact_date', timezone: 'America/New_York', from: '2024-07-04', now: T0 })!;
    expect(r.from).toBe('2024-07-04T04:00:00.000Z'); // EDT
    expect(r.to).toBe('2024-07-05T04:00:00.000Z');
  });

  it('rejects invalid dates: Feb 30, month 13, garbage', () => {
    expect(resolveDateRange({ mode: 'exact_date', timezone: 'UTC', from: '2024-02-30', now: T0 })).toBeNull();
    expect(resolveDateRange({ mode: 'exact_date', timezone: 'UTC', from: '2024-13-01', now: T0 })).toBeNull();
    expect(resolveDateRange({ mode: 'exact_date', timezone: 'UTC', from: 'not-a-date', now: T0 })).toBeNull();
    expect(resolveDateRange({ mode: 'custom_range', timezone: 'UTC', from: '2024-01-01', now: T0 })).toBeNull();
  });

  it('custom_range is inclusive of both endpoints and order-safe', () => {
    const r = resolveDateRange({ mode: 'custom_range', timezone: 'UTC', from: '2024-03-08', to: '2024-03-10', now: T0 })!;
    expect(r.from).toBe('2024-03-08T00:00:00.000Z');
    expect(r.to).toBe('2024-03-11T00:00:00.000Z'); // to-date + 1 day = exclusive end covering the full "to" day
    const flipped = resolveDateRange({ mode: 'custom_range', timezone: 'UTC', from: '2024-03-10', to: '2024-03-08', now: T0 })!;
    expect(flipped.from).toBe('2024-03-08T00:00:00.000Z');
  });

  it('time-of-day bounds apply inside the local day (DST-safe)', () => {
    const r = resolveDateRange({ mode: 'today', timezone: 'America/New_York', now: T0, fromTime: '09:00', toTime: '17:00' })!;
    // 09:00 on 2024-03-10 NY is AFTER the 02:00->03:00 jump: EDT (-4) -> 13:00Z
    expect(r.from).toBe('2024-03-10T13:00:00.000Z');
    // 17:00 the same day is also EDT -> 21:00Z
    expect(r.to).toBe('2024-03-10T21:00:00.000Z');
  });

  it('time-of-day before a DST jump uses the pre-jump offset', () => {
    // 01:30 on 2024-03-10 NY is BEFORE the 02:00->03:00 jump: EST (-5) -> 06:30Z
    const r = resolveDateRange({ mode: 'today', timezone: 'America/New_York', now: T0, fromTime: '01:30', toTime: '01:45' })!;
    expect(r.from).toBe('2024-03-10T06:30:00.000Z');
    expect(r.to).toBe('2024-03-10T06:45:00.000Z');
  });

  it('invalid timezone falls back to UTC, never throws', () => {
    const r = resolveDateRange({ mode: 'today', timezone: 'Not/AZone', now: T0 })!;
    expect(r.from).toBe('2024-03-10T00:00:00.000Z');
  });

  it('resolveTimezone prefers explicit, then stored, then system; rejects garbage', () => {
    expect(resolveTimezone('Europe/Berlin', null)).toBe('Europe/Berlin');
    expect(resolveTimezone(null, 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(resolveTimezone(null, 'system')).not.toBe('system');
    expect(resolveTimezone('garbage!', null)).not.toBe('garbage!');
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('response-state classifier (deterministic)', () => {
  const base = {
    status: 'active',
    snoozed_until: null as string | null,
    first_customer_message_at: '2024-03-01T10:00:00.000Z',
    first_response_at: null as string | null,
    last_customer_reply_at: null as string | null,
    last_human_agent_response_at: null as string | null,
    activity_history_complete: 1
  };

  it('customer wrote, nobody ever replied -> needs_first_response', () => {
    expect(responseStateOf(base)).toBe('needs_first_response');
  });

  it('customer follow-up after the agent reply -> customer_waiting', () => {
    expect(responseStateOf({ ...base, first_response_at: '2024-03-01T11:00:00.000Z', last_human_agent_response_at: '2024-03-05T11:00:00.000Z', last_customer_reply_at: '2024-03-06T09:00:00.000Z' })).toBe('customer_waiting');
  });

  it('agent replied after the last customer message -> recently_responded (within 24h) or agent_waiting', () => {
    const recent = { ...base, first_response_at: '2024-03-01T11:00:00.000Z', last_customer_reply_at: '2024-03-06T09:00:00.000Z', last_human_agent_response_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    expect(responseStateOf(recent)).toBe('recently_responded');
    const old = { ...recent, last_human_agent_response_at: new Date(Date.now() - 72 * 3600000).toISOString() };
    expect(responseStateOf(old)).toBe('agent_waiting');
  });

  it('closed beats everything; spam maps to closed', () => {
    expect(responseStateOf({ ...base, status: 'closed' })).toBe('closed');
    expect(responseStateOf({ ...base, status: 'spam' })).toBe('closed');
  });

  it('snoozed (active + future snooze) beats customer_waiting', () => {
    expect(responseStateOf({ ...base, snoozed_until: new Date(Date.now() + 3600000).toISOString() })).toBe('snoozed');
    expect(responseStateOf({ ...base, snoozed_until: new Date(Date.now() - 3600000).toISOString() })).toBe('needs_first_response'); // expired snooze is not snoozed
  });

  it('unknown: history incomplete and no messages known (honest fallback)', () => {
    expect(responseStateOf({ ...base, first_customer_message_at: null, activity_history_complete: 0 })).toBe('unknown');
  });

  it('never_responded: complete history, no customer message and no agent reply', () => {
    expect(responseStateOf({ ...base, first_customer_message_at: null, activity_history_complete: 1 })).toBe('never_responded');
  });

  it('ages: waiting, delays and durations in minutes (nulls are honest)', () => {
    const now = Date.now();
    const ages = responseAgesOf({
      remote_created_at: new Date(now - 3 * 24 * 3600000).toISOString(),
      first_response_at: new Date(now - 3 * 24 * 3600000 + 3600000).toISOString(),
      last_customer_reply_at: new Date(now - 7200000).toISOString(),
      last_human_agent_response_at: new Date(now - 26 * 3600000).toISOString(),
      customer_waiting_since: new Date(now - 7200000).toISOString(),
      closed_at: null
    });
    expect(ages.conversation_age).toBeGreaterThan(3 * 24 * 60 - 1);
    expect(ages.first_response_delay).toBeCloseTo(60, 0);
    expect(ages.customer_waiting_duration).toBeCloseTo(120, 0);
    expect(ages.time_since_agent_response).toBeCloseTo(26 * 60, 0);
    expect(ages.resolution_duration).toBeNull();
    expect(formatAgeMinutes(81)).toBe('1h 21m');
    expect(formatAgeMinutes(14)).toBe('14m');
    expect(formatAgeMinutes(30 * 24 * 60 + 6 * 60)).toBe('30d 6h');
    expect(formatAgeMinutes(null)).toBeNull();
    expect(formatAgeMinutes(-5)).toBeNull();
  });
});

describe('view definition schemas (route boundary)', () => {
  it('accepts a well-formed nested definition', () => {
    const def = {
      combinator: 'all',
      conditions: [
        { kind: 'status', statuses: ['active'] },
        { kind: 'group', combinator: 'any', children: [
          { kind: 'priority', priorities: ['urgent'] },
          { kind: 'response_state', states: ['customer_waiting'] }
        ] },
        { kind: 'date_activity', activityField: 'last_customer_reply_at', mode: 'today' }
      ]
    };
    expect(viewDefinitionSchema.safeParse(def).success).toBe(true);
  });

  it('rejects unknown condition kinds, bad operators, bad modes', () => {
    expect(viewConditionSchema.safeParse({ kind: 'drop_table', statuses: [] }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'status', statuses: [] }).success).toBe(false); // empty array
    expect(viewConditionSchema.safeParse({ kind: 'status', statuses: ['active'] }).success).toBe(true);
    expect(viewConditionSchema.safeParse({ kind: 'date_activity', activityField: 'nope', mode: 'today' }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'date_activity', activityField: 'created_at', mode: 'whenever' }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'response_age', metric: 'vibes', op: 'gt', minutes: 5 }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'priority', priorities: ['SUPER'] }).success).toBe(false);
    // SQL-injection-shaped values must never change the KIND of the condition
    expect(viewConditionSchema.safeParse({ kind: "status'; DROP TABLE conversations;--", statuses: ['active'] }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'response_state', states: ["customer_waiting' OR '1'='1"] }).success).toBe(false);
  });

  it('rejects oversized width (children > 25) and empty groups', () => {
    const wide = { kind: 'group', combinator: 'any', children: Array.from({ length: 30 }, () => ({ kind: 'status', statuses: ['active'] })) };
    expect(viewDefinitionSchema.safeParse({ combinator: 'all', conditions: [wide] }).success).toBe(false);
    expect(viewDefinitionSchema.safeParse({ combinator: 'all', conditions: [{ kind: 'group', combinator: 'all', children: [] }] }).success).toBe(false);
    // Depth is capped by the ENGINE at evaluation time (ViewCompileError) - verified in integration tests.
  });

  it('time-of-day must be strict HH:mm', () => {
    expect(viewConditionSchema.safeParse({ kind: 'date_activity', activityField: 'created_at', mode: 'exact_date', from: '2024-01-01', fromTime: '9:00' }).success).toBe(false);
    expect(viewConditionSchema.safeParse({ kind: 'date_activity', activityField: 'created_at', mode: 'exact_date', from: '2024-01-01', fromTime: '09:00' }).success).toBe(true);
  });

  it('the closed enums cover the plan Phase 3/4/6 surface', () => {
    expect(ACTIVITY_FIELDS).toContain('customer_waiting_since');
    expect(ACTIVITY_FIELDS).toContain('last_custom_field_change_at');
    expect(DATE_MODES).toContain('last_90d');
    expect(DATE_MODES).toContain('tomorrow');
    expect(RESPONSE_STATES).toContain('needs_first_response');
    expect(RESPONSE_STATES).toContain('unknown');
  });
});
