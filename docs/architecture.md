# Architecture

A map of the machinery, for people who prefer knowing why the machine is making that noise.

## High Level

```
+-------------------------------------------------------------+
|                      Ink / React 18                         |
|  +-------------+  +-------------+  +---------------------+  |
|  | Conversations|  |  Navigator  |  |     Active Chat     |  |
|  |    (Left)    |  |  (Middle)   |  |     (Right)         |  |
|  +-------------+  +-------------+  +---------------------+  |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                      App.tsx                                |
|  - State (reducer)                                          |
|  - Keyboard routing                                         |
|  - Overlay management                                       |
|  - Service + Repository wiring                              |
+-------------------------------------------------------------+
                              |
              +------------------------------+
              v               v               v
+------------------+ +--------------+ +--------------+
| MessagingService | | Repositories | |   Config     |
|  - Adapter registry           | SQLite      |  - Zod schema
|  - Message fan-out           | - Accounts  |  - Env vars
|  - Status + Auth events      | - Convs     |  - Defaults
|  - Dedup (accountId:msgId)   | - Messages  |
|  - Capability gating         | - Read state|
+------------------+ +--------------+ +--------------+
              |
              v
+-------------------------------------------------------------+
|                      Adapters                               |
|  +----------+ +----------+ +----------+ +----------+       |
|  | WhatsApp | | Telegram | |  Slack   | | SimpleX  |       |
|  | (Baileys)| | (GramJS) | |(Web API) | |  (CLI)   |       |
|  +----------+ +----------+ +----------+ +----------+       |
|  +------------------------------------------------------+   |
|  |                    DemoAdapter                       |   |
|  |           (simulated, no network, demo mode)         |   |
|  +------------------------------------------------------+   |
+-------------------------------------------------------------+
```

## Data Flow

1. **Startup**: index.tsx loads config, creates service, registers builtin adapters, opens SQLite, registers custom accounts from DB, reconciles cache writers, renders App.
2. **Connect**: App mounts -> service.connectAll() -> each adapter.connect() -> status events -> UI updates.
3. **Incoming**: adapter.emitMessage -> service.dispatch -> dedupe -> handlers (UI message state, repo persistence).
4. **Outgoing**: User types -> sendDraft -> service.sendMessage -> adapter.sendMessage -> service.dispatch (echo) -> repo persistence.
5. **Cache**: Repositories persist conversations/messages/read-state. Cache keyed by transport (demo/baileys/gramjs/socket/cli). Switching transports drops stale rows.
6. **Auth**: adapter.emitAuthPrompt -> service -> App auth overlay -> user submits -> service.submitAuthResponse -> adapter.

## Key Invariants

These rules exist because "it probably works" is not a data integrity strategy.

- **Account isolation**: Every adapter owns its dataPath. SQLite keys are account-scoped. Data from different accounts can never merge.
- **Message dedupe**: Replayed events after reconnect silently ignored (dedupe by accountId:messageId). SQLite cache ignores duplicate inserts (INSERT OR IGNORE).
- **Capability honesty**: Adapters declare capabilities explicitly. Service gates sends/history on them. Unsupported = explicit error, never silent no-op.
- **No message content in logs**: Scoped logger with scalar metadata only. QR codes, tokens, session keys never logged.
- **Transport-keyed cache**: Cached rows belong to the transport that wrote them. Switching an account between demo and real invalidates stale rows instead of mixing.
- **Reconnect bounded**: Bounded retry with exponential backoff and jitter. Adapters must make connect() idempotent and clean up timers/subscriptions in disconnect().

## State Management

Pure reducer (state.ts) - no Ink, service, or storage deps. Navigation, layout, unread logic unit testable without terminal.

AppState:
- terminal: { width, height }
- focus: conversations | navigator | chat
- mode: normal | insert
- overlay: none | help | palette | search | settings | auth | accounts | add-account | new-conversation
- layoutPreference: auto | three | two | one
- expanded: Record<accountId, boolean>
- hiddenAccounts: Record<accountId, boolean>
- selectedRow: number
- selected: ConversationRef | null
- selectedMessage: number
- drafts: Record<conversationKey, string>

Actions: resize, focus-next/prev-pane, focus-pane, move-selection, select-row, toggle-account, toggle-account-visibility, select-conversation, enter/leave-insert-mode, open/close-overlay, draft-set/clear, next-unread, cycle-layout, clamp-selection.

## Adapter Contract

MessagingAdapter (domain/types.ts):
- readonly account: AccountConfig
- readonly capabilities: AdapterCapabilities
- readonly transport: AdapterTransport
- getStatus(): AdapterStatus
- connect(): Promise<void>
- disconnect(): Promise<void>
- listConversations(): Promise<Conversation[]>
- getMessages(conversationId): Promise<Message[]>
- sendMessage(conversationId, text): Promise<Message>
- markRead?(conversationId): Promise<void>
- startConversation?(target): Promise<Conversation>
- listStartTargets?(): Promise<[{ id, title }]>
- getConnectionLink?(): Promise<string>
- onMessage(handler): () => void
- onStatus?(handler): () => void
- onAuthPrompt?(handler): () => void
- submitAuthResponse?(response): Promise<void>

AdapterCapabilities:
- canSendText, canSendAttachments, canEditMessages, canReact, canFetchHistory, canSearch, canStartConversations

BaseAdapter implements status lifecycle, message fan-out, auth prompt replay. Real adapters extend and implement abstract methods.

## Repository Layer

Only modules allowed to touch SQL (storage/repositories.ts). Every statement prepared once. All keys account-scoped. Message inserts idempotent (INSERT OR IGNORE). History capped per conversation (MESSAGE_CACHE_LIMIT = 500).

Repositories:
- AccountRepository: upsertAll (builtins), listCustom, addCustom, removeCustom, nextPosition
- ConversationRepository: upsert, deleteForAccount
- MessageRepository: add, list, search, deleteForAccount
- ConversationStateRepository: markRead, deleteForAccount
- PreferenceRepository: get/set (JSON)

## Overlay System

OverlayKind in state.ts. App.tsx renders conditional branches. Each overlay receives theme, height, callbacks. Shared auth overlay (AuthOverlay) handles QR + password for all platforms. CommandPalette filters commands token-wise. SearchOverlay searches conversations + cached messages.

## Themes

Two themes: default (truecolor hex) and ascii (no color, ASCII glyphs). All colors pinned 24-bit hex so terminal ANSI profile cannot remap. Color-incapable terminals degrade gracefully (nearest palette entry, or no color). CHATTY_ASCII=1, TERM=dumb, or NO_COLOR forces ASCII theme.