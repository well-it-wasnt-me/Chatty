import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AccountConfig, AuthPrompt } from '../../domain/types.js';
import { SlackAdapter } from './slack-adapter.js';
import type {
  SlackClientFactory,
  SlackClientLike,
  SlackConversationRecord,
  SlackHistoryMessage,
} from './types.js';

const ACCOUNT: AccountConfig = {
  id: 'slack',
  label: 'Slack',
  badge: 'SL',
  platform: 'slack',
  dataPath: '/tmp/chatty-slack-test',
};

const CHANNELS: SlackConversationRecord[] = [
  { id: 'C1', title: '#general', kind: 'channel', unread: 4, mentions: 0 },
  { id: 'D9', title: 'Dana', kind: 'direct', unread: 1, mentions: 1 },
];

class MockSlackClient implements SlackClientLike {
  readonly events: Array<(m: SlackHistoryMessage) => void> = [];
  posted: Array<{ channel: string; text: string }> = [];

  async authTest() {
    return { userId: 'U-ME', userName: 'me', team: 'acme' };
  }

  async listConversations(): Promise<SlackConversationRecord[]> {
    return CHANNELS;
  }

  async history(channel: string, _limit: number): Promise<SlackHistoryMessage[]> {
    if (channel === 'C1') {
      return [
        { ts: '1699999900.0001', channel: 'C1', text: 'deploy tonight', userId: 'U-DANA', out: false },
        { ts: '1699999990.0002', channel: 'C1', text: 'noted', userId: 'U-ME', out: true },
      ];
    }
    return [];
  }

  async postMessage(channel: string, text: string) {
    this.posted.push({ channel, text });
    return { ts: '1700000100.0005' };
  }

  async userName(userId: string): Promise<string> {
    return userId === 'U-DANA' ? 'Dana' : userId;
  }

  async listUsers(): Promise<Array<{ id: string; name: string }>> {
    return [
      { id: 'U-ME', name: 'me' },
      { id: 'U-DANA', name: 'Dana' },
      { id: 'U-LEE', name: 'Lee' },
    ];
  }

  async openDirectMessage(userId: string): Promise<SlackConversationRecord> {
    return { id: `D-${userId}`, title: userId === 'U-DANA' ? 'Dana' : userId, kind: 'direct', unread: 0, mentions: 0 };
  }

  onMessageEvent(handler: (m: SlackHistoryMessage) => void): void {
    this.events.push(handler);
  }

  async disconnect(): Promise<void> {}

  pushIncoming(message: SlackHistoryMessage): void {
    for (const handler of this.events) handler(message);
  }
}

function factoryOk(): SlackClientFactory {
  return async () => new MockSlackClient();
}

function factoryRejecting(): SlackClientFactory {
  return async () => {
    throw new Error('invalid_auth');
  };
}

describe('SlackAdapter', () => {
  it('connects with env-provided tokens and lists conversations', async () => {
    const adapter = new SlackAdapter(ACCOUNT, { userToken: 'xoxp-x', factory: factoryOk() });
    await adapter.connect();
    expect(adapter.getStatus()).toBe('connected');
    const conversations = await adapter.listConversations();
    expect(conversations.map((c) => c.id)).toEqual(['C1', 'D9']);
    expect(conversations[0]).toMatchObject({ title: '#general', kind: 'channel', unread: 4 });
    expect(conversations[1]).toMatchObject({ title: 'Dana', kind: 'direct', mentions: 1 });
  });

  it('serves history with resolved sender names and slack-ts timestamps', async () => {
    const adapter = new SlackAdapter(ACCOUNT, { userToken: 'xoxp-x', factory: factoryOk() });
    await adapter.connect();
    await adapter.listConversations();
    const history = await adapter.getMessages('C1');
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      id: '1699999900.0001',
      direction: 'incoming',
      sender: 'Dana',
      timestamp: 1699999900000,
    });
    expect(history[1].direction).toBe('outgoing');
    expect(history[1].state).toBe('sent');
    await expect(adapter.getMessages('nope')).rejects.toThrow(/Unknown conversation/);
  });

  it('sends text; id is the channel-scoped ts', async () => {
    const adapter = new SlackAdapter(ACCOUNT, { userToken: 'xoxp-x', factory: factoryOk() });
    await adapter.connect();
    await adapter.listConversations();
    const sent = await adapter.sendMessage('C1', 'ship it');
    expect(sent).toMatchObject({ id: '1700000100.0005', direction: 'outgoing', state: 'sent' });
  });

  it('routes realtime events to onMessage with unread bumps, ignoring own sends', async () => {
    const client = new MockSlackClient();
    const adapter = new SlackAdapter(ACCOUNT, {
      userToken: 'xoxp-x',
      appToken: 'xapp-x',
      factory: async () => client,
    });
    await adapter.connect();
    await adapter.listConversations();
    const received: string[] = [];
    adapter.onMessage((m) => received.push(`${m.sender ?? '?'}:${m.text}`));
    client.pushIncoming({ ts: '1700000200.0001', channel: 'C1', text: 'yo', userId: 'U-DANA', out: false });
    client.pushIncoming({ ts: '1700000201.0002', channel: 'C1', text: 'echo self', userId: 'U-ME', out: true });
    await vi.waitFor(() => expect(received).toEqual(['Dana:yo']));
    // own message is untouched in the unread counter
    expect((await adapter.listConversations()).find((c) => c.id === 'C1')?.unread).toBe(4);
  });

  it('prompts for tokens via the auth overlay when nothing is configured', async () => {
    const prompts: AuthPrompt[] = [];
    const dataPath = mkdtempSync(join(tmpdir(), 'chatty-slack-tokens-'));
    const adapter = new SlackAdapter(
      { ...ACCOUNT, dataPath },
      { factory: factoryOk() },
    );
    adapter.onAuthPrompt?.((p) => prompts.push(p));
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({ kind: 'text', label: expect.stringContaining('xoxp-') });
    await adapter.submitAuthResponse?.('xoxp-typed');
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toMatchObject({ kind: 'text', allowEmpty: true });
    await adapter.submitAuthResponse?.(''); // skip realtime
    await connecting;
    expect(adapter.getStatus()).toBe('connected');

    // Token persisted with owner-only permissions, never logged.
    const file = join(dataPath, 'tokens.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { userToken: string };
    expect(stored.userToken).toBe('xoxp-typed');
  });

  it('rejects garbage tokens in the prompt before hitting the API', async () => {
    let authCalls = 0;
    const adapter = new SlackAdapter(
      { ...ACCOUNT, dataPath: mkdtempSync(join(tmpdir(), 'chatty-slack-bad-')) },
      {
        factory: async () => {
          authCalls += 1;
          return new MockSlackClient();
        },
      },
    );
    const prompts: string[] = [];
    adapter.onAuthPrompt?.((p) => prompts.push(p.kind));
    const connecting = adapter.connect();
    await vi.waitFor(() => expect(prompts.length).toBe(1));
    await adapter.submitAuthResponse?.('not-a-token');
    // shape rejected -> still prompting; no API call was made
    expect(authCalls).toBe(0);
    const connectingFailed = connecting.catch((e: unknown) => e);
    await vi.waitFor(() => expect(prompts.length).toBe(2));
    await adapter.submitAuthResponse?.('also-bad');
    await vi.waitFor(() => expect(prompts.length).toBe(3));
    await adapter.submitAuthResponse?.('still-bad');
    await expect(connectingFailed).resolves.toBeInstanceOf(Error);
    expect(adapter.getStatus()).toBe('error');
  });

  it('fails fast on invalid env tokens (no silent prompt loop)', async () => {
    const adapter = new SlackAdapter(ACCOUNT, {
      userToken: 'xoxp-bad',
      factory: factoryRejecting(),
    });
    await expect(adapter.connect()).rejects.toThrow(/invalid_auth/);
    expect(adapter.getStatus()).toBe('error');
  });

  it('lists workspace members as start targets', async () => {
    const adapter = new SlackAdapter(ACCOUNT, { userToken: 'xoxp-x', factory: factoryOk() });
    await adapter.connect();
    const targets = await adapter.listStartTargets?.();
    expect(targets).toHaveLength(3);
    expect(targets?.[1]).toEqual({ id: 'U-DANA', title: 'Dana' });
  });

  it('starts a DM via conversations.open and can send into it', async () => {
    const client = new MockSlackClient();
    const adapter = new SlackAdapter(ACCOUNT, { userToken: 'xoxp-x', factory: async () => client });
    await adapter.connect();
    const conversation = await adapter.startConversation?.('U-DANA');
    expect(conversation).toMatchObject({ id: 'D-U-DANA', title: 'Dana', kind: 'direct' });
    const sent = await adapter.sendMessage('D-U-DANA', 'hello!');
    expect(sent.conversationId).toBe('D-U-DANA');
    expect(client.posted.at(-1)).toEqual({ channel: 'D-U-DANA', text: 'hello!' });
  });
});
