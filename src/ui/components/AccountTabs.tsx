import React from 'react';
import { Box, Text } from 'ink';
import type { AccountConfig, AdapterStatus } from '../../domain/types.js';
import { ON_CHIP, PLATFORM_STYLE, statusGlyph, type Theme } from '../theme/colors.js';

interface AccountTabsProps {
  theme: Theme;
  accounts: AccountConfig[];
  statuses: Record<string, AdapterStatus>;
  /** Badge of the account the left-pane selection is currently on. */
  activeAccountId?: string;
  hiddenAccounts: Record<string, boolean>;
}

function tabColor(theme: Theme, status: AdapterStatus): string {
  switch (status) {
    case 'connected':
      return theme.colors.ok;
    case 'connecting':
      return theme.colors.warn;
    case 'error':
      return theme.colors.error;
    default:
      return theme.colors.dim;
  }
}

/** Horizontal account switcher with one tab per configured account. */
export function AccountTabs({
  theme,
  accounts,
  statuses,
  activeAccountId,
  hiddenAccounts,
}: AccountTabsProps) {
  return (
    <Box paddingX={1} columnGap={1}>
      {accounts.map((account) => {
        const status = statuses[account.id] ?? 'disconnected';
        const hidden = hiddenAccounts[account.id] === true;
        const active = account.id === activeAccountId;
        const platform = PLATFORM_STYLE[account.platform] ?? {
          color: theme.colors.dim,
          letter: '?',
        };
        return (
          <Text
            key={account.id}
            bold={active}
            backgroundColor={active ? theme.colors.selectedBg : undefined}
            color={active ? theme.colors.text : tabColor(theme, status)}
          >
            {' '}
            <Text backgroundColor={active ? undefined : platform.color} color={ON_CHIP} bold>
              {` ${platform.letter} `}
            </Text>{' '}
            {account.badge} {statusGlyph(theme, status)}
            {hidden ? ' (hidden)' : ''}{' '}
          </Text>
        );
      })}
    </Box>
  );
}
