import { promises as dns } from 'node:dns';

/**
 * SSRF guard for outbound connector HTTP requests (plan Phase 22 + the
 * approved plan adjustment #4: "Connectors increase SSRF hardening - private
 * networks, localhost and cloud metadata endpoints are refused").
 *
 * Layers:
 * 1. URL shape: only http/https, a host must be present.
 * 2. Literal address checks: loopback, RFC1918 private, CGNAT 100.64/10,
 *    link-local 169.254/16 (AWS/GCP/Azure metadata endpoints), IPv6
 *    loopback/unique-local/link-local, IPv4-mapped IPv6, the unspecified
 *    address, and the raw numeric-encoding tricks (0x7f.0.0.1, 2130706433).
 * 3. Hostname checks: localhost, *.localhost, *.local, *.internal.
 * 4. DNS resolution (with an injectable resolver for tests): EVERY resolved
 *    address must be public - one private hit refuses the whole target, so
 *    DNS rebinding to an internal address cannot slip through on the
 *    happy path.
 *
 * The guard is deliberately fail-closed: anything it cannot parse is
 * refused, not allowed.
 */
export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  host?: string;
  resolvedAddresses?: string[];
}

export type DnsResolver = (host: string) => Promise<string[]>;

const defaultResolver: DnsResolver = async (host) => {
  const results = await dns.lookup(host, { all: true });
  return results.map((r) => r.address);
};

/** Parse and validate URL shape: http/https only. Throws on garbage. */
function parseHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`protocol "${url.protocol}" is not allowed (http/https only)`);
  }
  if (!url.hostname) throw new Error('URL has no host');
  return url;
}

function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** All IPv4 range checks. Returns a refusal reason or null when public. */
function ipv4Reason(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return 'malformed IPv4 literal';
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 0) return '0.0.0.0/8 (this-network)';
  if (a === 10) return '10.0.0.0/8 (RFC1918 private)';
  if (a === 127) return '127.0.0.0/8 (loopback)';
  if (a === 169 && b === 254) return '169.254.0.0/16 (link-local / cloud metadata)';
  if (a === 172 && b >= 16 && b <= 31) return '172.16.0.0/12 (RFC1918 private)';
  if (a === 192 && b === 168) return '192.168.0.0/16 (RFC1918 private)';
  if (a === 100 && b >= 64 && b <= 127) return '100.64.0.0/10 (carrier-grade NAT)';
  if (a === 198 && (b === 18 || b === 19)) return '198.18.0.0/15 (benchmarking)';
  if (a >= 224) return `${a}.0.0.0/4 (multicast/reserved)`;
  return null;
}

/** Expand an IPv6 literal (may be bracket-stripped) into 8 numeric groups. */
function expandIpv6(ip: string): number[] | null {
  const raw = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw.includes(':')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (s: string): (number | { v4: string })[] =>
    s.split(':').filter((g) => g !== '').map((g) => {
      if (g.includes('.')) return { v4: g };
      const n = parseInt(g, 16);
      return Number.isFinite(n) && n <= 0xffff ? n : NaN;
    });
  let head: (number | { v4: string })[] = [];
  let tail: (number | { v4: string })[] = [];
  if (halves.length === 2) {
    head = parseGroups(halves[0] ?? '');
    tail = parseGroups(halves[1] ?? '');
  } else {
    head = parseGroups(raw);
  }
  const groups: number[] = [];
  const emit = (g: number | { v4: string }): boolean => {
    if (typeof g === 'number') { groups.push(g); return true; }
    // IPv4-mapped suffix (e.g. ::ffff:127.0.0.1): emit as two groups.
    const o = g.v4.split('.').map(Number);
    if (o.length !== 4 || o.some((x) => !Number.isFinite(x) || x > 255)) return false;
    const o0 = o[0] ?? 0, o1 = o[1] ?? 0, o2 = o[2] ?? 0, o3 = o[3] ?? 0;
    groups.push((o0 << 8) | o1);
    groups.push((o2 << 8) | o3);
    return true;
  };
  for (const g of head) if (!emit(g)) return null;
  if (halves.length === 2) {
    // An IPv4 tail entry occupies TWO group slots (::ffff:1.2.3.4 = 2 groups).
    const tailSlots = tail.reduce<number>((n, g) => n + (typeof g === 'number' ? 1 : 2), 0);
    const missing = 8 - groups.length - tailSlots;
    if (missing < 0) return null;
    for (let i = 0; i < missing; i++) groups.push(0);
    for (const g of tail) if (!emit(g)) return null;
  }
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

function ipv6Reason(groups: number[]): string | null {
  if (groups.length !== 8) return 'malformed IPv6 literal';
  const g0 = groups[0] ?? 0, g5 = groups[5] ?? 0, g6 = groups[6] ?? 0, g7 = groups[7] ?? 0;
  const isUnspecified = groups.every((g) => g === 0);
  if (isUnspecified) return ':: (unspecified address)';
  const isLoopback = groups.slice(0, 7).every((g) => g === 0) && g7 === 1;
  if (isLoopback) return '::1 (IPv6 loopback)';
  // ::ffff:0:0/96 - IPv4-mapped: check the embedded v4 address.
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    const reason = ipv4Reason(v4);
    if (reason) return `::ffff:${v4} maps to ${reason}`;
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'fc00::/7 (IPv6 unique local)';
  if ((g0 & 0xffc0) === 0xfe80) return 'fe80::/10 (IPv6 link-local)';
  if ((g0 & 0xff00) === 0xff00) return 'ff00::/8 (IPv6 multicast)';
  return null;
}

/** Public check for any literal IP (v4 or v6). Null = public/not-an-IP. */
export function literalIpReason(ip: string): string | null {
  if (isIpv4Literal(ip)) return ipv4Reason(ip);
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups) return ipv6Reason(groups);
    return 'unparseable IPv6 literal';
  }
  // Numeric-encoding tricks: pure integer or hex forms resolve to loopback
  // ranges in some stacks - refuse anything that is all digits/hex dots.
  if (/^\d+$/.test(ip) || /^0x[0-9a-f]+(\.[0x0-9a-f]+)*$/i.test(ip)) {
    return 'numeric-encoded address form';
  }
  return null;
}

/** Hostname-shaped checks (no DNS): localhost and internal naming. */
function hostnameReason(host: string): string | null {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return `"${h}" is a localhost name`;
  if (h.endsWith('.local') || h.endsWith('.internal')) return `"${h}" looks like an internal name`;
  return null;
}

/** Synchronous layer: URL shape + literal IP + hostname checks. */
export function checkUrlLiteral(rawUrl: string): SsrfCheckResult {
  let url: URL;
  try {
    url = parseHttpUrl(rawUrl);
  } catch (e) {
    return { ok: false, reason: `invalid URL: ${(e as Error).message}` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipReason = literalIpReason(host);
  if (ipReason) return { ok: false, reason: `refused ${ipReason}`, host };
  const hReason = hostnameReason(host);
  if (hReason) return { ok: false, reason: hReason, host };
  return { ok: true, host };
}

/**
 * Full check including DNS resolution: every resolved address must be
 * public. Fail-closed on resolver errors (a name that cannot resolve is
 * refused, not allowed).
 */
export async function checkUrlResolved(rawUrl: string, resolver: DnsResolver = defaultResolver): Promise<SsrfCheckResult> {
  const literal = checkUrlLiteral(rawUrl);
  if (!literal.ok) return literal;
  const host = literal.host!;
  // Literal public IPs need no DNS pass.
  if (isIpv4Literal(host) || host.includes(':')) {
    return { ...literal, resolvedAddresses: [host] };
  }
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, reason: `host "${host}" does not resolve`, host };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `host "${host}" resolved to no addresses`, host };
  }
  for (const addr of addresses) {
    const reason = literalIpReason(addr);
    if (reason) return { ok: false, reason: `host "${host}" resolves to ${addr} (${reason})`, host, resolvedAddresses: addresses };
  }
  return { ok: true, host, resolvedAddresses: addresses };
}
