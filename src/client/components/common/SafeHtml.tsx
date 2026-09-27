import { type ReactNode } from 'react';

/**
 * Render sanitized thread HTML. SAFETY MODEL: this component is only safe
 * because the SERVER whitelist (src/server/security/sanitize.ts) strips
 * scripts, event handlers, javascript: URLs and dangerous CSS BEFORE the HTML
 * reaches the client. dangerouslySetInnerHTML itself provides NO protection -
 * do not reuse this component for HTML from any other source.
 */
export function SafeHtml({ html, fallbackText }: { html: string | null; fallbackText: string }): ReactNode {
  if (!html || html.trim().length === 0) {
    return <div className="thread-body">{renderParagraphs(fallbackText)}</div>;
  }
  return <div className="thread-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function renderParagraphs(text: string): ReactNode {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return paragraphs.map((p, i) => <p key={i}>{p}</p>);
}
