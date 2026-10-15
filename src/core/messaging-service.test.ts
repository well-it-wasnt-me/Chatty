import { describe, expect, it, vi } from 'vitest';
import type {
  AccountConfig,
  AdapterCapabilities,
  AdapterStatus,
  AdapterStatusChange,
  AuthPrompt,
  Conversation,
  Message,
  MessagingAdapter,
} from '../domain/types.js';
import { MessagingService } from './messaging-service.js';

const FULL_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false,
  canEditMessages: false,
  canReact: false,
  canFetchHistory: true,
  canSearch: false,
  canStartConversations: false,
};

function account(accountId: string): AccountConfig {
  return {
    id: accountId,
    label: accountId,
    badge: accountId.toUpperCase(),
    platform: 'simplex',
    dataPath: `/tmp/chatty-test-${accountId}`,
  };
}

interface StubOptions {
  failConnect?: boolean;
  conversations?: Conversation[];
  capabilities?: AdapterCapabilities;
}

/** Minimal controllable adapter for exercising the service contract. */
class StubAdapter implements MessagingAdapter {
  readonly account: AccountConfig;
  readonly capabilities: AdapterCapabilities;
  readonly transport = 'demo' as const;
  private status: AdapterStatus = 'disconnected';
  private readonly failConnect: boolean;
  private readonly conversations: Conversation[];
  private readonly handlers = new Set<(message: Message) => void>();
  private readonly authHandlers = new Set<(prompt: AuthPrompt) => void>();
  private readonly statusHandlers = new Set<(change: AdapterStatusChange) => void>();
  connectCalls = 0;
  answer?: (response: string) => Promise<void>;
  startedTargets: string[] = [];

  constructor(accountId: string, options: StubOptions = {}) {
    this.account = account(accountId);
    this.capabilities = options.capabilities ?? FULL_CAPABILITIES;
    this.failConnect = options.failConnect ?? false;
    this.conversations = options.conversations ?? [];
  }

  getStatus(): AdapterStatus {
    return this.status;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failConnect) {
      this.setStatusLocal('error');
      throw new Error('stub connect failure');
    }
    this.setStatusLocal('connected');
  }

  async disconnect(): Promise<void> {
    this.setStatusLocal('disconnected');
  }

  onStatus(handler: (change: AdapterStatusChange) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  private setStatusLocal(status: AdapterStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler({ status });
  }

  async listConversations(): Promise<Conversation[]> {
    return this.conversations;
  }

  async getMessages(_conversationId: string): Promise<Message[]> {
    return [];
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    return {
      id: `out-${text}`,
      accountId: this.account.id,
      conversationId,
      direction: 'outgoing',
      timestamp: Date.now(),
      text,
      state: 'sent',
    };
  }

  onMessage(handler: (message: Message) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onAuthPrompt(handler: (prompt: AuthPrompt) => void): () => void {
    this.authHandlers.add(handler);
    return () => {
      this.authHandlers.delete(handler);
    };
  }

  async submitAuthResponse(response: string): Promise<void> {
    if (this.answer) return this.answer(response);
    throw new Error('not waiting for an auth response');
  }

  /** Test helper: simulate an auth challenge. */
  emitAuth(prompt: AuthPrompt): void {
    for (const handler of this.authHandlers) handler(prompt);
  }

  /** Test helper: simulate an incoming platform event. */
  emit(message: Message): void {
    for (const handler of this.handlers) handler(message);
  }
}

function incomingMessage(id: string, timestamp = Date.now()): Message {
  return {
    id,
    accountId: 'ignored',
    conversationId: 'c1',
    direction: 'incoming',
    timestamp,
    text: 'event',
  };
}

function conversation(id: string, accountId: string, timestamp: number): Conversation {
  return {
    id,
    accountId,
    title: id,
    unread: 0,
    lastMessage: { ...incomingMessage(`${id}-m`, timestamp), accountId },
  };
}

describe('MessagingService', () => {
  it('rejects duplicate account ids', () => {
    const service = new MessagingService();
    service.register(new StubAdapter('a'));
    expect(() => service.register(new StubAdapter('a'))).toThrow(/Duplicate account id/);
  });

  it('deduplicates incoming events across replays', () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('a');
    service.register(adapter);
    const received: Message[] = [];
    service.onMessage((m) => received.push(m));
    adapter.emit(incomingMessage('m1'));
    adapter.emit(incomingMessage('m1')); // platform replay after reconnect
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe('m1');
  });

  it('scopes message ids per account, never globally', () => {
    const service = new MessagingService();
    const a = new StubAdapter('acct-a');
    const b = new StubAdapter('acct-b');
    service.register(a);
    service.register(b);
    const received: Message[] = [];
    service.onMessage((m) => received.push(m));
    a.emit(incomingMessage('42'));
    b.emit(incomingMessage('42'));
    expect(received).toHaveLength(2);
    expect(received.map((m) => m.accountId)).toEqual(['acct-a', 'acct-b']);
  });

  it('routes outgoing messages through the dispatch pipeline once', async () => {
    const service = new MessagingService();
    service.register(new StubAdapter('a'));
    const received: Message[] = [];
    service.onMessage((m) => received.push(m));
    const sent = await service.sendMessage('a', 'c1', 'hello');
    expect(sent.direction).toBe('outgoing');
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(sent.id);
  });

  it('surfaces unsupported capabilities as explicit errors', async () => {
    const service = new MessagingService();
    service.register(
      new StubAdapter('a', {
        capabilities: { ...FULL_CAPABILITIES, canSendText: false, canFetchHistory: false },
      }),
    );
    await expect(service.sendMessage('a', 'c1', 'hi')).rejects.toThrow(
      /does not support sending text/,
    );
    await expect(service.getMessages('a', 'c1')).rejects.toThrow(
      /does not support fetching history/,
    );
  });

  it('fails loudly on unknown accounts', async () => {
    const service = new MessagingService();
    await expect(service.getMessages('ghost', 'c1')).rejects.toThrow(/Unknown account/);
    await expect(service.sendMessage('ghost', 'c1', 'hi')).rejects.toThrow(/Unknown account/);
    await expect(service.markRead('ghost', 'c1')).rejects.toThrow(/Unknown account/);
  });

  it('merges conversations from all adapters, newest activity first', async () => {
    const service = new MessagingService();
    service.register(new StubAdapter('a', { conversations: [conversation('old', 'a', 1000)] }));
    service.register(new StubAdapter('b', { conversations: [conversation('new', 'b', 2000)] }));
    const conversations = await service.listConversations();
    expect(conversations.map((c) => c.id)).toEqual(['new', 'old']);
  });

  it(
    'connectAll isolates failures, reports status, retries boundedly',
    { timeout: 10_000 },
    async () => {
      const service = new MessagingService();
      const good = new StubAdapter('good');
      const bad = new StubAdapter('bad', { failConnect: true });
      service.register(good);
      service.register(bad);
      const statuses: Array<{ accountId: string; status: AdapterStatus }> = [];
      service.onStatus((change) => statuses.push(change));
      await expect(service.connectAll()).rejects.toThrow(/1 adapter\(s\) failed to connect/);
      expect(good.getStatus()).toBe('connected');
      expect(bad.connectCalls).toBe(3);
      expect(statuses.some((s) => s.accountId === 'bad' && s.status === 'error')).toBe(true);
    },
  );

  it('reconnects a single account with retry and keeps others up', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('a');
    service.register(adapter);
    await adapter.connect();
    expect(adapter.getStatus()).toBe('connected');
    await service.reconnect('a');
    expect(adapter.getStatus()).toBe('connected');
    expect(adapter.connectCalls).toBe(2);
    await expect(service.reconnect('ghost')).rejects.toThrow(/Unknown account/);
  });

  it('disconnectAll is idempotent and unsubscribes adapter events', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('a');
    service.register(adapter);
    const received: Message[] = [];
    service.onMessage((m) => received.push(m));
    await service.disconnectAll();
    adapter.emit(incomingMessage('after-shutdown'));
    expect(received).toHaveLength(0);
    await service.disconnectAll(); // second call must be a no-op
  });

  it('forwards adapter auth prompts with the account id', () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('tg');
    service.register(adapter);
    const challenges: Array<{ accountId: string; kind: string }> = [];
    service.onAuthPrompt((c) => challenges.push({ accountId: c.accountId, kind: c.prompt.kind }));
    adapter.emitAuth({ kind: 'qr', data: 'tg://login?token=x' });
    adapter.emitAuth({ kind: 'password', hint: 'home' });
    expect(challenges).toEqual([
      { accountId: 'tg', kind: 'qr' },
      { accountId: 'tg', kind: 'password' },
    ]);
  });

  it('replays pending auth challenges to late subscribers (UI mount race)', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('slack');
    service.register(adapter);
    adapter.emitAuth({ kind: 'text', label: 'token' }); // emitted BEFORE anyone subscribes
    const late: Array<{ accountId: string; kind: string }> = [];
    service.onAuthPrompt((c) => late.push({ accountId: c.accountId, kind: c.prompt.kind }));
    await vi.waitFor(() =>
      expect(late).toEqual([{ accountId: 'slack', kind: 'text' }]),
    );
  });

  it('clears pending auth challenges when the account reaches a terminal state', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('wa2');
    service.register(adapter);
    adapter.emitAuth({ kind: 'qr', data: 'x' });
    await adapter.connect(); // connected clears the prompt (via onStatus)
    const late: unknown[] = [];
    service.onAuthPrompt((c) => late.push(c));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(late).toHaveLength(0);
  });

  it('passes auth responses through to the adapter, never logging them', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('wa');
    service.register(adapter);
    let received = '';
    adapter.answer = (response) => {
      received = response;
      return Promise.resolve();
    };
    await service.submitAuthResponse('wa', 'spicy secret');
    expect(received).toBe('spicy secret');
    await expect(service.submitAuthResponse('ghost', 'x')).rejects.toThrow(/Unknown account/);
  });

  it('connectAccount connects one registered account with retry', async () => {
    const service = new MessagingService();
    const good = new StubAdapter('good');
    const bad = new StubAdapter('bad', { failConnect: true });
    service.register(good);
    service.register(bad);
    await service.connectAccount('good');
    expect(good.getStatus()).toBe('connected');
    await expect(service.connectAccount('bad')).rejects.toThrow(/bad/);
    expect(bad.connectCalls).toBe(3);
    expect(good.getStatus()).toBe('connected'); // unaffected
  });

  it('fires onAccountsChanged on register and unregister', async () => {
    const service = new MessagingService();
    const events: string[] = [];
    service.onAccountsChanged(() => events.push('changed'));
    const adapter = new StubAdapter('new');
    service.register(adapter);
    expect(events).toHaveLength(1);
    await service.unregister('new');
    expect(events).toHaveLength(2);
    expect(service.getAccounts().map((a) => a.id)).toEqual([]);
  });

  it('unregister stops event flow and disconnects the adapter', async () => {
    const service = new MessagingService();
    const adapter = new StubAdapter('gone');
    service.register(adapter);
    const received: Message[] = [];
    service.onMessage((m) => received.push(m));
    await adapter.connect();
    await service.unregister('gone');
    adapter.emit(incomingMessage('ghost-message'));
    expect(received).toHaveLength(0);
    expect(adapter.getStatus()).toBe('disconnected');
    await expect(service.getMessages('gone', 'c1')).rejects.toThrow(/Unknown account/);
  });
});
