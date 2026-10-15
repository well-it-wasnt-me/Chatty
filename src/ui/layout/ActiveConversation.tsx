import React from 'react';
import { Box, Text } from 'ink';
import type { AccountConfig, Conversation, DeliveryState, Message } from '../../domain/types.js';
import type { InputMode } from '../../app/state.js';
import type { Theme } from '../theme/colors.js';
import { formatClock, initials, wrapText } from '../format.js';

interface ActiveConversationProps {
  theme: Theme;
  conversation?: Conversation;
  account?: AccountConfig;
  messages: Message[];
  focused: boolean;
  mode: InputMode;
  draft: string;
  canSendText: boolean;
  canSendAttachments: boolean;
  width: number;
  height: number;
}

/** Rows occupied by the header and the composer box inside the pane. */
const CHROME_HEIGHT = 2 /* borders */ + 1 /* header */ + 3 /* composer */;

/**
 * Right pane: chat bubbles (incoming left on slate, outgoing right on blue,
 * per the reference design) with a bordered composer pinned to the bottom.
 */
export function ActiveConversation({
  theme,
  conversation,
  account,
  messages,
  focused,
  mode,
  draft,
  canSendText,
  canSendAttachments,
  width,
  height,
}: ActiveConversationProps) {
  const capacity = Math.max(1, height - CHROME_HEIGHT);
  const wrapWidth = bubbleWrapWidth(width);

  // Fill from the newest message backwards until the pane is full.
  const visible: Message[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = bubbleHeight(messages[i], wrapWidth);
    if (used + block > capacity) break;
    used += block;
    visible.unshift(messages[i]);
  }

  const title = conversation?.title ?? 'ACTIVE CHAT';
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={theme.borderStyle}
      borderColor={focused ? theme.colors.accent : theme.colors.dim}
    >
      <Text bold color={theme.colors.accent} wrap="truncate">
        {title.toUpperCase()}
        {account ? ` (${account.label})` : ''}
      </Text>
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
        {visible.map((message) => (
          <MessageBubble key={message.id} theme={theme} message={message} wrapWidth={wrapWidth} />
        ))}
        {conversation === undefined ? (
          <Text color={theme.colors.dim}>Nothing selected.</Text>
        ) : null}
      </Box>
      <Composer
        theme={theme}
        mode={mode}
        draft={draft}
        canSendText={canSendText}
        canSendAttachments={canSendAttachments}
        hasConversation={conversation !== undefined}
      />
    </Box>
  );
}

function bubbleWrapWidth(paneWidth: number): number {
  return Math.max(14, Math.min(56, paneWidth - 16));
}

/** Rendered height of one message bubble including the gap after it. */
function bubbleHeight(message: Message, wrapWidth: number): number {
  return wrapText(message.text, wrapWidth - 2).length + 2 /* label + time */ + 1 /* gap */;
}

function MessageBubble({
  theme,
  message,
  wrapWidth,
}: {
  theme: Theme;
  message: Message;
  wrapWidth: number;
}) {
  const outgoing = message.direction === 'outgoing';
  const bodyLines = wrapText(message.text, wrapWidth - 2).map((l) => l.trimEnd());
  const sender = outgoing ? 'You' : (message.sender ?? 'them');
  const timeLine = `${formatClock(message.timestamp)}${deliverySuffix(theme, message.state)}`;

  // Bubble hugs content, with one space of padding on each side.
  const contentWidth = Math.max(
    sender.length,
    timeLine.length,
    ...bodyLines.map((l) => l.length),
  );
  const inner = contentWidth + 2;
  const bg = outgoing ? theme.colors.bubbleOut : theme.colors.bubbleIn;

  const line = (text: string): string => ` ${text}`.padEnd(inner, ' ');
  const rightLine = (text: string): string => `${text.padStart(inner - 1, ' ')} `;

  const bubble = (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor={bg} color={outgoing ? '#BFDBFE' : theme.colors.ok} bold>
        {line(sender)}
      </Text>
      {bodyLines.map((text, i) => (
        <Text key={i} backgroundColor={bg} color={theme.colors.text}>
          {line(text)}
        </Text>
      ))}
      <Text backgroundColor={bg} color={theme.colors.dim}>
        {rightLine(timeLine)}
      </Text>
    </Box>
  );

  return (
    <Box justifyContent={outgoing ? 'flex-end' : 'flex-start'}>
      {outgoing ? (
        bubble
      ) : (
        <>
          <Box marginRight={1} flexDirection="column" justifyContent="flex-start">
            <Text backgroundColor={theme.colors.avatarBg} color={theme.colors.text} bold>
              {` ${initials(sender)[0] ?? '?'} `}
            </Text>
          </Box>
          {bubble}
        </>
      )}
    </Box>
  );
}

function deliverySuffix(theme: Theme, state: DeliveryState | undefined): string {
  if (state === undefined) return '';
  return ` ${theme.deliveryLabel[state]}`;
}

interface ComposerProps {
  theme: Theme;
  mode: InputMode;
  draft: string;
  canSendText: boolean;
  canSendAttachments: boolean;
  hasConversation: boolean;
}

function Composer({
  theme,
  mode,
  draft,
  canSendText,
  canSendAttachments,
  hasConversation,
}: ComposerProps) {
  if (!hasConversation) return <Text color={theme.colors.dim}> </Text>;
  const attachmentSlot = canSendAttachments ? ' [+]' : '';
  return (
    <Box
      borderStyle={theme.borderStyle}
      borderColor={mode === 'insert' ? theme.colors.accent : theme.colors.composerBorder}
      height={3}
      paddingX={1}
      width="100%"
    >
      {!canSendText ? (
        <Text color={theme.colors.dim} wrap="truncate">
          read-only: this platform does not support sending
        </Text>
      ) : mode === 'insert' ? (
        <Box width="100%">
          <Text wrap="truncate">
            {draft === '' ? (
              <Text color={theme.colors.dim}>Type a message…</Text>
            ) : (
              <Text color={theme.colors.text}>{draft}</Text>
            )}
            <Text color={theme.colors.ok}>{theme.glyphs.composerCursor}</Text>
          </Text>
          <Box flexGrow={1} />
          {attachmentSlot !== '' ? <Text color={theme.colors.dim}>{attachmentSlot}</Text> : null}
        </Box>
      ) : (
        <Box width="100%">
          <Text color={theme.colors.dim} wrap="truncate">
            Type a message… (i to start, Enter to edit later)
          </Text>
          <Box flexGrow={1} />
          {attachmentSlot !== '' ? <Text color={theme.colors.dim}>{attachmentSlot}</Text> : null}
        </Box>
      )}
    </Box>
  );
}
