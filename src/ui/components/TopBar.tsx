import React from 'react';
import { Box, Text } from 'ink';
import { VERSION, DEMO_TAGLINE } from '../../core/version.js';
import type { Theme } from '../theme/colors.js';

interface TopBarProps {
  theme: Theme;
  mode: 'demo' | 'real';
  connected: number;
  total: number;
  unread: number;
  /** Pre-formatted clock string, e.g. "14:03". */
  clock: string;
}

/** Single-line top bar: identity and global state, per the visual spec. */
export function TopBar({ theme, mode, connected, total, unread, clock }: TopBarProps) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text bold color={theme.colors.accent}>
        chatty v{VERSION}
        {mode === 'demo' ? <Text color={theme.colors.dim}> ({DEMO_TAGLINE})</Text> : null}
      </Text>
      <Text color={theme.colors.dim}>
        {clock} | {connected}/{total} connected | Unread: {unread}
      </Text>
    </Box>
  );
}
