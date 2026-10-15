import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('provides one entry per account with isolated paths', () => {
    const config = loadConfig({});
    expect(config.accounts.map((a) => a.id)).toEqual([
      'whatsapp-a',
      'whatsapp-b',
      'telegram',
      'simplex',
      'slack',
    ]);
    const paths = new Set(config.accounts.map((a) => a.dataPath));
    expect(paths.size).toBe(config.accounts.length);
  });

  it('keeps the two WhatsApp accounts on separate data paths', () => {
    const config = loadConfig({});
    const a = config.accounts.find((x) => x.id === 'whatsapp-a');
    const b = config.accounts.find((x) => x.id === 'whatsapp-b');
    expect(a?.dataPath).not.toBe(b?.dataPath);
    expect(a?.platform).toBe('whatsapp');
    expect(b?.platform).toBe('whatsapp');
  });

  it('places account data paths under the configured data dir', () => {
    const config = loadConfig({ CHATTY_DATA_DIR: '/tmp/chatty-data' });
    expect(config.dataDir).toBe('/tmp/chatty-data');
    for (const account of config.accounts) {
      expect(account.dataPath.startsWith(`${config.dataDir}/`)).toBe(true);
    }
  });

  it('defaults to real mode; demo is explicit opt-in', () => {
    expect(loadConfig({}).mode).toBe('real');
    expect(loadConfig({ CHATTY_MODE: 'real' }).mode).toBe('real');
    expect(loadConfig({ CHATTY_MODE: 'demo' }).mode).toBe('demo');
  });

  it('lets CLI flags override the mode', () => {
    expect(loadConfig({ CHATTY_MODE: 'real' }, { mode: 'demo' }).mode).toBe('demo');
  });

  it('parses log level case-insensitively and defaults to info', () => {
    expect(loadConfig({}).logLevel).toBe('info');
    expect(loadConfig({ CHATTY_LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
  });

  it('fails fast on an invalid log level with a clear message', () => {
    expect(() => loadConfig({ CHATTY_LOG_LEVEL: 'loud' })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ CHATTY_MODE: 'pretend' })).toThrow(/Invalid configuration/);
  });

  it('resolves the default log file under the data dir', () => {
    const config = loadConfig({ CHATTY_DATA_DIR: '/tmp/chatty-data' });
    expect(config.logFile).toBe('/tmp/chatty-data/chatty.log');
  });
});
