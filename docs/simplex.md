# SimpleX (simplex-chat CLI)

## Overview

This adapter talks to the real service when configured. It does not manifest credentials through positive thinking.

Official simplex-chat CLI as supervised local WebSocket chat server (--chat-server-port). Child process supervised here; account database lives under account.dataPath.

## How It Works

simplex-chat binary runs as a local chat server on a port (default 5225, auto-allocated per extra CLI instance: base + 1 per running instance). Adapter connects via WebSocket to ws://127.0.0.1:<port>.

Wire format:
- command: {"corrId": "n", "cmd": "/_get chats ..."}
- response: {"corrId": "n", "resp": {...}}
- event: {"resp": {...}}

Only fields chatty consumes are modeled; everything else validated loosely and passed through.

## Auth

No passwords. Profile created on first run with --user-display-name. Active user obtained via /user command. If no profile exists, /_create user creates one.

## Capabilities

- canSendText: true
- canSendAttachments: false (files exist in API; not implemented)
- canEditMessages: false
- canReact: false
- canFetchHistory: true (from local cache - see note)
- canSearch: false
- canStartConversations: true (via invitation links)

## History Note

SimpleX has no server-side history pull. The CLI holds a local SQLite. We serve getMessages from items accumulated this session plus the latest-item previews from /_get chats. No read-state sync through bot API -> no markRead (explicit absence).

## Starting a Conversation

SimpleX connects via one-time invitation links.

Two options in new-chat overlay:
- Share my invitation link: sends /_connect (no args). CLI creates a new connection and generates an invitation (valid 24 hours). Response deep-scanned for first https:// string - the link is always a URL. Displayed with QR code (qrToLines, max 41 cols).
- Accept an invitation link: paste contact's link. Sends /_connect <link>. On success, re-lists chats and returns the direct conversation that just appeared. If no new direct chat yet: connection request sent - chat appears once contact confirms.

Sending to a contact that has not completed the connection handshake fails with CLI error, surfaced to UI as-is.

## Data Path

Account owns dataDir/simplex/ containing:
- simplex_v1/ - CLI SQLite database
- chatty.db - shared SQLite (conversations, messages, read state, prefs)

## Environment

- CHATTY_SIMPLEX_IMPL: cli (default) or demo
- CHATTY_SIMPLEX_BIN: simplex-chat (default)
- CHATTY_SIMPLEX_PORT: 5225 (base port)
- CHATTY_SIMPLEX_DISPLAY_NAME: shown in SimpleX profile

## Failure Modes

Failures are reported instead of being dressed up as success. The bar is low, but we clear it.

- Binary not found: error status, readable message
- Port conflict: auto-allocates next port (base + 1 per instance)
- CLI crash: supervised restart with bounded backoff
- Connection rejected: chatError/chatErrors event logged, not surfaced as message
- Send to unaccepted contact: fails with "contact not accepted yet"

## Protocol Commands (protocol.ts)

- cmdActiveUser(): "/user"
- cmdCreateUser(displayName): "/_create user {...}"
- cmdGetChats(userId, count): "/_get chats <id> count=<n> {...}"
- cmdSendText(conversationId, text): "/_send <ref> json [...]"
- cmdCreateInvitation(): "/_connect"
- cmdConnectTo(link): "/_connect <link>"
- findConnectionLink(value): deep-scan for https:// string
- connectErrorText(resp): extracts readable reason from chatError/chatErrors

## Testing

simplex-smoke.ts: manual integration check against REAL simplex-chat binary (no mocks, no network creds, no messages sent). Verifies: process supervision, WebSocket handshake, active-user bootstrap, chat listing, graceful shutdown. Uses throwaway database under /tmp.

simplex.test.ts: protocol schemas, command builders, mapping functions, connection link extraction, error text extraction.