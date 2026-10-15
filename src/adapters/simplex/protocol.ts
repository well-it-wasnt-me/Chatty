import { z } from 'zod';
import type { Conversation, DeliveryState, Message } from '../../domain/types.js';

/**
 * SimpleX terminal protocol (bots/WebSocket API), verified against
 * simplex-chat v7 bots/api/*.md and the official TypeScript client.
 *
 * Wire format over ws://127.0.0.1:<port>:
 * - command  -> {"corrId": "n", "cmd": "/_get chats ..."}
 * - response -> {"corrId": "n", "resp": {...}}
 * - event    -> {"resp": {...}}
 *
 * Only the fields chatty actually consumes are modeled; everything else is
 * validated loosely and passed through. No field here ever contains data
 * chatty must not log - callers must still only log metadata.
 */

// ---------------------------------------------------------------- envelope

const envelopeSchema = z.object({
  corrId: z.string().optional(),
  resp: z.looseObject({ type: z.string() }),
});

export interface WireEnvelope {
  corrId?: string;
  resp: { type: string } & Record<string, unknown>;
}

/** Parses one raw WebSocket message; returns undefined for non-JSON junk. */
export function parseEnvelope(raw: string): WireEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) return undefined;
  return result.data as WireEnvelope;
}

export function encodeCommand(corrId: string, cmd: string): string {
  return JSON.stringify({ corrId, cmd });
}

// ------------------------------------------------------- wire shape (loose)

const ciStatusSchema = z.looseObject({ type: z.string() });

const ciMetaSchema = z.looseObject({
  itemId: z.number(),
  itemTs: z.string(),
  itemText: z.string(),
  itemStatus: ciStatusSchema,
});

const msgContentSchema = z.looseObject({ type: z.string() });

const ciContentSchema = z.looseObject({
  type: z.string(),
  msgContent: msgContentSchema.optional(),
});

const localProfileSchema = z.looseObject({ displayName: z.string() });

const contactSchema = z.looseObject({
  contactId: z.number(),
  localDisplayName: z.string(),
  profile: localProfileSchema.optional(),
});

const groupMemberProfileSchema = z.looseObject({
  memberProfile: localProfileSchema.optional(),
});

const groupInfoSchema = z.looseObject({
  groupId: z.number(),
  localDisplayName: z.string(),
});

const ciDirectionSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('directSnd') }),
  z.looseObject({ type: z.literal('directRcv') }),
  z.looseObject({ type: z.literal('groupSnd') }),
  z.looseObject({
    type: z.literal('groupRcv'),
    groupMember: groupMemberProfileSchema.optional(),
  }),
  z.looseObject({ type: z.literal('localSnd') }),
  z.looseObject({ type: z.literal('localRcv') }),
]);

const chatInfoSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('direct'), contact: contactSchema }),
  z.looseObject({ type: z.literal('group'), groupInfo: groupInfoSchema }),
  z.looseObject({ type: z.literal('local') }),
  z.looseObject({ type: z.literal('contactRequest') }),
  z.looseObject({ type: z.literal('contactConnection') }),
]);

const chatItemSchema = z.looseObject({
  chatDir: ciDirectionSchema,
  meta: ciMetaSchema,
  content: ciContentSchema,
});

const chatStatsSchema = z.looseObject({
  unreadCount: z.number(),
  unreadMentions: z.number(),
});

const aChatItemSchema = z.looseObject({
  chatInfo: chatInfoSchema,
  chatItem: chatItemSchema,
});

const aChatSchema = z.looseObject({
  chatInfo: chatInfoSchema,
  chatItems: z.array(chatItemSchema),
  chatStats: chatStatsSchema,
});

export type SxChatInfo = z.infer<typeof chatInfoSchema>;
export type SxChatItem = z.infer<typeof chatItemSchema>;
export type SxAChat = z.infer<typeof aChatSchema>;
export type SxAChatItem = z.infer<typeof aChatItemSchema>;

export const activeUserSchema = z.looseObject({
  type: z.literal('activeUser'),
  user: z.looseObject({ userId: z.number(), localDisplayName: z.string() }),
});

export const apiChatsSchema = z.looseObject({
  type: z.literal('apiChats'),
  chats: z.array(aChatSchema),
});

export const newChatItemsEventSchema = z.looseObject({
  type: z.literal('newChatItems'),
  chatItems: z.array(aChatItemSchema),
});

// ----------------------------------------------------------------- commands

export function cmdActiveUser(): string {
  return '/user';
}

export function cmdCreateUser(displayName: string): string {
  return `/_create user ${JSON.stringify({
    profile: { displayName, fullName: '' },
    pastTimestamp: false,
  })}`;
}

export function cmdGetChats(userId: number, count = 200): string {
  return (
    `/_get chats ${userId} count=${count} ` +
    JSON.stringify({ type: 'filters', favorite: false, unread: false })
  );
}

/** chatRef syntax: @<contactId> direct, #<groupId> group. */
export function cmdSendText(conversationId: string, text: string): string {
  if (!isDirectRef(conversationId) && !isGroupRef(conversationId)) {
    throw new Error(`Not a SimpleX chat reference: ${conversationId}`);
  }
  return `/_send ${conversationId} json ${JSON.stringify([
    { msgContent: { type: 'text', text }, mentions: {} },
  ])}`;
}

/**
 * `/_connect` with no argument: asks the CLI to create a new one-time
 * invitation link the user can share (CLI.md: "enter /c ... to create a new
 * connection and generate an invitation").
 */
export function cmdCreateInvitation(): string {
  return '/_connect';
}

/** `/_connect <invitation>`: accepts a contact's invitation link. */
export function cmdConnectTo(link: string): string {
  const trimmed = link.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error('not a SimpleX invitation link (expected https://...) - paste the full link your contact shared');
  }
  return `/_connect ${trimmed}`;
}

/**
 * The create-invitation response shape varies across simplex-chat versions,
 * so instead of pinning one schema we deep-scan the payload for the first
 * `https://` string - the invitation link is always a URL.
 */
export function findConnectionLink(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const match = /https:\/\/\S+/.exec(value);
    return match?.[0];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findConnectionLink(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'corrId') continue;
      const found = findConnectionLink(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Extracts a readable reason from a `chatError`/`chatErrors` response. */
export function connectErrorText(resp: Record<string, unknown>): string | undefined {
  const type = String(resp.type ?? '');
  if (type !== 'chatError' && type !== 'chatErrors') return undefined;
  const chatError = (resp as { chatError?: { content?: { text?: unknown } } }).chatError;
  const text = chatError?.content?.text;
  return typeof text === 'string' && text !== '' ? text : `simplex-chat rejected the connection (${type})`;
}

export function isDirectRef(conversationId: string): boolean {
  return /^@\d+$/.test(conversationId);
}

export function isGroupRef(conversationId: string): boolean {
  return /^#\d+$/.test(conversationId);
}

// ------------------------------------------------------------------ mapping

/** Stable domain conversation id for a chatInfo: "@<contactId>" / "#<groupId>". */
export function conversationRef(chatInfo: SxChatInfo): string | undefined {
  if (chatInfo.type === 'direct') return `@${chatInfo.contact.contactId}`;
  if (chatInfo.type === 'group') return `#${chatInfo.groupInfo.groupId}`;
  return undefined;
}

export function conversationTitle(chatInfo: SxChatInfo): string {
  if (chatInfo.type === 'direct') return chatInfo.contact.localDisplayName;
  if (chatInfo.type === 'group') return chatInfo.groupInfo.localDisplayName;
  return 'Notes';
}

export function mapChat(accountId: string, chat: SxAChat): Conversation | undefined {
  const ref = conversationRef(chat.chatInfo);
  if (ref === undefined) return undefined; // notes folders, contact requests: skip for now
  const last = chat.chatItems.at(-1);
  const title = conversationTitle(chat.chatInfo);
  return {
    id: ref,
    accountId,
    title,
    kind: chat.chatInfo.type === 'group' ? 'group' : 'direct',
    unread: chat.chatStats.unreadCount,
    mentions: chat.chatStats.unreadMentions,
    lastMessage: last
      ? mapChatItem(accountId, ref, title, { chatInfo: chat.chatInfo, chatItem: last })
      : undefined,
  };
}

function senderName(aChatItem: SxAChatItem, ownName: string): string {
  const dir = aChatItem.chatItem.chatDir;
  if (dir.type === 'directRcv') {
    return aChatItem.chatInfo.type === 'direct'
      ? aChatItem.chatInfo.contact.localDisplayName
      : ownName;
  }
  if (dir.type === 'groupRcv') {
    return dir.groupMember?.memberProfile?.displayName ?? 'member';
  }
  return ownName;
}

export function mapStatus(statusType: string): DeliveryState | undefined {
  switch (statusType) {
    case 'sndNew':
      return 'pending';
    case 'sndSent':
      return 'sent';
    case 'sndRcvd':
      return 'delivered';
    case 'sndError':
    case 'sndErrorAuth':
    case 'sndWarning':
      return 'failed';
    default:
      return undefined; // incoming statuses carry no delivery state in the UI
  }
}

/** Message content -> plain text; non-text content becomes a bracketed tag. */
export function msgContentText(msgContent: { type: string } & Record<string, unknown>): string {
  if (msgContent.type === 'text' && typeof msgContent.text === 'string') return msgContent.text;
  return `[${msgContent.type}]`;
}

export function mapChatItem(
  accountId: string,
  conversationId: string,
  ownName: string,
  aChatItem: SxAChatItem,
): Message {
  const item = aChatItem.chatItem;
  const outgoing = item.chatDir.type === 'directSnd' || item.chatDir.type === 'groupSnd';
  const msgContent = item.content.msgContent;
  return {
    id: String(item.meta.itemId),
    accountId,
    conversationId,
    direction: outgoing ? 'outgoing' : 'incoming',
    timestamp: Date.parse(item.meta.itemTs),
    text: msgContent ? msgContentText(msgContent) : `[${item.content.type}]`,
    sender: outgoing ? undefined : senderName(aChatItem, ownName),
    state: outgoing ? mapStatus(item.meta.itemStatus.type) : undefined,
    metadata: { simplexDir: item.chatDir.type, itemEdited: item.meta.itemEdited },
  };
}
