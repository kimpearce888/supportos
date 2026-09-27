import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';

dotenv.config();

const root = process.cwd();

function envStr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : fallback;
}
function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v == null) return fallback;
  return v.trim().toLowerCase() === 'true';
}

function ensureDir(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

export interface AppConfig {
  env: 'development' | 'production' | 'test';
  port: number;
  host: string;
  localAppUrl: string;
  databasePath: string;
  attachmentsPath: string;
  backupsPath: string;
  demoMode: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  helpscout: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    apiBase: string;
    webhookSecret: string;
  };
  lmstudio: {
    baseUrl: string;
    chatModel: string | null;
    embeddingModel: string | null;
    timeoutMs: number;
    concurrency: number;
  };
  qdrant: {
    url: string;
    enabled: boolean;
  };
  sync: {
    intervalMinutes: number;
    apiConcurrency: number;
  };
}

export function loadConfig(): AppConfig {
  const databasePath = envStr('DATABASE_PATH', './data/supportos.db');
  const dbAbs = path.isAbsolute(databasePath) ? databasePath : path.resolve(root, databasePath);
  fs.mkdirSync(path.dirname(dbAbs), { recursive: true });

  return {
    env: (envStr('NODE_ENV', 'development') as AppConfig['env']) ?? 'development',
    port: envInt('PORT', 3000),
    host: envStr('HOST', '127.0.0.1'),
    localAppUrl: envStr('LOCAL_APP_URL', 'http://localhost:3000'),
    databasePath: dbAbs,
    attachmentsPath: ensureDir(envStr('ATTACHMENTS_PATH', './data/attachments')),
    backupsPath: ensureDir('./backups'),
    demoMode: envBool('LOCAL_DEMO_MODE', false),
    logLevel: envStr('LOG_LEVEL', 'info') as AppConfig['logLevel'],
    helpscout: {
      clientId: envStr('HELPSCOUT_CLIENT_ID', ''),
      clientSecret: envStr('HELPSCOUT_CLIENT_SECRET', ''),
      redirectUri: envStr('HELPSCOUT_REDIRECT_URI', 'http://localhost:3000/oauth/callback'),
      apiBase: envStr('HELPSCOUT_API_BASE', 'https://api.helpscout.net'),
      webhookSecret: envStr('HELPSCOUT_WEBHOOK_SECRET', '')
    },
    lmstudio: {
      baseUrl: envStr('LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234'),
      chatModel: process.env.LMSTUDIO_CHAT_MODEL?.trim() || null,
      embeddingModel: process.env.LMSTUDIO_EMBEDDING_MODEL?.trim() || null,
      timeoutMs: envInt('LMSTUDIO_TIMEOUT_MS', 120000),
      concurrency: envInt('LMSTUDIO_CONCURRENCY', 2)
    },
    qdrant: {
      url: envStr('QDRANT_URL', 'http://127.0.0.1:6333'),
      enabled: envBool('QDRANT_ENABLED', true)
    },
    sync: {
      intervalMinutes: envInt('SYNC_INTERVAL_MINUTES', 5),
      apiConcurrency: envInt('SYNC_API_CONCURRENCY', 2)
    }
  };
}

export const config = loadConfig();
