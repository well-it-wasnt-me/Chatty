/**
 * Domain contract shared by the TUI, the MessagingService, and every adapter.
 *
 * The contract is intentionally small. Add attachment, edit, reaction,
 * read-state, thread or search methods only when an adapter can implement
 * them meaningfully -- unsupported capabilities are exposed explicitly via
 * AdapterCapabilities instead of being silently pretended to work.
 * We learned this lesson the hard way. You will too.
 */

/** Platforms supported by the client. Five accounts, four platforms. Counting is apparently a feature. */
export type Platform = 'whatsapp' | 'telegram' | 'slack' | 'simplex';

/**
 * Stable identifier for an account. Never reused, never shared --
 * in particular the two WhatsApp accounts always use distinct ids.
 * Treat it like a Social Security number but for chat.
 */
export type AccountId = string;

/** Static, per-account configuration. Boring is good here; surprises belong in birthday cards. */
export interface AccountConfig {
  /** Stable account identifier, e.g. "whatsapp-a". */
  id: AccountId;
  /** Human-readable name shown in the UI. */
  label: string;
  /** Platform tag shown in the UI, e.g. "WA-A", "TG". */
  badge: string;
  platform: Platform;
  /**
   * Directory for this account's credentials and persisted state.
   * Every account owns a separate path; WhatsApp A and B never share
   * auth state. Keep these outside the repository (see .env.example).
   * Or don't. I'm not your mother.
   */
  dataPath: string;
}

/** Explicit capability declaration. A checkbox is not a feature, no matter how confidently we label it. */
export interface AdapterCapabilities {
  canSendText: boolean;
  canSendAttachments: boolean;
  canEditMessages: boolean;
  canReact: boolean;
  canFetchHistory: boolean;
  canSearch: boolean;
  /** The adapter can create a new conversation given a platform target. */
  canStartConversations: boolean;
}

export type AdapterStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Transport backend for an account: demo (simulated) or a real one --
 * cli (SimpleX local chat server), gramjs (Telegram MTProto user client),
 * socket (Slack Socket Mode), baileys (WhatsApp Web).
 * The cache layer keys persisted data by this. Switching transports
 * invalidates stale cached rows instead of mixing garbage together.
 */
export type AdapterTransport = 'demo' | 'cli' | 'gramjs' | 'socket' | 'baileys';

export interface AdapterStatusChange {
  status: AdapterStatus;
  /** Non-sensitive description of an error, if status is 'error'. */
  error?: string;
}

/**
 * Authentication challenge raised by an adapter during connect/reconnect.
 * One shared shape for all platforms so the TUI never re-learns auth UX:
 *
 * - WhatsApp (Baileys): qr with the pairing payload from connection.update.qr.
 * - Telegram (GramJS): qr with the tg://login?token=... link, then password
 *   with the server's passwordHint when 2FA is enabled.
 * - Any platform needing a one-time code uses code; free-form input uses
 *   text with a label (e.g. phone number fallback).
 *
 * The data of a qr prompt is never logged and never stored -- it is a
 * short-lived secret (scan-to-login equivalent). We are not in the business
 * of leaking your login tokens.
 */
export type AuthPrompt =
  | { kind: 'qr'; data: string }
  | { kind: 'password'; hint?: string }
  | { kind: 'code'; hint?: string }
  | { kind: 'text'; label: string; allowEmpty?: boolean };

export type MessageDirection = 'incoming' | 'outgoing';

export type DeliveryState = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  /**
   * Platform-scoped message id. Only unique within
   * accountId:id -- never treat it as globally unique.
   * The service dedupes by accountId:messageId. You have been warned.
   */
  id: string;
  accountId: AccountId;
  conversationId: string;
  direction: MessageDirection;
  /** Epoch milliseconds. */
  timestamp: number;
  text: string;
  /** Display name of the sender for incoming messages. */
  sender?: string;
  state?: DeliveryState;
  /**
   * Platform-specific fields that do not map cleanly to the common model.
   * Adapters document their own metadata keys; the TUI only renders it if
   * it knows how. We do not guess.
   */
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  accountId: AccountId;
  title: string;
  /**
   * Coarse conversation classification. Adapters set this when the
   * platform exposes it; the UI uses it for icons and filtering only.
   * Do not build business logic on this. It is a hint.
   */
  kind?: ConversationKind;
  unread: number;
  /** Mentions of the local user, when the platform tracks them. */
  mentions?: number;
  /** Muted conversations still count unread internally but are de-emphasized. */
  muted?: boolean;
  lastMessage?: Message;
  metadata?: Record<string, unknown>;
}

export type ConversationKind = 'direct' | 'group' | 'channel';

/**
 * Common interface every adapter implements. The TUI only ever talks to
 * this contract through the MessagingService. Do not bypass the service.
 * The service handles dedup, capability gating, and auth prompt replay.
 * You are not special.
 */
export interface MessagingAdapter {
  readonly account: AccountConfig;
  readonly capabilities: AdapterCapabilities;
  /**
   * Transport that backs this adapter instance. The cache layer keys
   * persisted data by it, so switching an account between transports
   * (e.g. demo to real) invalidates stale cached rows instead of mixing.
   */
  readonly transport: AdapterTransport;

  getStatus(): AdapterStatus;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listConversations(): Promise<Conversation[]>;
  getMessages(conversationId: string): Promise<Message[]>;

  /**
   * Sends text and returns the message as the adapter accepted it.
   * Adapters notify listeners about incoming events only; outgoing
   * messages come back via this return value, which the service routes
   * through the same dispatch pipeline.
   */
  sendMessage(conversationId: string, text: string): Promise<Message>;

  /** Optional: mark a conversation read, if the platform supports read state. */
  markRead?(conversationId: string): Promise<void>;

  /**
   * Optional: creates a new conversation from a platform-specific target
   * (WhatsApp: phone number, Telegram: @username/phone, Slack: user id,
   * SimpleX: invitation link). Rejects with a readable reason on failure.
   */
  startConversation?(target: string): Promise<Conversation>;

  /**
   * Optional: candidates for startConversation, when the platform has a
   * pickable directory (Slack workspace users). Absent = free-form target.
   */
  listStartTargets?(): Promise<Array<{ id: string; title: string }>>;

  /**
   * Optional: platforms that connect via invitation links (SimpleX):
   * returns a fresh shareable one-time connection link.
   */
  getConnectionLink?(): Promise<string>;

  /**
   * Registers a handler for incoming messages. Returns an unsubscribe
   * function. Handlers must be safe to call reconnects -- the service
   * deduplicates replays.
   */
  onMessage(handler: (message: Message) => void): () => void;

  /**
   * Optional: registers a handler for connection status transitions, so
   * reconnect/loss events surface in the UI between getStatus() polls.
   * Returns an unsubscribe function. Only emit transitions, never payloads.
   */
  onStatus?(handler: (change: AdapterStatusChange) => void): () => void;

  /**
   * Optional: registers a handler for authentication challenges raised
   * while connecting (QR codes, 2FA passwords, one-time codes). Returns an
   * unsubscribe function. See AuthPrompt for the shared shape.
   */
  onAuthPrompt?(handler: (prompt: AuthPrompt) => void): () => void;

  /**
   * Optional: answers the current password/code/text challenge.
   * Rejects with a human-readable reason when the response was wrong.
   */
  submitAuthResponse?(response: string): Promise<void>;
}