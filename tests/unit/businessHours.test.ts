import { describe, it, expect } from 'vitest';
import { businessMinutesBetween, wallMinutesBetween, slaStatus, isValidTimezone, businessMinutesSince } from '../../src/server/analytics/businessHours.js';

/**
 * v1.4.0 SLA engine: pure business-hours math. Every case pins behavior the
 * SLA report depends on: weekend/night exclusion, DST transitions, half-hour
 * zones, and the honest null fallbacks.
 */
const WEEKDAYS_9_17 = { timezone: 'UTC', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 };

// 2026 calendar anchors (all UTC unless stated):
// Mar 6 2026 = Friday, Mar 7 = Saturday, Mar 8 = Sunday (US DST starts),
// Mar 9 = Monday.

describe('businessMinutesBetween (spec: honest business-minute math)', () => {
  it('counts minutes inside the window on the same day', () => {
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-06T15:00:00Z', WEEKDAYS_9_17)).toBe(180);
  });

  it('excludes time before the window opens', () => {
    // Fri 07:00 -> 09:30 crosses the open: only 09:00-09:30 counts
    expect(businessMinutesBetween('2026-03-06T07:00:00Z', '2026-03-06T09:30:00Z', WEEKDAYS_9_17)).toBe(30);
  });

  it('excludes time after the window closes', () => {
    // Fri 16:50 -> 18:00: only 16:50-17:00 counts
    expect(businessMinutesBetween('2026-03-06T16:50:00Z', '2026-03-06T18:00:00Z', WEEKDAYS_9_17)).toBe(10);
  });

  it('a weekend + night contributes zero: Friday 17:05 -> Monday 09:05 = 5 minutes', () => {
    expect(businessMinutesBetween('2026-03-06T17:05:00Z', '2026-03-09T09:05:00Z', WEEKDAYS_9_17)).toBe(5);
  });

  it('sums a multi-day span (Friday noon -> Tuesday noon)', () => {
    // Fri 12:00-17:00 = 300; Mon 9-17 = 480; Tue 9-12 = 180 -> 960
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-10T12:00:00Z', WEEKDAYS_9_17)).toBe(960);
  });

  it('skips configured-off weekdays entirely', () => {
    const monOnly = { ...WEEKDAYS_9_17, days: [1] };
    // Fri 12:00 -> Tue 12:00 -> only Monday 9-17 counts = 480
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-10T12:00:00Z', monOnly)).toBe(480);
  });

  it('measures the wall clock alongside (for honesty in the report)', () => {
    expect(wallMinutesBetween('2026-03-06T12:00:00Z', '2026-03-10T12:00:00Z')).toBe(4 * 24 * 60);
  });

  it('handles a DST transition (America/New_York, spring forward 2026-03-08)', () => {
    // Fri Mar 6 16:00 EST (UTC-5) -> Mon Mar 9 10:00 EDT (UTC-4)
    // Business minutes: Fri 16:00-17:00 (60) + Mon 09:00-10:00 (60) = 120
    const ny = { timezone: 'America/New_York', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 };
    expect(businessMinutesBetween('2026-03-06T21:00:00Z', '2026-03-09T14:00:00Z', ny)).toBe(120);
  });

  it('handles half-hour offset zones (Asia/Kolkata, UTC+5:30)', () => {
    // Kolkata window 09:00-17:00 IST = 03:30-11:30 UTC
    const kolkata = { timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 };
    // Mon Mar 9 05:00 UTC = 10:30 IST -> 06:30 UTC = 12:00 IST = 90 minutes
    expect(businessMinutesBetween('2026-03-09T05:00:00Z', '2026-03-09T06:30:00Z', kolkata)).toBe(90);
  });

  it('returns null for invalid input instead of lying (honest fallback)', () => {
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-06T15:00:00Z', { ...WEEKDAYS_9_17, timezone: 'Not/AZone' })).toBeNull();
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-06T15:00:00Z', { ...WEEKDAYS_9_17, days: [] })).toBeNull();
    expect(businessMinutesBetween('2026-03-06T12:00:00Z', '2026-03-06T15:00:00Z', { ...WEEKDAYS_9_17, endMinute: 540 })).toBeNull();
    expect(businessMinutesBetween('nope', '2026-03-06T15:00:00Z', WEEKDAYS_9_17)).toBeNull();
    expect(businessMinutesBetween('2026-03-06T15:00:00Z', '2026-03-06T12:00:00Z', WEEKDAYS_9_17)).toBeNull();
  });

  it('caps absurdly long spans with null (bounded computation)', () => {
    const start = new Date('2020-01-01T00:00:00Z').toISOString();
    const end = new Date('2030-01-01T00:00:00Z').toISOString();
    expect(businessMinutesBetween(start, end, WEEKDAYS_9_17)).toBeNull();
  });

  it('validates timezones without throwing', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('businessMinutesSince measures aging up to now', () => {
    const anHourAgo = new Date(Date.now() - 3600_000).toISOString();
    expect(businessMinutesSince(anHourAgo, WEEKDAYS_9_17)).toBeGreaterThanOrEqual(0);
  });
});

describe('slaStatus', () => {
  it('classifies against the target', () => {
    expect(slaStatus(10, 60)).toBe('met');
    expect(slaStatus(60, 60)).toBe('met');
    expect(slaStatus(61, 60)).toBe('missed');
  });

  it('reports no_target when no target is configured', () => {
    expect(slaStatus(999, null)).toBe('no_target');
  });

  it('reports unmeasured when the duration is unknown', () => {
    expect(slaStatus(null, 60)).toBe('unmeasured');
    expect(slaStatus(null, null)).toBe('unmeasured');
  });
});
