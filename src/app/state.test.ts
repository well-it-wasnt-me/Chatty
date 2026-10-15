import { describe, expect, it } from 'vitest';
import type { AccountConfig, Conversation } from '../domain/types.js';
import {
  conversationKey,
  effectiveLayout,
  flattenRows,
  initialState,
  reduce,
  unreadForAccount,
  unreadTotal,
  visiblePanes,
  windowSlice,
  type LeftRow,
} from './state.js';

const ACCOUNTS: AccountConfig[] = [
  { id: 'wa-a', label: 'A', badge: 'A', platform: 'whatsapp', dataPath: '/tmp/a' },
  { id: 'wa-b', label: 'B', badge: 'B', platform: 'whatsapp', dataPath: '/tmp/b' },
  { id: 'tg', label: 'TG', badge: 'TG', platform: 'telegram', dataPath: '/tmp/tg' },
];

function conv(accountId: string, id: string, unread: number, ts: number): Conversation {
  return {
    id,
    accountId,
    title: `${accountId}/${id}`,
    unread,
    lastMessage: {
      id: `${id}-m`,
      accountId,
      conversationId: id,
      direction: 'incoming',
      timestamp: ts,
      text: 'x',
    },
  };
}

const WIDE = { width: 160, height: 40 };

function ctxFor(rows: LeftRow[], messageCount = 0) {
  return { rows, messageCount };
}

describe('effectiveLayout', () => {
  it('chooses three/two/one panes by width in auto mode', () => {
    expect(effectiveLayout(WIDE, 'auto')).toBe('three');
    expect(effectiveLayout({ width: 120, height: 40 }, 'auto')).toBe('three');
    expect(effectiveLayout({ width: 119, height: 40 }, 'auto')).toBe('two');
    expect(effectiveLayout({ width: 78, height: 40 }, 'auto')).toBe('two');
    expect(effectiveLayout({ width: 77, height: 40 }, 'auto')).toBe('one');
  });

  it('reports too-small below the minimum terminal size', () => {
    expect(effectiveLayout({ width: 53, height: 40 }, 'auto')).toBe('too-small');
    expect(effectiveLayout({ width: 80, height: 13 }, 'auto')).toBe('too-small');
  });

  it('clamps forced layouts to what fits', () => {
    expect(effectiveLayout({ width: 100, height: 40 }, 'three')).toBe('two');
    expect(effectiveLayout({ width: 60, height: 40 }, 'two')).toBe('one');
    expect(effectiveLayout(WIDE, 'one')).toBe('one');
  });
});

describe('visiblePanes', () => {
  it('lists panes per layout, gating navigator/chat on selection', () => {
    expect(visiblePanes('three', true)).toEqual(['conversations', 'navigator', 'chat']);
    expect(visiblePanes('two', true)).toEqual(['conversations', 'chat']);
    expect(visiblePanes('two', false)).toEqual(['conversations']);
    expect(visiblePanes('one', false)).toEqual(['conversations']);
    expect(visiblePanes('too-small', false)).toEqual([]);
  });
});

describe('flattenRows', () => {
  const conversations = [
    conv('wa-a', 'c2', 0, 200),
    conv('wa-a', 'c1', 3, 100),
    conv('tg', 't1', 1, 300),
  ];

  it('groups conversations per account, newest activity first', () => {
    const rows = flattenRows(ACCOUNTS, conversations, {}, {});
    const kinds = rows.map((r) => (r.type === 'account' ? `a:${r.accountId}` : `c:${r.conversation.id}`));
    expect(kinds).toEqual(['a:wa-a', 'c:c2', 'c:c1', 'a:wa-b', 'a:tg', 'c:t1']);
  });

  it('keeps identical titles from different accounts separate', () => {
    const dup = [conv('wa-a', 'c1', 0, 100), { ...conv('wa-b', 'x', 0, 50), title: 'wa-a/c1' }];
    const rows = flattenRows(ACCOUNTS, dup, {}, {});
    const titles = rows.filter((r) => r.type === 'conversation').map((r) => r.type === 'conversation' ? `${r.accountId}:${r.conversation.title}` : '');
    expect(titles).toEqual(['wa-a:wa-a/c1', 'wa-b:wa-a/c1']);
  });

  it('omits conversations of collapsed accounts and hides hidden accounts', () => {
    const rows = flattenRows(ACCOUNTS, conversations, { 'wa-a': false }, { tg: true });
    const kinds = rows.map((r) => (r.type === 'account' ? `a:${r.accountId}` : `c:${r.conversation.id}`));
    expect(kinds).toEqual(['a:wa-a', 'a:wa-b']);
  });
});

describe('unread counters', () => {
  it('sums per account and overall', () => {
    const conversations = [conv('wa-a', 'c1', 3, 1), conv('wa-a', 'c2', 1, 2), conv('tg', 't', 2, 3)];
    expect(unreadTotal(conversations)).toBe(6);
    expect(unreadForAccount(conversations, 'wa-a')).toBe(4);
    expect(unreadForAccount(conversations, 'wa-b')).toBe(0);
  });
});

describe('reducer: focus and movement', () => {
  const conversations = [conv('wa-a', 'c1', 1, 1)];
  const rows = flattenRows(ACCOUNTS, conversations, {}, {});

  it('cycles panes with Tab/Shift+Tab given the visible layout', () => {
    let state = reduce(initialState(WIDE), { type: 'select-conversation', ref: { accountId: 'wa-a', conversationId: 'c1' } }, ctxFor(rows));
    state = reduce(state, { type: 'focus-next-pane' }, ctxFor(rows));
    expect(state.focus).toBe('navigator');
    state = reduce(state, { type: 'focus-next-pane' }, ctxFor(rows));
    expect(state.focus).toBe('chat');
    state = reduce(state, { type: 'focus-next-pane' }, ctxFor(rows));
    expect(state.focus).toBe('conversations');
    state = reduce(state, { type: 'focus-previous-pane' }, ctxFor(rows));
    expect(state.focus).toBe('chat');
  });

  it('clamps selection at list bounds', () => {
    const ctx = ctxFor(rows);
    let state = initialState(WIDE);
    state = reduce(state, { type: 'move-selection', delta: -1 }, ctx);
    expect(state.selectedRow).toBe(0);
    state = reduce(state, { type: 'select-row', index: rows.length - 1 }, ctx);
    state = reduce(state, { type: 'move-selection', delta: 1 }, ctx);
    expect(state.selectedRow).toBe(rows.length - 1);
  });

  it('moves message selection when the navigator is focused', () => {
    const ctx = ctxFor(rows, 5);
    let state = reduce(initialState(WIDE), { type: 'focus-pane', pane: 'conversations' }, ctx);
    state = reduce(
      { ...state, focus: 'navigator' as const },
      { type: 'move-selection', delta: 1 },
      ctx,
    );
    expect(state.selectedMessage).toBe(1);
    state = reduce(state, { type: 'move-selection', delta: -1 }, { ...ctx });
    expect(state.selectedMessage).toBe(0);
  });
});

describe('reducer: collapse, visibility, unread jump', () => {
  const conversations = [conv('wa-a', 'c1', 0, 1), conv('tg', 't1', 5, 300), conv('wa-b', 'x', 2, 200)];

  it('toggles account expansion and re-clamps the selection', () => {
    const rows = flattenRows(ACCOUNTS, conversations, {}, {});
    let state = reduce(initialState(WIDE), { type: 'select-row', index: rows.length - 1 }, ctxFor(rows));
    state = reduce(state, { type: 'toggle-account', accountId: 'wa-a' }, ctxFor(flattenRows(ACCOUNTS, conversations, { 'wa-a': false }, {})));
    expect(state.expanded['wa-a']).toBe(false);
    const afterRows = flattenRows(ACCOUNTS, conversations, state.expanded, {});
    expect(state.selectedRow).toBeLessThanOrEqual(afterRows.length - 1);
  });

  it('jumps to the next unread conversation, wrapping around', () => {
    const rows = flattenRows(ACCOUNTS, conversations, {}, {});
    const ctx = ctxFor(rows);
    let state = initialState(WIDE);
    state = reduce(state, { type: 'next-unread' }, ctx);
    expect(state.selected?.conversationId).toBe('x');
    state = reduce(state, { type: 'next-unread' }, ctx);
    expect(state.selected?.conversationId).toBe('t1');
  });

  it('does nothing when nothing is unread', () => {
    const calm = [conv('wa-a', 'c1', 0, 1)];
    const ctx = ctxFor(flattenRows(ACCOUNTS, calm, {}, {}));
    const state = initialState(WIDE);
    expect(reduce(state, { type: 'next-unread' }, ctx)).toBe(state);
  });
});

describe('reducer: composer drafts', () => {
  it('keeps drafts per conversation and clears them independently', () => {
    let state = initialState(WIDE);
    const refA = { accountId: 'wa-a', conversationId: 'c1' };
    const refB = { accountId: 'tg', conversationId: 't1' };
    state = reduce(state, { type: 'draft-set', key: conversationKey(refA), text: 'hello' }, ctxFor([]));
    state = reduce(state, { type: 'draft-set', key: conversationKey(refB), text: 'other' }, ctxFor([]));
    expect(state.drafts[conversationKey(refA)]).toBe('hello');
    state = reduce(state, { type: 'draft-clear', key: conversationKey(refA) }, ctxFor([]));
    expect(state.drafts[conversationKey(refA)]).toBeUndefined();
    expect(state.drafts[conversationKey(refB)]).toBe('other');
  });
});

describe('reducer: insert mode gating', () => {
  it('refuses insert mode without a selected conversation', () => {
    const state = initialState(WIDE);
    expect(reduce(state, { type: 'enter-insert-mode' }, ctxFor([])).mode).toBe('normal');
  });

  it('enters insert mode on the chat pane with a selection', () => {
    let state = reduce(initialState(WIDE), { type: 'select-conversation', ref: { accountId: 'wa-a', conversationId: 'c1' } }, ctxFor([]));
    state = reduce(state, { type: 'enter-insert-mode' }, ctxFor([]));
    expect(state.mode).toBe('insert');
    expect(state.focus).toBe('chat');
  });
});

describe('reducer: layout cycling and overlays', () => {
  it('cycles auto → three → two → one → auto', () => {
    let state = initialState(WIDE);
    expect(state.layoutPreference).toBe('auto');
    state = reduce(state, { type: 'cycle-layout' }, ctxFor([]));
    expect(state.layoutPreference).toBe('three');
    state = reduce(state, { type: 'cycle-layout' }, ctxFor([]));
    state = reduce(state, { type: 'cycle-layout' }, ctxFor([]));
    state = reduce(state, { type: 'cycle-layout' }, ctxFor([]));
    expect(state.layoutPreference).toBe('auto');
  });

  it('opens and closes overlays, leaving insert mode', () => {
    let state = reduce(initialState(WIDE), { type: 'select-conversation', ref: { accountId: 'wa-a', conversationId: 'c1' } }, ctxFor([]));
    state = reduce(state, { type: 'enter-insert-mode' }, ctxFor([]));
    state = reduce(state, { type: 'open-overlay', overlay: 'palette' }, ctxFor([]));
    expect(state.overlay).toBe('palette');
    expect(state.mode).toBe('normal');
    state = reduce(state, { type: 'close-overlay' }, ctxFor([]));
    expect(state.overlay).toBe('none');
  });
});

describe('windowSlice', () => {
  it('returns everything when it fits', () => {
    expect(windowSlice(5, 2, 10)).toEqual({ start: 0, end: 5 });
  });

  it('centers the selection inside the window', () => {
    const { start, end } = windowSlice(100, 50, 10);
    expect(end - start).toBe(10);
    expect(50).toBeGreaterThanOrEqual(start);
    expect(50).toBeLessThan(end);
  });

  it('clamps at both ends', () => {
    expect(windowSlice(100, 0, 10).start).toBe(0);
    expect(windowSlice(100, 99, 10).end).toBe(100);
  });

  it('degrades safely with zero capacity', () => {
    expect(windowSlice(100, 5, 0)).toEqual({ start: 0, end: 0 });
  });
});
