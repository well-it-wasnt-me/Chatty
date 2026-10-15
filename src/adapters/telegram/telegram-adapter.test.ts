import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig, AuthPrompt } from '../../domain/types.js';
import { TelegramAdapter } from './telegram-adapter.js';
import type {
  TelegramClientFactory,
  TelegramClientLike,
  TelegramFactoryOptions,
  TgDialog,
  TgHistoryMessage,
  TgPeer,
} from './types.js';

const ACCOUNT: AccountConfig = {
  id: 'telegram',
  label: 'Telegram',
  badge: 'TG',
  platform: 'telegram',
  dataPath: '/tmp/chatty-tg-test',
};

const DIALOGS: TgDialog[] = [
  {
    id: '777',
    title: 'Alice',
    kind: 'direct',
    unreadCount: 2,
    unreadMentionsCount: 0,
    lastMessage: { id: 11, conversationId: '777', text: 'hi', date: 1_700_000_000, out: false, sender: 'Alice' },
  },
  {
    id: '-1001234',
    title: 'Dev channel',
    kind: 'channel',
    unreadCount: 0,
    unreadMentionsCount: 1,
    lastMessage: { id: 5, conversationId: '-1001234', text: 'release out', date: 1_699_000_000, out: true },
  },
];

class MockTelegramClient implements TelegramClientLike {
  readonly events: Array<(m: TgHistoryMessage) => void> = [];
  disconnected = false;

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }

  async getDialogs(_limit: number): Promise<TgDialog[]> {
    return DIALOGS;
  }

  async getMessages(conversationId: string, _limit: number): Promise<TgHistoryMessage[]> {
    if (conversationId === '777') {
      return [
        { id: 9, conversationId: '777', text: 'older', date: 1_699_999_000, out: false, sender: 'Alice' },
        DIALOGS[0].lastMessage!,
      ];
    }
    return [];
  }

  async sendText(conversationId: string, text: string): Promise<TgHistoryMessage> {
    return { id: 500, conversationId, text, date: 1_700_000_100, out: true };
  }

  async resolvePeer(target: string): Promise<TgPeer> {
    if (target === '@nobody') throw new Error('could not resolve "@nobody" on telegram');
    return { id: '999', title: `Resolved ${target.replace(/^@/, '')}`, kind: 'direct' };
  }

  saveSession(): string {
    return 'mock-session-string';
  }

  onNewMessage(handler: (m: TgHistoryMessage) => void): void {
    this.events.push(handler);
  }

  /** Test helper: simulate an incoming MTProto update. */
  pushIncoming(message: TgHistoryMessage): void {
    for (const handler of this.events) handler(message);
  }
}

function makeAdapter(scenario: (options: TelegramFactoryOptions) => Promise<TelegramClientLike>) {
  const factory: TelegramClientFactory = scenario;
  const prompts: AuthPrompt[] = [];
  const adapter = new TelegramAdapter(ACCOUNT, { apiId: 1, apiHash: 'hash', factory });
  adapter.onAuthPrompt?.((p) => prompts.push(p));
  return { adapter, prompts };
}

describe('TelegramAdapter', () => {
  it('fails loudly without API credentials', async () => {
    const adapter = new TelegramAdapter(ACCOUNT, {});
    await expect(adapter.connect()).rejects.toThrow(/TELEGRAM_API_ID/);
    expect(adapter.getStatus()).toBe('error');
  });

  it('connects with a stored session, no prompts', async () => {
    const { adapter, prompts } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    expect(adapter.getStatus()).toBe('connected');
    expect(prompts).toHaveLength(0);
  });

  it('maps dialogs to conversations with kinds, unread, mentions', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    const conversations = await adapter.listConversations();
    expect(conversations).toHaveLength(2);
    expect(conversations[0]).toMatchObject({ id: '777', title: 'Alice', kind: 'direct', unread: 2 });
    expect(conversations[1]).toMatchObject({ id: '-1001234', kind: 'channel', mentions: 1 });
    expect(conversations[1].lastMessage?.state).toBe('sent');
    expect(conversations[1].lastMessage?.timestamp).toBe(1_699_000_000_000);
  });

  it('serves real history via getMessages and rejects unknown conversations', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    await adapter.listConversations();
    const history = await adapter.getMessages('777');
    expect(history.map((m) => m.id)).toEqual(['9', '11']);
    expect(history[0]).toMatchObject({
      direction: 'incoming',
      sender: 'Alice',
      timestamp: 1_699_999_000_000,
    });
    await expect(adapter.getMessages('nope')).rejects.toThrow(/Unknown conversation/);
  });

  it('sends text and returns the accepted outgoing message', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    await adapter.listConversations();
    const sent = await adapter.sendMessage('777', 'hello there');
    expect(sent).toMatchObject({
      id: '500',
      direction: 'outgoing',
      text: 'hello there',
      state: 'sent',
      timestamp: 1_700_000_100_000,
    });
  });

  it('runs the QR flow: QR prompt rotates, password comes via submitAuthResponse', async () => {
    const client = new MockTelegramClient();
    const { adapter, prompts } = makeAdapter(async (options) => {
      options.onQrCode('tg://login?token=AAA');
      options.onQrCode('tg://login?token=BBB'); // token rotation
      const password = await options.requestPassword('pet name');
      expect(password).toBe('hunter2');
      return client;
    });
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(prompts.map((p) => p.kind)).toEqual(['qr', 'qr', 'password']));
    expect((prompts[0] as { data: string }).data).toBe('tg://login?token=AAA');
    await adapter.submitAuthResponse?.('hunter2');
    await connecting;
    expect(adapter.getStatus()).toBe('connected');
  });

  it('rejects submitAuthResponse when no password is pending', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    await expect(adapter.submitAuthResponse?.('x')).rejects.toThrow(/not waiting/);
  });

  it('routes incoming updates to onMessage and bumps unread', async () => {
    const client = new MockTelegramClient();
    const { adapter } = makeAdapter(async () => client);
    await adapter.connect();
    await adapter.listConversations();
    const received: string[] = [];
    adapter.onMessage((m) => received.push(`${m.sender}:${m.text}`));
    client.pushIncoming({
      id: 12,
      conversationId: '777',
      text: 'ping',
      date: 1_700_001_000,
      out: false,
      sender: 'Alice',
    });
    expect(received).toEqual(['Alice:ping']);
    const conversations = await adapter.listConversations();
    // Dialogs re-read from the client; the cached conversation got the bump earlier.
    expect(conversations.find((c) => c.id === '777')?.unread).toBe(2);
  });

  it('disconnect tears down the client', async () => {
    const client = new MockTelegramClient();
    const { adapter } = makeAdapter(async () => client);
    await adapter.connect();
    await adapter.disconnect();
    expect(client.disconnected).toBe(true);
    expect(adapter.getStatus()).toBe('disconnected');
  });

  it('starts a conversation by @username and reuses the resolved peer', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    const conversation = await adapter.startConversation?.('@alice');
    expect(conversation).toMatchObject({ id: '999', title: 'Resolved alice', kind: 'direct' });
    // Existing peers are returned as-is instead of resolving again.
    const again = await adapter.startConversation?.('alice');
    expect(again?.id).toBe('999');
    // The resolved peer supports sends right away.
    const sent = await adapter.sendMessage('999', 'first!');
    expect(sent.conversationId).toBe('999');
  });

  it('surfaces resolution failures without pretending', async () => {
    const { adapter } = makeAdapter(async () => new MockTelegramClient());
    await adapter.connect();
    await expect(adapter.startConversation?.('@nobody')).rejects.toThrow(/could not resolve/);
  });
});

