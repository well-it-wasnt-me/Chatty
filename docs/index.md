# chatty

Five messaging accounts, one terminal, and fewer browser tabs pretending to be a workflow. 
Your inbox will still be your inbox. We are not magicians.

A terminal messenger that puts five accounts in one screen. No browser required.

## What This Is

chatty is a keyboard-driven TUI that unifies WhatsApp (two accounts), Telegram, SimpleX, and Slack in a single terminal window. 
Three panes: conversations, message navigator, active chat. Real adapters for all five platforms. Demo mode when you 
want to kick tires without credentials.

## Current Status

Version 0.1.0. Real mode is default. Demo mode is opt-in. All five adapters work. The TUI uses truecolor hex values so 
your terminal color scheme cannot ruin the palette.

## Quick Start

Two commands. No ceremony. We have all suffered enough setup wizards.

```bash
pnpm install
pnpm dev              # real mode (default)
pnpm dev -- --demo    # demo mode (nothing ever sent)
```

Real mode wires real adapters. WhatsApp shows QR. Slack prompts for tokens. Telegram and SimpleX error cleanly until you configure API creds or the simplex-chat binary.

## Requirements

- Node 22.5+ (built-in SQLite driver)
- pnpm 10 (npm works too)
- Terminal with Unicode support for default theme
- Set CHATTY_ASCII=1, TERM=dumb, or NO_COLOR for ASCII fallback

## Keyboard Shortcuts

| Key                   | Action                                                     |
|-----------------------|------------------------------------------------------------|
| Tab / Shift+Tab (h/l) | Focus next/previous pane                                   |
| j / k                 | Move selection                                             |
| Enter                 | Open conversation, focus chat, start composer              |
| i                     | Write a message                                            |
| c                     | Start new conversation (phone, @username, DM, invite link) |
| Esc                   | Leave composer, close overlay, refocus conversations       |
| g                     | Expand/collapse account group                              |
| a                     | Authenticate account (QR/2FA/code)                         |
| A                     | Accounts page (list, reconnect, remove)                    |
| A then a              | Add account page                                           |
| /                     | Search (at composer starts a / message)                    |
| Ctrl+P                | Command palette                                            |
| Ctrl+N                | Jump to next unread                                        |
| Ctrl+R                | Mark conversation read                                     |
| Ctrl+Q / Ctrl+C       | Quit                                                       |
| ?                     | Help overlay                                               |

Composer is INSERT mode. Navigation keys only work in NORMAL mode. Typing / at the composer begins a message starting with / (bot commands, links). Anywhere else / opens search.

## Layout

- 120+ columns: three panes (conversations, navigator, chat)
- 78-119 columns: two panes (conversations + chat)
- 54-77 columns: single pane (Tab switches list/chat)
- Below 54x14: fallback screen explains minimum size
- Resize handled live. Layout preference persisted (auto/three/two/one)

## Accounts Page

Press A for account management:

- List: every account with transport (builtin/custom, demo/cli), live status, data path
- Add (a): dedicated Add Account page - three step wizard (provider -> name -> review). SimpleX runs its own local simplex-chat server (auto port, fresh profile). Demo transports only in demo mode. After confirm you land back on accounts page. Auth challenges open shared auth flow automatically.
- Remove (d, custom only, two-press confirm): disconnects adapter, deletes row, wipes account data directory. Builtins can be hidden instead (palette: Toggle visibility).
- Reconnect (r): bounded retry reconnect of selected account.

Custom accounts persist in SQLite and re-register on startup.

## Start New Conversation

Press c (or palette: Start a new conversation) for platform-honest flows:

- WhatsApp: phone number (+1555...). Chat materializes on first send.
- Telegram: @username (or contact phone). Peer resolved once via MTProto and cached.
- Slack: pick workspace member from live users.list. Opens/reuses DM. Requires im:write scope.
- SimpleX: Share my invitation link (shows one-time link + QR) or Accept an invitation link (paste link from contact, chat appears once both ends confirm).

After start: conversation selected, composer focused, type first message immediately.

## Configuration

Environment variables (see .env.example), validated with Zod at startup:

- CHATTY_MODE: real (default) or demo
- CHATTY_DATA_DIR: root for credentials, SQLite cache, prefs (mode 0700). Each account owns dataDir/<account id>
- CHATTY_LOG_LEVEL / CHATTY_LOG_FILE: structured file log (mode 0600)
- CHATTY_ASCII: force ASCII theme
- CHATTY_THEME: default or ascii
- Platform-specific impl pins (CHATTY_WHATSAPP_IMPL, CHATTY_TELEGRAM_IMPL, CHATTY_SIMPLEX_IMPL, CHATTY_SLACK_IMPL) - demo or real transport
- Telegram: TELEGRAM_API_ID, TELEGRAM_API_HASH (my.telegram.org)
- SimpleX: CHATTY_SIMPLEX_BIN (default simplex-chat), CHATTY_SIMPLEX_PORT (default 5225), CHATTY_SIMPLEX_DISPLAY_NAME
- Slack: SLACK_USER_TOKEN (xoxp-), SLACK_APP_TOKEN (xapp- for realtime)
- WhatsApp: no env creds (QR pairing only)

## Demo Mode

Simulates all five accounts independently: seeded history, periodic incoming messages, unread counts, delivery indicators. One SimpleX conversation (New contact) where sending fails with explanatory error - exercises failure path. Never mixes with real traffic. In real mode the Add Account page only offers real transports. Custom accounts persisted as demos are skipped on startup (warning in log file).

## Architecture

- Ink 5 / React 18 TUI
- TypeScript strict, Vitest, pnpm 10
- Pure reducer for navigation/layout/unread logic (unit testable without terminal)
- MessagingService owns adapters, fans out messages/status/auth, dedupes by accountId:messageId
- BaseAdapter scaffolding: status lifecycle, message fan-out, auth prompt replay
- Typed repositories (only modules touching SQL). Messages idempotent (replayed events ignored). History capped per conversation (500).
- Adapter contract: connect, disconnect, getStatus, listConversations, getMessages, sendMessage, optional markRead, onMessage, optional onStatus. Capabilities explicit (canSendText, canStartConversations, etc). Unsupported = explicit error, never silent no-op.
- Real adapters extend BaseAdapter, implement abstract methods, call setStatus on transitions, emitMessage for incoming events.
- Cache keyed by transport. Switching an account between demo and real drops stale cached rows instead of mixing data.

## Platform Details

See platform docs for each adapter:
- [WhatsApp (Baileys)](whatsapp.md)
- [Telegram (GramJS)](telegram.md)
- [Slack (Web API + Socket Mode)](slack.md)
- [SimpleX (simplex-chat CLI)](simplex.md)

## License

MIT. Do whatever you want. It is not my problem if it breaks.