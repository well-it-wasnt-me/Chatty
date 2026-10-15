/**
 * Structural surface the WhatsApp adapter needs from Baileys.
 * The real binding lives in real-whatsapp.ts; tests use a mock.
 * Nothing Baileys-specific escapes into the UI.
 */

import type { ConversationKind } from '../../domain/types.js';

export interface WaHistoryMessage {
  /** Baileys WAMessage key id - unique per chat. */
  id: string;
  /** JID, e.g. 15551234567@s.whatsapp.net or 12345-6789@g.us */
  conversationId: string;
  text: string;
  timestampMs: number;
  fromMe: boolean;
  senderName?: string;
}

export interface WaChatSummary {
  id: string;
  title: string;
  kind: ConversationKind;
  unread: number;
}

export interface WaConnectionState {
  qr?: string;
  connection?: 'open' | 'close' | 'connecting';
  /** Numeric HTTP-like code (DisconnectReason), e.g. 401 = logged out. */
  statusCode?: number;
  isNewLogin?: boolean;
}

export interface WhatsAppSocketLike {
  onConnectionUpdate(handler: (state: WaConnectionState) => void): void;
  onCredsUpdate(handler: () => void): void;
  onHistorySet(
    handler: (payload: { chats: WaChatSummary[]; messages: WaHistoryMessage[] }) => void,
  ): void;
  onChatUpsert(handler: (chats: WaChatSummary[]) => void): void;
  onMessagesUpsert(
    handler: (payload: { messages: WaHistoryMessage[]; notify: boolean }) => void,
  ): void;
  sendText(conversationId: string, text: string): Promise<WaHistoryMessage>;
  markRead(conversationId: string, messageIds: string[]): Promise<void>;
  close(): void;
}

export interface WhatsAppFactoryOptions {
  /** Per-account auth/state directory (created 0700; Baileys creds inside). */
  dataPath: string;
  logger?: { warn(event: string, fields?: Record<string, string>): void };
}

export type WhatsAppSocketFactory = (
  options: WhatsAppFactoryOptions,
) => Promise<WhatsAppSocketLike>;
