import type { DB } from '../../database/connection.js';
import { HelpScoutHttpClient, HelpScoutApiError } from './client.js';

export interface OAuthStatus {
  configured: boolean;
  authenticated: boolean;
  expiresAt: string | null;
  demoMode: boolean;
}

/**
 * HelpScoutAuthService - OAuth 2.0 (Authorization Code + Client Credentials flows).
 * Tokens live ONLY in the server-side oauth_tokens table; secrets come from env.
 * Current documented endpoints:
 *   authorize: https://secure.helpscout.net/authentication/authorizeClientApplication?client_id=..&state=..
 *   token:     POST https://api.helpscout.net/v2/oauth2/token (form-encoded)
 */
export class HelpScoutAuthService {
  constructor(
    private http: HelpScoutHttpClient,
    private db: DB,
    private credentials: { clientId: string; clientSecret: string; redirectUri: string; apiBase: string }
  ) {}

  isConfigured(): boolean {
    return this.credentials.clientId.length > 0 && this.credentials.clientSecret.length > 0;
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({ client_id: this.credentials.clientId, state });
    return `https://secure.helpscout.net/authentication/authorizeClientApplication?${params.toString()}`;
  }

  private row(): { access_token: string | null; refresh_token: string | null; expires_at: string | null; revoked: number } | undefined {
    return this.db.prepare("SELECT access_token, refresh_token, expires_at, revoked FROM oauth_tokens WHERE account='default'").get() as
      | { access_token: string | null; refresh_token: string | null; expires_at: string | null; revoked: number }
      | undefined;
  }

  async getAccessToken(): Promise<string | null> {
    const row = this.row();
    if (!row || row.revoked || !row.access_token) return null;
    const expiresSoon = row.expires_at ? new Date(row.expires_at).getTime() < Date.now() + 120_000 : true;
    if (!expiresSoon) return row.access_token;
    if (row.refresh_token) {
      try {
        return await this.refreshTokens(row.refresh_token);
      } catch {
        return null;
      }
    }
    return row.access_token;
  }

  async exchangeCode(code: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    return this.tokenRequest({ grant_type: 'authorization_code', code });
  }

  async refreshTokens(refreshToken: string): Promise<string> {
    const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    this.saveTokens(tokens);
    return tokens.access_token;
  }

  /** Client Credentials flow: simplest for a personal internal integration (documented). */
  async clientCredentialsLogin(): Promise<{ access_token: string; expires_in?: number }> {
    return this.tokenRequest({ grant_type: 'client_credentials' });
  }

  private async tokenRequest(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const res = await fetch(`${this.credentials.apiBase}/v2/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...form,
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret
      }).toString(),
      signal: AbortSignal.timeout(20_000)
    });
    if (!res.ok) {
      throw new HelpScoutApiError(res.status, `OAuth token request failed (${res.status})`, 'Help Scout rejected the login credentials. Check your Client ID/Secret in Settings, then try connecting again.', null, false);
    }
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  saveTokens(tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }): void {
    this.db
      .prepare(
        `INSERT INTO oauth_tokens (account, access_token, refresh_token, token_type, expires_at, obtained_at, scope, revoked)
         VALUES ('default', ?, ?, 'bearer', ?, datetime('now'), ?, 0)
         ON CONFLICT(account) DO UPDATE SET access_token=excluded.access_token,
           refresh_token=COALESCE(excluded.refresh_token, refresh_token), expires_at=excluded.expires_at,
           obtained_at=datetime('now'), scope=excluded.scope, revoked=0`
      )
      .run(
        tokens.access_token,
        tokens.refresh_token ?? null,
        new Date(Date.now() + (tokens.expires_in ?? 172800) * 1000).toISOString(),
        tokens.scope ?? null
      );
  }

  async revoke(): Promise<void> {
    this.db.prepare("UPDATE oauth_tokens SET revoked = 1, access_token = NULL, refresh_token = NULL WHERE account = 'default'").run();
  }

  status(demoMode: boolean): OAuthStatus {
    const row = this.row();
    return {
      configured: this.isConfigured(),
      authenticated: !!row && !row.revoked && !!row.access_token,
      expiresAt: row?.expires_at ?? null,
      demoMode
    };
  }
}
