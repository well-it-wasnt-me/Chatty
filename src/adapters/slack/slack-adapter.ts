import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountConfig, AdapterCapabilities, Conversation, Message } from '../../domain/types.js';
import type { Logger } from '../../core/logger.js';
import { BaseAdapter } from '../base-adapter.js';
import { createSlackClient } from './real-slack.js';
import type { SlackClientFactory, SlackClientLike, SlackHistoryMessage } from './types.js';

/**
 * Slack adapter over the official SDKs. Token bootstrap order:
 *   1. SLACK_USER_TOKEN / SLACK_APP_TOKEN env (never from the repo)
 *   2. persisted tokens at <dataPath>/tokens.json (mode 0600)
 *   3. the shared auth overlay (text prompts; masked typing)
 *
 * Realtime requires the app-level (xapp) token; without it the adapter still
 * lists history and sends, but incoming events simply do not exist -- that is
 * explicit: capabilities say so via metadata and the docs show the scopes.
 * We do not pretend. You get what the platform gives you.
 */
const SLACK_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false,
  canEditMessages: false,
  canReact: false,
  canFetchHistory: true,
  canSearch: false,
  canStartConversations: true, // DMs via users.list + conversations.open
};

const HISTORY_LIMIT = 50;
const TOKEN_ATTEMPTS = 3;

export interface SlackAdapterOptions {
  userToken?: string;
  appToken?: string;
  factory?: SlackClientFactory;
}

interface SlackTokens {
  userToken: string;
  appToken?: string;
}

export class SlackAdapter extends BaseAdapter {
  private readonly factory: SlackClientFactory;
  private readonly envTokens: { userToken?: string; appToken?: string };
  private client: SlackClientLike | undefined;
  private readonly conversations = new Map<string, Conversation>();
  /** The pending text answer: token prompts resolve through the overlay. */
  private textResponder: ((response: string) => void) | undefined;

  constructor(account: AccountConfig, options: SlackAdapterOptions, logger?: Logger) {
    super(account, 'socket', SLACK_CAPABILITIES, logger);
    this.factory = options.factory ?? createSlackClient;
    this.envTokens = { userToken: options.userToken, appToken: options.appToken };
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    this.setStatus('connecting');
    try {
      // Token order: env -> persisted file -> masked overlay prompt. The
      // prompt path validates tokens before persisting (never store garbage)
      // and re-asks on auth failure, with a bounded attempt count.
      const provided = this.envOrStoredTokens();
      let tokens = provided;
      let lastError: unknown;
      let rejected = false;
      for (let attempt = 1; attempt <= TOKEN_ATTEMPTS; attempt++) {
        try {
          // Prompt when no credentials were provided; a bad answer or a
          // rejected token re-prompts with the reason, never silently.
          if (tokens === undefined) tokens = await this.promptForTokens(rejected);
          this.client = await this.factory({
            userToken: tokens.userToken,
            appToken: tokens.appToken,
            logger: this.logger
              ? { warn: (event, fields) => this.logger!.warn(event, fields) }
              : undefined,
          });
          const identity = await this.client.authTest();
          if (provided === undefined) writeTokens(this.account.dataPath, tokens);
          this.client.onMessageEvent((message) => this.handleIncoming(message));
          this.setStatus('connected');
          this.logger?.info('slack connected', { team: identity.team });
          return;
        } catch (error) {
          lastError = error;
          this.client = undefined;
          if (provided !== undefined) throw error; // env/persisted creds: fail, don't loop
          tokens = undefined;
          rejected = true;
        }
      }
      throw new Error('slack authentication failed repeatedly', { cause: lastError });
    } catch (error) {
      this.setStatus('error', describeError(error));
      this.client = undefined;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.disconnect();
    this.setStatus('disconnected');
  }

  async listConversations(): Promise<Conversation[]> {
    const records = await this.requireClient().listConversations();
    const conversations: Conversation[] = [];
    for (const record of records) {
      const existing = this.conversations.get(record.id);
      const conversation: Conversation = {
        id: record.id,
        accountId: this.account.id,
        title: record.title,
        kind: record.kind,
        unread: record.unread,
        mentions: record.mentions,
        lastMessage: existing?.lastMessage,
      };
      this.conversations.set(record.id, conversation);
      conversations.push(conversation);
    }
    return conversations.map((c) => ({ ...c }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const history = await this.requireClient().history(conversationId, HISTORY_LIMIT);
    const mapped: Message[] = [];
    for (const raw of history) {
      const sender =
        raw.userId !== undefined && !raw.out
          ? await this.requireClient().userName(raw.userId)
          : undefined;
      mapped.push(this.mapMessage(raw, sender));
    }
    const last = mapped.at(-1);
    const conversation = this.conversations.get(conversationId);
    if (conversation && last) conversation.lastMessage = last;
    return mapped;
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    if (!this.conversations.has(conversationId)) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
    const sent = await this.requireClient().postMessage(conversationId, text);
    const message = this.mapMessage({ ts: sent.ts, channel: conversationId, text, out: true });
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastMessage = message;
    return { ...message };
  }

  // markRead: Slack's API read-state for user tokens is unreliable/absent --
  // deliberately not implemented (no pretending).

  /** Workspace members, pickable as DM targets in the new-chat overlay. */
  async listStartTargets(): Promise<Array<{ id: string; title: string }>> {
    const users = await this.requireClient().listUsers();
    return users.map((user) => ({ id: user.id, title: user.name }));
  }

  /**
   * Opens (or returns) the DM channel with a workspace member. Requires
   * the im:write scope; the error says so when it is missing.
   */
  async startConversation(target: string): Promise<Conversation> {
    const userId = target.trim();
    if (userId === '') throw new Error('pick a workspace member to message');
    const record = await this.requireClient().openDirectMessage(userId);
    const existing = this.conversations.get(record.id);
    const conversation: Conversation = {
      id: record.id,
      accountId: this.account.id,
      title: record.title,
      kind: 'direct',
      unread: record.unread,
      mentions: record.mentions,
      lastMessage: existing?.lastMessage,
    };
    this.conversations.set(record.id, conversation);
    return { ...conversation };
  }

  /** Answers the current token prompt from the auth overlay. */
  async submitAuthResponse(response: string): Promise<void> {
    const responder = this.textResponder;
    if (!responder) throw new Error('slack is not waiting for a token');
    this.textResponder = undefined;
    responder(response);
  }

  /** Tokens from constructor options (env-derived) or the persisted file. */
  private envOrStoredTokens(): SlackTokens | undefined {
    if (this.envTokens.userToken !== undefined) {
      return {
        userToken: this.envTokens.userToken,
        appToken: this.envTokens.appToken,
      };
    }
    return readTokens(this.account.dataPath);
  }

  /** Masked prompts via the shared auth overlay; empty app token = skip realtime. */
  private async promptForTokens(rejected: boolean): Promise<SlackTokens> {
    const userToken = (
      await this.awaitText(
        rejected
          ? 'Rejected -- expected an xoxp-/xoxc- user token (or auth.test failed). Try again'
          : 'Slack user token (xoxp-...) -- see docs/ADAPTERS.md for required scopes',
      )
    ).trim();
    if (!userToken.startsWith('xoxp-') && !userToken.startsWith('xoxc-')) {
      throw new Error('that does not look like an xoxp-/xoxc- user token');
    }
    const appToken = (
      await this.awaitText(
        'Slack app token for realtime (xapp-...), or empty to skip realtime',
        true,
      )
    ).trim();
    return { userToken, appToken: appToken === '' ? undefined : appToken };
  }

  private awaitText(label: string, allowEmpty = false): Promise<string> {
    this.emitAuthPrompt({ kind: 'text', label, ...(allowEmpty ? { allowEmpty: true } : {}) });
    return new Promise<string>((resolve) => {
      this.textResponder = resolve;
    });
  }

  private mapMessage(raw: SlackHistoryMessage, sender?: string): Message {
    return {
      // Slack ts is unique within a channel -- scope is account+conversation.
      id: raw.ts,
      accountId: this.account.id,
      conversationId: raw.channel,
      direction: raw.out ? 'outgoing' : 'incoming',
      timestamp: tsToMillis(raw.ts),
      text: raw.text,
      sender: raw.out ? undefined : sender,
      state: raw.out ? 'sent' : undefined,
      metadata: { slackUserId: raw.userId },
    };
  }

  private handleIncoming(raw: SlackHistoryMessage): void {
    const conversation = this.conversations.get(raw.channel);
    if (!conversation || raw.out) return; // outgoing echoes come via sendMessage
    const mapped = this.mapMessage(raw);
    conversation.unread += 1;
    conversation.lastMessage = mapped;
    void this.requireClient()
      .userName(raw.userId ?? '')
      .then((name) => this.emitMessage({ ...mapped, sender: name }));
  }

  private requireClient(): SlackClientLike {
    if (!this.client) throw new Error('slack adapter is not connected');
    return this.client;
  }
}

function tsToMillis(ts: string): number {
  const value = Number(ts);
  return Number.isFinite(value) ? Math.round(value * 1000) : Date.now();
}

function tokensPath(dataPath: string): string {
  return join(dataPath, 'tokens.json');
}

function readTokens(dataPath: string): SlackTokens | undefined {
  const file = tokensPath(dataPath);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as SlackTokens;
    if (typeof parsed.userToken !== 'string' || parsed.userToken === '') return undefined;
    return parsed;
  } catch {
    return undefined; // corrupt token file -> re-prompt instead of crashing
  }
}

function writeTokens(dataPath: string, tokens: SlackTokens): void {
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  writeFileSync(tokensPath(dataPath), JSON.stringify(tokens), { mode: 0o600 });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}