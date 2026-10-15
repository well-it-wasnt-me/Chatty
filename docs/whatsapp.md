# WhatsApp (Baileys)

## Overview

This adapter talks to the real service when configured. It does not manifest credentials through positive thinking.

Two independent WhatsApp accounts: whatsapp-a and whatsapp-b. Each runs on an isolated Baileys socket with its own session directory under dataDir/<account-id>/auth/. No shared state.

## Auth

QR pairing. Every connection.update.qr becomes an overlay prompt (payloads rotate; never logged). Scan with phone: Linked Devices -> Link a Device.

401 / loggedOut = auth failure (distinct from transient network close). Runtime drops attempt an internal bounded reconnect.

## Capabilities

- canSendText: true
- canSendAttachments: false (Baileys supports media; not implemented)
- canEditMessages: false
- canReact: false (Baileys supports reactions; not implemented)
- canFetchHistory: true (history sync + locally accumulated store)
- canSearch: false
- canStartConversations: true (by phone number)

## Starting a Conversation

Enter phone in international format (+15551234567). The conversation is created locally. It becomes a real WhatsApp chat when the first message is sent (Baileys has no "create chat" call; chats materialize on activity, then chats.upsert confirms the title).

## History

History sync on connect. Locally accumulated messages stored in SQLite cache (capped at 500 per conversation). getMessages serves from cache + live updates.

## Data Path

Account owns dataDir/whatsapp-a/ and dataDir/whatsapp-b/. Each contains:
- auth/ - Baileys credentials (mode 0600)
- chatty.db - shared SQLite (conversations, messages, read state, prefs)

## Environment

- CHATTY_WHATSAPP_IMPL: baileys (default) or demo
- No API credentials in env. Auth is QR only.

## Failure Modes

Failures are reported instead of being dressed up as success. The bar is low, but we clear it.

- QR expires: new QR emitted automatically
- Logged out: status error, remove account and re-pair
- Network drop with live session: bounded internal reconnect (4 attempts, exponential backoff with jitter)
- Invalid session file: treated as logged out

## Testing

Mock socket in whatsapp-adapter.test.ts implements WhatsAppSocketLike. Tests cover: connect flow, QR emission, history sync, chat upsert, message send/echo, reconnect logic, logged-out distinction.