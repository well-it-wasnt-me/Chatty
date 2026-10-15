import { describe, expect, it } from 'vitest';
import type { AccountConfig } from '../domain/types.js';
import {
  accountSwitchCommands,
  buildCommands,
  currentAccountId,
  filterCommands,
  type CommandDeps,
} from './commands.js';
import { flattenRows, initialState } from './state.js';

const ACCOUNTS: AccountConfig[] = [
  { id: 'wa-a', label: 'WhatsApp A', badge: 'WA-A', platform: 'whatsapp', dataPath: '/tmp/a' },
  { id: 'slack', label: 'Slack', badge: 'SL', platform: 'slack', dataPath: '/tmp/s' },
];

function makeDeps(overrides: Partial<CommandDeps> = {}): CommandDeps {
  const notifications: string[] = [];
  return {
    accounts: ACCOUNTS,
    state: initialState({ width: 160, height: 40 }),
    rows: flattenRows(ACCOUNTS, [], {}, {}),
    statuses: {},
    service: {
      markRead: async () => {},
      reconnect: async () => {},
    } as unknown as CommandDeps['service'],
    dispatch: () => {},
    quit: () => {},
    notify: (line) => notifications.push(line),
    ...overrides,
  };
}

describe('filterCommands', () => {
  const commands = [...accountSwitchCommands(ACCOUNTS), ...buildCommands()];

  it('returns everything for an empty query', () => {
    expect(filterCommands(commands, '')).toHaveLength(commands.length);
  });

  it('matches tokens case-insensitively', () => {
    expect(filterCommands(commands, 'QUIT').map((c) => c.id)).toEqual(['quit']);
    expect(filterCommands(commands, 'switch whatsapp')).toHaveLength(1);
    expect(filterCommands(commands, 'account').length).toBeGreaterThanOrEqual(3);
  });

  it('requires all tokens to match', () => {
    expect(filterCommands(commands, 'switch layout')).toHaveLength(0);
  });
});

describe('currentAccountId', () => {
  it('resolves the account under the selected row', () => {
    const deps = makeDeps();
    deps.state = { ...deps.state, selectedRow: 0 };
    expect(currentAccountId(deps)).toBe('wa-a');
    deps.state = { ...deps.state, selectedRow: 1 };
    expect(currentAccountId(deps)).toBe('slack');
  });

  it('falls back to the selected chat account', () => {
    const deps = makeDeps();
    deps.rows = [];
    deps.state = {
      ...deps.state,
      selected: { accountId: 'slack', conversationId: 'c1' },
    };
    expect(currentAccountId(deps)).toBe('slack');
  });
});

describe('built-in commands', () => {
  it('switch account jumps to the account row', () => {
    const actions: string[] = [];
    const deps = makeDeps({ dispatch: (a) => actions.push(a.type) });
    accountSwitchCommands(ACCOUNTS)[1].run(deps);
    expect(actions).toEqual(['focus-pane', 'select-row']);
  });

  it('mark read without a selection notifies instead of crashing', () => {
    const notifications: string[] = [];
    const deps = makeDeps({ notify: (l) => notifications.push(l) });
    void buildCommands().find((c) => c.id === 'mark-conversation-read')?.run(deps);
    expect(notifications[0]).toMatch(/no conversation selected/);
  });

  it('add account opens the add-account page', () => {
    const actions: string[] = [];
    const deps = makeDeps({
      dispatch: (a) => actions.push(`${a.type}:${(a as { overlay?: string }).overlay ?? ''}`),
    });
    void buildCommands().find((c) => c.id === 'add-account')?.run(deps);
    expect(actions).toEqual(['open-overlay:add-account']);
  });

  it('quit runs the quit callback', async () => {
    let quitCalled = false;
    const deps = makeDeps({ quit: () => (quitCalled = true) });
    await buildCommands().find((c) => c.id === 'quit')?.run(deps);
    expect(quitCalled).toBe(true);
  });
});
