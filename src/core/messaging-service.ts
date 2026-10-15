import type {
  AccountConfig,
  AccountId,
  AdapterCapabilities,
  AdapterStatus,
  AuthPrompt,
  Conversation,
  Message,
  MessagingAdapter,
} from '../domain/types.js';
import { Logger } from './logger.js';

interface StatusChange {
  accountId: AccountId;
  status: AdapterStatus;
  /** Non-sensitive description of an error, if status is 'error'. */
  error?: string;
}

interface AuthChallenge {
  accountId: AccountId;
  prompt: AuthPrompt;
}

type MessageHandler = (message: Message) => void;
type StatusHandler = (change: StatusChange) => void;
type AuthPromptHandler = (challenge: AuthChallenge) => void;
type AccountsChangedHandler = () => void;

/** Maximum remembered message keys before the dedupe set is pruned. */
const DEDUPE_LIMIT = 5000;

/** Bounded retry with exponential backoff and jitter. */
async function withRetry(
  operation: () => Promise<void>,
  label: string,
  logger?: Logger,
  attempts = 3,
  baseDelayMs = 500,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      // Log the attempt number and reason class only - never payloads.
      const detail = error instanceof Error ? error.message : String(error);
      logger?.warn('connect attempt failed', { attempt, detail });
      if (attempt < attempts) {
        const jitter = Math.random() * baseDelayMs;
        const delay = baseDelayMs * 2 ** (attempt - 1) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  // Describe the failure without including message contents or secrets.
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}: failed after ${attempts} attempts (${detail})`, {
    cause: lastError,
  });
}

export interface MessagingServiceOptions {
  logger?: Logger;
}

/**
 * Owns every adapter and is the only thing the TUI talks to. It dedupes
 * replayed incoming events, isolates per-adapter connect failures, makes
 * unsupported capabilities explicit, and routes outgoing messages through
 * the same dispatch pipeline so the UI has a single update path.
 */
export class MessagingService {
  private readonly adapters = new Map<AccountId, MessagingAdapter>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private readonly authPromptHandlers = new Set<AuthPromptHandler>();
  private readonly accountsChangedHandlers = new Set<AccountsChangedHandler>();
  /** Latest unanswered auth challenge per account (state, not event). */
  private readonly pendingAuthPrompts = new Map<AccountId, AuthPrompt>();
  private readonly unsubscribeAdapters = new Map<AccountId, () => void>();
  private readonly logger: Logger;

  /** Seen `${accountId}:${message.id}` keys, for idempotent dispatch. */
  private readonly seenKeys = new Set<string>();

  private disposed = false;

  constructor(options: MessagingServiceOptions = {}) {
    this.logger = options.logger ?? Logger.silent();
  }

  register(adapter: MessagingAdapter): void {
    if (this.adapters.has(adapter.account.id)) {
      throw new Error(`Duplicate account id: ${adapter.account.id}`);
    }
    this.adapters.set(adapter.account.id, adapter);
    const unsubscribers: Array<() => void> = [
      adapter.onMessage((message) => {
        this.dispatchIncoming(adapter.account.id, message);
      }),
    ];
    if (adapter.onStatus) {
      unsubscribers.push(
        adapter.onStatus((change) => {
          if (change.status === 'connected' || change.status === 'error' || change.status === 'disconnected') {
            this.pendingAuthPrompts.delete(adapter.account.id);
          }
          this.emitStatus({ accountId: adapter.account.id, ...change });
        }),
      );
    }
    if (adapter.onAuthPrompt) {
      unsubscribers.push(
        adapter.onAuthPrompt((prompt) => {
          this.pendingAuthPrompts.set(adapter.account.id, prompt);
          for (const handler of this.authPromptHandlers) {
            handler({ accountId: adapter.account.id, prompt });
          }
        }),
      );
    }
    this.logger.debug('adapter registered', { accountId: adapter.account.id });
    this.unsubscribeAdapters.set(adapter.account.id, () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    });
    for (const handler of this.accountsChangedHandlers) handler();
  }

  /**
   * Connects one already-registered account with bounded retry; failures
   * surface as status events and a thrown, non-sensitive error.
   */
  async connectAccount(accountId: AccountId): Promise<void> {
    const adapter = this.requireAdapter(accountId);
    try {
      await withRetry(() => adapter.connect(), `connect ${accountId}`, this.logger);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emitStatus({ accountId, status: 'error', error: detail });
      throw new Error(detail, { cause: error });
    }
  }

  /**
   * Removes an account at runtime: unsubscribes its handlers, disconnects
   * it, drops all references. Persistent cleanup (session data, stored
   * rows) is the caller's job.
   */
  async unregister(accountId: AccountId): Promise<void> {
    const adapter = this.adapters.get(accountId);
    if (!adapter) throw new Error(`Unknown account: ${accountId}`);
    this.unsubscribeAdapters.get(accountId)?.();
    this.unsubscribeAdapters.delete(accountId);
    this.adapters.delete(accountId);
    this.pendingAuthPrompts.delete(accountId);
    this.logger.info('adapter unregistered', { accountId });
    for (const handler of this.accountsChangedHandlers) handler();
    await adapter.disconnect();
  }

  onAccountsChanged(handler: AccountsChangedHandler): () => void {
    this.accountsChangedHandlers.add(handler);
    return () => {
      this.accountsChangedHandlers.delete(handler);
    };
  }

  /** Connects all adapters; one failure never blocks the others. */
  async connectAll(): Promise<void> {
    const adapters = [...this.adapters.values()];
    const results = await Promise.allSettled(
      adapters.map((adapter) =>
        withRetry(() => adapter.connect(), `connect ${adapter.account.id}`, this.logger),
      ),
    );
    let failures = 0;
    results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      failures += 1;
      const reason = result.reason;
      this.emitStatus({
        accountId: adapters[index].account.id,
        status: 'error',
        error: reason instanceof Error ? reason.message : String(reason),
      });
    });
    if (failures > 0) {
      // Individual failures were already reported via status events.
      throw new Error(`${failures} adapter(s) failed to connect`);
    }
  }

  /** Graceful parallel shutdown; safe to call twice. */
  async disconnectAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribeAdapters.values()) unsubscribe();
    this.unsubscribeAdapters.clear();
    await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.disconnect()),
    );
    this.logger.info('service disconnected');
  }

  getAccounts(): AccountConfig[] {
    return [...this.adapters.values()].map((adapter) => adapter.account);
  }

  getAdapterStatus(accountId: AccountId): AdapterStatus {
    return this.adapters.get(accountId)?.getStatus() ?? 'disconnected';
  }

  async listConversations(): Promise<Conversation[]> {
    const all: Conversation[] = [];
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.listConversations()),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') all.push(...result.value);
    }
    all.sort((a, b) => lastActivity(b) - lastActivity(a));
    return all;
  }

  async getMessages(accountId: AccountId, conversationId: string): Promise<Message[]> {
    const adapter = this.requireAdapter(accountId);
    if (!adapter.capabilities.canFetchHistory) {
      throw new Error(`${accountId}: this platform does not support fetching history`);
    }
    return adapter.getMessages(conversationId);
  }

  async sendMessage(
    accountId: AccountId,
    conversationId: string,
    text: string,
  ): Promise<Message> {
    const adapter = this.requireAdapter(accountId);
    // Unsupported capabilities are explicit errors, never silent no-ops.
    if (!adapter.capabilities.canSendText) {
      throw new Error(`${accountId}: this platform does not support sending text`);
    }
    // The adapter returns the accepted message; adapters do not notify
    // listeners for their own outgoing messages, so dispatch it here to
    // keep a single update path for the UI.
    const message = await adapter.sendMessage(conversationId, text);
    this.dispatch(accountId, message);
    return message;
  }

  /**
   * Reconnects one account: tear down, then connect with bounded backoff.
   * Used by the "Reconnect account" command; failures surface as status
   * events and an explicit thrown error, never a crash.
   */
  async reconnect(accountId: AccountId): Promise<void> {
    const adapter = this.requireAdapter(accountId);
    this.logger.info('adapter reconnect requested', { accountId });
    await adapter.disconnect().catch((error: unknown) => {
      // A failing teardown must not block the reconnect, but it is logged.
      this.logger.warn('adapter disconnect before reconnect failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await withRetry(() => adapter.connect(), `reconnect ${accountId}`, this.logger);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.emitStatus({ accountId, status: 'error', error: detail });
      throw new Error(detail, { cause: error });
    }
  }

  /** Capabilities by account, e.g. to gate the composer on canSendText. */
  getCapabilities(accountId: AccountId): AdapterCapabilities {
    return this.requireAdapter(accountId).capabilities;
  }

  async markRead(accountId: AccountId, conversationId: string): Promise<void> {
    const adapter = this.requireAdapter(accountId);
    if (adapter.markRead) await adapter.markRead(conversationId);
    // Unsupported read state is explicitly optional; do not pretend.
  }

  /**
   * Starts a new conversation (capability-gated): target is
   * platform-specific - phone number, @username, user id, invitation link.
   */
  async startConversation(accountId: AccountId, target: string): Promise<Conversation> {
    const adapter = this.requireAdapter(accountId);
    if (!adapter.capabilities.canStartConversations || !adapter.startConversation) {
      throw new Error(`${accountId}: this platform cannot start new conversations yet`);
    }
    return adapter.startConversation(target);
  }

  /** Pickable start targets, when the platform has a directory (Slack). */
  async listStartTargets(accountId: AccountId): Promise<Array<{ id: string; title: string }>> {
    const adapter = this.requireAdapter(accountId);
    if (!adapter.listStartTargets) {
      throw new Error(`${accountId}: this platform has no pickable contacts — enter the target instead`);
    }
    return adapter.listStartTargets();
  }

  /** Shareable invitation link (SimpleX-style platforms). */
  async getConnectionLink(accountId: AccountId): Promise<string> {
    const adapter = this.requireAdapter(accountId);
    if (!adapter.getConnectionLink) {
      throw new Error(`${accountId}: this platform does not use connection links`);
    }
    return adapter.getConnectionLink();
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onAuthPrompt(handler: AuthPromptHandler): () => void {
    this.authPromptHandlers.add(handler);
    // Auth challenges are state: replay pending ones (UI mounts after
    // connectAll may already have emitted them).
    const pending = [...this.pendingAuthPrompts.entries()];
    if (pending.length > 0) {
      queueMicrotask(() => {
        if (this.authPromptHandlers.has(handler)) {
          for (const [accountId, prompt] of pending) handler({ accountId, prompt });
        }
      });
    }
    return () => {
      this.authPromptHandlers.delete(handler);
    };
  }

  /** Forwards a response to the current auth challenge of the account. */
  async submitAuthResponse(accountId: AccountId, response: string): Promise<void> {
    const adapter = this.requireAdapter(accountId);
    if (!adapter.submitAuthResponse) {
      throw new Error(`${accountId}: this platform is not waiting for an auth response`);
    }
    // The response (password/code) is never logged - not even its length.
    await adapter.submitAuthResponse(response);
  }

  /** Platform reconnects can replay events, so every dispatch is deduped. */
  private dispatchIncoming(accountId: AccountId, message: Message): void {
    this.dispatch(accountId, message);
  }

  /**
   * Dedupes by `${accountId}:${message.id}` and fans out to handlers.
   * Returns whether the message was newly seen.
   */
  private dispatch(accountId: AccountId, message: Message): boolean {
    const key = `${accountId}:${message.id}`;
    if (this.seenKeys.has(key)) return false;
    this.seenKeys.add(key);
    if (this.seenKeys.size > DEDUPE_LIMIT) {
      // Sets iterate in insertion order; drop the oldest half.
      const toDelete = [...this.seenKeys].slice(0, Math.floor(DEDUPE_LIMIT / 2));
      for (const k of toDelete) this.seenKeys.delete(k);
    }
    const normalized: Message = { ...message, accountId };
    for (const handler of this.messageHandlers) handler(normalized);
    return true;
  }

  private emitStatus(change: StatusChange): void {
    for (const handler of this.statusHandlers) handler(change);
  }

  private requireAdapter(accountId: AccountId): MessagingAdapter {
    const adapter = this.adapters.get(accountId);
    if (!adapter) throw new Error(`Unknown account: ${accountId}`);
    return adapter;
  }
}

function lastActivity(conversation: Conversation): number {
  return conversation.lastMessage?.timestamp ?? 0;
}
