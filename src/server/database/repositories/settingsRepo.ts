import type { DB } from '../connection.js';
import { nowIso } from './helpers.js';
import type { AppSettings } from '../../../shared/types.js';

/** Application settings + secret abstraction (section 6: never store raw tokens in frontend; OS keychain when practical, documented fallback here). */
export class SettingsRepository {
  constructor(private db: DB) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM application_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      const v = JSON.parse(row.value);
      return (v === null ? fallback : v) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO application_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
      .run(key, JSON.stringify(value));
  }

  getAllSettings(): AppSettings {
    return {
      sync_interval_minutes: this.get('sync_interval_minutes', 5),
      api_concurrency: this.get('api_concurrency', 2),
      ai_enabled: this.get('ai_enabled', true),
      automatic_analysis_enabled: this.get('automatic_analysis_enabled', true),
      automatic_note_enabled: this.get('automatic_note_enabled', false),
      automatic_draft_enabled: this.get('automatic_draft_enabled', false),
      automation_enabled: this.get('automation_enabled', false),
      automation_write_actions_enabled: this.get('automation_write_actions_enabled', false),
      qdrant_enabled: this.get('qdrant_enabled', true),
      attachment_auto_download: this.get('attachment_auto_download', true),
      automatic_reply_sending: this.get('automatic_reply_sending', false),
      retention_days: this.get<number | null>('retention_days', null),
      backup_interval_hours: this.get<number | null>('backup_interval_hours', 24),
      log_level: this.get('log_level', 'info'),
      display_timezone: this.get('display_timezone', 'system'),
      redaction_enabled: this.get('redaction_enabled', true),
      ai_evaluation_mode: this.get('ai_evaluation_mode', false)
    };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    // Safety: automatic_reply_sending can never be enabled in v1 (spec #14)
    if ('automatic_reply_sending' in patch) {
      (patch as Record<string, unknown>).automatic_reply_sending = false;
    }
    for (const [k, v] of Object.entries(patch)) {
      this.set(k, v);
    }
    return this.getAllSettings();
  }

  // ---------------- OAuth token storage (server-side only) ----------------
  getOAuthTokens(): { access_token: string | null; refresh_token: string | null; expires_at: string | null; revoked: boolean } {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE account = 'default'").get() as
      | { access_token: string | null; refresh_token: string | null; expires_at: string | null; revoked: number }
      | undefined;
    if (!row) return { access_token: null, refresh_token: null, expires_at: null, revoked: true };
    return { access_token: row.access_token, refresh_token: row.refresh_token, expires_at: row.expires_at, revoked: !!row.revoked };
  }

  saveOAuthTokens(tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }): void {
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 172800) * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (account, access_token, refresh_token, token_type, expires_at, obtained_at, scope, revoked)
         VALUES ('default', ?, ?, 'bearer', ?, ?, ?, 0)
         ON CONFLICT(account) DO UPDATE SET access_token=excluded.access_token,
           refresh_token=COALESCE(excluded.refresh_token, refresh_token), expires_at=excluded.expires_at,
           obtained_at=excluded.obtained_at, scope=excluded.scope, revoked=0`
      )
      .run(tokens.access_token, tokens.refresh_token ?? null, expiresAt, nowIso(), tokens.scope ?? null);
  }

  revokeOAuth(): void {
    this.db.prepare("UPDATE oauth_tokens SET revoked = 1, access_token = NULL, refresh_token = NULL WHERE account = 'default'").run();
  }

  // ---------------- LM Studio / Qdrant settings (stored in DB, editable via UI) ----------------
  getLmStudio(): { base_url: string; chat_model: string | null; embedding_model: string | null; timeout_ms: number; concurrency: number } {
    return {
      base_url: this.get('lmstudio_base_url', 'http://127.0.0.1:1234'),
      chat_model: this.get<string | null>('lmstudio_chat_model', null),
      embedding_model: this.get<string | null>('lmstudio_embedding_model', null),
      timeout_ms: this.get('lmstudio_timeout_ms', 120000),
      concurrency: this.get('lmstudio_concurrency', 2)
    };
  }

  updateLmStudio(patch: { base_url?: string; chat_model?: string | null; embedding_model?: string | null; timeout_ms?: number; concurrency?: number }): void {
    if (patch.base_url !== undefined) this.set('lmstudio_base_url', patch.base_url);
    if (patch.chat_model !== undefined) this.set('lmstudio_chat_model', patch.chat_model);
    if (patch.embedding_model !== undefined) this.set('lmstudio_embedding_model', patch.embedding_model);
    if (patch.timeout_ms !== undefined) this.set('lmstudio_timeout_ms', patch.timeout_ms);
    if (patch.concurrency !== undefined) this.set('lmstudio_concurrency', patch.concurrency);
  }

  getQdrant(): { url: string; enabled: boolean } {
    return { url: this.get('qdrant_url', 'http://127.0.0.1:6333'), enabled: this.get('qdrant_enabled', true) };
  }

  updateQdrant(patch: { url?: string; enabled?: boolean }): void {
    if (patch.url !== undefined) this.set('qdrant_url', patch.url);
    if (patch.enabled !== undefined) this.set('qdrant_enabled', patch.enabled);
  }

  // ---------------- Index versioning (section 103) ----------------
  getIndexVersions(): { fts_version: number; chunk_version: number; embedding_model: string | null; knowledge_parser_version: number } {
    return {
      fts_version: this.get('fts_version', 0),
      chunk_version: this.get('chunk_version', 0),
      embedding_model: this.get<string | null>('embedding_model', null),
      knowledge_parser_version: this.get('knowledge_parser_version', 0)
    };
  }

  setIndexVersion(key: 'fts_version' | 'chunk_version' | 'embedding_model' | 'knowledge_parser_version', value: number | string | null): void {
    this.set(key, value);
  }
}
