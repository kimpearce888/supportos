/**
 * Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF) for
 * connector imports. No external dependency, bounded to a size cap by the
 * caller. Returns { headers, rows } - every row becomes a flat object.
 */
export function parseCsv(text: string, maxRows = 5000): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      record.push(field); records.push(record); record = []; field = '';
      if (records.length >= maxRows + 1) break;
      continue;
    }
    if (ch === '\n') {
      record.push(field); records.push(record); record = []; field = '';
      if (records.length >= maxRows + 1) break;
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }
  // Drop trailing empty record from a final newline.
  const last = records[records.length - 1];
  if (last && last.length === 1 && last[0] === '') records.pop();
  if (records.length === 0) return { headers: [], rows: [] };
  const headerRecord = records[0] ?? [];
  const headers = headerRecord.map((h) => h.trim()).filter(Boolean);
  const rows: Record<string, string>[] = [];
  for (const rec of records.slice(1, maxRows + 1)) {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = rec[idx] ?? ''; });
    if (Object.keys(obj).length > 0) rows.push(obj);
  }
  return { headers, rows };
}
