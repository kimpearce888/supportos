/** Shared pure utilities (usable on server and client). */

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function toIsoOrNullMs(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString();
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function displayName(first?: string | null, last?: string | null, fallback = 'Unknown'): string {
  const parts = [first ?? '', last ?? ''].filter((p) => p && p.trim().length > 0);
  return parts.length ? parts.join(' ') : fallback;
}

export function initialsOf(first?: string | null, last?: string | null): string {
  const a = (first ?? '').trim().charAt(0).toUpperCase();
  const b = (last ?? '').trim().charAt(0).toUpperCase();
  const r = a + b;
  return r || '?';
}

export function escapeLikeParam(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

/** Strip HTML tags to plain text (best-effort, for previews/snippets). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(text: string, maxLen = 1200, overlap = 150): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxLen, clean.length);
    if (end < clean.length) {
      const dot = clean.lastIndexOf('. ', end);
      if (dot > start + maxLen * 0.5) end = dot + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    start = end - overlap;
    if (start < 0) start = 0;
    if (end >= clean.length) break;
  }
  return chunks;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function safeParseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
