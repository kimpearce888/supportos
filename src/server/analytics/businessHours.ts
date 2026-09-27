/**
 * Business-hours engine (v1.4.0): pure, dependency-free time math.
 *
 * Design decisions:
 * - All computation happens on INSTANTS (epoch ms) converted through the
 *   mailbox's IANA timezone with Intl, so daylight-saving transitions are
 *   handled by the platform's tz database rather than hand-rolled offset
 *   arithmetic. The wall->instant conversion iterates the classic
 *   guess-and-correct trick (two passes converge for all real zones).
 * - Business minutes are REAL minutes that fall inside the configured
 *   schedule: nights, weekends and non-configured weekdays contribute zero.
 *   A reply that arrives Saturday 9am after a Friday 5pm ticket has aged
 *   ZERO business minutes - which is the honest answer for SLA purposes.
 * - The engine never throws for weird zones: invalid timezones surface as
 *   NaN offsets and the caller (SlaService) falls back to wall minutes,
 *   labeled as such in the report.
 */

export interface BusinessHoursConfig {
  /** IANA timezone, e.g. 'America/New_York'. */
  timezone: string;
  /** Active weekdays as JS Date.getDay() values: 0=Sunday .. 6=Saturday. */
  days: number[];
  /** Schedule start, minutes after local midnight (e.g. 540 = 09:00). */
  startMinute: number;
  /** Schedule end, minutes after local midnight (e.g. 1020 = 17:00). */
  endMinute: number;
}

export interface SlaTargets {
  firstResponseTargetMin: number | null;
  resolutionTargetMin: number | null;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  timezone: 'UTC',
  days: [1, 2, 3, 4, 5],
  startMinute: 540,
  endMinute: 1020
};

const WEEKDAY_TO_DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a timezone. */
function partsInZone(ts: number, timeZone: string): { y: number; mo: number; d: number; mi: number; dow: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    mi: Number(parts.hour === '24' ? '0' : parts.hour) * 60 + Number(parts.minute),
    dow: WEEKDAY_TO_DOW[parts.weekday ?? 'Mon'] ?? 1
  };
}

/** Offset (minutes) to ADD to an epoch ms value to get wall time in the zone. */
function offsetAt(ts: number, timeZone: string): number {
  const p = partsInZone(ts, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, Math.floor(p.mi / 60), p.mi % 60);
  return (asUtc - ts) / 60000;
}

/** Epoch ms for a wall-clock day + minute-of-day in a timezone (DST-aware). */
function instantForWall(y: number, mo: number, d: number, minute: number, timeZone: string): number {
  const naive = Date.UTC(y, mo - 1, d, Math.floor(minute / 60), minute % 60, 0, 0);
  let ts = naive;
  for (let i = 0; i < 2; i++) {
    const off = offsetAt(ts, timeZone);
    if (!Number.isFinite(off)) return NaN;
    ts = naive - off * 60000;
  }
  return ts;
}

/** True when the zone resolves (guards the fallback path for bad input). */
export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Safety bound: spans longer than this fall back to wall minutes. */
const MAX_SPAN_DAYS = 400;

/**
 * Real minutes between two instants that fall inside the schedule.
 * Returns null when the computation cannot be trusted (invalid timezone or a
 * span beyond MAX_SPAN_DAYS) - the caller then falls back to wall minutes and
 * says so in the report.
 */
export function businessMinutesBetween(startISO: string, endISO: string, cfg: BusinessHoursConfig): number | null {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (!isValidTimezone(cfg.timezone)) return null;
  if (end - start > MAX_SPAN_DAYS * 86400000) return null;

  const active = new Set(cfg.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (active.size === 0) return null;
  const dayStart = Math.max(0, Math.min(1440, cfg.startMinute));
  const dayEnd = Math.max(dayStart, Math.min(1440, cfg.endMinute));
  if (dayEnd <= dayStart) return null;

  // Walk local calendar days from the start's day to the end's day.
  const startParts = partsInZone(start, cfg.timezone);
  const endParts = partsInZone(end, cfg.timezone);
  let cursorY = startParts.y;
  let cursorMo = startParts.mo;
  let cursorD = startParts.d;
  let totalMs = 0;
  for (let guard = 0; guard <= MAX_SPAN_DAYS + 2; guard++) {
    const dayTs = instantForWall(cursorY, cursorMo, cursorD, 0, cfg.timezone);
    if (!Number.isFinite(dayTs)) return null;
    const dow = partsInZone(dayTs, cfg.timezone).dow;
    if (active.has(dow)) {
      const winStart = instantForWall(cursorY, cursorMo, cursorD, dayStart, cfg.timezone);
      const winEnd = instantForWall(cursorY, cursorMo, cursorD, dayEnd, cfg.timezone);
      const overlapStart = Math.max(start, winStart);
      const overlapEnd = Math.min(end, winEnd);
      if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
    }
    if (cursorY === endParts.y && cursorMo === endParts.mo && cursorD === endParts.d) break;
    // next calendar day
    const nextMidnight = instantForWall(cursorY, cursorMo, cursorD, 1439, cfg.timezone) + 60000;
    const np = partsInZone(nextMidnight, cfg.timezone);
    cursorY = np.y;
    cursorMo = np.mo;
    cursorD = np.d;
  }
  return totalMs / 60000;
}

/** Wall-clock minutes between two instants (the honest fallback / comparison). */
export function wallMinutesBetween(startISO: string, endISO: string): number | null {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 60000;
}

/** SLA verdict for a measured duration against a target. */
export function slaStatus(minutes: number | null, targetMin: number | null): 'met' | 'missed' | 'no_target' | 'unmeasured' {
  if (targetMin == null) return minutes != null ? 'no_target' : 'unmeasured';
  if (minutes == null) return 'unmeasured';
  return minutes <= targetMin ? 'met' : 'missed';
}

/** Minutes since an instant, business-adjusted (for "currently waiting" aging). */
export function businessMinutesSince(iso: string, cfg: BusinessHoursConfig): number | null {
  return businessMinutesBetween(iso, new Date().toISOString(), cfg);
}
