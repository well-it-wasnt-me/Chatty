import type { AccountConfig, AdapterCapabilities, Conversation, ConversationKind, Message } from '../../domain/types.js';
import type { Logger } from '../../core/logger.js';
import { BaseAdapter } from '../base-adapter.js';
import { createWhatsAppSocket, DisconnectReason } from './real-whatsapp.js';
import type {
  WaHistoryMessage,
  WhatsAppSocketFactory,
  WhatsAppSocketLike,
} from './types.js';

/**
 * WhatsApp adapter over Baileys. Two accounts run side by side: each adapter
 * instance owns an isolated socket + dataPath/auth/ (enforced by config
 * construction; never shared).
 *
 * Auth: QR pairing -- every connection.update.qr becomes an overlay prompt
 * (payloads rotate; never logged). 401/loggedOut is reported distinctly from
 * transient network closes: logged-out = auth failure, everything else is
 * network; runtime drops attempt an internal bounded reconnect.
 * We do not pretend. You get what the platform gives you.
 */
const WHATSAPP_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false, // Baileys supports media; not implemented here yet
  canEditMessages: false,
  canReact: false, // Baileys supports reactions; not implemented here yet
  canFetchHistory: true, // from history-sync + locally accumulated store
  canSearch: false,
  canStartConversations: true, // by phone number
};

const PHONE_DIGITS = /^[0-9]{7,15}$/;

const HISTORY_LIMIT = 100;
const RUNTIME_RECONNECT_ATTEMPTS = 4;

export interface WhatsAppAdapterOptions {
  factory?: WhatsAppSocketFactory;
}

export class WhatsAppAdapter extends BaseAdapter {
  private readonly factory: WhatsAppSocketFactory;
  private socket: WhatsAppSocketLike | undefined;
  private readonly conversations = new Map<string, Conversation>();
  private readonly items = new Map<string, Message[]>();
  private openResolver: ((ok: boolean) => void) | undefined;
  private reconnecting = false;

  constructor(account: AccountConfig, options: WhatsAppAdapterOptions = {}, logger?: Logger) {
    super(account, 'baileys', WHATSAPP_CAPABILITIES, logger);
    this.factory = options.factory ?? createWhatsAppSocket;
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this.setStatus('connecting');
    try {
      this.socket = await this.factory({
        dataPath: this.account.dataPath,
        logger: this.logger
          ? { warn: (event, fields) => this.logger!.warn(event, fields) }
          : undefined,
      });
    } catch (error) {
      this.setStatus('error', describeError(error));
      throw error;
    }
    this.wireEvents(this.socket);
    // Resolves on 'open', rejects on auth failure / terminal close.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.openResolver = undefined;
        reject(new Error('whatsapp pairing timed out waiting for connection open'));
      }, 90_000);
      this.openResolver = (ok) => {
        clearTimeout(timeout);
        this.openResolver = undefined;
        if (ok) resolve();
        else reject(new Error('whatsapp logged out -- remove the account and re-pair'));
      };
    });
    this.setStatus('connected');
    this.logger?.info('whatsapp connected');
  }

  async disconnect(): Promise<void> {
    this.openResolver = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.close();
    }
    this.setStatus('disconnected');
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0))
      .map((c) => ({ ...c }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return (this.items.get(conversationId) ?? []).map((m) => ({ ...m }));
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    const socket = this.requireSocket();
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const sent = await socket.sendText(conversationId, text);
    const message = this.mapMessage(sent);
    this.rememberItem(conversationId, message);
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastMessage = message;
    return { ...message };
  }

  /** Marks the conversation's inbound messages read (Baileys receipts). */
  async markRead(conversationId: string): Promise<void> {
    const socket = this.requireSocket();
    const inboundIds = (this.items.get(conversationId) ?? [])
      .filter((m) => m.direction === 'incoming')
      .slice(-25)
      .map((m) => m.id);
    if (inboundIds.length > 0) {
      await socket.markRead(conversationId, inboundIds);
    }
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.unread = 0;
  }

  /**
   * Starts a direct chat by phone number (international format). The
   * conversation is created locally; it becomes a real WhatsApp chat when
   * the first message is sent (Baileys has no "create chat" call -- chats
   * materialize on activity, then chats.upsert confirms the title).
   */
  async startConversation(target: string): Promise<Conversation> {
    this.requireSocket();
    const digits = target.replace(/\D/g, '');
    if (!PHONE_DIGITS.test(digits)) {
      throw new Error('enter a phone number in international format, e.g. +15551234567');
    }
    const jid = `${digits}@s.whatsapp.net`;
    const existing = this.conversations.get(jid);
    if (existing) return { ...existing };
    this.upsertChat({ id: jid, title: `+${digits}`, kind: 'direct', unread: 0 });
    const conversation = this.conversations.get(jid);
    if (!conversation) throw new Error('could not create the conversation');
    return { ...conversation };
  }

  // ------------------------------------------------------------- plumbing

  private wireEvents(socket: WhatsAppSocketLike): void {
    socket.onConnectionUpdate((state) => this.handleConnection(state));
    socket.onCredsUpdate(() => this.logger?.debug('credentials persisted'));
    socket.onHistorySet(({ chats, messages }) => {
      for (const chat of chats) this.upsertChat(chat);
      for (const message of messages) this.rememberItem(message.conversationId, this.mapMessage(message));
    });
    socket.onChatUpsert((chats) => {
      for (const chat of chats) this.upsertChat(chat);
    });
    socket.onMessagesUpsert(({ messages, notify }) => {
      for (const raw of messages) {
        const message = this.mapMessage(raw);
        this.rememberItem(raw.conversationId, message);
        const conversation = this.conversations.get(raw.conversationId);
        if (conversation) {
          conversation.lastMessage = message;
          if (notify && !raw.fromMe) conversation.unread += 1;
        }
        if (notify && !raw.fromMe) this.emitMessage(message);
      }
    });
  }

  private handleConnection(state: {
    qr?: string;
    connection?: 'open' | 'close' | 'connecting';
    statusCode?: number;
  }): void {
    if (state.qr) {
      // Payloads rotate until scanned; the overlay re-renders each time.
      this.emitAuthPrompt({ kind: 'qr', data: state.qr });
      return;
    }
    if (state.connection === 'open') {
      this.reconnecting = false;
      this.openResolver?.(true);
      if (!this.isConnected()) this.setStatus('connected');
      return;
    }
    if (state.connection !== 'close') return;

    if (state.statusCode === DisconnectReason.loggedOut) {
      // Auth failure, distinguishable per the engineering rules.
      this.setStatus('error', 'logged out -- remove the account and re-pair');
      this.openResolver?.(false);
      return;
    }
    if (this.isConnected() && !this.reconnecting) {
      // Network drop with a live session: bounded internal reconnect.
      this.setStatus('connecting');
      void this.retryRuntimeReconnect();
      return;
    }
    this.openResolver?.(false);
  }

  private async retryRuntimeReconnect(): Promise<void> {
    this.reconnecting = true;
    for (let attempt = 1; attempt <= RUNTIME_RECONNECT_ATTEMPTS; attempt++) {
      const delay = 500 * 2 ** (attempt - 1) + Math.random() * 500;
      await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        this.socket = await this.factory({
          dataPath: this.account.dataPath,
          logger: this.logger
            ? { warn: (event, fields) => this.logger!.warn(event, fields) }
            : undefined,
        });
        this.wireEvents(this.socket);
        this.reconnecting = false;
        return; // 'open' event restores connected status
      } catch (error) {
        this.logger?.warn('reconnect attempt failed', {
          attempt,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.reconnecting = false;
    this.setStatus('error', 'whatsapp reconnect attempts exhausted');
  }

  private upsertChat(chat: { id: string; title: string; kind: ConversationKind; unread: number }): void {
    const existing = this.conversations.get(chat.id);
    this.conversations.set(chat.id, {
      id: chat.id,
      accountId: this.account.id,
      title: chat.title,
      kind: chat.kind,
      unread: chat.unread,
      lastMessage: this.items.get(chat.id)?.at(-1) ?? existing?.lastMessage,
    });
  }

  private mapMessage(raw: WaHistoryMessage): Message {
    return {
      id: raw.id,
      accountId: this.account.id,
      conversationId: raw.conversationId,
      direction: raw.fromMe ? 'outgoing' : 'incoming',
      timestamp: raw.timestampMs,
      text: raw.text,
      sender: raw.fromMe ? undefined : raw.senderName,
      state: raw.fromMe ? 'sent' : undefined,
      metadata: { jid: raw.conversationId },
    };
  }

  private rememberItem(conversationId: string, message: Message): void {
    let list = this.items.get(conversationId);
    if (!list) {
      list = [];
      this.items.set(conversationId, list);
    }
    if (!list.some((m) => m.id === message.id)) list.push(message);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
  }

  private requireSocket(): WhatsAppSocketLike {
    if (!this.socket) throw new Error('whatsapp adapter is not connected');
    return this.socket;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}