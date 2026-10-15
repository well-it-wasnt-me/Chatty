import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import type { AccountConfig, AdapterStatus, AuthPrompt, Conversation, Message } from '../domain/types.js';
import type { MessagingService } from '../core/messaging-service.js';
import type { Logger } from '../core/logger.js';
import {
  createAdapterForAccount,
  nextSimplexCliPort,
} from '../adapters/adapter-factory.js';
import type {
  AccountRepository,
  ConversationStateRepository,
  ConversationRepository,
  MessageRepository,
  PreferenceRepository,
  StoredCustomAccount,
} from '../storage/repositories.js';
import type { AppConfig } from '../config/config.js';
import { formatClock } from '../ui/format.js';
import { qrToLines } from '../ui/qr.js';
import { chooseTheme, type Theme } from '../ui/theme/colors.js';
import { TopBar } from '../ui/components/TopBar.js';
import { AccountTabs } from '../ui/components/AccountTabs.js';
import { ShortcutBar } from '../ui/components/ShortcutBar.js';
import { ThreePaneLayout } from '../ui/layout/ThreePaneLayout.js';
import { HelpOverlay } from '../ui/overlays/HelpOverlay.js';
import { CommandPalette } from '../ui/overlays/CommandPalette.js';
import { SearchOverlay } from '../ui/overlays/SearchOverlay.js';
import { SettingsOverlay } from '../ui/overlays/SettingsOverlay.js';
import { AuthOverlay } from '../ui/overlays/AuthOverlay.js';
import {
  AddAccountPage,
  deriveBadge,
  providerChoices,
  type ProviderChoice,
} from '../ui/overlays/AddAccountPage.js';
import { NewConversationOverlay } from '../ui/overlays/NewConversationOverlay.js';
import { AccountsPage, type AccountRow } from '../ui/overlays/AccountsPage.js';
import { searchAll, type SearchHit } from '../core/search.js';
import {
  accountSwitchCommands,
  buildCommands,
  currentAccountId,
  type ChattyCommand,
  type CommandDeps,
} from './commands.js';
import {
  conversationKey,
  effectiveLayout,
  flattenRows,
  initialState,
  MIN_HEIGHT,
  MIN_WIDTH,
  reduce,
  unreadTotal,
  type Action,
  type AppState,
  type ConversationRef,
  type ReduceContext,
} from './state.js';

/** Maximum messages kept per conversation in memory. */
const MESSAGE_WINDOW = 300;

/** Persisted UI prefs are disk input - validate before trusting them. */
const uiPrefsSchema = z.object({
  layoutPreference: z.enum(['auto', 'three', 'two', 'one']).optional(),
  hiddenAccounts: z.record(z.string(), z.boolean()).optional(),
  expanded: z.record(z.string(), z.boolean()).optional(),
});
const UI_PREFS_KEY = 'ui';

export interface AppDeps {
  service: MessagingService;
  config: AppConfig;
  logger: Logger;
  repositories: {
    accounts: AccountRepository;
    conversations: ConversationRepository;
    messages: MessageRepository;
    state: ConversationStateRepository;
    prefs: PreferenceRepository;
  };
  theme?: Theme;
}

export function App({ service, config, logger, repositories, theme }: AppDeps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const resolvedTheme = theme ?? chooseTheme();

  const readSize = useCallback(
    () => ({ width: stdout?.columns ?? 100, height: stdout?.rows ?? 30 }),
    [stdout],
  );

  const [ui, setUi] = useState<AppState>(() => initialState(readSize()));
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [statuses, setStatuses] = useState<Record<string, AdapterStatus>>({});
  const [statusLine, setStatusLine] = useState('');
  const [now, setNow] = useState(() => Date.now());
  /** Latest pending auth challenge per account, and its pre-rendered QR. */
  const [authPrompts, setAuthPrompts] = useState<Record<string, AuthPrompt>>({});
  const [authQrLines, setAuthQrLines] = useState<Record<string, string[]>>({});
  const [authError, setAuthError] = useState<Record<string, string>>({});
  /** Account the auth overlay is currently showing (overlay kind 'auth'). */
  const [authFor, setAuthFor] = useState<string | null>(null);
  /** User-added accounts, persisted in SQLite. */
  const [customAccounts, setCustomAccounts] = useState<StoredCustomAccount[]>([]);
  const [accounts, setAccounts] = useState(() => service.getAccounts());

  // ---- reducer dispatch with live context --------------------------------

  const ctxRef = useRef<ReduceContext>({ rows: [], messageCount: 0 });
  const layout = effectiveLayout(ui.terminal, ui.layoutPreference);
  const rows = flattenRows(accounts, conversations, ui.expanded, ui.hiddenAccounts);
  const activeKey = ui.selected === null ? null : conversationKey(ui.selected);
  const activeMessages = activeKey === null ? [] : (messages[activeKey] ?? []);
  ctxRef.current = { rows, messageCount: activeMessages.length };

  // Keystrokes arriving in the same stdin packet share one React render
  // batch; this mirror lets the input handler always read fresh state.
  const uiMirror = useRef<AppState>(ui);
  uiMirror.current = ui;
  /** Account created through the Accounts page in this session; its first
   *  auth challenge hops straight into the auth overlay. */
  const lastAddedRef = useRef<string | null>(null);

  const apply = useCallback((action: Action) => {
    uiMirror.current = reduce(uiMirror.current, action, ctxRef.current);
    setUi(uiMirror.current);
  }, []);

  const notify = setStatusLine;

  // ---- data plumbing ------------------------------------------------------

  const refreshConversations = useCallback(async () => {
    try {
      const all = await service.listConversations();
      for (const conversation of all) repositories.conversations.upsert(conversation);
      setConversations(all);
    } catch (error) {
      notify(`conversation refresh failed: ${describe(error)}`);
    }
  }, [service, repositories]);

  const openConversation = useCallback(
    async (ref: ConversationRef) => {
      const key = conversationKey(ref);
      try {
        const history = await service.getMessages(ref.accountId, ref.conversationId);
        for (const message of history) repositories.messages.add(message);
        setMessages((prev) => {
          const live = prev[key] ?? [];
          const known = new Set(history.map((m) => m.id));
          const merged = [...history, ...live.filter((m) => !known.has(m.id))];
          merged.sort((a, b) => a.timestamp - b.timestamp);
          return { ...prev, [key]: merged.slice(-MESSAGE_WINDOW) };
        });
        await service.markRead(ref.accountId, ref.conversationId);
        repositories.state.markRead(ref.accountId, ref.conversationId, Date.now());
        await refreshConversations();
      } catch (error) {
        notify(`open failed: ${describe(error)}`);
      }
    },
    [service, repositories, refreshConversations],
  );

  // Load history whenever the selection changes (including via command),
  // without re-running for identical selections.
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (ui.selected === null) return;
    const key = conversationKey(ui.selected);
    if (openedRef.current === key && messages[key] !== undefined) return;
    openedRef.current = key;
    void openConversation(ui.selected);
  }, [ui.selected, openConversation, messages]);

  // ---- service subscriptions ----------------------------------------------

  useEffect(() => {
    const unsubscribeStatus = service.onStatus((change) => {
      setStatuses((prev) => ({ ...prev, [change.accountId]: change.status }));
      if (change.status === 'error' && change.error) notify(`${change.accountId}: ${change.error}`);
      if (change.status === 'connected') {
        // A successful connect completes any pending auth challenge.
        setStatusLine((prev) => (prev.includes('authentication') ? '' : prev));
        setAuthPrompts((prev) => {
          if (!(change.accountId in prev)) return prev;
          const next = { ...prev };
          delete next[change.accountId];
          return next;
        });
        setAuthFor((prev) => {
          if (prev === change.accountId) apply({ type: 'close-overlay' });
          return prev === change.accountId ? null : prev;
        });
      }
      void refreshConversations();
    });
    const unsubscribeMessages = service.onMessage((message) => {
      repositories.messages.add(message);
      setMessages((prev) => {
        const key = conversationKey({
          accountId: message.accountId,
          conversationId: message.conversationId,
        });
        const existing = prev[key] ?? [];
        if (existing.some((m) => m.id === message.id)) return prev;
        return { ...prev, [key]: [...existing, message].slice(-MESSAGE_WINDOW) };
      });
      void refreshConversations();
    });
    const unsubscribeAuth = service.onAuthPrompt(({ accountId, prompt }) => {
      setAuthPrompts((prev) => ({ ...prev, [accountId]: prompt }));
      setAuthError((prev) => ({ ...prev, [accountId]: '' }));
      if (prompt.kind === 'qr') {
        // Rendered once here; the payload itself is never logged or stored.
        setAuthQrLines((prev) => ({ ...prev, [accountId]: qrToLines(prompt.data) }));
      }
      // Adding an account jumps straight into its auth flow.
      if (
        (uiMirror.current.overlay === 'accounts' ||
          uiMirror.current.overlay === 'add-account') &&
        lastAddedRef.current === accountId
      ) {
        setAuthFor(accountId);
        apply({ type: 'open-overlay', overlay: 'auth' });
        return;
      }
      if (uiMirror.current.overlay !== 'auth') {
        notify(`${accountLabel(accountId)} needs authentication — press a to authenticate`);
      }
    });
    const unsubscribeAccounts = service.onAccountsChanged(() => {
      setAccounts(service.getAccounts());
      setCustomAccounts(repositories.accounts.listCustom());
      void refreshConversations();
    });
    return () => {
      unsubscribeStatus();
      unsubscribeMessages();
      unsubscribeAuth();
      unsubscribeAccounts();
    };
  }, [service, repositories, refreshConversations, apply]);

  // Initial load + persisted UI prefs + custom accounts from SQLite.
  useEffect(() => {
    void refreshConversations();
    const initial: Record<string, AdapterStatus> = {};
    for (const account of accounts) initial[account.id] = service.getAdapterStatus(account.id);
    setStatuses(initial);
    setCustomAccounts(repositories.accounts.listCustom());

    const stored = uiPrefsSchema.safeParse(repositories.prefs.get(UI_PREFS_KEY));
    if (stored.success) {
      const prefs = stored.data;
      setUi((prev) => ({
        ...prev,
        layoutPreference: prefs.layoutPreference ?? prev.layoutPreference,
        hiddenAccounts: prefs.hiddenAccounts ?? prev.hiddenAccounts,
        expanded: prefs.expanded ?? prev.expanded,
      }));
    }
  }, [service, accounts, repositories, refreshConversations]);

  // Persist UI prefs whenever they change.
  useEffect(() => {
    repositories.prefs.set(UI_PREFS_KEY, {
      layoutPreference: ui.layoutPreference,
      hiddenAccounts: ui.hiddenAccounts,
      expanded: ui.expanded,
    });
  }, [repositories, ui.layoutPreference, ui.hiddenAccounts, ui.expanded]);

  // Terminal resize + ticking clock.
  useEffect(() => {
    const onResize = () => apply({ type: 'resize', terminal: readSize() });
    stdout?.on('resize', onResize);
    const clock = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      stdout?.off('resize', onResize);
      clearInterval(clock);
    };
  }, [stdout, readSize, apply]);

  // ---- sending --------------------------------------------------------------

  const quit = useCallback(() => exit(), [exit]);

  const mirrorKey = (): string | null =>
    uiMirror.current.selected === null ? null : conversationKey(uiMirror.current.selected);

  const sendDraft = useCallback(async () => {
    const selected = uiMirror.current.selected;
    if (selected === null) return;
    const key = conversationKey(selected);
    const text = (uiMirror.current.drafts[key] ?? '').trim();
    if (text === '') {
      apply({ type: 'leave-insert-mode' });
      return;
    }
    try {
      await service.sendMessage(selected.accountId, selected.conversationId, text);
      apply({ type: 'draft-clear', key });
      apply({ type: 'leave-insert-mode' });
      await refreshConversations();
    } catch (error) {
      // Surface the reason; the draft is preserved for retry or edit.
      notify(`send failed: ${describe(error)}`);
    }
  }, [apply, service, refreshConversations]);

  // ---- keyboard routing -----------------------------------------------------

  useInput((input, key) => {
    // Ink can coalesce several plain characters typed in the same tick into
    // one `input` chunk; route each character separately so fast typing
    // (and key replay) behaves identically to slow typing.
    const flags = {
      return: key.return,
      escape: key.escape,
      tab: key.tab,
      shift: key.shift,
      ctrl: key.ctrl,
      meta: key.meta,
      backspace: key.backspace || key.delete,
      upArrow: key.upArrow,
      downArrow: key.downArrow,
    };
    const hasSpecial =
      flags.return || flags.escape || flags.tab || flags.ctrl || flags.meta ||
      flags.backspace || flags.upArrow || flags.downArrow;
    if (!hasSpecial && input.length > 1) {
      const insert = uiMirror.current.mode === 'insert';
      for (const ch of input) {
        if (ch === '\r' || ch === '\n') {
          // Pasted newlines never send a message; real Enter does.
          routeKey(insert ? ' ' : '', { return: !insert });
        } else if (ch === '\t') {
          routeKey('', { tab: true });
        } else if (ch === '\x7f') {
          routeKey('', { backspace: true });
        } else if (ch === '\x1b') {
          routeKey('', { escape: true });
        } else {
          routeKey(ch, {});
        }
      }
      return;
    }
    routeKey(input, flags);
  });

  interface KeyFlags {
    return?: boolean;
    escape?: boolean;
    tab?: boolean;
    shift?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    backspace?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
  }

  function routeKey(input: string, key: KeyFlags): void {
    // Read from the mirror: several keys can arrive per render batch.
    const s = uiMirror.current;
    const liveRows = flattenRows(accounts, conversations, s.expanded, s.hiddenAccounts);
    const liveKey = mirrorKey();

    if (key.ctrl && (input === 'c' || input === 'q')) {
      quit();
      return;
    }
    // Overlays own their input while open. Two controls fighting over keystrokes is not multitasking.
    if (s.overlay !== 'none') return;

    if (s.mode === 'insert') {
      if (key.escape) {
        apply({ type: 'leave-insert-mode' });
      } else if (key.return) {
        void sendDraft();
      } else if (key.backspace) {
        if (liveKey !== null) {
          const draft = s.drafts[liveKey] ?? '';
          apply({ type: 'draft-set', key: liveKey, text: draft.slice(0, -1) });
        }
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        if (liveKey !== null) {
          // Control bytes from pastes become spaces; messages stay one line. The terminal has enough ways to misbehave already.
          // eslint-disable-next-line no-control-regex
          const text = input.replace(/[\x00-\x1f]/g, ' ');
          apply({ type: 'draft-set', key: liveKey, text: (s.drafts[liveKey] ?? '') + text });
        }
      }
      return;
    }

    if (key.tab && !key.shift) return apply({ type: 'focus-next-pane' });
    if (key.tab && key.shift) return apply({ type: 'focus-previous-pane' });
    if (key.ctrl && input === 'p') return apply({ type: 'open-overlay', overlay: 'palette' });
    if (key.ctrl && input === 'n') return apply({ type: 'next-unread' });
    if (key.ctrl && input === 'r') {
      if (s.selected) {
        void service.markRead(s.selected.accountId, s.selected.conversationId);
        repositories.state.markRead(s.selected.accountId, s.selected.conversationId, Date.now());
        void refreshConversations();
      }
      return;
    }
    if (input === '?') return apply({ type: 'open-overlay', overlay: 'help' });
    if (input === '/') {
      // At the composer with a writable conversation, '/' begins the
      // message (links, bot commands like /start must be sendable);
      // anywhere else it opens search.
      if (s.focus === 'chat' && s.selected && canSend(s.selected.accountId)) {
        const key = conversationKey(s.selected);
        apply({ type: 'enter-insert-mode' });
        apply({ type: 'draft-set', key, text: (s.drafts[key] ?? '') + '/' });
        return;
      }
      return apply({ type: 'open-overlay', overlay: 'search' });
    }
    if (input === 'c') return apply({ type: 'open-overlay', overlay: 'new-conversation' });
    if (input === 'A') return apply({ type: 'open-overlay', overlay: 'accounts' });
    if (input === 'a') {
      // Auth: current account first, then any account with a pending prompt.
      const current = currentAccountId(commandDeps);
      const target =
        (current && authPrompts[current] ? current : undefined) ??
        Object.keys(authPrompts)[0];
      if (target === undefined) return notify('no account is waiting for authentication');
      return openAuthFor(target);
    }
    if (input === 'j' || key.downArrow) return apply({ type: 'move-selection', delta: 1 });
    if (input === 'k' || key.upArrow) return apply({ type: 'move-selection', delta: -1 });
    if (input === 'h') return apply({ type: 'focus-previous-pane' });
    if (input === 'l') return apply({ type: 'focus-next-pane' });

    if (input === 'g') {
      const row = liveRows[s.selectedRow];
      if (row?.type === 'account') return apply({ type: 'toggle-account', accountId: row.accountId });
      return;
    }

    if (input === 'i') {
      if (s.selected && canSend(s.selected.accountId)) {
        return apply({ type: 'enter-insert-mode' });
      }
      return;
    }

    if (key.escape) {
      if (s.focus !== 'conversations') return apply({ type: 'focus-pane', pane: 'conversations' });
      return;
    }

    if (key.return) {
      const row = liveRows[s.selectedRow];
      if (s.focus === 'conversations' && row?.type === 'account') {
        return apply({ type: 'toggle-account', accountId: row.accountId });
      }
      if (s.focus === 'conversations' && row?.type === 'conversation') {
        return apply({
          type: 'select-conversation',
          ref: { accountId: row.accountId, conversationId: row.conversation.id },
        });
      }
      if (s.focus === 'navigator') return apply({ type: 'focus-pane', pane: 'chat' });
      if (s.focus === 'chat' && s.selected && canSend(s.selected.accountId)) {
        return apply({ type: 'enter-insert-mode' });
      }
      return;
    }
  }

  function canSend(accountId: string): boolean {
    return can(accountId, 'canSendText');
  }

  function can(accountId: string, capability: 'canSendText' | 'canSendAttachments'): boolean {
    // accountId always comes from a registered adapter; if a refactor ever
    // breaks that invariant, refuse rather than crashing the render.
    try {
      return service.getCapabilities(accountId)[capability];
    } catch {
      return false;
    }
  }

  function accountLabel(accountId: string): string {
    return accounts.find((a) => a.id === accountId)?.label ?? accountId;
  }

  /** Opens the auth overlay for an account with a pending challenge. */
  function openAuthFor(accountId: string): void {
    setAuthFor(accountId);
    apply({ type: 'open-overlay', overlay: 'auth' });
  }

  const submitAuth = useCallback(
    (response: string) => {
      const accountId = authFor;
      if (!accountId) return;
      void service.submitAuthResponse(accountId, response).catch((error: unknown) => {
        setAuthError((prev) => ({ ...prev, [accountId]: describe(error) }));
      });
    },
    [authFor, service],
  );

  // ---- account management (Accounts page) ----------------------------------

  const accountRows = useMemo<Array<AccountRow>>(() => {
    const customById = new Map(customAccounts.map((c) => [c.id, c]));
    const builtinImpl = (account: AccountConfig): AccountRow['impl'] => {
      if (account.id === 'simplex') return config.simplex.impl;
      if (account.id === 'telegram') return config.telegram.impl;
      if (account.platform === 'whatsapp') return config.whatsapp.impl;
      if (account.id === 'slack') return config.slack.impl;
      return 'demo';
    };
    return accounts.map((account) => {
      const custom = customById.get(account.id);
      return {
        config: account,
        status: service.getAdapterStatus(account.id),
        origin: custom ? 'custom' : 'builtin',
        impl: custom?.impl ?? builtinImpl(account),
      };
    });
  }, [accounts, customAccounts, service, config.simplex.impl, config.telegram.impl, config.whatsapp.impl, config.slack.impl, statuses]);

  const addAccount = useCallback(
    (choice: ProviderChoice, label: string) => {
      const id = `custom-${choice.platform}-${Date.now().toString(36)}`;
      const account: AccountConfig = {
        id,
        label,
        badge: deriveBadge(label),
        platform: choice.platform,
        dataPath: join(config.dataDir, id),
      };
      repositories.accounts.addCustom(
        { ...account, impl: choice.transport },
        repositories.accounts.nextPosition(),
      );
      const cliSimplexCount = customAccounts.filter(
        (c) => c.platform === 'simplex' && c.impl === 'cli',
      ).length;
      const adapter = createAdapterForAccount(account, choice.transport, logger, {
        // The picker already hides demo transports in real mode; this keeps
        // a stale/persisted demo choice from silently simulating.
        allowDemo: config.mode === 'demo',
        simplexPort: nextSimplexCliPort(config.simplex.port, cliSimplexCount),
        telegram: { apiId: config.telegram.apiId, apiHash: config.telegram.apiHash },
        slack: { userToken: config.slack.userToken, appToken: config.slack.appToken },
      });
      service.register(adapter);
      lastAddedRef.current = id;
      setCustomAccounts(repositories.accounts.listCustom());
      void service.connectAccount(id).catch((error: unknown) => notify(describe(error)));
      // A follow-up auth challenge (QR/2FA) hops straight into the auth
      // overlay via the onAuthPrompt subscription.
      notify(`Adding ${label}…`);
    },
    [config, customAccounts, repositories, service, apply, logger],
  );

  /** The Add account page hands off to the Accounts page after creating. */
  const addAccountFromPage = useCallback(
    (choice: ProviderChoice, label: string) => {
      addAccount(choice, label);
      // Land on the Accounts page: connection status is visible there and
      // any auth challenge still hops into the shared auth overlay.
      apply({ type: 'open-overlay', overlay: 'accounts' });
    },
    [addAccount, apply],
  );

  const removeAccount = useCallback(
    (accountId: string) => {
      const label = accountLabel(accountId);
      void (async () => {
        try {
          await service.unregister(accountId);
        } catch (error) {
          notify(`remove failed: ${describe(error)}`);
          return;
        }
        repositories.accounts.removeCustom(accountId);
        // Wipe the account's own directory only - never anything shared.
        const custom = customAccounts.find((c) => c.id === accountId);
        if (custom) rmSync(custom.dataPath, { recursive: true, force: true });
        // Cached conversations/messages/read state would otherwise linger
        // in `/` search results for an account that no longer exists.
        repositories.conversations.deleteForAccount(accountId);
        repositories.messages.deleteForAccount(accountId);
        repositories.state.deleteForAccount(accountId);
        setCustomAccounts(repositories.accounts.listCustom());
        notify(`Removed ${label} and wiped its local session data`);
      })();
    },
    [customAccounts, repositories, service],
  );

  const reconnectAccount = useCallback(
    (accountId: string) => {
      void service
        .reconnect(accountId)
        .then(() => notify(`${accountLabel(accountId)} reconnected`))
        .catch((error: unknown) => notify(describe(error)));
    },
    [service],
  );

  // ---- overlays --------------------------------------------------------------

  const commandDeps: CommandDeps = {
    accounts,
    state: ui,
    rows,
    statuses,
    service,
    dispatch: apply,
    quit,
    notify,
  };
  const allCommands = useMemo(
    () => [...accountSwitchCommands(accounts), ...buildCommands()],
    [accounts],
  );

  const runCommand = (command: ChattyCommand): void => {
    apply({ type: 'close-overlay' });
    void command.run(commandDeps);
  };

  const search = useCallback(
    (query: string): SearchHit[] =>
      searchAll(
        {
          conversations: conversations.map((c) => ({
            accountId: c.accountId,
            id: c.id,
            title: c.title,
          })),
          messageHits: repositories.messages.search(query),
        },
        query,
      ),
    [conversations, repositories],
  );

  const jumpTo = (hit: SearchHit): void => {
    const index = rows.findIndex(
      (row) =>
        row.type === 'conversation' &&
        row.accountId === hit.accountId &&
        row.conversation.id === hit.conversationId,
    );
    apply({ type: 'close-overlay' });
    apply({
      type: 'select-conversation',
      ref: { accountId: hit.accountId, conversationId: hit.conversationId },
      ...(index >= 0 ? { row: index } : {}),
    });
    apply({ type: 'focus-pane', pane: 'chat' });
  };

  // ---- new conversation flow -------------------------------------------------

  /** Accounts whose adapter can start conversations (capability-gated). */
  const startCapableAccounts = useMemo(
    () =>
      accounts.filter((a) => {
        try {
          return service.getCapabilities(a.id).canStartConversations;
        } catch {
          return false;
        }
      }),
    [accounts, service],
  );

  const startNewConversation = useCallback(
    (accountId: string, target: string) => service.startConversation(accountId, target),
    [service],
  );

  const listStartTargets = useCallback(
    (accountId: string) => service.listStartTargets(accountId),
    [service],
  );

  const loadConnectionLink = useCallback(
    (accountId: string) =>
      service.getConnectionLink(accountId).then((link) => ({ link, qrLines: qrToLines(link) })),
    [service],
  );

  /** Success: select the new chat and land in the composer for the first message. */
  const conversationStarted = useCallback(
    (conversation: Conversation) => {
      setConversations((prev) =>
        prev.some(
          (c) => c.accountId === conversation.accountId && c.id === conversation.id,
        )
          ? prev
          : [...prev, conversation],
      );
      apply({ type: 'close-overlay' });
      apply({
        type: 'select-conversation',
        ref: { accountId: conversation.accountId, conversationId: conversation.id },
      });
      apply({ type: 'focus-pane', pane: 'chat' });
      notify(`chat with ${conversation.title} ready — press i and type the first message`);
    },
    [apply],
  );

  // ---- render -----------------------------------------------------------------

  const paneHeight = Math.max(3, ui.terminal.height - 4); // top bar, tabs, status, shortcut bar
  const overlayHeight = Math.max(3, ui.terminal.height - 4);
  const focusedAccount = accounts.find((a) => a.id === currentAccountId(commandDeps));
  const selectedConversation =
    ui.selected === null
      ? undefined
      : conversations.find(
          (c) => c.accountId === ui.selected?.accountId && c.id === ui.selected?.conversationId,
        );
  const connectedCount = Object.values(statuses).filter((s) => s === 'connected').length;

  return (
    <Box flexDirection="column" width={ui.terminal.width} height={ui.terminal.height}>
      <TopBar
        theme={resolvedTheme}
        mode={config.mode}
        connected={connectedCount}
        total={accounts.length}
        unread={unreadTotal(conversations)}
        clock={formatClock(now)}
      />
      <AccountTabs
        theme={resolvedTheme}
        accounts={accounts}
        statuses={statuses}
        activeAccountId={focusedAccount?.id}
        hiddenAccounts={ui.hiddenAccounts}
      />
      {statusLine !== '' ? (
        <Box paddingX={1}>
          <Text color={resolvedTheme.colors.error} wrap="truncate">
            {statusLine}
          </Text>
        </Box>
      ) : null}

      {layout === 'too-small' ? (
        <Box borderStyle={resolvedTheme.borderStyle} borderColor={resolvedTheme.colors.error} paddingX={1}>
          <Text color={resolvedTheme.colors.text}>
            Terminal too small: {ui.terminal.width}×{ui.terminal.height}. chatty needs at least{' '}
            {MIN_WIDTH}×{MIN_HEIGHT}. Enlarge the terminal or press Ctrl+Q to quit.
          </Text>
        </Box>
      ) : ui.overlay === 'help' ? (
        <HelpOverlay theme={resolvedTheme} height={overlayHeight} onClose={() => apply({ type: 'close-overlay' })} />
      ) : ui.overlay === 'palette' ? (
        <CommandPalette
          theme={resolvedTheme}
          height={overlayHeight}
          commands={allCommands}
          onRun={runCommand}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'search' ? (
        <SearchOverlay
          theme={resolvedTheme}
          height={overlayHeight}
          search={search}
          onJump={jumpTo}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'settings' ? (
        <SettingsOverlay
          theme={resolvedTheme}
          height={overlayHeight}
          config={config}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'accounts' ? (
        <AccountsPage
          theme={resolvedTheme}
          height={overlayHeight}
          rows={accountRows}
          onOpenAdd={() => apply({ type: 'open-overlay', overlay: 'add-account' })}
          onRemove={removeAccount}
          onReconnect={reconnectAccount}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'add-account' ? (
        <AddAccountPage
          theme={resolvedTheme}
          height={overlayHeight}
          choices={providerChoices({
            telegramReal:
              config.telegram.impl === 'gramjs' ||
              (config.telegram.apiId !== undefined && config.telegram.apiHash !== undefined),
            demoTransports: config.mode === 'demo',
          })}
          onAdd={addAccountFromPage}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'new-conversation' ? (
        <NewConversationOverlay
          theme={resolvedTheme}
          height={overlayHeight}
          accounts={startCapableAccounts}
          statuses={statuses}
          preselectedAccountId={ui.selected?.accountId ?? focusedAccount?.id}
          onStart={startNewConversation}
          onListTargets={listStartTargets}
          onConnectionLink={loadConnectionLink}
          onStarted={conversationStarted}
          onClose={() => apply({ type: 'close-overlay' })}
        />
      ) : ui.overlay === 'auth' && authFor !== null && authPrompts[authFor] ? (
        <AuthOverlay
          theme={resolvedTheme}
          height={overlayHeight}
          accountLabel={accountLabel(authFor)}
          prompt={authPrompts[authFor]}
          qrLines={authQrLines[authFor]}
          error={authError[authFor]}
          onSubmit={submitAuth}
          onClose={() => {
            setAuthFor(null);
            apply({ type: 'close-overlay' });
          }}
        />
      ) : (
        <ThreePaneLayout
          theme={resolvedTheme}
          layout={layout}
          focus={ui.focus}
          width={ui.terminal.width}
          height={paneHeight}
          panes={{
            accounts,
            conversations,
            statuses,
            expanded: ui.expanded,
            hiddenAccounts: ui.hiddenAccounts,
            selectedRow: ui.selectedRow,
            selectedConversation,
            selectedAccount: selectedConversation
              ? accounts.find((a) => a.id === selectedConversation.accountId)
              : undefined,
            messages: activeMessages,
            selectedMessage: ui.selectedMessage,
            mode: ui.mode,
            draft: activeKey === null ? '' : (ui.drafts[activeKey] ?? ''),
            canSendText: ui.selected !== null && canSend(ui.selected.accountId),
            canSendAttachments:
              ui.selected !== null && can(ui.selected.accountId, 'canSendAttachments'),
          }}
        />
      )}

      <ShortcutBar
        theme={resolvedTheme}
        mode={ui.mode}
        overlay={ui.overlay}
        accountBadge={focusedAccount?.badge}
        hasConversation={ui.selected !== null}
        authPending={Object.keys(authPrompts).length > 0}
        width={ui.terminal.width}
      />
    </Box>
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
