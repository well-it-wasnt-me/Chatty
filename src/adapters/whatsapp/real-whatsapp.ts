import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from 'baileys';
import type { proto } from 'baileys/WAProto/index.js';
import type {
  WaChatSummary,
  WaHistoryMessage,
  WhatsAppSocketFactory,
  WhatsAppSocketLike,
} from './types.js';

/**
 * Real WhatsApp binding over Baileys (unofficial WhatsApp Web protocol -
 * review WhatsApp's terms and account-ban risk; expect upstream breakage).
 * Verified against the installed baileys@7.0.0-rc14 typings.
 *
 * - Auth state: <dataPath>/auth/ via useMultiFileAuthState (per account -
 *   A and B never share; enforced by construction).
 * - QR payloads arrive through connection.update.qr (rotated by the server);
 *   handed upward verbatim, never logged.
 * - Baileys logs via pino to stdout by default - we replace that with an
 *   error-only sink into our file logger (its debug logs can carry keys).
 */

interface BaileysLoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(): BaileysLoggerLike;
}

function quietBaileysLogger(
  logger?: { warn(event: string, fields?: Record<string, string>): void },
): BaileysLoggerLike {
  const sink: BaileysLoggerLike = {
    debug() {},
    info() {},
    warn() {},
    trace() {},
    error() {
      logger?.warn('baileys internal error', {});
    },
    fatal() {
      logger?.warn('baileys internal fatal', {});
    },
    child: () => sink,
  };
  return sink;
}

function conversationKindOf(jid: string): WaChatSummary['kind'] {
  return jid.endsWith('@g.us') ? 'group' : 'direct';
}

function messageText(message: proto.IMessage | null | undefined): string {
  if (!message) return '';
  if (typeof message.conversation === 'string') return message.conversation;
  const extended = message.extendedTextMessage?.text;
  if (typeof extended === 'string') return extended;
  const caption = message.imageMessage?.caption ?? message.videoMessage?.caption;
  if (typeof caption === 'string') return caption;
  const type = Object.keys(message)[0];
  return type ? `[${type}]` : '';
}

function mapMessage(raw: proto.IWebMessageInfo): WaHistoryMessage | undefined {
  const jid = raw.key?.remoteJid;
  if (!jid || !raw.key?.id) return undefined;
  return {
    id: raw.key.id,
    conversationId: jid,
    text: messageText(raw.message),
    timestampMs: Number(raw.messageTimestamp ?? 0) * 1000,
    fromMe: raw.key.fromMe ?? false,
    senderName: raw.pushName ?? undefined,
  };
}

function chatTitle(chat: proto.IConversation, contactNames?: Map<string, string>): string {
  const id = chat.id ?? '';
  return chat.name ?? chat.displayName ?? contactNames?.get(id) ?? id.replace(/@.*$/, '');
}

export const createWhatsAppSocket: WhatsAppSocketFactory = async (options) => {
  const authFolder = join(options.dataPath, 'auth');
  mkdirSync(authFolder, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const socket: WASocket = makeWASocket({
    auth: state,
    logger: quietBaileysLogger(options.logger) as never,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  const listeners = new Map<string, Array<(payload: never) => void>>();
  const on = <K extends string>(event: K, handler: (payload: never) => void): void => {
    const list = listeners.get(event) ?? [];
    list.push(handler);
    listeners.set(event, list);
  };

  const contactNames = new Map<string, string>();

  socket.ev.on('connection.update', (update) => {
    const lastError = update.lastDisconnect?.error;
    const statusCode =
      typeof lastError === 'object' && lastError !== null && 'output' in lastError
        ? (lastError as { output?: { statusCode?: number } }).output?.statusCode
        : undefined;
    onEmit('connection', {
      qr: update.qr || undefined, // empty string means "not needed"
      connection: update.connection,
      statusCode,
      isNewLogin: update.isNewLogin,
    });
  });

  socket.ev.on('creds.update', () => {
    void saveCreds();
    onEmit('creds', undefined as never);
  });

  socket.ev.on('messaging-history.set', (payload) => {
    const contacts = payload.contacts ?? [];
    for (const contact of contacts) {
      const name = contact.name ?? contact.notify;
      if (contact.id && name) contactNames.set(String(contact.id), String(name));
    }
    const chats = (payload.chats ?? [])
      .filter((chat) => chat.id !== undefined && chat.id !== null)
      .map((chat) => ({
        id: String(chat.id),
        title: chatTitle(chat, contactNames),
        kind: conversationKindOf(String(chat.id)),
        unread: chat.unreadCount ?? 0,
      }));
    const messages = (payload.messages ?? [])
      .map(mapMessage)
      .filter((m): m is WaHistoryMessage => m !== undefined);
    onEmit('history', { chats, messages });
  });

  socket.ev.on('chats.upsert', (chats) => {
    onEmit(
      'chats',
      chats
        .filter((chat) => chat.id !== undefined && chat.id !== null)
        .map((chat) => ({
          id: String(chat.id),
          title: chatTitle(chat, contactNames),
          kind: conversationKindOf(String(chat.id)),
          unread: chat.unreadCount ?? 0,
        })),
    );
  });

  socket.ev.on('messages.upsert', ({ messages, type }) => {
    const mapped = messages
      .map(mapMessage)
      .filter((m): m is WaHistoryMessage => m !== undefined);
    if (mapped.length > 0) onEmit('messages', { messages: mapped, notify: type === 'notify' });
  });

  function onEmit(event: string, payload: unknown): void {
    for (const handler of listeners.get(event) ?? []) {
      try {
        (handler as (payload: unknown) => void)(payload);
      } catch (error) {
        options.logger?.warn('baileys event handler failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const bound: WhatsAppSocketLike = {
    onConnectionUpdate: (handler) => on('connection', handler),
    onCredsUpdate: (handler) => on('creds', handler),
    onHistorySet: (handler) => on('history', handler),
    onChatUpsert: (handler) => on('chats', handler),
    onMessagesUpsert: (handler) => on('messages', handler),
    async sendText(conversationId, text) {
      const sent = await socket.sendMessage(conversationId, { text });
      const mapped = sent ? mapMessage(sent) : undefined;
      return (
        mapped ?? {
          id: `local-${Date.now().toString(36)}`,
          conversationId,
          text,
          timestampMs: Date.now(),
          fromMe: true,
        }
      );
    },
    async markRead(conversationId, messageIds) {
      await socket.readMessages(
        messageIds.map((id) => ({ id, remoteJid: conversationId, fromMe: false })),
      );
    },
    close() {
      socket.end(undefined);
    },
  };

  return bound;
};

export { DisconnectReason };
