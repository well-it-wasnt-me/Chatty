/**
 * Structural surface the Telegram adapter needs from an MTProto client.
 * The real binding lives in real-telegram.ts (GramJS); tests use a mock.
 * Nothing Telegram-specific escapes this file's types into the UI.
 */

import type { ConversationKind } from '../../domain/types.js';

export interface TgHistoryMessage {
  /** Chat-scoped message id (Telegram message ids are per-chat). */
  id: number;
  conversationId: string;
  text: string;
  /** Unix seconds. */
  date: number;
  out: boolean;
  sender?: string;
}

export interface TgDialog {
  /** Stable peer id string, e.g. user id or "-100" channel id. */
  id: string;
  title: string;
  kind: ConversationKind;
  unreadCount: number;
  unreadMentionsCount: number;
  lastMessage?: TgHistoryMessage;
}

/** A resolved chat peer (from @username, phone number, or t.me link). */
export interface TgPeer {
  /** Stable peer id string, matching dialog ids - usable for sends. */
  id: string;
  title: string;
  kind: ConversationKind;
}

export interface TelegramClientLike {
  /** New clients are connected and authorized inside the factory. */
  disconnect(): Promise<void>;
  getDialogs(limit: number): Promise<TgDialog[]>;
  getMessages(conversationId: string, limit: number): Promise<TgHistoryMessage[]>;
  sendText(conversationId: string, text: string): Promise<TgHistoryMessage>;
  /**
   * Resolves a @username (or a contact's phone number) to a peer. Throws
   * with a readable reason when the username does not exist.
   */
  resolvePeer(target: string): Promise<TgPeer>;
  /** Serializes the session for persistence (a secret - file mode 0600). */
  saveSession(): string;
  onNewMessage(handler: (message: TgHistoryMessage) => void): void;
}

export interface TelegramFactoryOptions {
  apiId: number;
  apiHash: string;
  /** Previously saved session string, if any. */
  session?: string;
  dataPath: string;
  /** QR payloads rotate; each call is a fresh login link. */
  onQrCode(link: string): void;
  /** Resolves with the user's 2FA password. */
  requestPassword(hint?: string): Promise<string>;
  logger?: { warn(event: string, fields?: Record<string, string>): void };
}

export type TelegramClientFactory = (
  options: TelegramFactoryOptions,
) => Promise<TelegramClientLike>;
