import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from '../database/connection.js';
import { KnowledgeRepository } from '../database/repositories/knowledgeRepo.js';

export interface ImportedDocument {
  title: string;
  content: string;
  format: string;
}

/**
 * Local knowledge ingestion (spec #70): Markdown, TXT, CSV, JSON, HTML natively;
 * PDF and DOCX via optional parsers (graceful degradation if unavailable).
 */
export class KnowledgeIngestor {
  private repo: KnowledgeRepository;

  constructor(private db: DB) {
    this.repo = new KnowledgeRepository(db);
  }

  async importFile(filePath: string, sourceName: string, visibility: 'customer_safe' | 'internal_only'): Promise<{ documentId: number; title: string; changed: boolean }[]> {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const files = fs
        .readdirSync(abs)
        .filter((f) => /\.(md|txt|csv|json|html?|pdf|docx)$/i.test(f))
        .slice(0, 200);
      const out: { documentId: number; title: string; changed: boolean }[] = [];
      for (const f of files) {
        out.push(...(await this.importFile(path.join(abs, f), sourceName, visibility)));
      }
      return out;
    }
    const docs = await this.parseFile(abs);
    let sourceId = this.repo.getSource(sourceName)?.id;
    if (!sourceId) sourceId = this.repo.createSource(sourceName, 'local_file', visibility);
    const results: { documentId: number; title: string; changed: boolean }[] = [];
    for (const doc of docs) {
      const { id, changed } = this.repo.upsertDocument(sourceId, doc.title, doc.content, { visibility, format: doc.format });
      results.push({ documentId: id, title: doc.title, changed });
    }
    return results;
  }

  async parseFile(abs: string): Promise<ImportedDocument[]> {
    const ext = path.extname(abs).toLowerCase();
    const base = path.basename(abs, ext);
    const raw = fs.readFileSync(abs);
    switch (ext) {
      case '.md':
      case '.markdown':
        return [{ title: base, content: raw.toString('utf8'), format: 'markdown' }];
      case '.txt':
        return [{ title: base, content: raw.toString('utf8'), format: 'txt' }];
      case '.csv': {
        const text = raw.toString('utf8');
        const docs = this.splitCsvSections(base, text);
        return docs;
      }
      case '.json': {
        const docs: ImportedDocument[] = [];
        const data = JSON.parse(raw.toString('utf8')) as unknown;
        if (Array.isArray(data)) {
          (data as Record<string, unknown>[]).slice(0, 500).forEach((item, i) => {
            docs.push({ title: (typeof item.title === 'string' && item.title) || (typeof item.name === 'string' && item.name) || `${base} [${i + 1}]`, content: this.flattenRecord(item), format: 'txt' });
          });
        } else if (data && typeof data === 'object') {
          const obj = data as Record<string, unknown>;
          if (Array.isArray(obj.documents)) {
            for (const d of (obj.documents as Record<string, unknown>[]).slice(0, 500)) {
              docs.push({ title: String(d.title ?? d.name ?? base), content: String(d.content ?? d.text ?? this.flattenRecord(d)), format: String(d.format ?? 'txt') });
            }
          } else {
            docs.push({ title: String(obj.title ?? base), content: this.flattenRecord(obj), format: 'txt' });
          }
        }
        return docs;
      }
      case '.html':
      case '.htm': {
        const text = this.htmlToTextKeepStructure(raw.toString('utf8'));
        return [{ title: this.extractHtmlTitle(raw.toString('utf8')) ?? base, content: text, format: 'html' }];
      }
      case '.pdf': {
        const text = await this.parsePdf(raw);
        if (!text.trim()) throw new Error('No text could be extracted from this PDF (it may be scanned images).');
        return [{ title: base, content: text, format: 'txt' }];
      }
      case '.docx': {
        const text = await this.parseDocx(raw);
        return [{ title: base, content: text, format: 'txt' }];
      }
      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }
  }

  private splitCsvSections(base: string, text: string): ImportedDocument[] {
    // One document per row: title column (title/name/question) + content columns
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [{ title: base, content: '', format: 'txt' }];
    const header = this.parseCsvLine(lines[0] ?? '');
    const titleIdx = header.findIndex((h) => /^(title|name|question|topic)$/i.test(h.trim()));
    const docs: ImportedDocument[] = [];
    // Row cap mirrors the JSON import limit (500): a huge CSV would otherwise
    // run unbounded synchronous upserts + FTS writes on the event loop.
    const MAX_ROWS = 500;
    for (const line of lines.slice(1, 1 + MAX_ROWS)) {
      const cells = this.parseCsvLine(line);
      if (cells.every((c) => !c.trim())) continue;
      const title = ((titleIdx >= 0 ? cells[titleIdx] : cells[0]) ?? '').trim() || `${base} entry`;
      const content = header.map((h, i) => `${h}: ${cells[i] ?? ''}`).join('\n');
      docs.push({ title: title.slice(0, 200), content, format: 'txt' });
    }
    if (docs.length === 0) docs.push({ title: base, content: text, format: 'txt' });
    return docs;
  }

  private parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else inQuotes = false;
        } else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return cells;
  }

  private async parsePdf(raw: Buffer): Promise<string> {
    try {
      const mod = (await import('pdf-parse/lib/pdf-parse.js')) as unknown as { default: (b: Buffer) => { text: string } };
      const result = mod.default(raw);
      return result.text;
    } catch {
      throw new Error('PDF parsing is unavailable or failed for this file. Supported best with text-based PDFs.');
    }
  }

  private async parseDocx(raw: Buffer): Promise<string> {
    try {
      const mammoth = (await import('mammoth')) as unknown as { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> };
      const result = await mammoth.extractRawText({ buffer: raw });
      return result.value;
    } catch {
      throw new Error('DOCX parsing is unavailable or failed for this file.');
    }
  }

  private flattenRecord(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (typeof v === 'string') lines.push(`${k}: ${v}`);
      else if (typeof v === 'number' || typeof v === 'boolean') lines.push(`${k}: ${v}`);
      else lines.push(`${k}: ${JSON.stringify(v)}`);
    }
    return lines.join('\n');
  }

  private htmlToTextKeepStructure(html: string): string {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private extractHtmlTitle(html: string): string | null {
    const m = html.match(/<title>([^<]*)<\/title>/i);
    return m ? m[1]?.trim() || null : null;
  }

  importManual(sourceName: string, documents: { title: string; content: string; format: string }[], visibility: 'customer_safe' | 'internal_only'): { documentId: number; title: string; changed: boolean }[] {
    let sourceId = this.repo.getSource(sourceName)?.id;
    if (!sourceId) sourceId = this.repo.createSource(sourceName, 'manual', visibility);
    const out: { documentId: number; title: string; changed: boolean }[] = [];
    for (const d of documents) {
      const { id, changed } = this.repo.upsertDocument(sourceId, d.title, d.content, { visibility, format: d.format });
      out.push({ documentId: id, title: d.title, changed });
    }
    return out;
  }

  static checksum(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}
