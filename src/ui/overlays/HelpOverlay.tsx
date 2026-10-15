import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../theme/colors.js';

const SHORTCUTS: Array<[string, string]> = [
  ['Tab / Shift+Tab', 'Focus next / previous pane'],
  ['j / k', 'Move selection down / up'],
  ['h / l', 'Focus previous / next pane'],
  ['Enter', 'Open conversation or start composer'],
  ['Esc', 'Cancel, close overlay, or leave composer'],
  ['g', 'Toggle expand/collapse of the selected account'],
  ['i', 'Write a message in the open conversation'],
  ['c', 'Start a new conversation (phone, @username, DM, invite link)'],
  ['a', 'Authenticate an account (QR scan / 2FA password)'],
  ['A', 'Accounts page — manage, reconnect, remove'],
  ['A → a', 'Add account page — provider → name → review'],
  ['/', "Search (at the composer it starts a '/' message)"],
  ['Ctrl+P', 'Open command palette'],
  ['Ctrl+N', 'Jump to next unread conversation'],
  ['Ctrl+R', 'Mark current conversation as read'],
  ['Ctrl+Q / Ctrl+C', 'Quit'],
  ['?', 'This help'],
];

export function HelpOverlay({ theme, height, onClose }: { theme: Theme; height: number; onClose: () => void }) {
  useInput((input, key) => {
    if (key.escape || input === '?' || input === 'q') onClose();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.colors.accent}
      height={height}
      paddingX={2}
    >
      <Text bold color={theme.colors.accent}>
        Keyboard shortcuts
      </Text>
      {SHORTCUTS.map(([keys, action]) => (
        <Text key={keys}>
          <Text color={theme.colors.text}>{keys.padEnd(20)}</Text>
          <Text color={theme.colors.dim}>{action}</Text>
        </Text>
      ))}
      <Text color={theme.colors.dim}>Esc to close</Text>
    </Box>
  );
}
