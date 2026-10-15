import type {
  AccountConfig,
  AdapterCapabilities,
  AdapterStatus,
  AdapterStatusChange,
  AdapterTransport,
  AuthPrompt,
  Conversation,
  Message,
  MessagingAdapter,
} from '../domain/types.js';
import type { Logger } from '../core/logger.js';

/**
 * Shared scaffolding for MessagingAdapter implementations: status
 * lifecycle (getStatus/setStatus/onStatus) and fan-out of incoming
 * messages to subscribed handlers.
 *
 * Real adapters extend this class and implement the abstract methods,
 * calling setStatus on every connection transition and emitMessage
 * for each incoming event (the service deduplicates replays).
 * emitMessage copies the message so handlers cannot mutate the
 * adapter's own records. We do not trust you with our internal state.
 */
export abstract class BaseAdapter implements MessagingAdapter {
  readonly account: AccountConfig;
  readonly capabilities: AdapterCapabilities;
  readonly transport: AdapterTransport;
  protected readonly logger?: Logger;

  private status: AdapterStatus = 'disconnected';
  private readonly messageHandlers = new Set<(message: Message) => void>();
  private readonly statusHandlers = new Set<(change: AdapterStatusChange) => void>();
  private readonly authPromptHandlers = new Set<(prompt: AuthPrompt) => void>();
  /** Latest unanswered challenge; replayed to late subscribers (UI mounts
   *  after connect starts -- auth prompts are state, not transient events). */
  private pendingAuthPrompt: AuthPrompt | undefined;

  protected constructor(
    account: AccountConfig,
    transport: AdapterTransport,
    capabilities: AdapterCapabilities,
    logger?: Logger,
  ) {
    this.account = account;
    this.transport = transport;
    this.capabilities = capabilities;
    this.logger = logger?.child(`adapter.${account.id}`);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract listConversations(): Promise<Conversation[]>;
  abstract getMessages(conversationId: string): Promise<Message[]>;
  abstract sendMessage(conversationId: string, text: string): Promise<Message>;

  getStatus(): AdapterStatus {
    return this.status;
  }

  onMessage(handler: (message: Message) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStatus(handler: (change: AdapterStatusChange) => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onAuthPrompt(handler: (prompt: AuthPrompt) => void): () => void {
    this.authPromptHandlers.add(handler);
    const pending = this.pendingAuthPrompt;
    if (pending !== undefined) {
      queueMicrotask(() => {
        if (this.authPromptHandlers.has(handler)) handler(pending);
      });
    }
    return () => {
      this.authPromptHandlers.delete(handler);
    };
  }

  /**
   * Raises an authentication challenge for the UI. Only the prompt kind is
   * logged -- QR payloads and hints are short-lived secrets.
   */
  protected emitAuthPrompt(prompt: AuthPrompt): void {
    this.pendingAuthPrompt = prompt;
    this.logger?.info('auth prompt', { kind: prompt.kind });
    for (const handler of this.authPromptHandlers) handler(prompt);
  }

  /** Transitions status once; repeated identical statuses are suppressed. */
  protected setStatus(status: AdapterStatus, error?: string): void {
    if (this.status === status) return;
    this.status = status;
    if (status === 'connected' || status === 'error' || status === 'disconnected') {
      this.pendingAuthPrompt = undefined; // terminal states end a challenge
    }
    if (status === 'error') {
      this.logger?.warn('adapter status error', { error });
    } else {
      this.logger?.info('adapter status change', { status });
    }
    const change: AdapterStatusChange = { status, error };
    for (const handler of this.statusHandlers) handler(change);
  }

  /** Current status for subclasses that need to gate work on it. */
  protected isConnected(): boolean {
    return this.status === 'connected';
  }

  /** Fans out a copy of an incoming message to all subscribers. */
  protected emitMessage(message: Message): void {
    const copy: Message = { ...message, accountId: this.account.id };
    for (const handler of this.messageHandlers) handler(copy);
  }
}