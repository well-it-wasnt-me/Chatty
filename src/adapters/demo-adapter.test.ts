import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig } from '../domain/types.js';
import { DemoAdapter, type DemoSeed } from './demo-adapter.js';

const ACCOUNT: AccountConfig = {
  id: 'demo-test',
  label: 'Demo (test)',
  badge: 'DT',
  platform: 'simplex',
  dataPath: '/tmp/chatty-demo-test',
};

function makeAdapter(): DemoAdapter {
  const seed: DemoSeed = {
    conversations: [
      {
        id: 'c1',
        title: 'First',
        kind: 'group',
        unread: 2,
        messages: [
          { text: 'hi', minutesAgo: 10, direction: 'incoming', sender: 'Sam' },
          { text: 'yo', minutesAgo: 5, direction: 'outgoing' },
        ],
        incomingPool: ['later'],
      },
      {
        id: 'c2',
        title: 'Blocked contact',
        kind: 'direct',
        unread: 0,
        failSends: 'contact not accepted yet',
        messages: [{ text: 'old', minutesAgo: 100, direction: 'incoming', sender: 'Kim' }],
      },
    ],
  };
  return new DemoAdapter(ACCOUNT, seed);
}

describe('DemoAdapter', () => {
  it('transitions status across connect/disconnect', async () => {
    const adapter = makeAdapter();
    expect(adapter.getStatus()).toBe('disconnected');
    const transitions: string[] = [];
    adapter.onStatus?.((change) => transitions.push(change.status));
    await adapter.connect();
    expect(adapter.getStatus()).toBe('connected');
    await adapter.disconnect();
    expect(adapter.getStatus()).toBe('disconnected');
    expect(transitions).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('lists seeded conversations with kinds, as copies', async () => {
    const adapter = makeAdapter();
    const conversations = await adapter.listConversations();
    expect(conversations).toHaveLength(2);
    expect(conversations[0].accountId).toBe(ACCOUNT.id);
    expect(conversations[0].kind).toBe('group');
    conversations[0].unread = 999;
    const fresh = await adapter.listConversations();
    expect(fresh[0].unread).toBe(2);
  });

  it('serves seeded history chronologically and rejects unknown conversations', async () => {
    const adapter = makeAdapter();
    const messages = await adapter.getMessages('c1');
    expect(messages).toHaveLength(2);
    expect(messages[0].timestamp).toBeLessThanOrEqual(messages[1].timestamp);
    await expect(adapter.getMessages('nope')).rejects.toThrow(/Unknown conversation/);
  });

  it('appends outgoing messages and updates last activity', async () => {
    const adapter = makeAdapter();
    const sent = await adapter.sendMessage('c1', 'ping');
    expect(sent.direction).toBe('outgoing');
    expect(sent.state).toBe('sent');
    expect(sent.accountId).toBe(ACCOUNT.id);
    const messages = await adapter.getMessages('c1');
    expect(messages.at(-1)?.text).toBe('ping');
    const conversations = await adapter.listConversations();
    expect(conversations.find((c) => c.id === 'c1')?.lastMessage?.text).toBe('ping');
  });

  it('fails sends honestly for conversations marked failSends', async () => {
    const adapter = makeAdapter();
    await expect(adapter.sendMessage('c2', 'hello?')).rejects.toThrow(
      /contact not accepted yet/,
    );
    // And nothing was appended to history.
    const messages = await adapter.getMessages('c2');
    expect(messages.find((m) => m.text === 'hello?')).toBeUndefined();
  });

  it('clears unread on markRead', async () => {
    const adapter = makeAdapter();
    await adapter.markRead('c1');
    const conversations = await adapter.listConversations();
    expect(conversations.find((c) => c.id === 'c1')?.unread).toBe(0);
  });

  it('declares capabilities honestly', () => {
    const adapter = makeAdapter();
    expect(adapter.capabilities.canSendText).toBe(true);
    expect(adapter.capabilities.canSendAttachments).toBe(false);
    expect(adapter.capabilities.canEditMessages).toBe(false);
    expect(adapter.capabilities.canReact).toBe(false);
    expect(adapter.capabilities.canSearch).toBe(false);
  });

  it('supports unsubscribing message handlers safely', () => {
    const adapter = makeAdapter();
    const unsubscribe = adapter.onMessage(() => {});
    unsubscribe();
    unsubscribe();
  });

  it('plays a seeded auth script: QR scan, then a checked response', async () => {
    const adapter = new DemoAdapter(ACCOUNT, {
      conversations: [],
      authScript: [
        { prompt: { kind: 'qr', data: 'demo://pair' }, advanceAfterMs: 20 },
        { prompt: { kind: 'password', hint: 'demo code is 1234' }, expect: '1234' },
      ],
    });
    const prompts: string[] = [];
    adapter.onAuthPrompt?.((p) => prompts.push(p.kind));
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(prompts).toEqual(['qr']));
    await vi.waitFor(() => expect(prompts).toEqual(['qr', 'password']));
    await expect(adapter.submitAuthResponse?.('0000')).rejects.toThrow(/wrong code/);
    await adapter.submitAuthResponse?.('1234');
    await connecting;
    expect(adapter.getStatus()).toBe('connected');
  });

  it('rejects auth responses when nothing is pending, and cancels on disconnect', async () => {
    const demo = new DemoAdapter(ACCOUNT, { conversations: [] });
    await expect(demo.submitAuthResponse?.('x')).rejects.toThrow(/no auth challenge/);

    const pending = new DemoAdapter(ACCOUNT, {
      conversations: [],
      authScript: [{ prompt: { kind: 'password' }, expect: '1234' }],
    });
    const connecting = pending.connect();
    await vi.waitFor(() => expect(pending.getStatus()).toBe('connecting'));
    await pending.disconnect();
    await expect(connecting).rejects.toThrow(/closed during authentication/);
    expect(pending.getStatus()).toBe('disconnected');
  });
});
