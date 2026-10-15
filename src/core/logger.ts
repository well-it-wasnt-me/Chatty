import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Leveled, structured logger for adapter and service diagnostics.
 *
 * Hard rules (see README "Important engineering rules"):
 * - NEVER log message contents, QR codes, tokens, session keys, or
 *   credentials. Log events with scalar metadata only, e.g.
 *   logger.info('adapter connected', { accountId }). The LogFields
 *   type refuses non-scalar values to make misuse loud instead of silent.
 * - The log file is created with 0600 and its directory with 0700.
 * - Logging must never crash the TUI: write failures disable the sink.
 * We learned this the hard way. You will too if you ignore it.
 */

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} satisfies Record<string, number>;

export type LogLevel = keyof typeof LOG_LEVELS;

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

interface LoggerOptions {
  /** Absolute or relative path of the log file. undefined disables output. */
  filePath?: string;
  minLevel: LogLevel;
  /** Dotted scope prefix, e.g. "service" or "adapter.whatsapp-a". */
  scope?: string;
}

export class Logger {
  private readonly filePath?: string;
  private readonly minLevel: LogLevel;
  private readonly scope: string;
  private enabled: boolean;
  private initialized = false;

  constructor(options: LoggerOptions) {
    this.filePath = options.filePath;
    this.minLevel = options.minLevel;
    this.scope = options.scope ?? '';
    this.enabled = this.filePath !== undefined;
  }

  /** A logger with no sink; useful default for tests and library callers. */
  static silent(): Logger {
    return new Logger({ minLevel: 'error' });
  }

  /** Returns a derived logger that prefixes every line with the scope. */
  child(scope: string): Logger {
    const combined = this.scope === '' ? scope : `${this.scope}.${scope}`;
    const child = new Logger({
      filePath: this.filePath,
      minLevel: this.minLevel,
      scope: combined,
    });
    // Inherit a disabled sink so one failing file disables the whole tree.
    child.enabled = this.enabled;
    return child;
  }

  debug(event: string, fields?: LogFields): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields?: LogFields): void {
    if (!this.enabled || this.filePath === undefined) return;
    if (LOG_LEVELS[level] < LOG_LEVELS[this.minLevel]) return;
    if (!this.ensureSink()) return;
    const record: Record<string, LogFieldValue> = {
      ts: new Date().toISOString(),
      level,
      ...(this.scope === '' ? {} : { scope: this.scope }),
      event,
      ...fields,
    };
    try {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // A broken sink must never take down the UI; drop future writes.
      this.enabled = false;
    }
  }

  /** Creates the directory/file with restrictive permissions, once. */
  private ensureSink(): boolean {
    if (this.initialized) return this.enabled;
    this.initialized = true;
    if (this.filePath === undefined) return false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      appendFileSync(this.filePath, '', { mode: 0o600 });
      // Best-effort hardening when the file/dir pre-existed with loose modes.
      chmodSync(this.filePath, 0o600);
      this.enabled = true;
    } catch {
      this.enabled = false;
    }
    return this.enabled;
  }
}