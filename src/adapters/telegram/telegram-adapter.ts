import type { AccountConfig, AdapterCapabilities, Conversation, Message } from '../../domain/types.js';
import type { Logger } from '../../core/logger.js';
import { BaseAdapter } from '../base-adapter.js';
import { createTelegramClient } from './real-telegram.js';
import type {
  TelegramClientFactory,
  TelegramClientLike,
  TelegramFactoryOptions,
  TgHistoryMessage,
} from './types.js';

/**
 * Telegram adapter over GramJS. Authentication (QR + optional 2FA password)
 * plays through the shared auth overlay: QR payloads rotate freely, password
 * responses come back through submitAuthResponse. The session string is a
 * persisted credential under the account's own dataPath (mode 0600).
 * We do not pretend. You get what the platform gives you.
 */
const TELEGRAM_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false, // GramJS supports media; not implemented here yet
  canEditMessages: false,
  canReact: false,
  canFetchHistory: true, // real API history this time (getMessages)
  canSearch: false,
  canStartConversations: true, // by @username (phone only for contacts)
};

const DIALOG_LIMIT = 100;
const HISTORY_LIMIT = 50;

export interface TelegramAdapterOptions {
  apiId?: number;
  apiHash?: string;
  factory?: TelegramClientFactory;
}

export class TelegramAdapter extends BaseAdapter {
  private readonly options: TelegramAdapterOptions & { factory: TelegramClientFactory };
  private client: TelegramClientLike | undefined;
  private passwordResponder: ((password: string) => void) | undefined;
  private readonly conversations = new Map<string, Conversation>();

  constructor(account: AccountConfig, options: TelegramAdapterOptions, logger?: Logger) {
    super(account, 'gramjs', TELEGRAM_CAPABILITIES, logger);
    this.options = { ...options, factory: options.factory ?? createTelegramClient };
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this.setStatus('connecting');
    if (this.options.apiId === undefined || this.options.apiHash === undefined) {
      this.setStatus('error', 'missing TELEGRAM_API_ID / TELEGRAM_API_HASH');
      throw new Error('telegram requires TELEGRAM_API_ID and TELEGRAM_API_HASH (my.telegram.org)');
    }
    const factoryOptions: TelegramFactoryOptions = {
      apiId: this.options.apiId,
      apiHash: this.options.apiHash,
      dataPath: this.account.dataPath,
      // QR tokens rotate; each emission re-renders the overlay's code.
      onQrCode: (link) => this.emitAuthPrompt({ kind: 'qr', data: link }),
      requestPassword: (hint) => this.awaitPassword(hint),
      logger: this.logger
        ? { warn: (event, fields) => this.logger!.warn(event, fields) }
        : undefined,
    };
    try {
      this.client = await this.options.factory(factoryOptions);
    } catch (error) {
      this.setStatus('error', describeError(error));
      throw error;
    }
    this.client.onNewMessage((message) => this.handleIncoming(message));
    this.setStatus('connected');
    this.logger?.info('telegram connected');
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.disconnect();
    this.setStatus('disconnected');
  }

  async listConversations(): Promise<Conversation[]> {
    const client = this.requireClient();
    const dialogs = await client.getDialogs(DIALOG_LIMIT);
    const conversations: Conversation[] = [];
    for (const dialog of dialogs) {
      const conversation: Conversation = {
        id: dialog.id,
        accountId: this.account.id,
        title: dialog.title,
        kind: dialog.kind,
        unread: dialog.unreadCount,
        mentions: dialog.unreadMentionsCount,
        lastMessage: dialog.lastMessage
          ? this.mapMessage(dialog.lastMessage)
          : undefined,
      };
      this.conversations.set(dialog.id, conversation);
      conversations.push(conversation);
    }
    conversations.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
    return conversations.map((c) => ({ ...c }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const messages = await this.requireClient().getMessages(conversationId, HISTORY_LIMIT);
    return messages.map((m) => this.mapMessage(m));
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const sent = await this.requireClient().sendText(conversationId, text);
    const message = this.mapMessage(sent);
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastMessage = message;
    return { ...message };
  }

  // No markRead in v1 (readReceipts via invoke possible later -- documented).

  /**
   * Starts a chat with a @username (or a contact's phone number). The peer
   * is resolved once and cached in the binding, so sends work immediately.
   */
  async startConversation(target: string): Promise<Conversation> {
    const client = this.requireClient();
    const trimmed = target.trim();
    if (trimmed === '') throw new Error('enter a @username or phone number');
    const peer = await client.resolvePeer(trimmed);
    const existing = this.conversations.get(peer.id);
    if (existing) return { ...existing };
    const conversation: Conversation = {
      id: peer.id,
      accountId: this.account.id,
      title: peer.title,
      kind: peer.kind,
      unread: 0,
    };
    this.conversations.set(peer.id, conversation);
    return { ...conversation };
  }

  /** Bridge: GramJS password callbacks resolve through the auth overlay. */
  private awaitPassword(hint?: string): Promise<string> {
    this.emitAuthPrompt({ kind: 'password', hint });
    return new Promise<string>((resolve) => {
      this.passwordResponder = resolve;
    });
  }

  async submitAuthResponse(response: string): Promise<void> {
    const responder = this.passwordResponder;
    if (!responder) throw new Error('telegram is not waiting for a password');
    this.passwordResponder = undefined;
    responder(response);
  }

  private mapMessage(message: TgHistoryMessage): Message {
    return {
      // Telegram message ids are per-chat -- scope stays account+conversation.
      id: String(message.id),
      accountId: this.account.id,
      conversationId: message.conversationId,
      direction: message.out ? 'outgoing' : 'incoming',
      timestamp: message.date * 1000,
      text: message.text,
      sender: message.out ? undefined : message.sender,
      state: message.out ? 'sent' : undefined,
    };
  }

  private handleIncoming(message: TgHistoryMessage): void {
    if (message.out) return; // our own sends are returned by sendMessage
    const mapped = this.mapMessage(message);
    const conversation = this.conversations.get(mapped.conversationId);
    if (conversation) {
      conversation.unread += 1;
      conversation.lastMessage = mapped;
    }
    this.emitMessage(mapped);
  }

  private requireClient(): TelegramClientLike {
    if (!this.client) throw new Error('telegram adapter is not connected');
    return this.client;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}