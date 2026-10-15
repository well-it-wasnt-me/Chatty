# Telegram (GramJS)

## Overview

This adapter talks to the real service when configured. It does not manifest credentials through positive thinking.

Telegram user client via GramJS (pure JS MTProto, actively maintained). Not the Bot API - Bot API cannot read personal account history.

## Auth

QR login via signInUserWithQrCode. Each rotated token becomes a fresh tg://login?token=... prompt. If 2FA enabled, password comes back through requestPassword (bridged to TUI auth overlay). Wrong passwords retry via signInWithPassword without re-scanning QR.

Session string persisted under account dataPath (mode 0600). Reused on subsequent connects.

## Capabilities

- canSendText: true
- canSendAttachments: false (GramJS supports media; not implemented)
- canEditMessages: false
- canReact: false
- canFetchHistory: true (real API history via getMessages)
- canSearch: false
- canStartConversations: true (by @username or contact phone)

## Starting a Conversation

Enter @username (or contact phone). Peer resolved once via MTProto (client.getEntity) and cached in binding. Subsequent sends use cached entity. Resolution failures surface with readable reason.

## History

Real API history via getMessages (limit 50). Dialogs fetched via getDialogs (limit 100) with unread counts and mentions. Message ids are per-chat; scope stays account+conversation.

## Data Path

Account owns dataDir/telegram/ containing:
- session.txt - StringSession (mode 0600)
- chatty.db - shared SQLite

## Environment

- CHATTY_TELEGRAM_IMPL: gramjs (default) or demo
- TELEGRAM_API_ID (required for real mode, from my.telegram.org)
- TELEGRAM_API_HASH (required for real mode)

## Failure Modes

Failures are reported instead of being dressed up as success. The bar is low, but we clear it.

- Missing API credentials: error status at connect, readable message
- Invalid session: QR flow restarts
- 2FA password wrong: retries up to 3 times without re-scanning QR
- Flood wait: GramJS handles with connectionRetries (5)
- Network drop: GramJS reconnectionRetries (5)

## Seam

TelegramClientLike interface (types.ts) - structural surface needed from MTProto client:
- disconnect()
- getDialogs(limit)
- getMessages(conversationId, limit)
- sendText(conversationId, text)
- resolvePeer(target) -> { id, title, kind }
- saveSession() -> string
- onNewMessage(handler)

Real binding in real-telegram.ts. Mock in telegram-adapter.test.ts.

## Testing

MockTelegramClient in telegram-adapter.test.ts implements seam. Tests cover: connect with stored session, dialog mapping, history, send, QR flow with token rotation, 2FA password, incoming routing with unread bumps, disconnect teardown, startConversation by @username with peer reuse.