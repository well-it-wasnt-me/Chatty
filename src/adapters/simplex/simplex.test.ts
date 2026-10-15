import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig } from '../../domain/types.js';
import type { ChildProcess } from 'node:child_process';
import {
  cmdActiveUser,
  cmdGetChats,
  cmdSendText,
  conversationRef,
  mapChat,
  mapChatItem,
  mapStatus,
  msgContentText,
  parseEnvelope,
  type SxAChat,
  type SxAChatItem,
} from './protocol.js';
import { SimplexAdapter } from './simplex-adapter.js';
import type { SocketFactory, SocketHandlers, SpawnOptions } from './transport.js';

const ACCOUNT: AccountConfig = {
  id: 'simplex',
  label: 'SimpleX',
  badge: 'SimpleX',
  platform: 'simplex',
  dataPath: '/tmp/chatty-simplex-test',
};

// ------------------------------------------------------------- fixtures

const USER = { userId: 7, localDisplayName: 'me' };

function directInfo(contactId: number, name: string) {
  return { type: 'direct', contact: { contactId, localDisplayName: name } };
}

function incomingItem(contactId: number, name: string, itemId: number, text: string, ts: string): SxAChatItem {
  return {
    chatInfo: directInfo(contactId, name),
    chatItem: {
      chatDir: { type: 'directRcv' },
      meta: {
        itemId,
        itemTs: ts,
        itemText: text,
        itemStatus: { type: 'rcvNew' },
        itemEdited: false,
      },
      content: { type: 'rcvMsgContent', msgContent: { type: 'text', text } },
    },
  } as unknown as SxAChatItem;
}

const CHATS_FIXTURE: SxAChat[] = [
  {
    chatInfo: directInfo(3, 'Alice'),
    chatItems: [incomingItem(3, 'Alice', 101, 'hey there', '2026-10-14T10:00:00Z').chatItem],
    chatStats: { unreadCount: 2, unreadMentions: 0, reportsCount: 0, minUnreadItemId: 100, unreadChat: false },
  },
  {
    chatInfo: { type: 'group', groupInfo: { groupId: 9, localDisplayName: 'Team' } },
    chatItems: [
      {
        chatDir: { type: 'groupRcv', groupMember: { memberProfile: { displayName: 'Bob' } } },
        meta: { itemId: 55, itemTs: '2026-10-14T09:00:00Z', itemText: 'standup at 9', itemStatus: { type: 'rcvNew' }, itemEdited: false },
        content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'standup at 9' } },
      },
    ],
    chatStats: { unreadCount: 0, unreadMentions: 1, reportsCount: 0, minUnreadItemId: 0, unreadChat: false },
  },
] as unknown as SxAChat[];

// ------------------------------------------------------------- fakes

class FakeSocket {
  private handler?: SocketHandlers;
  /** Test hook: completes when the Nth command has been sent. */
  private readonly waiters: Array<{ count: number; resolve(): void }> = [];
  sentCount = 0;

  constructor(private readonly responder: (cmd: string) => Record<string, unknown>) {}

  attach(handlers: SocketHandlers): this {
    this.handler = handlers;
    queueMicrotask(() => this.handler?.onOpen());
    return this;
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as { corrId: string; cmd: string };
    this.sentCount += 1;
    const resp = this.responder(parsed.cmd);
    queueMicrotask(() => {
      this.handler?.onMessage(JSON.stringify({ corrId: parsed.corrId, resp }));
      const atCount = this.waiters.filter((w) => w.count <= this.sentCount);
      atCount.forEach((w) => w.resolve());
    });
  }

  /** Server-initiated event push. */
  emitEvent(resp: Record<string, unknown>): void {
    queueMicrotask(() => this.handler?.onMessage(JSON.stringify({ resp })));
  }

  waitForCommands(count: number): Promise<void> {
    if (this.sentCount >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  close(): void {
    this.handler?.onClose(1000, 'bye');
  }
}

interface FakeSetup {
  adapter: SimplexAdapter;
  socket: FakeSocket;
  spawnArgs(): SpawnOptions | undefined;
}

function fakeChatServer(responder: (cmd: string) => Record<string, unknown>): FakeSetup {
  const socket = new FakeSocket(responder);
  let capturedSpawn: SpawnOptions | undefined;
  const socketFactory: SocketFactory = (_url, handlers) => socket.attach(handlers);
  const spawner = (options: SpawnOptions): ChildProcess => {
    capturedSpawn = options;
    return { on: () => undefined, once: () => undefined, kill: () => true, exitCode: 0 } as unknown as ChildProcess;
  };
  const adapter = new SimplexAdapter(ACCOUNT, {
    binary: 'simplex-chat',
    dbPathPrefix: '/tmp/chatty-simplex-test/simplex_v1',
    displayName: 'me',
    port: 59999,
    socketFactory,
    spawner,
  });
  return { adapter, socket, spawnArgs: () => capturedSpawn };
}

function defaultResponder(cmd: string): Record<string, unknown> {
  if (cmd === cmdActiveUser()) return { type: 'activeUser', user: USER };
  if (cmd.startsWith('/_get chats')) return { type: 'apiChats', user: USER, chats: CHATS_FIXTURE };
  if (cmd.startsWith('/_send')) return { type: 'newChatItems', user: USER, chatItems: [] };
  return { type: 'cmdOk' };
}

// ------------------------------------------------------------- protocol unit tests

describe('simplex protocol mapping', () => {
  it('parses command/response and event envelopes', () => {
    expect(parseEnvelope('{"corrId":"4","resp":{"type":"cmdOk"}}')).toMatchObject({ corrId: '4' });
    expect(parseEnvelope('{"resp":{"type":"newChatItems"}}')?.corrId).toBeUndefined();
    expect(parseEnvelope('not json')).toBeUndefined();
    expect(parseEnvelope('{"noResp":true}')).toBeUndefined();
  });

  it('builds verified command strings', () => {
    expect(cmdActiveUser()).toBe('/user');
    expect(cmdGetChats(7, 50)).toBe(
      '/_get chats 7 count=50 {"type":"filters","favorite":false,"unread":false}',
    );
    expect(cmdSendText('@3', 'hello')).toBe(
      '/_send @3 json [{"msgContent":{"type":"text","text":"hello"},"mentions":{}}]',
    );
    expect(() => cmdSendText('bogus', 'x')).toThrow(/chat reference/);
  });

  it('maps chats to conversations with unread counts and kinds', () => {
    const conv = mapChat('simplex', CHATS_FIXTURE[0]);
    expect(conv).toMatchObject({
      id: '@3',
      accountId: 'simplex',
      title: 'Alice',
      kind: 'direct',
      unread: 2,
    });
    expect(conv?.lastMessage?.text).toBe('hey there');
    const group = mapChat('simplex', CHATS_FIXTURE[1]);
    expect(group).toMatchObject({ id: '#9', kind: 'group', unread: 0, mentions: 1 });
  });

  it('maps items to messages with direction, sender, state', () => {
    const msg = mapChatItem('simplex', '@3', 'me', incomingItem(3, 'Alice', 101, 'hey there', '2026-10-14T10:00:00Z'));
    expect(msg).toMatchObject({
      id: '101',
      conversationId: '@3',
      direction: 'incoming',
      sender: 'Alice',
      text: 'hey there',
    });
    expect(msg.timestamp).toBe(Date.parse('2026-10-14T10:00:00Z'));
  });

  it('maps delivery statuses and text extraction', () => {
    expect(mapStatus('sndNew')).toBe('pending');
    expect(mapStatus('sndSent')).toBe('sent');
    expect(mapStatus('sndRcvd')).toBe('delivered');
    expect(mapStatus('sndErrorAuth')).toBe('failed');
    expect(mapStatus('rcvRead')).toBeUndefined();
    expect(msgContentText({ type: 'text', text: 'hi' })).toBe('hi');
    expect(msgContentText({ type: 'image' })).toBe('[image]');
  });

  it('derives refs only for chats we model', () => {
    expect(conversationRef(directInfo(3, 'A') as never)).toBe('@3');
    expect(
      conversationRef({ type: 'group', groupInfo: { groupId: 9, localDisplayName: 'T' } } as never),
    ).toBe('#9');
  });
});

// ------------------------------------------------------------- adapter tests

describe('SimplexAdapter', () => {
  async function connected(): Promise<FakeSetup> {
    const setup = fakeChatServer(defaultResponder);
    await setup.adapter.connect();
    return setup;
  }

  it('spawns the CLI with the account data path and connects', async () => {
    const setup = await connected();
    expect(setup.adapter.getStatus()).toBe('connected');
    const args = setup.spawnArgs();
    expect(args?.binary).toBe('simplex-chat');
    expect(args?.args).toContain('-d');
    expect(args?.args).toContain('/tmp/chatty-simplex-test/simplex_v1');
    expect(args?.args).toContain('--user-display-name');
  });

  it('lists conversations from apiChats with mapping applied', async () => {
    const setup = await connected();
    const conversations = await setup.adapter.listConversations();
    expect(conversations.map((c) => c.id)).toEqual(['@3', '#9']);
    expect(conversations[0].unread).toBe(2);
    expect(conversations[1].kind).toBe('group');
  });

  it('serves history from accumulated items and previews', async () => {
    const setup = await connected();
    await setup.adapter.listConversations();
    const history = await setup.adapter.getMessages('@3');
    expect(history.map((m) => m.text)).toEqual(['hey there']);
    await expect(setup.adapter.getMessages('@999')).rejects.toThrow(/Unknown conversation/);
  });

  it('sends text via /_send and returns the accepted outgoing message', async () => {
    let sendCmd = '';
    const outItem: SxAChatItem = {
      chatInfo: directInfo(3, 'Alice'),
      chatItem: {
        chatDir: { type: 'directSnd' },
        meta: { itemId: 200, itemTs: '2026-10-14T11:00:00Z', itemText: 'yo', itemStatus: { type: 'sndSent' }, itemEdited: false },
        content: { type: 'sndMsgContent', msgContent: { type: 'text', text: 'yo' } },
      },
    } as unknown as SxAChatItem;
    const setup = fakeChatServer((cmd) => {
      if (cmd === cmdActiveUser()) return defaultResponder(cmd);
      if (cmd.startsWith('/_get chats')) return defaultResponder(cmd);
      if (cmd.startsWith('/_send')) {
        sendCmd = cmd;
        return { type: 'newChatItems', user: USER, chatItems: [outItem] };
      }
      return { type: 'cmdOk' };
    });
    const adapter = setup.adapter;
    await adapter.connect();
    await adapter.listConversations();
    const sent = await adapter.sendMessage('@3', 'yo');
    expect(sendCmd).toBe(cmdSendText('@3', 'yo'));
    expect(sent).toMatchObject({ id: '200', direction: 'outgoing', state: 'sent', text: 'yo' });
    const history = await adapter.getMessages('@3');
    expect(history.at(-1)?.text).toBe('yo');
  });

  it('routes incoming events to onMessage listeners and accumulates history', async () => {
    const setup = await connected();
    await setup.adapter.listConversations();
    const received: string[] = [];
    setup.adapter.onMessage((m) => received.push(`${m.sender}:${m.text}`));
    setup.socket.emitEvent({
      type: 'newChatItems',
      user: USER,
      chatItems: [incomingItem(3, 'Alice', 102, 'ping', '2026-10-14T12:00:00Z')],
    });
    await vi.waitFor(() => expect(received).toEqual(['Alice:ping']));
    // Event-time unread bump gives instant UI feedback; a re-list then
    // re-reads the authoritative server value (2 in this fixture).
    const history = await setup.adapter.getMessages('@3');
    expect(history.map((m) => m.id)).toEqual(['101', '102']);
    const conversations = await setup.adapter.listConversations();
    expect(conversations.find((c) => c.id === '@3')?.unread).toBe(2);
  });

  it('surfaces connection failure with an error status', async () => {
    const failingFactory: SocketFactory = (_url, handlers) => ({
      send: () => undefined,
      close: () => undefined,
      ...(() => {
        queueMicrotask(() => handlers.onError('refused'));
        return {};
      })(),
    });
    const adapter = new SimplexAdapter(ACCOUNT, {
      binary: 'simplex-chat',
      dbPathPrefix: '/tmp/x',
      displayName: 'me',
      port: 59998,
      socketFactory: failingFactory,
      spawner: (() => ({ on: () => undefined, once: () => undefined, kill: () => true, exitCode: 0 }) as unknown as ChildProcess),
      startupTimeoutMs: 300,
    });
    await expect(adapter.connect()).rejects.toThrow(/did not open/);
    expect(adapter.getStatus()).toBe('error');
  });

  it('disconnect stops the transport and reports disconnected', async () => {
    const setup = await connected();
    await setup.adapter.disconnect();
    expect(setup.adapter.getStatus()).toBe('disconnected');
  });
});
