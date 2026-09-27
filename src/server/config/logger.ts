/** Structured logging that never logs secrets or full customer content. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  service?: string;
  jobId?: number | string;
  requestId?: string;
  operation?: string;
  errorCode?: string | number;
  [key: string]: unknown;
}

const SENSITIVE_KEYS = /token|secret|password|authorization|apikey|api_key/i;

function scrub(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = SENSITIVE_KEYS.test(k) ? '[redacted]' : v;
  }
  return out;
}

export class StructuredLogger {
  constructor(public level: LogLevel = 'info') {}

  log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...scrub(fields ?? {}) };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(msg: string, fields?: LogFields): void {
    this.log('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log('error', msg, fields);
  }

  child(bound: LogFields): StructuredLogger {
    return new ChildLogger(this.level, bound);
  }
}

class ChildLogger extends StructuredLogger {
  constructor(level: LogLevel, private bound: LogFields) {
    super(level);
  }
  override log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const entry = { ts: new Date().toISOString(), level, msg, ...scrub({ ...this.bound, ...fields }) };
    const line = JSON.stringify(entry);
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export function createLogger(level: LogLevel = 'info'): StructuredLogger {
  return new StructuredLogger(level);
}
