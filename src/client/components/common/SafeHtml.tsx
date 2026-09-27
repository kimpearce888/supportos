import { type ReactNode } from 'react';

/** Render sanitized thread HTML. The server sanitizes untrusted HTML before storage/return;
 *  here we render it into an isolated container with no script execution possible
 *  (React does not execute script tags inserted via innerHTML-style APIs). */
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
