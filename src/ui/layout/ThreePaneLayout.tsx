import React from 'react';
import { Box } from 'ink';
import type { AccountConfig, AdapterStatus, Conversation, Message } from '../../domain/types.js';
import type { EffectiveLayout, FocusPane, InputMode } from '../../app/state.js';
import type { Theme } from '../theme/colors.js';
import { ConversationTree } from './ConversationTree.js';
import { MessageNavigator } from './MessageNavigator.js';
import { ActiveConversation } from './ActiveConversation.js';

/** All rendering data the panes need, bundled so the layout stays declarative. */
export interface PaneData {
  accounts: AccountConfig[];
  conversations: Conversation[];
  statuses: Record<string, AdapterStatus>;
  expanded: Record<string, boolean>;
  hiddenAccounts: Record<string, boolean>;
  selectedRow: number;
  selectedConversation?: Conversation;
  selectedAccount?: AccountConfig;
  messages: Message[];
  selectedMessage: number;
  mode: InputMode;
  draft: string;
  canSendText: boolean;
  canSendAttachments: boolean;
}

interface ThreePaneLayoutProps {
  theme: Theme;
  layout: EffectiveLayout;
  focus: FocusPane;
  width: number;
  height: number;
  panes: PaneData;
}

const LEFT_WIDTH_THREE = 30;
const MIDDLE_WIDTH = 34;
const LEFT_WIDTH_TWO = 40;

/**
 * Arranges panes for the current width: three columns when wide, two when
 * narrower, one in compact mode. Borders are always visible separators;
 * the focused pane is drawn with an accent border.
 */
export function ThreePaneLayout({ theme, layout, focus, width, height, panes }: ThreePaneLayoutProps) {
  if (layout === 'one') {
    const paneWidth = width;
    return (
      <Box height={height}>
        {focus === 'conversations' ? (
          <ConversationTree
            theme={theme}
            accounts={panes.accounts}
            conversations={panes.conversations}
            statuses={panes.statuses}
            expanded={panes.expanded}
            hiddenAccounts={panes.hiddenAccounts}
            selectedRow={panes.selectedRow}
            focused
            width={paneWidth}
            height={height}
          />
        ) : (
          <ActiveConversation
            theme={theme}
            conversation={panes.selectedConversation}
            account={panes.selectedAccount}
            messages={panes.messages}
            focused
            mode={panes.mode}
            draft={panes.draft}
            canSendText={panes.canSendText}
            canSendAttachments={panes.canSendAttachments}
            width={paneWidth}
            height={height}
          />
        )}
      </Box>
    );
  }

  if (layout === 'two') {
    const rightWidth = Math.max(10, width - LEFT_WIDTH_TWO);
    return (
      <Box height={height}>
        <ConversationTree
          theme={theme}
          accounts={panes.accounts}
          conversations={panes.conversations}
          statuses={panes.statuses}
          expanded={panes.expanded}
          hiddenAccounts={panes.hiddenAccounts}
          selectedRow={panes.selectedRow}
          focused={focus === 'conversations'}
          width={LEFT_WIDTH_TWO}
          height={height}
        />
        <ActiveConversation
          theme={theme}
          conversation={panes.selectedConversation}
          account={panes.selectedAccount}
          messages={panes.messages}
          focused={focus === 'chat'}
          mode={panes.mode}
          draft={panes.draft}
          canSendText={panes.canSendText}
          canSendAttachments={panes.canSendAttachments}
          width={rightWidth}
          height={height}
        />
      </Box>
    );
  }

  const rightWidth = Math.max(10, width - LEFT_WIDTH_THREE - MIDDLE_WIDTH);
  return (
    <Box height={height}>
      <ConversationTree
        theme={theme}
        accounts={panes.accounts}
        conversations={panes.conversations}
        statuses={panes.statuses}
        expanded={panes.expanded}
        hiddenAccounts={panes.hiddenAccounts}
        selectedRow={panes.selectedRow}
        focused={focus === 'conversations'}
        width={LEFT_WIDTH_THREE}
        height={height}
      />
      <MessageNavigator
        theme={theme}
        title={panes.selectedConversation?.title}
        messages={panes.messages}
        unread={panes.selectedConversation?.unread ?? 0}
        selectedMessage={panes.selectedMessage}
        focused={focus === 'navigator'}
        width={MIDDLE_WIDTH}
        height={height}
      />
      <ActiveConversation
        theme={theme}
        conversation={panes.selectedConversation}
        account={panes.selectedAccount}
        messages={panes.messages}
        focused={focus === 'chat'}
        mode={panes.mode}
        draft={panes.draft}
        canSendText={panes.canSendText}
        canSendAttachments={panes.canSendAttachments}
        width={rightWidth}
        height={height}
      />
    </Box>
  );
}
