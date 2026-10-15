import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '../../domain/types.js';
import { windowSlice } from '../../app/state.js';
import type { Theme } from '../theme/colors.js';
import { formatClock, initials, truncate } from '../format.js';

interface MessageNavigatorProps {
  theme: Theme;
  title?: string;
  messages: Message[];
  unread: number;
  selectedMessage: number;
  focused: boolean;
  width: number;
  height: number;
}

/**
 * Middle pane: two-line rows (sender + time, then a dim preview) with a
 * compact initial chip per message, mirroring the reference design.
 * Scrolls independently of the other panes.
 */
export function MessageNavigator({
  theme,
  title,
  messages,
  unread,
  selectedMessage,
  focused,
  width,
  height,
}: MessageNavigatorProps) {
  const rowHeight = 2;
  const visibleCount = Math.max(1, Math.floor((height - 3) / rowHeight)); // borders + title
  const { start, end } = windowSlice(messages.length, selectedMessage, visibleCount);
  const visible = messages.slice(start, end);
  const firstUnread = messages.length - unread;
  const nameWidth = Math.max(6, width - 16);
  const previewWidth = Math.max(6, width - 8);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={theme.borderStyle}
      borderColor={focused ? theme.colors.accent : theme.colors.dim}
    >
      <Text bold color={theme.colors.dim} wrap="truncate">
        MESSAGES{title ? ` (${truncate(title, 18)})` : ''}
      </Text>
      {visible.length === 0 ? (
        <Text color={theme.colors.dim}>Select a conversation.</Text>
      ) : (
        visible.map((message, offset) => {
          const index = start + offset;
          const selected = index === selectedMessage && focused;
          const isUnread = index >= firstUnread;
          const sender =
            message.direction === 'outgoing' ? 'You' : (message.sender ?? 'them');
          const bg = selected ? theme.colors.selectedBg : undefined;
          return (
            <Box key={message.id} flexDirection="column">
              <Text wrap="truncate" backgroundColor={bg}>
                {selected ? theme.glyphs.selected : ' '}
                <Text backgroundColor={selected ? bg : theme.colors.avatarBg} color={theme.colors.text} bold>
                  {` ${initials(sender)[0] ?? '?'} `}
                </Text>
                <Text bold color={selected ? theme.colors.accent : theme.colors.text}>
                  {' '}
                  {truncate(sender, nameWidth)}
                </Text>
                <Text color={theme.colors.dim}> {formatClock(message.timestamp)}</Text>
                {isUnread ? <Text color={theme.colors.warn}> {theme.glyphs.unreadBullet}</Text> : null}
              </Text>
              <Text wrap="truncate" backgroundColor={bg} color={theme.colors.dim}>
                {'     '}
                {truncate(message.text, previewWidth)}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
