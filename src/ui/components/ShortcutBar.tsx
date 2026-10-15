import React from 'react';
import { Box, Text } from 'ink';
import type { InputMode, OverlayKind } from '../../app/state.js';
import type { Theme } from '../theme/colors.js';

interface ShortcutBarProps {
  theme: Theme;
  mode: InputMode;
  overlay: OverlayKind;
  /** Badge of the account holding the current selection, if any. */
  accountBadge?: string;
  hasConversation: boolean;
  /** An account is waiting for an auth challenge response. */
  authPending: boolean;
  width: number;
}

interface Hint {
  keys: string;
  label: string;
}

function hintsFor(mode: InputMode, overlay: OverlayKind, hasConversation: boolean): Hint[] {
  if (overlay !== 'none') {
    return [
      { keys: 'Esc', label: 'Close' },
      { keys: 'Enter', label: 'Confirm' },
      { keys: '↑/↓', label: 'Select' },
    ];
  }
  if (mode === 'insert') {
    return [
      { keys: 'Enter', label: 'Send' },
      { keys: 'Esc', label: 'Done' },
    ];
  }
  const base: Hint[] = [
    { keys: 'j/k', label: 'Navigate' },
    { keys: 'Enter', label: 'Open' },
    { keys: 'Tab', label: 'Next Pane' },
    { keys: '/', label: 'Search' },
    { keys: 'Ctrl+P', label: 'Commands' },
    { keys: 'Ctrl+N', label: 'Unread' },
  ];
  if (hasConversation) base.splice(4, 0, { keys: 'i', label: 'Write' });
  base.push({ keys: '?', label: 'Help' }, { keys: 'Ctrl+Q', label: 'Quit' });
  return base;
}

/** Bottom bar, styled after the reference: cyan keys, dim separators. */
export function ShortcutBar({ theme, mode, overlay, accountBadge, hasConversation, authPending, width }: ShortcutBarProps) {
  const all = hintsFor(mode, overlay, hasConversation);
  if (authPending && mode !== 'insert' && overlay === 'none') {
    all.splice(3, 0, { keys: 'a', label: 'Authenticate' });
  }
  // Hints are dropped from the tail until they fit; the reference layout
  // keeps the full set at >=120 columns. The right label is never truncated.
  const rightLabel = `${accountBadge ?? '—'} | ${mode === 'insert' ? 'INSERT' : 'NORMAL'}`;
  let budget = Math.max(0, width - 2 - rightLabel.length - 3);
  const hints: Hint[] = [];
  for (const hint of all) {
    const text = `${hint.keys} ${hint.label}`;
    const cost = text.length + (hints.length === 0 ? 0 : 3);
    if (cost > budget) break;
    budget -= cost;
    hints.push(hint);
  }
  return (
    <Box justifyContent="space-between" paddingX={1} height={1}>
      <Text wrap="truncate">
        {hints.flatMap((hint, i) => [
          <Text key={`k${i}`} color={theme.colors.accent} bold>
            {i === 0 ? '' : ' | '}
            {hint.keys}
            <Text color={theme.colors.dim}> {hint.label}</Text>
          </Text>,
        ])}
      </Text>
      <Text color={theme.colors.accent} wrap="truncate">
        {rightLabel}
      </Text>
    </Box>
  );
}
