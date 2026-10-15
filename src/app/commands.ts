import type { AccountConfig, AdapterStatus } from '../domain/types.js';
import type { MessagingService } from '../core/messaging-service.js';
import type { Action, AppState, LeftRow } from './state.js';

/**
 * Command palette registry. Commands receive a deps object assembled by
 * App on each render, so they always act on fresh state. `filterCommands`
 * is pure and unit-tested.
 */

export interface CommandDeps {
  accounts: AccountConfig[];
  state: AppState;
  rows: LeftRow[];
  statuses: Record<string, AdapterStatus>;
  service: MessagingService;
  dispatch: (action: Action) => void;
  quit: () => void;
  /** Show a transient status/error line. Never receives message contents. Logs are for debugging, not collecting secrets like trading cards. */
  notify: (line: string) => void;
}

export interface ChattyCommand {
  id: string;
  title: string;
  hint?: string;
  run: (deps: CommandDeps) => void | Promise<void>;
}

/** Account the left-pane selection currently sits on (fallback: selected chat's). */
export function currentAccountId(deps: CommandDeps): string | undefined {
  const row = deps.rows[deps.state.selectedRow];
  if (row?.type === 'account') return row.accountId;
  if (row?.type === 'conversation') return row.accountId;
  return deps.state.selected?.accountId;
}

export function buildCommands(): ChattyCommand[] {
  return [
    {
      id: 'search-messages',
      title: 'Search conversations & messages',
      hint: '/',
      run: (deps) => deps.dispatch({ type: 'open-overlay', overlay: 'search' }),
    },
    {
      id: 'start-conversation',
      title: 'Start a new conversation',
      hint: 'c',
      run: (deps) => deps.dispatch({ type: 'open-overlay', overlay: 'new-conversation' }),
    },
    {
      id: 'jump-to-unread',
      title: 'Jump to next unread conversation',
      hint: 'Ctrl+N',
      run: (deps) => deps.dispatch({ type: 'next-unread' }),
    },
    {
      id: 'mark-conversation-read',
      title: 'Mark conversation as read',
      hint: 'Ctrl+R',
      run: (deps) => {
        const selected = deps.state.selected;
        if (!selected) {
          deps.notify('no conversation selected');
          return;
        }
        void deps.service.markRead(selected.accountId, selected.conversationId).then(() => {
          deps.notify('marked as read');
        });
      },
    },
    {
      id: 'reconnect-account',
      title: 'Reconnect account (selected account)',
      run: async (deps) => {
        const accountId = currentAccountId(deps);
        if (!accountId) {
          deps.notify('no account selected');
          return;
        }
        deps.notify(`reconnecting ${accountId}…`);
        try {
          await deps.service.reconnect(accountId);
          deps.notify(`${accountId} reconnected`);
        } catch (error) {
          deps.notify(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      id: 'toggle-account-visibility',
      title: 'Toggle visibility of selected account',
      run: (deps) => {
        const accountId = currentAccountId(deps);
        if (!accountId) return;
        deps.dispatch({ type: 'toggle-account-visibility', accountId });
      },
    },
    {
      id: 'change-layout',
      title: 'Change layout (cycle auto / three / two / one)',
      run: (deps) => deps.dispatch({ type: 'cycle-layout' }),
    },
    {
      id: 'add-account',
      title: 'Add account (choose provider)',
      hint: 'A → a',
      run: (deps) => deps.dispatch({ type: 'open-overlay', overlay: 'add-account' }),
    },
    {
      id: 'manage-accounts',
      title: 'Manage accounts (add / remove / reconnect)',
      hint: 'A',
      run: (deps) => deps.dispatch({ type: 'open-overlay', overlay: 'accounts' }),
    },
    {
      id: 'open-settings',
      title: 'Open settings',
      run: (deps) => deps.dispatch({ type: 'open-overlay', overlay: 'settings' }),
    },
    {
      id: 'quit',
      title: 'Quit',
      hint: 'Ctrl+Q',
      run: (deps) => deps.quit(),
    },
  ];
}

/** Commands to switch to each configured account, generated from config. */
export function accountSwitchCommands(accounts: AccountConfig[]): ChattyCommand[] {
  return accounts.map((account) => ({
    id: `switch-account:${account.id}`,
    title: `Switch account: ${account.label} (${account.badge})`,
    run: (deps) => {
      const index = deps.rows.findIndex(
        (row) => row.type === 'account' && row.accountId === account.id,
      );
      if (index >= 0) {
        deps.dispatch({ type: 'focus-pane', pane: 'conversations' });
        deps.dispatch({ type: 'select-row', index });
      } else {
        deps.notify(`${account.label} is hidden — toggle its visibility first`);
      }
    },
  }));
}

/** Token-wise case-insensitive filter; every token must appear in the title. */
export function filterCommands(commands: ChattyCommand[], query: string): ChattyCommand[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return commands;
  return commands.filter((command) => {
    const haystack = command.title.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
