import type { AccountConfig, Conversation } from '../domain/types.js';

/**
 * Pure application state: a reducer plus selectors with no Ink, service or
 * storage dependencies, so navigation, layout and unread logic are unit
 * testable without rendering a terminal. App.tsx interprets the actions
 * that imply side effects (fetch history, send, mark read, persist prefs).
 */

export type FocusPane = 'conversations' | 'navigator' | 'chat';
export type InputMode = 'normal' | 'insert';
export type OverlayKind =
  | 'none'
  | 'help'
  | 'palette'
  | 'search'
  | 'settings'
  | 'auth'
  | 'accounts'
  | 'add-account'
  | 'new-conversation';
export type LayoutPreference = 'auto' | 'three' | 'two' | 'one';
export type EffectiveLayout = 'three' | 'two' | 'one' | 'too-small';

export interface ConversationRef {
  accountId: string;
  conversationId: string;
}

export interface TerminalSize {
  width: number;
  height: number;
}

export interface AppState {
  terminal: TerminalSize;
  focus: FocusPane;
  mode: InputMode;
  overlay: OverlayKind;
  layoutPreference: LayoutPreference;
  /** accountId -> expanded; missing key means expanded. */
  expanded: Record<string, boolean>;
  /** accountId -> hidden; hidden accounts are omitted from the left pane. */
  hiddenAccounts: Record<string, boolean>;
  /** Row index within the flattened, visible left-pane rows. */
  selectedRow: number;
  /** The active conversation shown in navigator and chat panes. */
  selected: ConversationRef | null;
  /** Selected message index within the active conversation. */
  selectedMessage: number;
  /** Composer drafts, keyed by conversationKey. Survive pane switches. */
  drafts: Record<string, string>;
}

export const MIN_WIDTH = 54;
export const MIN_HEIGHT = 14;
export const THREE_PANE_MIN_WIDTH = 120;
export const TWO_PANE_MIN_WIDTH = 78;

export function initialState(terminal: TerminalSize): AppState {
  return {
    terminal,
    focus: 'conversations',
    mode: 'normal',
    overlay: 'none',
    layoutPreference: 'auto',
    expanded: {},
    hiddenAccounts: {},
    selectedRow: 0,
    selected: null,
    selectedMessage: 0,
    drafts: {},
  };
}

/** Resolves the pane arrangement for the current terminal size. */
export function effectiveLayout(
  terminal: TerminalSize,
  preference: LayoutPreference,
): EffectiveLayout {
  if (terminal.width < MIN_WIDTH || terminal.height < MIN_HEIGHT) return 'too-small';
  const { width } = terminal;
  const fits = (required: EffectiveLayout): boolean => {
    if (required === 'three') return width >= THREE_PANE_MIN_WIDTH;
    if (required === 'two') return width >= TWO_PANE_MIN_WIDTH;
    return true;
  };
  if (preference === 'auto') {
    if (width >= THREE_PANE_MIN_WIDTH) return 'three';
    if (width >= TWO_PANE_MIN_WIDTH) return 'two';
    return 'one';
  }
  if (fits(preference)) return preference;
  if (preference === 'three' && fits('two')) return 'two';
  return 'one';
}

/** Panes that exist under the effective layout, in Tab order. */
export function visiblePanes(layout: EffectiveLayout, hasSelection: boolean): FocusPane[] {
  switch (layout) {
    case 'three':
      return ['conversations', 'navigator', 'chat'];
    case 'two':
      return hasSelection ? ['conversations', 'chat'] : ['conversations'];
    case 'one':
      return hasSelection ? ['conversations', 'chat'] : ['conversations'];
    case 'too-small':
      return [];
  }
}

export function conversationKey(ref: ConversationRef): string {
  return `${ref.accountId}/${ref.conversationId}`;
}

/** A row in the left pane: either an account header or a conversation. */
export type LeftRow =
  | { type: 'account'; accountId: string }
  | { type: 'conversation'; accountId: string; conversation: Conversation };

/**
 * Flattens accounts and their conversations (sorted by last activity) into
 * the visible left-pane rows, honoring hidden accounts and collapsed groups.
 */
export function flattenRows(
  accounts: AccountConfig[],
  conversations: Conversation[],
  expanded: Record<string, boolean>,
  hiddenAccounts: Record<string, boolean>,
): LeftRow[] {
  const rows: LeftRow[] = [];
  for (const account of accounts) {
    if (hiddenAccounts[account.id]) continue;
    rows.push({ type: 'account', accountId: account.id });
    if (expanded[account.id] ?? true) {
      const own = conversations
        .filter((c) => c.accountId === account.id)
        .sort((a, b) => (b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0));
      for (const conversation of own) {
        rows.push({ type: 'conversation', accountId: account.id, conversation });
      }
    }
  }
  return rows;
}

export function unreadTotal(conversations: Conversation[]): number {
  return conversations.reduce((sum, c) => sum + c.unread, 0);
}

export function unreadForAccount(conversations: Conversation[], accountId: string): number {
  return conversations
    .filter((c) => c.accountId === accountId)
    .reduce((sum, c) => sum + c.unread, 0);
}

/**
 * Computes the [start, end) slice that keeps `selected` visible inside a
 * pane with room for `capacity` rows, centering when possible.
 */
export function windowSlice(
  total: number,
  selected: number,
  capacity: number,
): { start: number; end: number } {
  if (capacity <= 0 || total <= 0) return { start: 0, end: 0 };
  if (total <= capacity) return { start: 0, end: total };
  const maxStart = total - capacity;
  const start = clamp(selected - Math.floor(capacity / 2), 0, maxStart);
  return { start, end: start + capacity };
}

/** Side-effect-free context the reducer needs to resolve an action. */
export interface ReduceContext {
  rows: LeftRow[];
  /** Number of messages in the active conversation. */
  messageCount: number;
}

export type Action =
  | { type: 'resize'; terminal: TerminalSize }
  | { type: 'focus-next-pane' }
  | { type: 'focus-previous-pane' }
  | { type: 'focus-pane'; pane: FocusPane }
  | { type: 'move-selection'; delta: 1 | -1 }
  | { type: 'select-row'; index: number }
  | { type: 'toggle-account'; accountId: string }
  | { type: 'toggle-account-visibility'; accountId: string }
  | { type: 'select-conversation'; ref: ConversationRef; row?: number }
  | { type: 'enter-insert-mode' }
  | { type: 'leave-insert-mode' }
  | { type: 'open-overlay'; overlay: OverlayKind }
  | { type: 'close-overlay' }
  | { type: 'draft-set'; key: string; text: string }
  | { type: 'draft-clear'; key: string }
  | { type: 'next-unread' }
  | { type: 'cycle-layout' }
  | { type: 'clamp-selection' };

const LAYOUT_CYCLE: LayoutPreference[] = ['auto', 'three', 'two', 'one'];

export function reduce(state: AppState, action: Action, ctx: ReduceContext): AppState {
  const panes = visiblePanes(effectiveLayout(state.terminal, state.layoutPreference),
    state.selected !== null);

  switch (action.type) {
    case 'resize':
      return clampSelections({ ...state, terminal: action.terminal }, ctx);

    case 'focus-next-pane':
    case 'focus-previous-pane': {
      if (panes.length === 0) return state;
      const order = panes;
      const current = order.indexOf(state.focus);
      const step = action.type === 'focus-next-pane' ? 1 : -1;
      const next = order[(current + step + order.length) % order.length] ?? order[0];
      if (next === state.focus) return state;
      return { ...state, focus: next, mode: 'normal' };
    }

    case 'focus-pane': {
      if (!panes.includes(action.pane)) return state;
      if (action.pane === state.focus) return state;
      return { ...state, focus: action.pane, mode: 'normal' };
    }

    case 'move-selection': {
      if (state.focus === 'conversations') {
        const max = Math.max(0, ctx.rows.length - 1);
        return { ...state, selectedRow: clamp(state.selectedRow + action.delta, 0, max) };
      }
      if (state.focus === 'navigator') {
        const max = Math.max(0, ctx.messageCount - 1);
        return { ...state, selectedMessage: clamp(state.selectedMessage + action.delta, 0, max) };
      }
      return state;
    }

    case 'select-row':
      return { ...state, selectedRow: clamp(action.index, 0, Math.max(0, ctx.rows.length - 1)) };

    case 'toggle-account': {
      const expanded = { ...state.expanded, [action.accountId]: !(state.expanded[action.accountId] ?? true) };
      return clampSelections({ ...state, expanded }, ctx);
    }

    case 'toggle-account-visibility': {
      const hiddenAccounts = {
        ...state.hiddenAccounts,
        [action.accountId]: !state.hiddenAccounts[action.accountId],
      };
      return clampSelections({ ...state, hiddenAccounts, selectedRow: 0 }, ctx);
    }

    case 'select-conversation':
      return {
        ...state,
        selected: action.ref,
        selectedMessage: 0,
        selectedRow: action.row ?? state.selectedRow,
      };

    case 'enter-insert-mode': {
      if (state.selected === null) return state;
      return { ...state, mode: 'insert', focus: 'chat' };
    }

    case 'leave-insert-mode':
      return { ...state, mode: 'normal' };

    case 'open-overlay':
      return { ...state, overlay: action.overlay, mode: 'normal' };

    case 'close-overlay':
      return { ...state, overlay: 'none' };

    case 'draft-set': {
      return { ...state, drafts: { ...state.drafts, [action.key]: action.text } };
    }

    case 'draft-clear': {
      const drafts = { ...state.drafts };
      delete drafts[action.key];
      return { ...state, drafts };
    }

    case 'next-unread': {
      const unreadRows = ctx.rows
        .map((row, index) => ({ row, index }))
        .filter(
          (entry) =>
            entry.row.type === 'conversation' &&
            entry.row.conversation.unread > 0 &&
            !entry.row.conversation.muted,
        );
      if (unreadRows.length === 0) return state;
      const after = unreadRows.find((entry) => entry.index > state.selectedRow) ?? unreadRows[0];
      const row = after.row;
      if (row.type !== 'conversation') return state;
      return {
        ...state,
        selectedRow: after.index,
        selected: { accountId: row.accountId, conversationId: row.conversation.id },
        selectedMessage: 0,
      };
    }

    case 'cycle-layout': {
      const index = LAYOUT_CYCLE.indexOf(state.layoutPreference);
      const layoutPreference = LAYOUT_CYCLE[(index + 1) % LAYOUT_CYCLE.length];
      return { ...state, layoutPreference };
    }

    case 'clamp-selection':
      return clampSelections(state, ctx);

    default:
      return state;
  }
}

function clampSelections(state: AppState, ctx: ReduceContext): AppState {
  return {
    ...state,
    selectedRow: clamp(state.selectedRow, 0, Math.max(0, ctx.rows.length - 1)),
    selectedMessage: clamp(state.selectedMessage, 0, Math.max(0, ctx.messageCount - 1)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
