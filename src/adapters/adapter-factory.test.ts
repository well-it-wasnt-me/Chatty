import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/config.js';
import type { AccountConfig } from '../domain/types.js';
import { DemoAdapter } from './demo-adapter.js';
import { SimplexAdapter } from './simplex/simplex-adapter.js';
import { createAdapterForAccount, createAdapters, nextSimplexCliPort } from './adapter-factory.js';
import { WhatsAppAdapter } from './whatsapp/whatsapp-adapter.js';
import { deriveBadge, providerChoices } from '../ui/overlays/AddAccountPage.js';

describe('createAdapters (builtins)', () => {
  it('creates real adapters for all five accounts by default', () => {
    const adapters = createAdapters(loadConfig({}));
    expect(adapters).toHaveLength(5);
    expect(adapters.every((a) => !(a instanceof DemoAdapter))).toBe(true);
    expect(adapters.filter((a) => a instanceof WhatsAppAdapter)).toHaveLength(2);
    expect(adapters.filter((a) => a instanceof SimplexAdapter)).toHaveLength(1);
  });

  it('creates demo adapters for all five accounts in demo mode, honoring the demo auth script', () => {
    const adapters = createAdapters(loadConfig({ CHATTY_MODE: 'demo', CHATTY_DEMO_AUTH: 'whatsapp-a' }));
    expect(adapters).toHaveLength(5);
    expect(adapters.every((a) => a instanceof DemoAdapter)).toBe(true);
  });

  it('lets a per-platform override pin one platform to demo inside real mode', () => {
    const config = loadConfig({ CHATTY_SIMPLEX_IMPL: 'demo', CHATTY_SIMPLEX_PORT: '5400' });
    const adapters = createAdapters(config);
    expect(adapters.filter((a) => a instanceof DemoAdapter)).toHaveLength(1);
    expect(adapters.find((a) => a.account.id === 'simplex')).toBeInstanceOf(DemoAdapter);
  });

  it('gives whatsapp-a and whatsapp-b independent adapter instances for baileys', () => {
    const adapters = createAdapters(loadConfig({ CHATTY_WHATSAPP_IMPL: 'baileys' }));
    const wa = adapters.filter((a) => a.account.platform === 'whatsapp');
    expect(wa).toHaveLength(2);
    expect(wa.every((a) => a instanceof WhatsAppAdapter)).toBe(true);
    expect(wa[0].account.id).toBe('whatsapp-a');
    expect(wa[1].account.id).toBe('whatsapp-b');
    // Never share auth state: distinct adapter objects and data paths.
    expect(wa[0]).not.toBe(wa[1]);
    expect(wa[0].account.dataPath).not.toBe(wa[1].account.dataPath);
  });
});

describe('createAdapterForAccount (runtime-added accounts)', () => {
  const base: AccountConfig = {
    id: 'custom-slack-x9',
    label: "Bob's Slack",
    badge: 'BS',
    platform: 'slack',
    dataPath: '/tmp/chatty-x9',
  };

  it('gives a demo adapter with a generic sandbox seed for demo accounts', async () => {
    const adapter = createAdapterForAccount(base, 'demo', undefined, { allowDemo: true });
    expect(adapter).toBeInstanceOf(DemoAdapter);
    const conversations = await adapter.listConversations();
    expect(conversations[0]?.title).toBe('Demo contact');
  });

  it('fails loudly for a transport the platform does not have', () => {
    expect(() => createAdapterForAccount(base, 'gramjs', undefined)).toThrow(
      /no gramjs adapter for slack accounts/,
    );
  });

  it('gives the real SimpleX adapter for a cli simplex account on a fresh port', () => {
    const adapter = createAdapterForAccount(
      { ...base, platform: 'simplex' },
      'cli',
      undefined,
      { simplexPort: nextSimplexCliPort(5225, 1) },
    );
    expect(adapter).toBeInstanceOf(SimplexAdapter);
  });
});

describe('port allocation', () => {
  it('allocates a fresh port per extra CLI instance', () => {
    expect(nextSimplexCliPort(5225, 0)).toBe(5226);
    expect(nextSimplexCliPort(5225, 3)).toBe(5229);
  });
});

describe('accounts page helpers', () => {
  it('derives compact badges from labels', () => {
    expect(deriveBadge("Bob's Work Slack")).toBe('BWS');
    expect(deriveBadge('alice')).toBe('A');
    expect(deriveBadge('   ')).toBe('??');
    expect(deriveBadge('one two three four five')).toBe('OTTF');
  });

  it('lists real transports per platform honestly', () => {
    const withoutCreds = providerChoices();
    const real = withoutCreds.filter((c) => c.transport !== 'demo');
    expect(real.map((c) => `${c.platform}:${c.transport}`)).toEqual([
      'simplex:cli',
      'whatsapp:baileys',
      'slack:socket',
    ]);
    // Telegram's real transport requires API credentials in env.
    expect(withoutCreds.some((c) => c.transport === 'gramjs')).toBe(false);
    const withCreds = providerChoices({ telegramReal: true });
    expect(withCreds.some((c) => c.transport === 'gramjs')).toBe(true);
    expect(withCreds.find((c) => c.transport === 'gramjs')?.note).toContain('2FA');
  });

  it('hides demo transports in real mode', () => {
    const real = providerChoices({ telegramReal: true, demoTransports: false });
    expect(real.every((c) => c.transport !== 'demo')).toBe(true);
    expect(real.map((c) => `${c.platform}:${c.transport}`)).toEqual([
      'simplex:cli',
      'telegram:gramjs',
      'whatsapp:baileys',
      'slack:socket',
    ]);
  });
});
