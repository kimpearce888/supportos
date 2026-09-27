import sanitizeHtml from 'sanitize-html';

/**
 * Safe HTML rendering for untrusted email/ticket content (spec #86, #87).
 * Never allow scripts, event handlers, javascript: URLs or iframes.
 * Preserve normal email formatting (links, lists, emphasis, quotes, images as links).
 *
 * Inline CSS is filtered (see sanitizeStyle): raw style attributes previously
 * passed through unsanitized, allowing position:fixed full-pane overlays and
 * url() tracking beacons inside otherwise-sanitized email HTML.
 */
const DANGEROUS_CSS = /(url\s*\(|@import|expression\s*\(|position\s*:\s*(fixed|absolute)|behavior\s*:|-moz-binding|javascript\s*:)/i;

function scrubStyle(tagName: string, attribs: Record<string, string>): { tagName: string; attribs: Record<string, string> } {
  if (attribs.style != null) {
    // Drop the whole attribute when it contains dangerous constructs; keep
    // benign email layout styling (colors, fonts, padding, alignment).
    if (!attribs.style || DANGEROUS_CSS.test(attribs.style)) {
      delete attribs.style;
    } else {
      attribs.style = attribs.style.slice(0, 2000);
    }
  }
  return { tagName, attribs };
}

export function sanitizeThreadHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  return sanitizeHtml(dirty, {
    allowedTags: [
      'a', 'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'code', 'pre', 'blockquote',
      'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'img', 'font', 'center', 'small', 'sub', 'sup', 'dl', 'dt', 'dd'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel', 'title'],
      img: ['src', 'alt', 'title', 'width', 'height', 'style'],
      span: ['style'],
      div: ['style'],
      p: ['style'],
      table: ['style', 'border', 'cellpadding', 'cellspacing', 'align'],
      td: ['style', 'colspan', 'rowspan', 'align', 'valign'],
      th: ['style', 'colspan', 'rowspan', 'align', 'valign'],
      font: ['color', 'face', 'size'],
      blockquote: ['style', 'cite']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
      // CSS scrubbing on every element that carries a style attribute
      span: scrubStyle,
      div: scrubStyle,
      p: scrubStyle,
      table: scrubStyle,
      td: scrubStyle,
      th: scrubStyle,
      img: scrubStyle,
      blockquote: scrubStyle
    },
    exclusiveFilter: (frame) => frame.tag === 'img' && typeof frame.attribs?.src === 'string' && frame.attribs.src.trim().startsWith('data:text/html')
  });
}

/** Escape text for safe HTML contexts (we build our own DOM via React, but this guards server-side compositions). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
