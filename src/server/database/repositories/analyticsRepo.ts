import type { DB } from '../connection.js';

/** Daily metrics cache + report snapshots (section 150: don't recompute historical reports). */
export class AnalyticsRepository {
  constructor(private db: DB) {}

  upsertDailyMetric(key: string, date: string, value: number): void {
    this.db
      .prepare(`INSERT INTO daily_metrics (metric_key, date, value, updated_at) VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(metric_key, date) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, date, value);
  }

  getDailySeries(keys: string[], from: string, to: string): { metric_key: string; date: string; value: number }[] {
    if (keys.length === 0) return [];
    const placeholders = keys.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT metric_key, date, value FROM daily_metrics WHERE metric_key IN (${placeholders}) AND date >= ? AND date <= ? ORDER BY date`)
      .all(...keys, from, to) as { metric_key: string; date: string; value: number }[];
  }

  saveReportSnapshot(key: string, params: Record<string, unknown>, result: unknown, dataVersion = '1'): void {
    this.db.prepare('INSERT INTO report_snapshots (report_key, params, generated_at, data_version, result) VALUES (?, ?, datetime(\'now\'), ?, ?)').run(key, JSON.stringify(params), dataVersion, JSON.stringify(result));
  }

  getReportSnapshot(key: string, paramsHash: string, maxAgeMinutes = 60): { result: unknown; generated_at: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT result, generated_at FROM report_snapshots
         WHERE report_key = ? AND params = ? AND generated_at >= datetime('now', '-' || ? || ' minutes')
         ORDER BY id DESC LIMIT 1`
      )
      .get(key, paramsHash, maxAgeMinutes) as { result: string; generated_at: string } | undefined;
    if (!row) return undefined;
    return { result: JSON.parse(row.result), generated_at: row.generated_at };
  }

  listMetricDefinitions(): { key: string; name: string; description: string | null; formula: string | null; source: string; limitations: string | null }[] {
    return this.db.prepare('SELECT key, name, description, formula, source, limitations FROM metric_definitions ORDER BY key').all() as { key: string; name: string; description: string | null; formula: string | null; source: string; limitations: string | null }[];
  }

  // ---------------- Release correlation (section 51) ----------------
  addReleaseEvent(name: string, version: string, occurredAt: string, notes?: string): void {
    this.db.prepare('INSERT INTO release_events (name, version, occurred_at, notes) VALUES (?, ?, ?, ?)').run(name, version, occurredAt, notes ?? null);
  }

  listReleaseEvents(): { id: number; name: string; version: string | null; occurred_at: string; notes: string | null }[] {
    return this.db.prepare('SELECT * FROM release_events ORDER BY occurred_at DESC').all() as { id: number; name: string; version: string | null; occurred_at: string; notes: string | null }[];
  }

  /** Conversation counts 7 days before/after each release event - wording must remain "potentially related". */
  releaseCorrelation(): { release: string; version: string | null; occurred_at: string; before_7d: number; after_7d: number }[] {
    const events = this.listReleaseEvents();
    return events.map((e) => {
      const before = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL AND remote_created_at IS NOT NULL AND remote_created_at >= datetime(?, '-7 days') AND remote_created_at < ?`)
        .all(e.occurred_at, e.occurred_at) as { n: number }[])[0]?.n ?? 0;
      const after = (this.db
        .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NOT NULL AND remote_created_at IS NOT NULL AND remote_created_at >= ? AND remote_created_at < datetime(?, '+7 days')`)
        .all(e.occurred_at, e.occurred_at) as { n: number }[])[0]?.n ?? 0;
      return { release: e.name, version: e.version, occurred_at: e.occurred_at, before_7d: before, after_7d: after };
    });
  }
}
