import type { AccountConfig, AdapterCapabilities, Conversation, Message } from '../../domain/types.js';
import type { Logger } from '../../core/logger.js';
import { BaseAdapter } from '../base-adapter.js';
import {
  activeUserSchema,
  apiChatsSchema,
  cmdActiveUser,
  cmdConnectTo,
  cmdCreateInvitation,
  cmdCreateUser,
  cmdGetChats,
  cmdSendText,
  connectErrorText,
  conversationRef,
  conversationTitle,
  findConnectionLink,
  mapChat,
  mapChatItem,
  newChatItemsEventSchema,
  type SxAChatItem,
  type WireEnvelope,
} from './protocol.js';
import { SimplexTransport, type SimplexTransportOptions } from './transport.js';

/**
 * SimpleX adapter backed by the official simplex-chat CLI running as a
 * local WebSocket chat server (--chat-server-port). The child process is
 * supervised here; the account's database lives under account.dataPath.
 *
 * Honest capability notes:
 * - History: SimpleX has no server-side history pull; the CLI holds a local
 *   SQLite. We serve getMessages from items accumulated this session plus
 *   the latest-item previews from /_get chats -- see docs/ADAPTERS.md.
 * - No read-state sync through the bot API -> no markRead (explicit).
 * - Sending to a contact that has not completed the connection handshake
 *   fails with the CLI's error, surfaced to the UI as-is.
 * We do not pretend. You get what the platform gives you.
 */
const SIMPLEX_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false, // files exist in the API; not implemented here yet
  canEditMessages: false,
  canReact: false,
  canFetchHistory: true, // from the local cache, see note above
  canSearch: false,
  canStartConversations: true, // via invitation links (getConnectionLink / startConversation)
};

export interface SimplexAdapterOptions extends SimplexTransportOptions {
  displayName: string;
}

export class SimplexAdapter extends BaseAdapter {
  private readonly simplexTransport: SimplexTransport;
  private readonly displayName: string;
  private userId: number | undefined;
  private ownName: string;
  private readonly conversations = new Map<string, Conversation>();
  private readonly items = new Map<string, Message[]>();
  private shuttingDown = false;

  constructor(account: AccountConfig, options: SimplexAdapterOptions, logger?: Logger) {
    super(account, 'cli', SIMPLEX_CAPABILITIES, logger);
    this.displayName = options.displayName;
    this.ownName = options.displayName;
    this.simplexTransport = new SimplexTransport({ ...options, logger });
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this.setStatus('connecting');
    try {
      await this.simplexTransport.start();
      this.simplexTransport.onEvent((envelope) => this.handleEvent(envelope));
      await this.bootstrapUser();
      this.setStatus('connected');
    } catch (error) {
      this.setStatus('error', describeError(error));
      await this.simplexTransport.stop().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    await this.simplexTransport.stop();
    this.shuttingDown = false;
    this.setStatus('disconnected');
  }

  async listConversations(): Promise<Conversation[]> {
    const userId = this.requireUser();
    const resp = await this.simplexTransport.command(cmdGetChats(userId));
    const parsed = apiChatsSchema.safeParse(resp);
    if (!parsed.success) throw new Error(`unexpected _get chats response: ${String(resp.type)}`);
    const conversations: Conversation[] = [];
    for (const chat of parsed.data.chats) {
      const conversation = mapChat(this.account.id, chat);
      if (!conversation) continue;
      const last = chat.chatItems.at(-1);
      if (last) {
        this.rememberItem(
          conversation.id,
          mapChatItem(this.account.id, conversation.id, this.ownName, {
            chatInfo: chat.chatInfo,
            chatItem: last,
          }),
        );
      }
      this.conversations.set(conversation.id, conversation);
      conversations.push(conversation);
    }
    conversations.sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
    return conversations.map((c) => ({ ...c }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    return (this.items.get(conversationId) ?? []).map((m) => ({ ...m }));
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const resp = await this.simplexTransport.command(cmdSendText(conversationId, text));
    const parsed = newChatItemsEventSchema.safeParse(resp);
    if (!parsed.success) {
      throw new Error(`send rejected by simplex-chat (${String(resp.type ?? 'unknown')})`);
    }
    const own = parsed.data.chatItems.find((ci) =>
      String(conversationRef(ci.chatInfo)) === conversationId &&
      (ci.chatItem.chatDir.type === 'directSnd' || ci.chatItem.chatDir.type === 'groupSnd'),
    );
    const source: SxAChatItem | undefined = own ?? parsed.data.chatItems[0];
    if (!source) throw new Error('send accepted but response carried no items');
    const message = mapChatItem(this.account.id, conversationId, this.ownName, source);
    this.rememberItem(conversationId, message);
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastMessage = message;
    return { ...message };
  }

  // No markRead: the bot API exposes no read-state command -> explicit absence.

  /**
   * Creates a fresh one-time invitation link the user can share. The link
   * is the identity of a new connection queue -- nothing sensitive.
   */
  async getConnectionLink(): Promise<string> {
    this.requireUser();
    const resp = await this.simplexTransport.command(cmdCreateInvitation());
    const link = findConnectionLink(resp);
    if (link === undefined) {
      throw new Error(`simplex-chat returned no connection link (${String(resp.type ?? 'unknown')})`);
    }
    return link;
  }

  /**
   * Accepts a contact's invitation link. The direct chat materializes when
   * both ends confirm the handshake, so after /_connect we re-list chats
   * and return the direct conversation that just appeared.
   */
  async startConversation(link: string): Promise<Conversation> {
    this.requireUser();
    const resp = await this.simplexTransport.command(cmdConnectTo(link));
    const errorText = connectErrorText(resp);
    if (errorText !== undefined) throw new Error(errorText);
    const known = new Set(this.conversations.keys());
    const conversations = await this.listConversations();
    const fresh = conversations.find((c) => !known.has(c.id) && c.kind === 'direct');
    if (fresh === undefined) {
      throw new Error('connection request sent -- the chat appears once the contact confirms the connection');
    }
    return fresh;
  }

  private async bootstrapUser(): Promise<void> {
    const resp = await this.simplexTransport.command(cmdActiveUser());
    const activeUser = activeUserSchema.safeParse(resp);
    if (activeUser.success) {
      this.userId = activeUser.data.user.userId;
      this.ownName = activeUser.data.user.localDisplayName;
      this.logger?.info('active user', { userId: this.userId });
      return;
    }
    // First run without a profile (should not happen with --user-display-name)
    const created = await this.simplexTransport.command(cmdCreateUser(this.displayName));
    const createdUser = activeUserSchema.safeParse(created);
    if (!createdUser.success) {
      throw new Error('could not obtain or create a SimpleX user profile');
    }
    this.userId = createdUser.data.user.userId;
    this.logger?.info('created user', { userId: this.userId });
  }

  private handleEvent(envelope: WireEnvelope): void {
    if (envelope.resp.type === 'chatError' || envelope.resp.type === 'chatErrors') {
      this.logger?.warn('simplex chat error event', { type: envelope.resp.type });
      return;
    }
    const parsed = newChatItemsEventSchema.safeParse(envelope.resp);
    if (!parsed.success) return; // other events ignored for now (logged at debug)
    this.logger?.debug('event ignored or processed', { type: envelope.resp.type });
    for (const aChatItem of parsed.data.chatItems) {
      const dir = aChatItem.chatItem.chatDir.type;
      // Outgoing echoes come back through sendMessage's response, not events.
      if (dir === 'directSnd' || dir === 'groupSnd' || dir === 'localSnd' || dir === 'localRcv') {
        continue;
      }
      const ref = conversationRef(aChatItem.chatInfo);
      if (ref === undefined) continue;
      const message = mapChatItem(this.account.id, ref, this.ownName, aChatItem);
      this.rememberItem(ref, message);
      const conversation = this.conversations.get(ref);
      if (conversation) {
        conversation.unread += 1;
        conversation.lastMessage = message;
      } else {
        this.conversations.set(ref, {
          id: ref,
          accountId: this.account.id,
          title: conversationTitle(aChatItem.chatInfo),
          kind: aChatItem.chatInfo.type === 'group' ? 'group' : 'direct',
          unread: 1,
          lastMessage: message,
        });
      }
      if (!this.shuttingDown) this.emitMessage(message);
    }
  }

  private rememberItem(conversationId: string, message: Message): void {
    let list = this.items.get(conversationId);
    if (!list) {
      list = [];
      this.items.set(conversationId, list);
    }
    if (!list.some((m) => m.id === message.id)) list.push(message);
    list.sort((a, b) => a.timestamp - b.timestamp);
  }

  private requireUser(): number {
    if (this.userId === undefined) throw new Error('simplex adapter is not connected');
    return this.userId;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}