import React from 'react';
import { Box, Text } from 'ink';
import type { AccountConfig, AdapterStatus, Conversation } from '../../domain/types.js';
import { flattenRows, unreadForAccount, windowSlice } from '../../app/state.js';
import { ON_CHIP, PLATFORM_STYLE, statusGlyph, type Theme } from '../theme/colors.js';
import { truncate } from '../format.js';

interface ConversationTreeProps {
  theme: Theme;
  accounts: AccountConfig[];
  conversations: Conversation[];
  statuses: Record<string, AdapterStatus>;
  expanded: Record<string, boolean>;
  hiddenAccounts: Record<string, boolean>;
  selectedRow: number;
  focused: boolean;
  width: number;
  height: number;
}

/**
 * Left pane: collapsible account groups with platform chips and indented
 * conversations; unread/mention counts align on the right edge.
 */
export function ConversationTree({
  theme,
  accounts,
  conversations,
  statuses,
  expanded,
  hiddenAccounts,
  selectedRow,
  focused,
  width,
  height,
}: ConversationTreeProps) {
  const rows = flattenRows(accounts, conversations, expanded, hiddenAccounts);
  const capacity = Math.max(1, height - 2); // borders
  const { start, end } = windowSlice(rows.length, selectedRow, capacity);
  const visible = rows.slice(start, end);
  const innerWidth = width - 2;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={theme.borderStyle}
      borderColor={focused ? theme.colors.accent : theme.colors.dim}
    >
      <Text bold color={theme.colors.dim} wrap="truncate">
        ACCOUNTS & CONVERSATIONS
      </Text>
      {visible.map((row, offset) => {
        const index = start + offset;
        const selected = index === selectedRow && focused;
        if (row.type === 'account') {
          const account = accounts.find((a) => a.id === row.accountId);
          return (
            <AccountHeader
              key={`a:${row.accountId}`}
              theme={theme}
              account={account}
              status={statuses[row.accountId] ?? 'disconnected'}
              expanded={expanded[row.accountId] ?? true}
              unread={unreadForAccount(conversations, row.accountId)}
              selected={selected}
              width={innerWidth}
            />
          );
        }
        return (
          <ConversationRow
            key={`c:${row.accountId}/${row.conversation.id}`}
            theme={theme}
            conversation={row.conversation}
            selected={selected}
            width={innerWidth}
          />
        );
      })}
      {rows.length === 0 ? <Text color={theme.colors.dim}>No conversations.</Text> : null}
    </Box>
  );
}

interface AccountHeaderProps {
  theme: Theme;
  account?: AccountConfig;
  status: AdapterStatus;
  expanded: boolean;
  unread: number;
  selected: boolean;
  width: number;
}

function AccountHeader({
  theme,
  account,
  status,
  expanded,
  unread,
  selected,
  width,
}: AccountHeaderProps) {
  const chevron = expanded ? theme.glyphs.expanded : theme.glyphs.collapsed;
  const platform = PLATFORM_STYLE[account?.platform ?? ''] ?? { color: theme.colors.dim, letter: '?' };
  const labelWidth = Math.max(6, width - 10 - (unread > 0 ? 4 : 0));
  const label = truncate(account?.label ?? '?', labelWidth);
  const bg = selected ? theme.colors.selectedBg : undefined;
  return (
    <Box width="100%">
      <Text wrap="truncate" bold backgroundColor={bg} color={selected ? theme.colors.accent : theme.colors.text}>
        {selected ? theme.glyphs.selected : ' '}
        {chevron}{' '}
        <Text backgroundColor={selected ? bg : platform.color} color={ON_CHIP}>
          {` ${platform.letter} `}
        </Text>{' '}
        {label}{' '}
        <Text color={statusColor(theme, status)}>{statusGlyph(theme, status)}</Text>
      </Text>
      <Box flexGrow={1} />
      {unread > 0 ? (
        <Text backgroundColor={bg} color={theme.colors.warn} bold>
          {unread}
        </Text>
      ) : null}
    </Box>
  );
}

function ConversationRow({
  theme,
  conversation,
  selected,
  width,
}: {
  theme: Theme;
  conversation: Conversation;
  selected: boolean;
  width: number;
}) {
  const hasCounts = conversation.unread > 0 || (conversation.mentions ?? 0) > 0;
  // marker(2) + indent(2) + bullet+space(2) + counts(<=7)
  const titleWidth = Math.max(6, width - 6 - (hasCounts ? 7 : 0));
  const title = truncate(conversation.title, titleWidth);
  const bg = selected ? theme.colors.selectedBg : undefined;
  return (
    <Box width="100%">
      <Text
        wrap="truncate"
        bold={conversation.unread > 0 || selected}
        dimColor={conversation.muted === true}
        color={selected ? theme.colors.accent : undefined}
        backgroundColor={bg}
      >
        {selected ? theme.glyphs.selected : ' '}{'  '}
        <Text color={theme.colors.dim}>{theme.kindLabel[conversation.kind ?? 'unknown']}</Text>{' '}
        {title}
      </Text>
      <Box flexGrow={1} />
      {conversation.mentions !== undefined && conversation.mentions > 0 ? (
        <Text backgroundColor={bg} color={theme.colors.mention}>
          @{conversation.mentions}{' '}
        </Text>
      ) : null}
      {conversation.unread > 0 ? (
        <Text
          backgroundColor={bg}
          bold
          color={conversation.muted === true ? theme.colors.dim : theme.colors.warn}
        >
          {conversation.unread}
        </Text>
      ) : null}
    </Box>
  );
}

function statusColor(theme: Theme, status: AdapterStatus): string {
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
