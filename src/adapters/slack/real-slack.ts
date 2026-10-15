import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import type {
  SlackClientFactory,
  SlackClientLike,
  SlackConversationRecord,
  SlackHistoryMessage,
} from './types.js';

/**
 * Real Slack binding over the official SDKs: @slack/web-api (WebClient,
 * user token) + @slack/socket-mode (app-level token, realtime events).
 * Verified against the installed packages' typings; never the RTM API.
 *
 * Required user-token scopes (add to your Slack app + reinstall):
 *   channels:read channels:history groups:read groups:history
 *   im:read im:history im:write mpim:read mpim:history users:read chat:write
 * (im:write is only needed for "start a DM" in the new-chat overlay.)
 * Socket Mode additionally needs an app-level token (xapp-...) with
 * `connections:write` and the `message` events subscribed:
 * message.channels, message.groups, message.im, message.mpim.
 * We do not pretend. You get what the platform gives you.
 */

const CHANNEL_TYPES = 'public_channel,private_channel,mpim,im';
const CONVERSATION_LIMIT = 200;

interface SlackChannel {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_member?: boolean;
  unread_count_display?: number;
  mention_count_display?: number;
}

interface SlackMessage {
  ts?: string;
  text?: string;
  user?: string;
  subtype?: string;
}

export const createSlackClient: SlackClientFactory = async (options) => {
  const web = new WebClient(options.userToken, {
    retryConfig: { retries: 3 }, // bounded -- API rate limits get retries, not hangs
  });
  const auth = await web.auth.test(); // throws on invalid_auth -- caller owns retry
  const ownUserId = auth.user_id ?? undefined;
  const ownName = (auth.user as string | undefined) ?? 'me';

  // Socket Mode: realtime events, only when an app-level token exists.
  let socket: SocketModeClient | undefined;
  if (options.appToken !== undefined && options.appToken !== '') {
    socket = new SocketModeClient({ appToken: options.appToken });
    await socket.start();
  }

  const userNames = new Map<string, string>();
  async function resolveUserName(userId: string): Promise<string> {
    const cached = userNames.get(userId);
    if (cached) return cached;
    try {
      const res = await web.users.info({ user: userId });
      const name =
        (res.user?.profile?.display_name as string | undefined) ||
        (res.user?.real_name as string | undefined) ||
        userId;
      userNames.set(userId, name);
      return name;
    } catch (error) {
      options.logger?.warn('users.info failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return userId;
    }
  }

  function kindOf(channel: SlackChannel): SlackConversationRecord['kind'] {
    if (channel.is_im || channel.is_mpim) return channel.is_mpim ? 'group' : 'direct';
    return 'channel';
  }

  async function titleOf(channel: SlackChannel): Promise<string> {
    if (channel.is_im) {
      const name = channel.user ? await resolveUserName(channel.user) : undefined;
      return name ?? 'DM';
    }
    const name = channel.name ?? channel.id ?? '?';
    return kindOf(channel) === 'channel' ? `#${name}` : name;
  }

  function mapMessage(message: SlackMessage): SlackHistoryMessage | undefined {
    if (!message.ts) return undefined;
    return {
      ts: message.ts,
      channel: '',
      text: message.text ?? '',
      userId: message.user,
      out: message.user !== undefined && message.user === ownUserId,
    };
  }

  const bound: SlackClientLike = {
    async authTest() {
      return { userId: ownUserId ?? '', userName: ownName, team: auth.team ?? '' };
    },

    async userName(userId) {
      return resolveUserName(userId);
    },

    async listConversations() {
      const all: SlackChannel[] = [];
      let cursor: string | undefined;
      do {
        const res = await web.conversations.list({
          types: CHANNEL_TYPES,
          limit: CONVERSATION_LIMIT,
          cursor,
          exclude_archived: true,
        });
        for (const channel of (res.channels ?? []) as SlackChannel[]) {
          // Channels we are not a member of cannot be read -- never pretend.
          if ((channel.is_channel || channel.is_group) && channel.is_member === false) continue;
          all.push(channel);
        }
        cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined;
      } while (cursor);

      const records: SlackConversationRecord[] = [];
      for (const channel of all) {
        if (!channel.id) continue;
        records.push({
          id: channel.id,
          title: await titleOf(channel),
          kind: kindOf(channel),
          unread: channel.unread_count_display ?? 0,
          mentions: channel.mention_count_display ?? 0,
        });
      }
      return records;
    },

    async history(channel, limit) {
      const res = await web.conversations.history({ channel, limit });
      const out: SlackHistoryMessage[] = [];
      for (const message of ((res.messages ?? []) as SlackMessage[]).reverse()) {
        // Only plain text messages; joins/leaves/bot notices are skipped.
        if (message.subtype !== undefined) continue;
        const mapped = mapMessage(message);
        if (mapped) out.push({ ...mapped, channel });
      }
      return out;
    },

    async postMessage(channel, text) {
      const res = await web.chat.postMessage({ channel, text });
      if (!res.ts) throw new Error('slack did not return a ts for the sent message');
      return { ts: res.ts };
    },

    async listUsers() {
      const users: Array<{ id: string; name: string }> = [];
      let cursor: string | undefined;
      do {
        const res = await web.users.list({ limit: 200, cursor });
        for (const user of res.members ?? []) {
          // Bots, deactivated accounts, and Slackbot itself are not pickable.
          if (user.deleted === true || user.is_bot === true || user.id === 'USLACKBOT') continue;
          const name: string = user.name ?? user.id ?? 'unknown';
          users.push({ id: user.id ?? 'unknown', name });
        }
        cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined;
      } while (cursor);
      return users;
    },

    async openDirectMessage(userId) {
      const res = await web.conversations.open({ users: userId });
      // The SDK allows `channel` to be a bare id string on some server versions.
      const raw = res.channel;
      const channel: SlackChannel =
        typeof raw === 'string' ? { id: raw } : ((raw ?? {}) as SlackChannel);
      if (!channel.id) throw new Error('slack did not return a DM channel -- check the im:write scope');
      return {
        id: channel.id,
        title: await resolveUserName(userId),
        kind: 'direct',
        unread: channel.unread_count_display ?? 0,
        mentions: channel.mention_count_display ?? 0,
      };
    },

    onMessageEvent(handler) {
      if (!options.appToken || !socket) return; // realtime explicitly absent
      socket.on('message', (envelope: { event?: unknown; ack?: () => Promise<void> }) => {
        void envelope.ack?.();
        const event = envelope.event as SlackMessage & { channel?: string } | undefined;
        if (!event || event.subtype !== undefined || !event.channel) return;
        const mapped = mapMessage(event);
        if (mapped) handler({ ...mapped, channel: event.channel });
      });
    },

    async disconnect() {
      await socket?.disconnect().catch((error: unknown) => {
        options.logger?.warn('socket-mode disconnect failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };

  return bound;
};