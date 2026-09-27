import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { DateMode, DateRange } from '../../shared/activity.js';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Date-range resolver (v1.7.0): turns a DateMode into exact UTC instants in
 * the USER'S configured IANA timezone.
 *
 * Why dayjs utc+timezone plugins (not hand-rolled offsets): calendar-day
 * boundaries depend on the zone's DST rules (a 23h or 25h local day must
 * still yield exactly one local day). dayjs.tz delegates to the platform tz
 * database via Intl - the same source of truth the SLA business-hours engine
 * trusts. All instants are stored UTC; only the BOUNDARY computation is local.
 *
 * Calendar modes (today/this week/...) resolve local wall-clock boundaries and
 * convert to UTC. Rolling modes (last 24h/7d...) are exact now-minus windows -
 * deliberately different semantics, surfaced as `kind` so the UI can label
 * them ("Today" vs "Last 24 hours" are NOT the same filter).
 */

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the user's timezone: explicit param > stored setting > system > UTC. */
export function resolveTimezone(explicit?: string | null, storedSetting?: string | null): string {
  for (const candidate of [explicit, storedSetting]) {
    if (candidate && candidate !== 'system' && isValidTimezone(candidate)) return candidate;
  }
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimezone(system) ? system : 'UTC';
}

const MS_PER_MINUTE = 60_000;

/**
 * Convert "HH:mm" to minutes-after-local-midnight. Returns null for invalid input.
 */
function parseTimeOfDay(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Wall-clock -> instant via dayjs.tz parse: builds the local Y-M-D (+ optional
 * time) in the target zone and lets the tz database pick the offset (DST-
 * correct). NOTE: dayjs's own `.startOf('day')` on tz instances is NOT used
 * anywhere - its keepLocalTime path derives the offset from the pre-conversion
 * instant, which is wrong by the DST delta for half-hour zones (verified
 * against Australia/Lord_Howe 2024-04-07). Calendar boundaries are therefore
 * computed with date-only arithmetic on a neutral dayjs, then converted with
 * this parse.
 */
function localInstant(tz: string, y: number, m: number, d: number, minutesAfterMidnight = 0): dayjs.Dayjs {
  const hh = Math.floor(minutesAfterMidnight / 60);
  const mm = minutesAfterMidnight % 60;
  return dayjs.tz(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, 'YYYY-MM-DD HH:mm', tz);
}

/** Date-only arithmetic on a NEUTRAL (no timezone) dayjs - immune to offsets. */
function dateOnly(y: number, m: number, d: number): dayjs.Dayjs {
  return dayjs.utc(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 'YYYY-MM-DD');
}

export interface DateRangeInput {
  mode: DateMode;
  timezone: string;
  /** For exact_date / custom_range: YYYY-MM-DD (assumed in `timezone`). */
  from?: string | null;
  to?: string | null;
  /** Optional time-of-day bounds "HH:mm" applied to the date window. */
  fromTime?: string | null;
  toTime?: string | null;
  /** Injectable clock for tests (epoch ms). */
  now?: number;
}

/**
 * Resolve a date filter to [from, to) UTC ISO instants. Returns null when the
 * mode needs explicit dates that were not supplied (caller answers 422, never
 * silently widens the filter).
 */
export function resolveDateRange(input: DateRangeInput): DateRange | null {
  const tz = isValidTimezone(input.timezone) ? input.timezone : 'UTC';
  const now = input.now != null ? dayjs(input.now) : dayjs();
  // Wall-clock components of "now" in the user zone (tz conversion of an
  // instant is exact; only dayjs OPERATIONS on tz instances are unsafe).
  const wall = now.tz(tz);
  const y = wall.year();
  const m = wall.month() + 1;
  const d = wall.date();
  // Boundary helper: dayOffset shifts the wall DATE by N days (0 = today),
  // monthOffset shifts by N months (clamped to month length), then converts
  // the resulting local midnight to a UTC instant via the DST-correct parse.
  const midnightAt = (dayOffset: number): dayjs.Dayjs => {
    const shifted = dateOnly(y, m, d).add(dayOffset, 'day');
    return localInstant(tz, shifted.year(), shifted.month() + 1, shifted.date(), 0);
  };
  const monthMidnightAt = (monthOffset: number, dayOfMonth: number): dayjs.Dayjs => {
    const shifted = dateOnly(y, m, 1).add(monthOffset, 'month').date(Math.min(dayOfMonth, daysInMonth(dateOnly(y, m, 1).add(monthOffset, 'month'))));
    return localInstant(tz, shifted.year(), shifted.month() + 1, shifted.date(), 0);
  };
  // Week start = Sunday 00:00 local (dayjs convention), dayOffset from today.
  const dow = wall.day(); // 0=Sunday
  const weekMidnightAt = (weekOffset: number): dayjs.Dayjs => midnightAt(weekOffset * 7 - dow);

  const withTimeBounds = (from: dayjs.Dayjs, to: dayjs.Dayjs, kind: DateRange['kind'], label: string): DateRange => {
    let f = from;
    let t = to;
    const fromMin = parseTimeOfDay(input.fromTime);
    const toMin = parseTimeOfDay(input.toTime);
    if (fromMin != null) f = localInstant(tz, f.year(), f.month() + 1, f.date(), fromMin);
    if (toMin != null) {
      // "to 17:00" = exclusive end at 17:00 on the LAST INCLUDED day; when the
      // window end already lands on midnight-of-next-day, step back one day.
      const lastDay = t.subtract(1, 'millisecond');
      t = localInstant(tz, lastDay.year(), lastDay.month() + 1, lastDay.date(), toMin);
    }
    return { from: f.utc().toISOString(), to: t.utc().toISOString(), label, kind };
  };

  const isoDate = (v: string | null | undefined): { y: number; m: number; d: number } | null => {
    if (!v) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!match) return null;
    const yy = Number(match[1]);
    const mm = Number(match[2]);
    const dd = Number(match[3]);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const probe = localInstant(tz, yy, mm, dd, 12);
    if (probe.month() + 1 !== mm || probe.date() !== dd) return null; // rejects Feb 30 etc.
    return { y: yy, m: mm, d: dd };
  };

  switch (input.mode) {
    // ---- Calendar-day modes (local boundaries, DST-correct via localInstant) ----
    case 'today':
      return withTimeBounds(midnightAt(0), midnightAt(1), 'calendar', 'Today');
    case 'yesterday':
      return withTimeBounds(midnightAt(-1), midnightAt(0), 'calendar', 'Yesterday');
    case 'tomorrow':
      return withTimeBounds(midnightAt(1), midnightAt(2), 'calendar', 'Tomorrow');
    case 'this_week':
      return withTimeBounds(weekMidnightAt(0), weekMidnightAt(1), 'calendar', 'This week');
    case 'last_week':
      return withTimeBounds(weekMidnightAt(-1), weekMidnightAt(0), 'calendar', 'Last week');
    case 'this_month':
      return withTimeBounds(monthMidnightAt(0, 1), monthMidnightAt(1, 1), 'calendar', 'This month');
    case 'last_month':
      return withTimeBounds(monthMidnightAt(-1, 1), monthMidnightAt(0, 1), 'calendar', 'Last month');

    // ---- Rolling modes (exact now-minus windows) ----
    case 'last_24h':
      return { from: now.subtract(24, 'hour').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 24 hours', kind: 'rolling' };
    case 'last_48h':
      return { from: now.subtract(48, 'hour').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 48 hours', kind: 'rolling' };
    case 'last_7d':
      return { from: now.subtract(7, 'day').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 7 days', kind: 'rolling' };
    case 'last_14d':
      return { from: now.subtract(14, 'day').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 14 days', kind: 'rolling' };
    case 'last_30d':
      return { from: now.subtract(30, 'day').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 30 days', kind: 'rolling' };
    case 'last_90d':
      return { from: now.subtract(90, 'day').utc().toISOString(), to: now.utc().toISOString(), label: 'Last 90 days', kind: 'rolling' };

    // ---- Exact modes ----
    case 'exact_date': {
      const dd = isoDate(input.from);
      if (!dd) return null;
      const start = localInstant(tz, dd.y, dd.m, dd.d, 0);
      return withTimeBounds(start, start.add(1, 'day'), 'exact', `On ${input.from}`);
    }
    case 'custom_range': {
      const a = isoDate(input.from);
      const b = isoDate(input.to);
      if (!a || !b) return null;
      const startA = localInstant(tz, a.y, a.m, a.d, 0);
      const startB = localInstant(tz, b.y, b.m, b.d, 0);
      const lo = startA.isBefore(startB) ? startA : startB;
      const hi = (startA.isBefore(startB) ? startB : startA).add(1, 'day');
      return withTimeBounds(lo, hi, 'exact', `${input.from} to ${input.to}`);
    }
    default:
      return null;
  }
}

function daysInMonth(d: dayjs.Dayjs): number {
  return d.daysInMonth();
}

/**
 * Response-age metric -> (SQL minutes expression, label). Ages are computed
 * with julianday differences (exact wall minutes; business-hour weighting is
 * an SLA concern, not an age concern - deliberately kept separate).
 */
export const AGE_METRIC_SQL: Record<string, { sql: string; label: string }> = {
  time_since_customer_reply: { sql: "(julianday('now') - COALESCE(julianday(c.last_customer_reply_at), julianday('now'))) * 1440", label: 'Time since customer reply' },
  time_since_agent_response: { sql: "(julianday('now') - COALESCE(julianday(c.last_human_agent_response_at), julianday('now'))) * 1440", label: 'Time since agent response' },
  customer_waiting_duration: { sql: "(julianday('now') - COALESCE(julianday(c.customer_waiting_since), julianday('now'))) * 1440", label: 'Customer waiting' },
  first_response_delay: { sql: "(COALESCE(julianday(c.first_response_at), julianday('now')) - COALESCE(julianday(c.remote_created_at), julianday('now'))) * 1440", label: 'First response delay' },
  resolution_duration: { sql: "(COALESCE(julianday(c.closed_at), julianday('now')) - COALESCE(julianday(c.remote_created_at), julianday('now'))) * 1440", label: 'Resolution duration' },
  conversation_age: { sql: "(julianday('now') - COALESCE(julianday(c.remote_created_at), julianday('now'))) * 1440", label: 'Conversation age' }
};

/** Format minutes into the compact human form the plan specifies (14m / 3h 21m / 1d 6h). */
export function formatAgeMinutes(minutes: number | null | undefined): string | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return null;
  const total = Math.floor(minutes);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const MS_PER_MIN = MS_PER_MINUTE;
