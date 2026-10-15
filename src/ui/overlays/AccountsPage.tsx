import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AccountConfig, AdapterStatus, AdapterTransport } from '../../domain/types.js';
import { ON_CHIP, PLATFORM_STYLE, statusGlyph, type Theme } from '../theme/colors.js';
import { truncate } from '../format.js';

/**
 * Full-page account management: list configured accounts, jump to the
 * dedicated Add account page (`a`), remove custom accounts (wiping their
 * session data, per the security rules), and reconnect on demand.
 * Custom accounts persist across restarts (SQLite).
 */

export interface AccountRow {
  config: AccountConfig;
  status: AdapterStatus;
  /** 'builtin' accounts come from static config; 'custom' from the DB. */
  origin: 'builtin' | 'custom';
  impl: AdapterTransport;
}

export interface AccountsPageProps {
  theme: Theme;
  height: number;
  rows: AccountRow[];
  /** Opens the dedicated Add account page (provider -> name -> review). */
  onOpenAdd: () => void;
  onRemove: (accountId: string) => void;
  onReconnect: (accountId: string) => void;
  onClose: () => void;
}

type PageView =
  | { kind: 'list' }
  | { kind: 'confirm-remove'; row: AccountRow };

export function AccountsPage({
  theme,
  height,
  rows,
  onOpenAdd,
  onRemove,
  onReconnect,
  onClose,
}: AccountsPageProps) {
  const [view, setView] = useState<PageView>({ kind: 'list' });
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (view.kind === 'list') {
      if (key.escape) return onClose();
      if (input === 'j' || key.downArrow) return setSelected((p) => Math.min(rows.length - 1, p + 1));
      if (input === 'k' || key.upArrow) return setSelected((p) => Math.max(0, p - 1));
      if (input === 'a') return onOpenAdd();
      if (input === 'r') {
        const row = rows[selected];
        if (row) return onReconnect(row.config.id);
      }
      if (input === 'd') {
        const row = rows[selected];
        if (!row) return;
        if (row.origin !== 'custom') return; // builtins can be hidden, not removed
        return setView({ kind: 'confirm-remove', row });
      }
      return;
    }
    if (view.kind === 'confirm-remove') {
      if (input === 'd') {
        onRemove(view.row.config.id);
        return setView({ kind: 'list' });
      }
      return setView({ kind: 'list' }); // any other key cancels
    }
    return undefined;
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
        Accounts
      </Text>
      {view.kind === 'list' ? (
        <Box flexDirection="column">
          {rows.map((row, index) => {
            const style = PLATFORM_STYLE[row.config.platform] ?? { color: theme.colors.dim, letter: '?' };
            return (
              <Text
                key={row.config.id}
                wrap="truncate"
                backgroundColor={index === selected ? theme.colors.selectedBg : undefined}
                color={index === selected ? theme.colors.accent : undefined}
              >
                {index === selected ? theme.glyphs.selected : ' '}{' '}
                <Text backgroundColor={style.color} color={ON_CHIP} bold>{` ${style.letter} `}</Text>{' '}
                <Text bold>{truncate(row.config.label, 24)}</Text>
                <Text color={theme.colors.dim}>
                  {' '}({row.config.badge}) · {row.origin} · {row.impl}
                </Text>
                <Text color={statusColor(theme, row.status)}> {statusGlyph(theme, row.status)} {row.status}</Text>
              </Text>
            );
          })}
          <Text color={theme.colors.dim}> </Text>
          <Text color={theme.colors.dim}>
            a add account · d remove (custom only, wipes its data) · r reconnect · Esc close
          </Text>
        </Box>
      ) : view.kind === 'confirm-remove' ? (
        <Box flexDirection="column">
          <Text color={theme.colors.warn} bold>
            Remove {view.row.config.label}?
          </Text>
          <Text color={theme.colors.text}>
            Its adapter will be disconnected and its session data under its own
            directory will be deleted.
          </Text>
          <Text color={theme.colors.dim}>press d again to confirm · any other key to cancel</Text>
        </Box>
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