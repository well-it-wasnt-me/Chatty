import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { Api } from 'telegram/tl/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { signInUserWithQrCode, signInWithPassword } from 'telegram/client/auth.js';
import type { Entity } from 'telegram/define.js';
import type {
  TelegramClientLike,
  TgDialog,
  TelegramFactoryOptions,
  TgHistoryMessage,
  TgPeer,
} from './types.js';

/**
 * Real Telegram binding over GramJS (pure-JS MTProto, actively maintained --
 * deliberately not the Bot API, which cannot read personal account history).
 *
 * Auth: QR login via signInUserWithQrCode; each rotated token becomes a
 * fresh tg://login?token=... prompt. If 2FA is enabled, the password comes
 * back through requestPassword (bridged to the TUI auth overlay); wrong
 * passwords retry via signInWithPassword without re-scanning the QR.
 *
 * Session persistence: GramJS session.save() string is written to
 * <dataPath>/session.txt with mode 0600. It is a credential -- never logged.
 * We do not log your secrets. Ever.
 */

const DIALOG_LIMIT = 100;
const PASSWORD_RETRIES = 3;

export const createTelegramClient: (
  options: TelegramFactoryOptions,
) => Promise<TelegramClientLike> = async (options) => {
  mkdirDataPath(options.dataPath);
  const stored = readSession(options.dataPath);
  const session = new StringSession(stored ?? options.session ?? '');
  const client = new TelegramClient(session, options.apiId, options.apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  if (!(await client.checkAuthorization())) {
    await qrSignInWithPasswordRetry(client, options);
    writeSession(options.dataPath, session.save());
  }

  const entities = new Map<string, Entity>();

  const conversationIdOf = (peer: Api.Message): string => String(peer.chatId ?? 'me');

  const mapMessage = (
    message: Api.Message,
    conversationId: string,
    sender?: string,
  ): TgHistoryMessage => ({
    id: message.id,
    conversationId,
    text: message.message ?? '',
    date: message.date,
    out: message.out ?? false,
    sender,
  });

  async function senderNameOf(message: Api.Message): Promise<string | undefined> {
    if (message.out) return undefined;
    try {
      const sender = await message.getSender();
      if (sender && typeof sender === 'object') {
        const named = sender as Api.User;
        if (named.firstName) {
          return [named.firstName, named.lastName ?? ''].filter(Boolean).join(' ');
        }
        if ('username' in named && named.username) return String(named.username);
      }
    } catch {
      options.logger?.warn('sender lookup failed');
    }
    return undefined;
  }

  async function ensureDialogsLoaded(): Promise<void> {
    if (entities.size > 0) return;
    const dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
    for (const dialog of dialogs) {
      if (dialog.entity && dialog.id !== undefined) {
        entities.set(String(dialog.id), dialog.entity);
      }
    }
  }

  /** Duck-typed peer metadata (Api.User vs Chat/Channel share few fields). */
  function peerMeta(entity: Entity): { title: string; kind: TgPeer['kind'] } {
    const raw = entity as {
      firstName?: unknown;
      lastName?: unknown;
      username?: unknown;
      title?: unknown;
      broadcast?: unknown;
    };
    const name = [raw.firstName, raw.lastName]
      .filter((part): part is string => typeof part === 'string' && part !== '')
      .join(' ');
    if (name !== '' || typeof raw.username === 'string') {
      return { title: name !== '' ? name : String(raw.username), kind: 'direct' };
    }
    if (typeof raw.title === 'string') {
      return { title: raw.title, kind: raw.broadcast === true ? 'channel' : 'group' };
    }
    return { title: String(entity.id), kind: 'direct' };
  }

  const bound: TelegramClientLike = {
    async disconnect() {
      await client.disconnect();
    },
    async getDialogs(limit) {
      const dialogs = await client.getDialogs({ limit });
      const mapped: TgDialog[] = [];
      for (const dialog of dialogs) {
        if (!dialog.entity || dialog.id === undefined) continue;
        const id = String(dialog.id);
        entities.set(id, dialog.entity);
        mapped.push({
          id,
          title: dialog.title ?? dialog.name ?? id,
          kind: dialog.isUser ? 'direct' : dialog.isGroup ? 'group' : 'channel',
          unreadCount: dialog.unreadCount,
          unreadMentionsCount: dialog.unreadMentionsCount,
          lastMessage: dialog.message
            ? mapMessage(dialog.message, id, await senderNameOf(dialog.message))
            : undefined,
        });
      }
      return mapped;
    },
    async getMessages(conversationId, limit) {
      await ensureDialogsLoaded();
      const entity = entities.get(conversationId);
      if (!entity) throw new Error(`Unknown conversation: ${conversationId}`);
      const messages = await client.getMessages(entity, { limit });
      const mapped: TgHistoryMessage[] = [];
      for (const message of messages.reverse()) {
        if (message.className !== 'Message') continue;
        mapped.push(mapMessage(message, conversationId, await senderNameOf(message)));
      }
      return mapped;
    },
    async sendText(conversationId, text) {
      await ensureDialogsLoaded();
      const entity = entities.get(conversationId);
      if (!entity) throw new Error(`Unknown conversation: ${conversationId}`);
      const message = await client.sendMessage(entity, { message: text });
      return mapMessage(message, conversationId);
    },
    async resolvePeer(target) {
      // GramJS resolves usernames (and phone numbers of contacts) via MTProto.
      const entity = await client.getEntity(target.replace(/^@/, '').trim()).catch(() => {
        throw new Error(`could not resolve "${target}" on telegram`);
      });
      const id = String(entity.id);
      // Cache the entity so sendText works without a prior dialog fetch.
      entities.set(id, entity);
      const meta = peerMeta(entity);
      return { id, title: meta.title, kind: meta.kind };
    },
    saveSession() {
      return session.save();
    },
    onNewMessage(handler) {
      client.addEventHandler(async (event: NewMessageEvent) => {
        const message = event.message;
        if (message.className !== 'Message') return;
        if (!message.message) return; // media-only: placeholder support later
        const conversationId = conversationIdOf(message);
        handler(mapMessage(message, conversationId, await senderNameOf(message)));
      }, new NewMessage({}));
    },
  };
  return bound;
};

/** QR sign-in; on 2FA, retries the password without re-scanning. */
async function qrSignInWithPasswordRetry(
  client: TelegramClient,
  options: TelegramFactoryOptions,
): Promise<void> {
  const credentials = { apiId: options.apiId, apiHash: options.apiHash };
  try {
    await signInUserWithQrCode(client, credentials, {
      qrCode: async ({ token }) => {
        // Verified: tg://login?token=<base64url> is the standard login link.
        options.onQrCode(`tg://login?token=${Buffer.from(token).toString('base64url')}`);
      },
      password: (hint) => options.requestPassword(hint),
      onError: (err) => options.logger?.warn('telegram auth error', { error: err.message }),
    });
    return;
  } catch (error) {
    if (!isPasswordError(error)) throw error;
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= PASSWORD_RETRIES; attempt++) {
    try {
      await signInWithPassword(client, credentials, {
        password: (hint) => options.requestPassword(hint),
        onError: (err) => options.logger?.warn('telegram auth error', { error: err.message }),
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isPasswordError(error)) throw error;
    }
  }
  throw new Error('2FA password was rejected repeatedly', { cause: lastError });
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && /PASSWORD/.test(error.message);
}

function sessionPath(dataPath: string): string {
  return join(dataPath, 'session.txt');
}

function mkdirDataPath(dataPath: string): void {
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
}

function readSession(dataPath: string): string | undefined {
  const file = sessionPath(dataPath);
  if (!existsSync(file)) return undefined;
  const value = readFileSync(file, 'utf8').trim();
  return value === '' ? undefined : value;
}

function writeSession(dataPath: string, session: string): void {
  // The session string is a credential: owner-only file, outside the repo.
  writeFileSync(sessionPath(dataPath), session, { mode: 0o600 });
}