# chatty - Terminal Messenger

All your conversations. One terminal. No browser circus. Civilization has limits, and apparently one of them is opening 
twelve tabs to answer a message.

A keyboard-driven, three-pane terminal client unifying five messaging accounts in one screen:

- WhatsApp Personal
- WhatsApp Work
- Telegram
- SimpleX Chat
- Slack

**Current status: a polished TUI plus real adapters for all five platforms.** The software is organized. 
The group chats remain a separate problem.
Real mode is the default; the simulated demo mode is opt-in (`--demo`).

- **SimpleX** - official `simplex-chat` CLI as a supervised local chat server.
- **Telegram** - GramJS user client; QR login + optional 2FA password via the shared auth overlay (press `a`).
- **Slack** - official Web API + Socket Mode; tokens via env or the masked overlay prompt.
- **WhatsApp A and B** - Baileys; independent QR pairing per account on isolated sockets/session dirs.
- Everything defaults to real adapters: accounts without credentials surface setup prompts or readable errors in the UI 
  instead of pretending. The deterministic demo mode (simulated accounts, nothing ever sent) is opt-in
  via `--demo` / `CHATTY_MODE=demo`. Details per platform: [platform documentation](docs/index.md#platform-details).

```text
 chatty v0.1.0 (demo mode)                  14:28 | 5/5 connected | Unread: 12
  * WA Personal   * WA Work   * Telegram   * Slack   * SimpleX
+----------------+--------------+-------------------------------------------+
| CONVERSATIONS  | NAVIGATOR    | ACTIVE CHAT                               |
|> v WhatsApp .. | Alice   2:25p| Alice - WhatsApp (personal)               |
|  = Family grp 2| Bob     1:12p| Alice: Did you see the new logs?          |
|  @ Mum       1 | Charlie 9:03a|            Yes, investigating now. 2:31p >|
|  v Telegram    |              | Alice: The issue is in auth.              |
|  # Dev chann  3|              |                                           |
| ...            |              | > typing...                               |
+----------------+--------------+-------------------------------------------+
| j/k move * Tab panes * Enter open * / search * ^P palette * ? help * ^Q quit
```

## Requirements

The usual tools are required. No, a terminal emulator from 1998 is not a personality trait.

- Node.js **22.5+** (uses the built-in SQLite driver; Node 24 recommended)
- pnpm 10 (`npm` also works - every script is manager-agnostic)
- A terminal with Unicode support for the default theme; set `CHATTY_ASCII=1`, `TERM=dumb` or `NO_COLOR` for the ASCII/no-color fallback
- All colors are pinned 24-bit truecolor hex values, so the terminal ANSI profile/scheme cannot remap them; 
  color-incapable terminals degrade gracefully (nearest palette entry, or no color at all)

## Run it

Install the dependencies, then start the app. This is the part where the computer does what you asked, which is a refreshing change.


```bash
pnpm install
pnpm dev            # real mode (default)
pnpm dev -- --demo  # simulated demo mode (nothing is ever sent)
```

Real mode wires the real adapters for all five accounts: WhatsApp presents QR pairing, Slack asks for its tokens in the 
auth overlay, while Telegram and SimpleX surface readable errors until `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` or the 
`simplex-chat` binary are configured (see Configuration below).

## Keyboard

| Shortcut                      | Action                                                                             |
|-------------------------------|------------------------------------------------------------------------------------|
| `Tab` / `Shift+Tab` (`h`/`l`) | Focus next / previous pane                                                         |
| `j` / `k`                     | Move selection in the focused pane                                                 |
| `Enter`                       | Open conversation, focus chat, start composer                                      |
| `i`                           | Write a message in the open conversation                                           |
| `c`                           | Start a new conversation (phone, @username, DM, invite link)                       |
| `Esc`                         | Leave composer, close overlay, or refocus conversations                            |
| `g`                           | Expand/collapse the selected account group                                         |
| `a`                           | Authenticate account (QR scan / 2FA password / code)                               |
| `A`                           | Accounts page - list, reconnect, remove                                            |
| `A` -> `a`                    | Add account page (or palette: *Add account*)                                       |
| `/`                           | Search conversations and cached messages (at the composer it begins a `/` message) |
| `Ctrl+P`                      | Command palette (switch account, reconnect, layout, ...)                           |
| `Ctrl+N`                      | Jump to next unread conversation                                                   |
| `Ctrl+R`                      | Mark current conversation as read                                                  |
| `Ctrl+Q` / `Ctrl+C`           | Quit cleanly                                                                       |
| `?`                           | Shortcut help overlay                                                              |

While the composer is active (`INSERT` in the bottom bar), characters are inserted into the message; 
navigation keys only work in `NORMAL` mode. Yes, like VIM.
Typing `/` at the composer begins a message starting with `/` (bot commands, links); anywhere else `/` opens search.

## Layout

- >=120 columns: three panes (conversations, message navigator, active chat).
- 78-119 columns: two panes (conversations + active chat).
- 54-77 columns: single pane (`Tab` switches list/chat).
- Smaller than 54x14: a fallback screen explains the minimum size.
- Resizing is handled live; the layout preference can also be pinned via the *Change layout* command (persisted, `auto`/`three`/`two`/`one`).

## Start a new conversation

Press `c` (or the palette's *Start a new conversation*) to open the platform-honest new-chat flow:

- **WhatsApp** - enter a phone number in international format (`+1555...`); the chat materializes when you send the first message.
- **Telegram** - enter a `@username` (or a contact's phone number); the peer is resolved once via MTProto and cached.
- **Slack** - pick a workspace member from the live `users.list`; opens (or reuses) the DM channel. Requires the `im:write` scope.
- **SimpleX** - two options:
  * *Share my invitation link* - shows a one-time connection link and a QR code you can share (scan with a phone).
  * *Accept an invitation link* - paste a link a contact sent you; the chat appears once both ends confirm.

After starting, the conversation is selected and the composer focused so you can type the first message immediately.

## Accounts page

Press `A` (or the palette's *Manage accounts*) to open account management.

- **List:** every configured account with its transport (`builtin`/`custom`, `demo`/`cli`), live connection status and data path isolation.
- **Add (`a`):** opens the dedicated **Add account page** (also reachable via the palette's *Add account*): 
  a three-step wizard - pick a provider -> name it (live badge preview) -> review and confirm. 
  SimpleX runs its own local `simplex-chat` chat server (auto-allocated port, fresh profile);
  After confirming you land back on the accounts page; if the account raises an authentication challenge, the shared 
  auth flow (`a` overlay: QR + 2FA password) opens automatically.
- **Remove (`d`, custom accounts only, two-press confirm):** disconnects the adapter, deletes the persisted row, and 
  wipes the account's own data directory - builtin accounts can be hidden instead.
- **Reconnect (`r`):** bounded-retry reconnect of the selected account.

Custom accounts persist in SQLite and are re-registered on startup.


## Configuration

Environment variables (see `.env.example`), validated with Zod at startup:

- `CHATTY_MODE` - `real` (default) or `demo`
- `CHATTY_DATA_DIR` - root for credentials, SQLite cache and prefs (mode `0700`); each account owns `dataDir/<account id>`
- `CHATTY_LOG_LEVEL` / `CHATTY_LOG_FILE` - structured file log (mode `0600`)
- `CHATTY_ASCII` - force the ASCII theme
- `CHATTY_SIMPLEX_IMPL` - `cli` to enable the real SimpleX adapter (the official `simplex-chat` chat server), plus
  `CHATTY_SIMPLEX_BIN` / `CHATTY_SIMPLEX_PORT` / `CHATTY_SIMPLEX_DISPLAY_NAME`
- `CHATTY_TELEGRAM_IMPL` - `gramjs` to enable the real Telegram adapter (GramJS user client); 
  requires `TELEGRAM_API_ID` + `TELEGRAM_API_HASH` from <https://my.telegram.org/apps>. 
  Login runs as a QR scan (phone app: Settings -> Devices -> Link Desktop), with 2FA password when enabled.
- `CHATTY_SLACK_IMPL` - `socket` to enable the real Slack adapter (official Web API, Socket Mode for realtime). 
  `SLACK_USER_TOKEN` / `SLACK_APP_TOKEN` via env, or typed masked into the auth overlay on first run (validated
  with `auth.test`, then persisted at `data/slack/tokens.json`, mode `0600`).
- `CHATTY_WHATSAPP_IMPL` - `baileys` to enable the real WhatsApp adapter for **both** accounts; each does its own QR 
  pairing (phone: Linked devices -> link a device) with isolated `data/whatsapp-a/` and `data/whatsapp-b/` session dirs.
- `CHATTY_DEMO_AUTH` - demo-only: give an account id a simulated QR + 2FA pairing flow to exercise the auth overlay

## Storage and privacy

Local state lives in `$CHATTY_DATA_DIR/chatty.db` (SQLite, WAL, migrated via `PRAGMA user_version`): 
account metadata, conversation metadata, a message cache capped at the newest 500 messages per conversation, read state, 
UI preferences, and adapter sync cursors. Message inserts are idempotent, so replayed platform events never duplicate.

**The database is not encrypted.** Full-disk encryption is the recommended boundary. If local message caching is a concern, 
delete the `data/` directory; credentials (once real adapters exist) will likewise live only under `dataDir/<account id>` 
with restrictive permissions. There is no automatic message re-sending: a failed send is surfaced and the draft is preserved, 
you decide whether to retry. Nothing (messages, tokens, QR codes, session keys) is ever written to the log file or the terminal outside the UI.

## Architecture

```text
src/
  index.tsx                      entry: config -> logging -> service -> adapters -> db -> TUI
  app/
    App.tsx                      composition root of the UI
    state.ts                     pure reducer: focus, panes, selection, drafts, layout
    commands.ts                  command palette registry
  core/
    messaging-service.ts         owns adapters: dedupe, retry/backoff, reconnect, capabilities
    logger.ts                    leveled structured file log (0600, never logs contents)
    search.ts                    local substring search over conversations + cache
    version.ts
  domain/types.ts                shared contract: accounts, conversations, messages, adapter
  config/config.ts               Zod-validated env configuration
  storage/
    database.ts                  node:sqlite bootstrap + pragmas
    migrations.ts                append-only schema migrations
    repositories.ts              typed SQL layer (accounts, conversations, messages, state, prefs)
  adapters/
    base-adapter.ts              status lifecycle + event fan-out + auth prompts
    demo-adapter.ts              deterministic simulated platform (incl. auth script)
    adapter-factory.ts           account  adapter wiring
    simplex/                   real SimpleX: protocol types (zod), process+WS transport, adapter
    telegram/                  real Telegram (GramJS): client seam + binding + adapter
    slack/                     real Slack (official API + Socket Mode)
    whatsapp/                  real WhatsApp (Baileys): socket seam + binding + adapter
  ui/
    theme/colors.ts              palette, glyphs, delivery marks, ASCII fallback
    qr.ts                        terminal QR rendering for auth pairing
    components/                  TopBar, AccountTabs, ShortcutBar
    layout/                      ThreePaneLayout, ConversationTree, MessageNavigator, ActiveConversation
    overlays/                    Help, CommandPalette, Search, Settings, Auth (shared QR/2FA flow)
tests: colocated *.test.ts (Vitest), no network, no real accounts
scripts/                       manual integration checks (e.g. real SimpleX smoke test)
docs/ADAPTERS.md                 integration plans/status per platform (deps, auth, limits)
```

The TUI never calls protocol libraries directly; it talks to `MessagingService`, which talks to adapters behind the `MessagingAdapter`
contract. Capabilities are explicit: unsupported operations fail loudly with a readable error instead of pretending.

## Development

```bash
pnpm typecheck   # strict TypeScript
pnpm test        # Vitest - no network, no credentials
pnpm lint        # ESLint flat config
pnpm build       # production build (tests excluded)
```
