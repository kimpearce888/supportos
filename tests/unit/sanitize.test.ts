import { describe, it, expect } from 'vitest';
import { sanitizeThreadHtml } from '../../src/server/security/sanitize.js';

describe('HTML sanitization of untrusted ticket content (spec #86, #87)', () => {
  it('removes script tags entirely', () => {
    const out = sanitizeThreadHtml('<p>hi</p><script>alert("xss")</script>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });
  it('strips event handlers', () => {
    const out = sanitizeThreadHtml('<p onclick="alert(1)">click me</p>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('click me');
  });
  it('blocks javascript: URLs', () => {
    const out = sanitizeThreadHtml('<a href="javascript:alert(1)">link</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });
  it('blocks iframes and objects', () => {
    const out = sanitizeThreadHtml('<iframe src="https://evil.example"></iframe><object data="x"></object>');
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('object');
  });
  it('preserves normal email formatting', () => {
    const out = sanitizeThreadHtml('<p>Hello <b>world</b></p><blockquote><p>quoted</p></blockquote><a href="https://example.com">link</a>');
    expect(out).toContain('<b>world</b>');
    expect(out).toContain('blockquote');
    expect(out).toContain('href="https://example.com"');
  });
  it('forces safe link attributes', () => {
    const out = sanitizeThreadHtml('<a href="https://example.com">x</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });
  it('keeps images from http(s) but blocks html data URLs', () => {
    expect(sanitizeThreadHtml('<img src="https://x.example/i.png">')).toContain('i.png');
    expect(sanitizeThreadHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain('data:text/html');
  });
});
