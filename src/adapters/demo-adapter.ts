import type {
  AccountConfig,
  AdapterCapabilities,
  AuthPrompt,
  Conversation,
  Message,
} from '../domain/types.js';
import type { Logger } from '../core/logger.js';
import { BaseAdapter } from './base-adapter.js';

/** A seeded message in the sample history. */
export interface DemoSeedMessage {
  text: string;
  /** Epoch-ms offset from now, negative for the past. */
  minutesAgo: number;
  direction: 'incoming' | 'outgoing';
  sender?: string;
}

/** A seeded conversation. */
export interface DemoSeedConversation {
  id: string;
  title: string;
  unread: number;
  kind?: Conversation['kind'];
  mentions?: number;
  muted?: boolean;
  messages: DemoSeedMessage[];
  /** Pool of occasional incoming messages, used round-robin. */
  incomingPool?: string[];
  /**
   * When set, sending into this conversation fails with this reason --
   * e.g. an unaccepted SimpleX contact. Exercises the failure path.
   */
  failSends?: string;
}

export interface DemoSeed {
  conversations: DemoSeedConversation[];
  /**
   * Optional simulated authentication challenge sequence, played once per
   * process: qr steps with advanceAfterMs simulate a phone scan; steps
   * with expect wait for a submitAuthResponse matching the value.
   */
  authScript?: DemoAuthStep[];
}

export interface DemoAuthStep {
  prompt: AuthPrompt;
  advanceAfterMs?: number;
  expect?: string;
}

/**
 * Explicit and honest capability set for the demo adapter: it can send
 * text and serve seeded history, nothing else.
 */
const DEMO_CAPABILITIES: AdapterCapabilities = {
  canSendText: true,
  canSendAttachments: false,
  canEditMessages: false,
  canReact: false,
  canFetchHistory: true,
  canSearch: false,
  canStartConversations: true,
};

/**
 * Deterministic simulated traffic: the first message arrives shortly after
 * connect, then one per interval per account, with the target conversation
 * chosen by a seeded PRNG so demo sessions are reproducible.
 */
const FIRST_INCOMING_MS = 6_000;
const INCOMING_INTERVAL_MS = 20_000;

let nextId = 0;
function freshId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${Date.now().toString(36)}-${nextId}`;
}

/** mulberry32 -- tiny deterministic PRNG for reproducible demo traffic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromText(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * In-memory sample adapter used while the TUI is being developed. It
 * simulates a connect handshake, seeded history, occasional incoming
 * traffic, and a local echo for outgoing messages. No credentials, no
 * persistence, no network.
 */
export class DemoAdapter extends BaseAdapter {
  private readonly conversations = new Map<string, Conversation>();
  private readonly history = new Map<string, Message[]>();
  private readonly incomingPools = new Map<string, string[]>();
  private readonly failReasons = new Map<string, string>();
  private readonly random: () => number;
  private readonly authScript: DemoAuthStep[];
  private authDone = false;
  private authAdvanceTimer: ReturnType<typeof setTimeout> | undefined;
  private authAdvanceReject: ((err: Error) => void) | undefined;
  private authWaiter:
    | { expect: string; resolve(): void; reject(err: Error): void }
    | undefined;
  private firstTimer: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Monotonic token: disconnect invalidates an in-flight connect. */
  private connectToken = 0;

  constructor(account: AccountConfig, seed: DemoSeed, logger?: Logger) {
    super(account, 'demo', DEMO_CAPABILITIES, logger);
    this.random = mulberry32(seedFromText(account.id));
    this.authScript = seed.authScript ?? [];
    const now = Date.now();
    for (const seeded of seed.conversations) {
      const messages: Message[] = seeded.messages.map((m) => ({
        id: freshId('demo'),
        accountId: account.id,
        conversationId: seeded.id,
        direction: m.direction,
        text: m.text,
        sender: m.sender,
        timestamp: now - m.minutesAgo * 60_000,
        state: m.direction === 'outgoing' ? 'delivered' : undefined,
      }));
      messages.sort((a, b) => a.timestamp - b.timestamp);
      this.history.set(seeded.id, messages);
      this.conversations.set(seeded.id, {
        id: seeded.id,
        accountId: account.id,
        title: seeded.title,
        kind: seeded.kind,
        unread: seeded.unread,
        mentions: seeded.mentions,
        muted: seeded.muted,
        lastMessage: messages[messages.length - 1],
      });
      if (seeded.incomingPool && seeded.incomingPool.length > 0) {
        this.incomingPools.set(seeded.id, [...seeded.incomingPool]);
      }
      if (seeded.failSends !== undefined) {
        this.failReasons.set(seeded.id, seeded.failSends);
      }
    }
  }

  async connect(): Promise<void> {
    if (this.isConnected()) return;
    const token = ++this.connectToken;
    this.setStatus('connecting');
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.assertConnectAlive(token);
    // Simulated pairing flow, if seeded (skipped on later connects).
    if (!this.authDone && this.authScript.length > 0) {
      await this.runAuthScript(token);
    }
    this.assertConnectAlive(token);
    this.setStatus('connected');
    this.firstTimer = setTimeout(() => {
      this.simulateIncoming();
      this.timer = setInterval(() => this.simulateIncoming(), INCOMING_INTERVAL_MS);
      // Never keep the process alive just for demo traffic.
      this.timer.unref?.();
    }, FIRST_INCOMING_MS);
    this.firstTimer.unref?.();
  }

  async disconnect(): Promise<void> {
    this.connectToken += 1;
    if (this.firstTimer !== undefined) clearTimeout(this.firstTimer);
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.authAdvanceTimer !== undefined) clearTimeout(this.authAdvanceTimer);
    this.firstTimer = undefined;
    this.timer = undefined;
    this.authAdvanceTimer = undefined;
    this.authWaiter?.reject(new Error('connection closed during authentication'));
    this.authWaiter = undefined;
    this.authAdvanceReject?.(new Error('connection closed during authentication'));
    this.authAdvanceReject = undefined;
    this.setStatus('disconnected');
  }

  async submitAuthResponse(response: string): Promise<void> {
    const waiter = this.authWaiter;
    if (!waiter) throw new Error('no auth challenge is pending');
    if (response !== waiter.expect) {
      throw new Error('wrong code -- try the hint in the title bar');
    }
    this.authWaiter = undefined;
    waiter.resolve();
  }

  /** Plays the seeded challenge steps; rejects if disconnected mid-flow. */
  private async runAuthScript(token: number): Promise<void> {
    for (const step of this.authScript) {
      this.assertConnectAlive(token);
      this.emitAuthPrompt(step.prompt);
      if (step.expect !== undefined) {
        await new Promise<void>((resolve, reject) => {
          this.authWaiter = { expect: step.expect as string, resolve, reject };
        });
        this.assertConnectAlive(token);
      } else {
        const delay = step.advanceAfterMs ?? 0;
        await new Promise<void>((resolve, reject) => {
          this.authAdvanceReject = reject;
          this.authAdvanceTimer = setTimeout(() => {
            this.authAdvanceReject = undefined;
            resolve();
          }, delay);
          this.authAdvanceTimer.unref?.();
        });
      }
    }
    this.authDone = true;
  }

  private assertConnectAlive(token: number): void {
    if (token !== this.connectToken) {
      throw new Error('connection closed during authentication');
    }
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].map((c) => ({ ...c }));
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const messages = this.history.get(conversationId);
    if (!messages) throw new Error(`Unknown conversation: ${conversationId}`);
    return messages.map((m) => ({ ...m }));
  }

  async sendMessage(conversationId: string, text: string): Promise<Message> {
    const messages = this.history.get(conversationId);
    if (!messages) throw new Error(`Unknown conversation: ${conversationId}`);
    // Honest failure simulation: never pretend the message went out.
    const failReason = this.failReasons.get(conversationId);
    if (failReason !== undefined) {
      throw new Error(failReason);
    }
    const message: Message = {
      id: freshId('demo'),
      accountId: this.account.id,
      conversationId,
      direction: 'outgoing',
      text,
      timestamp: Date.now(),
      state: 'sent',
    };
    messages.push(message);
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.lastMessage = message;
    // Outgoing messages are returned to the caller, not broadcast to
    // onMessage listeners; the service dispatches them itself.
    return { ...message };
  }

  async markRead(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (conversation) conversation.unread = 0;
  }

  async startConversation(target: string): Promise<Conversation> {
    const title = target.trim();
    if (title === '') throw new Error('enter a name for the new contact');
    const id = `demo-new-${freshId('c')}`;
    const message: Message = {
      id: freshId('demo'),
      accountId: this.account.id,
      conversationId: id,
      direction: 'incoming',
      sender: title,
      text: `Hello from ${title}! This conversation was created via the new-chat flow.`,
      timestamp: Date.now(),
    };
    const conversation: Conversation = {
      id,
      accountId: this.account.id,
      title,
      kind: 'direct',
      unread: 1,
      lastMessage: message,
    };
    this.conversations.set(id, conversation);
    this.history.set(id, [message]);
    return { ...conversation };
  }

  private simulateIncoming(): void {
    if (!this.isConnected()) return;
    const entries = [...this.incomingPools.entries()];
    if (entries.length === 0) return;
    const [conversationId, pool] = entries[Math.floor(this.random() * entries.length)];
    const text = pool.shift();
    if (text === undefined) return;
    // Recycle the pool so demo traffic never runs dry.
    pool.push(text);
    const message: Message = {
      id: freshId('demo'),
      accountId: this.account.id,
      conversationId,
      direction: 'incoming',
      text,
      sender: 'someone',
      timestamp: Date.now(),
    };
    const messages = this.history.get(conversationId);
    if (messages) messages.push(message);
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.lastMessage = message;
      conversation.unread += 1;
    }
    this.emitMessage(message);
  }
}