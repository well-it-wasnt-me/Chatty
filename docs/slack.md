# Slack (Web API + Socket Mode)

## Overview

This adapter talks to the real service when configured. It does not manifest credentials through positive thinking.

Official SDKs: @slack/web-api (WebClient, user token) + @slack/socket-mode (app-level token, realtime events). Verified against installed package typings. Not the deprecated RTM API.

## Auth

Token bootstrap order:
1. SLACK_USER_TOKEN / SLACK_APP_TOKEN env (never from repo)
2. Persisted tokens at dataPath/slack/tokens.json (mode 0600)
3. Shared auth overlay (text prompts, masked typing)

Realtime requires app-level token. Without it: adapter still lists history and sends, but incoming events simply do not exist - explicit via capabilities and docs.

## Capabilities

- canSendText: true
- canSendAttachments: false
- canEditMessages: false
- canReact: false
- canFetchHistory: true
- canSearch: false
- canStartConversations: true (DMs via users.list + conversations.open)

## Starting a Conversation

Pick workspace member from live users.list (requires users:read scope - already required). Opens (or returns existing) DM channel via conversations.open (requires im:write scope). If im:write missing, error says so.

## Required Scopes

User token:
- channels:read channels:history groups:read groups:history
- im:read im:history im:write mpim:read mpim:history
- users:read chat:write

App token (Socket Mode):
- connections:write
- Event subscriptions: message.channels, message.groups, message.im, message.mpim

## History

conversations.list (types: public_channel,private_channel,mpim,im, limit 200, exclude archived). Channels we are not a member of cannot be read - never pretend.

conversations.history (limit 50). Only plain text messages; joins/leaves/bot notices skipped (subtype !== undefined).

## Data Path

Account owns dataDir/slack/ containing:
- tokens.json - { userToken, appToken? } (mode 0600)
- chatty.db - shared SQLite

## Environment

- CHATTY_SLACK_IMPL: socket (default) or demo
- SLACK_USER_TOKEN (xoxp- or xoxc-)
- SLACK_APP_TOKEN (xapp- for realtime, optional)

## Failure Modes

Failures are reported instead of being dressed up as success. The bar is low, but we clear it.

- Invalid auth token: auth.test throws invalid_auth - fail fast, no silent prompt loop
- Missing im:write scope: conversations.open fails with readable error
- No app token: realtime explicitly absent, no crash
- Rate limits: WebClient retryConfig (3 retries)
- Socket Mode disconnect: bounded reconnect handled by SDK

## Seam

SlackClientLike interface (types.ts):
- authTest() -> { userId, userName, team }
- listConversations() -> SlackConversationRecord[]
- history(channel, limit) -> SlackHistoryMessage[]
- postMessage(channel, text) -> { ts }
- userName(userId) -> string
- listUsers() -> [{ id, name }]
- openDirectMessage(userId) -> SlackConversationRecord
- onMessageEvent(handler)
- disconnect()

Real binding in real-slack.ts. Mock in slack-adapter.test.ts.

## Testing

MockSlackClient in slack-adapter.test.ts implements seam. Tests cover: env token connect + list, history with resolved sender names, send text, realtime events with unread bumps (ignoring own sends), token prompt via auth overlay, token persistence (mode 0600), garbage token rejection before API call, invalid env token fast fail, listUsers as start targets, startConversation via conversations.open with im:write scope check.