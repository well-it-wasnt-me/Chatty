import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig, AuthPrompt } from '../../domain/types.js';
import { WhatsAppAdapter } from './whatsapp-adapter.js';
import type {
  WaChatSummary,
  WaConnectionState,
  WaHistoryMessage,
  WhatsAppSocketLike,
} from './types.js';

const ACCOUNT: AccountConfig = {
  id: 'whatsapp-a',
  label: 'WhatsApp (personal)',
  badge: 'WA Personal',
  platform: 'whatsapp',
  dataPath: '/tmp/chatty-wa-test',
};

class MockSocket implements WhatsAppSocketLike {
  private handlers = new Map<string, Array<(p: never) => void>>();
  wired = false;
  sent: Array<{ jid: string; text: string }> = [];
  readMarks: Array<{ jid: string; ids: string[] }> = [];
  closed = false;

  private listen(map: Record<string, (p: never) => void>) {
    for (const [k, v] of Object.entries(map)) {
      const list = this.handlers.get(k) ?? [];
      list.push(v);
      this.handlers.set(k, list);
    }
  }

  onConnectionUpdate(h: (s: WaConnectionState) => void): void { this.listen({ connection: h as never }); this.wired = true; }
  onCredsUpdate(h: () => void): void { this.listen({ creds: h as never }); }
  onHistorySet(h: (p: { chats: WaChatSummary[]; messages: WaHistoryMessage[] }) => void): void { this.listen({ history: h as never }); }
  onChatUpsert(h: (c: WaChatSummary[]) => void): void { this.listen({ chats: h as never }); }
  onMessagesUpsert(h: (p: { messages: WaHistoryMessage[]; notify: boolean }) => void): void { this.listen({ messages: h as never }); }

  emit(event: string, payload: unknown): void {
    for (const h of this.handlers.get(event) ?? []) (h as (p: unknown) => void)(payload);
  }

  async sendText(jid: string, text: string): Promise<WaHistoryMessage> {
    this.sent.push({ jid, text });
    return { id: 'WA-SENT-1', conversationId: jid, text, timestampMs: 1_700_000_000_000, fromMe: true };
  }

  async markRead(jid: string, ids: string[]): Promise<void> {
    this.readMarks.push({ jid, ids });
  }

  close(): void {
    this.closed = true;
  }
}

const CHATS: WaChatSummary[] = [
  { id: '111@s.whatsapp.net', title: 'Mum', kind: 'direct', unread: 2 },
  { id: 'group@g.us', title: 'Family group', kind: 'group', unread: 1 },
];

const HISTORY: WaHistoryMessage[] = [
  { id: 'm1', conversationId: '111@s.whatsapp.net', text: 'call me later', timestampMs: 1_699_999_000_000, fromMe: false, senderName: 'Mum' },
  { id: 'm2', conversationId: '111@s.whatsapp.net', text: 'ok', timestampMs: 1_699_999_500_000, fromMe: true },
];

function makeAdapter(socket: MockSocket) {
  const prompts: AuthPrompt[] = [];
  const adapter = new WhatsAppAdapter(ACCOUNT, { factory: async () => socket });
  adapter.onAuthPrompt?.((p) => prompts.push(p));
  return { adapter, prompts, socket };
}

async function pairedConnect(socket: MockSocket, adapter: WhatsAppAdapter): Promise<void> {
  const connecting = adapter.connect();
  await vi.waitFor(() => expect(socket.wired).toBe(true));
  socket.emit('connection', { connection: 'open' } satisfies WaConnectionState);
  await connecting;
}

describe('WhatsAppAdapter', () => {
  it('surfaces QR payloads as auth prompts, then connects on open', async () => {
    const { adapter, prompts, socket } = makeAdapter(new MockSocket());
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(socket.wired).toBe(true));
    socket.emit('connection', { qr: 'wa-qr-payload-1' } satisfies WaConnectionState);
    socket.emit('connection', { qr: 'wa-qr-payload-2' } satisfies WaConnectionState); // rotation
    await vi.waitFor(() => expect(prompts.map((p) => p.kind)).toEqual(['qr', 'qr']));
    socket.emit('connection', { connection: 'open' } satisfies WaConnectionState);
    await connecting;
    expect(adapter.getStatus()).toBe('connected');
  });

  it('maps history-sync chats and marks conversations read via receipts', async () => {
    const { adapter, socket } = makeAdapter(new MockSocket());
    await pairedConnect(socket, adapter);
    socket.emit('history', { chats: CHATS, messages: HISTORY });
    const conversations = await adapter.listConversations();
    expect(conversations.map((c) => c.id)).toContain('111@s.whatsapp.net');
    expect(conversations.find((c) => c.id === 'group@g.us')?.kind).toBe('group');
    const history = await adapter.getMessages('111@s.whatsapp.net');
    expect(history.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(history[0]).toMatchObject({ direction: 'incoming', sender: 'Mum' });

    await adapter.markRead('111@s.whatsapp.net');
    expect(socket.readMarks[0]).toMatchObject({ jid: '111@s.whatsapp.net' });
    expect(socket.readMarks[0].ids).toContain('m1');
    expect((await adapter.listConversations()).find((c) => c.id === '111@s.whatsapp.net')?.unread).toBe(0);
  });

  it('routes incoming upserts to onMessage with unread bumps', async () => {
    const { adapter, socket } = makeAdapter(new MockSocket());
    await pairedConnect(socket, adapter);
    socket.emit('history', { chats: CHATS, messages: HISTORY });
    const received: string[] = [];
    adapter.onMessage((m) => received.push(`${m.sender}:${m.text}`));
    socket.emit('messages', {
      notify: true,
      messages: [
        { id: 'm3', conversationId: '111@s.whatsapp.net', text: 'ping', timestampMs: 1_700_000_000_000, fromMe: false, senderName: 'Mum' },
      ],
    });
    expect(received).toEqual(['Mum:ping']);
    const list = await adapter.listConversations();
    expect(list.find((c) => c.id === '111@s.whatsapp.net')?.unread).toBe(3);
  });

  it('sends text via the socket with a stable chat-scoped id', async () => {
    const { adapter, socket } = makeAdapter(new MockSocket());
    await pairedConnect(socket, adapter);
    socket.emit('history', { chats: CHATS, messages: [] });
    const sent = await adapter.sendMessage('111@s.whatsapp.net', 'hello mum');
    expect(sent).toMatchObject({ id: 'WA-SENT-1', direction: 'outgoing', state: 'sent' });
    expect(socket.sent[0]).toMatchObject({ jid: '111@s.whatsapp.net', text: 'hello mum' });
    await expect(adapter.sendMessage('nope@s.whatsapp.net', 'x')).rejects.toThrow(/Unknown conversation/);
  });

  it('distinguishes logged-out from transient network failure', async () => {
    const { adapter, socket } = makeAdapter(new MockSocket());
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(socket.wired).toBe(true));
    socket.emit('connection', { connection: 'close', statusCode: 401 } satisfies WaConnectionState);
    await expect(connecting).rejects.toThrow(/logged out/);
    expect(adapter.getStatus()).toBe('error');
  });

  it('disconnect closes the socket', async () => {
    const { adapter, socket } = makeAdapter(new MockSocket());
    await pairedConnect(socket, adapter);
    await adapter.disconnect();
    expect(socket.closed).toBe(true);
    expect(adapter.getStatus()).toBe('disconnected');
  });
});
