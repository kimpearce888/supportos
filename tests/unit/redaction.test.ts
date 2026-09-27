import { describe, it, expect } from 'vitest';
import { redactText } from '../../src/server/security/redaction.js';

describe('redaction layer (spec #127)', () => {
  it('redacts card numbers', () => {
    const r = redactText('My card is 4111 1111 1111 1111 please charge it');
    expect(r.text).not.toContain('4111');
    expect(r.redactions.some((x) => x.pattern === 'card_number')).toBe(true);
  });
  it('redacts CVV patterns', () => {
    const r = redactText('cvv: 123 and CVC 4567');
    expect(r.text).not.toMatch(/\b123\b/);
    expect(r.text).not.toMatch(/\b4567\b/);
  });
  it('redacts api keys and tokens', () => {
    const r = redactText('api_key = sk_live_abcdefgh12345678 and password: hunter2secure');
    expect(r.text).not.toContain('sk_live_abcdefgh12345678');
    expect(r.text).toContain('[REDACTED-SECRET]');
  });
  it('redacts bearer tokens', () => {
    const r = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(r.text).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });
  it('redacts private key blocks', () => {
    const r = redactText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----');
    expect(r.text).not.toContain('MIIEowIBAAKCAQEA');
    expect(r.text).toContain('[REDACTED-PRIVATE-KEY]');
  });
  it('keeps ordinary email addresses (spec: do not blindly redact emails)', () => {
    const r = redactText('Please reply to lucia@andeslogistics.cl about the schedule');
    expect(r.text).toContain('lucia@andeslogistics.cl');
    expect(r.redactions.length).toBe(0);
  });
  it('can be disabled', () => {
    const r = redactText('password: hunter2secure', false);
    expect(r.text).toContain('hunter2secure');
  });
});
