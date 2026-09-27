/** Configurable redaction layer for AI prompts (spec #127). */
export interface RedactionResult {
  text: string;
  redactions: { pattern: string; count: number }[];
}

const PATTERNS: { name: string; re: RegExp; replacement: string }[] = [
  { name: 'card_number', re: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED-CARD]' },
  { name: 'cvv', re: /\b(?:cvv|cvc|security code)[\s:=-]*(\d{3,4})\b/gi, replacement: '[REDACTED-CVV]' },
  { name: 'api_key', re: /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\b[\s:=-]*[A-Za-z0-9_\-\.]{8,}/gi, replacement: '[REDACTED-SECRET]' },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, replacement: '[REDACTED-TOKEN]' },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED-AWS-KEY]' },
  { name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED-PRIVATE-KEY]' }
];

export function redactText(text: string, enabled = true): RedactionResult {
  if (!enabled) return { text, redactions: [] };
  let out = text;
  const redactions: { pattern: string; count: number }[] = [];
  for (const p of PATTERNS) {
    const matches = out.match(p.re);
    if (matches && matches.length > 0) {
      out = out.replace(p.re, (m) => {
        // preserve prefix words like "cvv:" in the replacement for readability
        const prefixMatch = m.match(/^\s*(?:cvv|cvc|security code|api[_-]?key|token|secret|password|passwd|pwd)?[\s:=-]*/i);
        return (prefixMatch ? prefixMatch[0] : '') + p.replacement;
      });
      redactions.push({ pattern: p.name, count: matches.length });
    }
  }
  return { text: out, redactions };
}
