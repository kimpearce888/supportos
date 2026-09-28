import { describe, it, expect } from 'vitest';
import { checkUrlLiteral, checkUrlResolved, literalIpReason, type DnsResolver } from '../../src/server/security/ssrfGuard.js';

/**
 * v2.0.0 (M4) unit tests: the SSRF guard (approved plan adjustment #4).
 * The guard must fail CLOSED: private networks, loopback, link-local
 * (cloud metadata), CGNAT, IPv6 private/loopback, IPv4-mapped IPv6,
 * numeric-encoding tricks and internal hostnames are all refused - and DNS
 * resolution is checked address-by-address with an injectable resolver.
 */
describe('ssrfGuard literal checks', () => {
  it('allows public http/https URLs', () => {
    expect(checkUrlLiteral('https://api.example.com/releases').ok).toBe(true);
    expect(checkUrlLiteral('http://93.184.216.34/v1/data').ok).toBe(true);
    expect(checkUrlLiteral('https://example.com:8443/path?x=1').ok).toBe(true);
  });

  it('refuses non-http protocols and garbage', () => {
    expect(checkUrlLiteral('file:///etc/passwd').ok).toBe(false);
    expect(checkUrlLiteral('ftp://example.com/data').ok).toBe(false);
    expect(checkUrlLiteral('gopher://example.com').ok).toBe(false);
    expect(checkUrlLiteral('not a url').ok).toBe(false);
    expect(checkUrlLiteral('').ok).toBe(false);
  });

  it('refuses loopback and private IPv4 ranges', () => {
    for (const url of [
      'http://127.0.0.1/api',
      'http://localhost/api',
      'http://10.0.0.5/api',
      'http://10.255.255.255/api',
      'http://172.16.0.1/api',
      'http://172.31.255.254/api',
      'http://192.168.1.1/api',
      'http://169.254.169.254/latest/meta-data',   // AWS/GCP/Azure metadata
      'http://169.254.170.2/v2/credentials',       // ECS metadata
      'http://100.64.0.7/api',                     // CGNAT
      'http://0.0.0.0/api',
      'http://198.18.0.9/api'
    ]) {
      const r = checkUrlLiteral(url);
      expect(r.ok, `${url} should be refused`).toBe(false);
      expect(r.reason).toBeTruthy();
    }
  });

  it('allows public IPv4 outside the refused ranges', () => {
    expect(literalIpReason('8.8.8.8')).toBeNull();
    expect(literalIpReason('1.1.1.1')).toBeNull();
    expect(literalIpReason('172.32.0.1')).toBeNull(); // just outside 172.16/12
    expect(literalIpReason('192.169.0.1')).toBeNull(); // just outside 192.168/16
  });

  it('refuses IPv6 loopback, unique-local, link-local and mapped-v4', () => {
    expect(literalIpReason('::1')).toContain('loopback');
    expect(literalIpReason('::')).toContain('unspecified');
    expect(literalIpReason('fe80::1')).toContain('link-local');
    expect(literalIpReason('fc00::1234')).toContain('unique local');
    expect(literalIpReason('fd12:3456:789a::1')).toContain('unique local');
    expect(literalIpReason('::ffff:127.0.0.1')).toContain('loopback');
    expect(literalIpReason('::ffff:169.254.169.254')).toContain('metadata');
    expect(checkUrlLiteral('http://[::1]/api').ok).toBe(false);
    expect(checkUrlLiteral('http://[fe80::1]/api').ok).toBe(false);
  });

  it('refuses numeric-encoding tricks and internal hostnames', () => {
    expect(checkUrlLiteral('http://0x7f000001/api').ok).toBe(false);        // hex loopback
    expect(checkUrlLiteral('http://2130706433/api').ok).toBe(false);        // decimal loopback
    expect(checkUrlLiteral('http://127.1/api').ok).toBe(false);             // short loopback form is NOT a full IPv4 literal -> hostname rules? (malformed/numeric)
    expect(checkUrlLiteral('https://dashboard.internal/api').ok).toBe(false);
    expect(checkUrlLiteral('https://printer.local/api').ok).toBe(false);
    expect(checkUrlLiteral('https://api.localhost/api').ok).toBe(false);
  });
});

describe('ssrfGuard DNS resolution checks', () => {
  const resolves = (addrs: string[]): DnsResolver => async () => addrs;

  it('allows hostnames resolving to public addresses', async () => {
    const r = await checkUrlResolved('https://api.example.com/data', resolves(['93.184.216.34']));
    expect(r.ok).toBe(true);
    expect(r.resolvedAddresses).toEqual(['93.184.216.34']);
  });

  it('refuses when ANY resolved address is private (DNS rebinding shape)', async () => {
    const r = await checkUrlResolved('https://evil.example.com/data', resolves(['93.184.216.34', '192.168.0.10']));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('192.168.0.10');
  });

  it('refuses when every resolved address is private', async () => {
    const r = await checkUrlResolved('https://internal.example.com/data', resolves(['10.1.2.3']));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('10.1.2.3');
  });

  it('fails closed when resolution fails or returns nothing', async () => {
    const failing: DnsResolver = async () => { throw new Error('NXDOMAIN'); };
    const r = await checkUrlResolved('https://nope.example.com/data', failing);
    expect(r.ok).toBe(false);
    const empty: DnsResolver = async () => [];
    const r2 = await checkUrlResolved('https://nope.example.com/data', empty);
    expect(r2.ok).toBe(false);
  });

  it('skips DNS for literal public IPs', async () => {
    let called = 0;
    const counting: DnsResolver = async () => { called++; return ['10.0.0.1']; };
    const r = await checkUrlResolved('http://93.184.216.34/data', counting);
    expect(r.ok).toBe(true);
    expect(called).toBe(0);
  });
});
