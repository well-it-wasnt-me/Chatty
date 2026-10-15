import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Logger } from './logger.js';

function tempLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'chatty-log-')), 'chatty.log');
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, 'utf8').trim();
  if (content === '') return [];
  return content.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Logger', () => {
  it('writes structured JSON lines with scope', () => {
    const filePath = tempLogPath();
    const logger = new Logger({ filePath, minLevel: 'info', scope: 'service' });
    logger.info('adapter connected', { accountId: 'telegram', attempts: 2 });
    const [line] = readLines(filePath);
    expect(line.level).toBe('info');
    expect(line.scope).toBe('service');
    expect(line.event).toBe('adapter connected');
    expect(line.accountId).toBe('telegram');
    expect(line.attempts).toBe(2);
    expect(typeof line.ts).toBe('string');
  });

  it('filters events below the minimum level', () => {
    const filePath = tempLogPath();
    const logger = new Logger({ filePath, minLevel: 'warn' });
    logger.debug('too quiet');
    logger.info('still too quiet');
    logger.error('loud enough');
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('loud enough');
  });

  it('creates the log file with restrictive permissions', () => {
    const filePath = tempLogPath();
    const logger = new Logger({ filePath, minLevel: 'info' });
    logger.info('hello');
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('child logger prefixes scope and shares the sink', () => {
    const filePath = tempLogPath();
    const logger = new Logger({ filePath, minLevel: 'debug', scope: 'adapter.whatsapp-a' });
    logger.child('tls').debug('handshake ok');
    const [line] = readLines(filePath);
    expect(line.scope).toBe('adapter.whatsapp-a.tls');
  });

  it('a silent logger and a broken sink never throw', () => {
    Logger.silent().error('dropped');
    // A regular file used as a directory forces a fast ENOTDIR failure
    // (unlike unwritable virtual filesystems, which can stall syscalls).
    const blocker = join(mkdtempSync(join(tmpdir(), 'chatty-log-')), 'blocker');
    appendFileSync(blocker, '', { mode: 0o600 });
    const logger = new Logger({ filePath: join(blocker, 'chatty.log'), minLevel: 'info' });
    logger.info('dropped without crashing');
    logger.child('nested').error('also dropped without crashing');
  });
});
