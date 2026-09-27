/**
 * Shared route-layer helpers (v1.6.0 audit hardening).
 *
 * The v1.6.0 neutral audit found a recurring bug class: query-string numerics
 * passed through bare `Number()` crash downstream with 500s (`?page=abc` ->
 * SqliteError "datatype mismatch", `?days=abc` -> RangeError from
 * `new Date(NaN).toISOString()`). Every list-ish route now clamps through
 * `clampListParam`, mirroring the pattern conversations.ts already used.
 */
export function clampListParam(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value != null && value !== '' ? Number(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Clamp for "last N days"-style params; NaN/garbage falls back to the default. */
export function clampDaysParam(value: string | undefined, fallback: number, min: number, max: number): number {
  return clampListParam(value, fallback, min, max);
}
