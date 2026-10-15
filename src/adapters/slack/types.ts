/**
 * Structural surface the Slack adapter needs from the official SDK.
 * The real binding lives in real-slack.ts (@slack/web-api + Socket Mode);
 * tests use a mock. Nothing Slack-specific escapes into the UI.
 */

import type { ConversationKind } from '../../domain/types.js';

export interface SlackHistoryMessage {
  /** Slack ts string - unique per channel (e.g. "1699999999.000100"). */
  ts: string;
  channel: string;
  text: string;
  userId?: string;
  /** True when authored by the logged-in user. */
  out: boolean;
}

export interface SlackConversationRecord {
  id: string;
  title: string;
  kind: ConversationKind;
  unread: number;
  mentions: number;
}

export interface SlackAuthIdentity {
  userId: string;
  userName: string;
  team: string;
}

export interface SlackClientLike {
  authTest(): Promise<SlackAuthIdentity>;
  listConversations(): Promise<SlackConversationRecord[]>;
  history(channel: string, limit: number): Promise<SlackHistoryMessage[]>;
  postMessage(channel: string, text: string): Promise<{ ts: string }>;
  /** Resolves a user id to a display name (cached). */
  userName(userId: string): Promise<string>;
  /** Workspace members pickable as DM targets (users:read scope). */
  listUsers(): Promise<Array<{ id: string; name: string }>>;
  /**
   * Opens (or returns the existing) DM channel with a user
   * (conversations.open - requires the im:write scope).
   */
  openDirectMessage(userId: string): Promise<SlackConversationRecord>;
  /** Realtime message events - only when an app-level token is configured. */
  onMessageEvent(handler: (message: SlackHistoryMessage) => void): void;
  disconnect(): Promise<void>;
}

export interface SlackFactoryOptions {
  userToken: string;
  appToken?: string;
  logger?: { warn(event: string, fields?: Record<string, string>): void };
}

export type SlackClientFactory = (
  options: SlackFactoryOptions,
) => Promise<SlackClientLike>;
