import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  AccountConfig,
  AdapterStatus,
  Conversation,
} from '../../domain/types.js';
import { ON_CHIP, PLATFORM_STYLE, type Theme } from '../theme/colors.js';

/**
 * "Start a new conversation" page. The flow is platform-honest:
 * - WhatsApp: enter a phone number (the chat materializes on first send).
 * - Telegram: enter a @username (or a contact's phone number).
 * - Slack: pick a workspace member (users.list + conversations.open).
 * - SimpleX: share your own invitation link (with QR) or accept a
 *   contact's invitation link.
 *
 * After a successful start, App selects the conversation and focuses the
 * composer so the first message can be typed right away.
 */

export interface NewConversationOverlayProps {
  theme: Theme;
  height: number;
  /** Accounts whose adapter declared canStartConversations. */
  accounts: AccountConfig[];
  statuses: Record<string, AdapterStatus>;
  /** Account to preselect (the one the user is looking at). */
  preselectedAccountId?: string;
  onStart: (accountId: string, target: string) => Promise<Conversation>;
  onListTargets: (accountId: string) => Promise<Array<{ id: string; title: string }>>;
  onConnectionLink: (accountId: string) => Promise<{ link: string; qrLines: string[] }>;
  /** Called once the conversation exists; App selects it and focuses chat. */
  onStarted: (conversation: Conversation) => void;
  onClose: () => void;
}

type View =
  | { kind: 'account' }
  | { kind: 'input'; accountId: string }
  | { kind: 'targets'; accountId: string }
  | { kind: 'simplex'; accountId: string }
  | { kind: 'link'; accountId: string };

interface PlatformFlow {
  kind: 'input' | 'targets' | 'simplex';
  prompt: string;
  placeholder: string;
}

/** What "start a chat" means on each platform, honestly. */
const PLATFORM_FLOW: Record<AccountConfig['platform'], PlatformFlow> = {
  whatsapp: {
    kind: 'input',
    prompt: 'WhatsApp phone number (international format)',
    placeholder: '+15551234567',
  },
  telegram: {
    kind: 'input',
    prompt: "Telegram @username (or a contact's phone number)",
    placeholder: '@username',
  },
  slack: {
    kind: 'targets',
    prompt: 'Pick a workspace member to message',
    placeholder: '',
  },
  simplex: {
    kind: 'simplex',
    prompt: 'SimpleX connects via one-time invitation links',
    placeholder: 'https://... - the invitation link your contact shared',
  },
};

/** Placeholder for free-text inputs that are not phone/username shaped. */
const SIMPLEX_ACCEPT_PLACEHOLDER = 'https://... - the invitation link your contact shared';

const MAX_QR_WIDTH = 41;

export function NewConversationOverlay({
  theme,
  height,
  accounts,
  statuses,
  preselectedAccountId,
  onStart,
  onListTargets,
  onConnectionLink,
  onStarted,
  onClose,
}: NewConversationOverlayProps) {
  const preselected = preselectedAccountId ?? accounts[0]?.id;
  const [view, setView] = useState<View>({ kind: 'account' });
  const [accountIndex, setAccountIndex] = useState(() =>
    Math.max(0, accounts.findIndex((a) => a.id === preselected)),
  );
  const [input, setInput] = useState('');
  const [targets, setTargets] = useState<Array<{ id: string; title: string }>>([]);
  const [optionIndex, setOptionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; qrLines: string[] } | null>(null);

  const account = accounts[accountIndex];
  const flow = account ? PLATFORM_FLOW[account.platform] : undefined;

  const loadTargets = useMemo(
    () => (accountId: string) => {
      setBusy(true);
      setError(null);
      onListTargets(accountId)
        .then((list) => {
          setTargets(list);
          setOptionIndex(0);
          setBusy(false);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
        });
    },
    [onListTargets],
  );

  // Slack: fetch the pickable members when entering its flow.
  useEffect(() => {
    if (view.kind === 'targets' && view.accountId) loadTargets(view.accountId);
  }, [view, loadTargets]);

  const submit = (target: string): void => {
    if (!account || view.kind === 'account' || view.kind === 'link') return;
    const accountId = account.id;
    setBusy(true);
    setError(null);
    onStart(accountId, target)
      .then((conversation) => {
        setBusy(false);
        onStarted(conversation);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      });
  };

  const showConnectionLink = (): void => {
    if (!account) return;
    setBusy(true);
    setError(null);
    onConnectionLink(account.id)
      .then((result) => {
        setLink(result);
        setBusy(false);
        setView({ kind: 'link', accountId: account.id });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
      });
  };

  useInput((typed, key) => {
    if (busy) return;
    if (view.kind === 'account') {
      if (key.escape) return onClose();
      if (typed === 'j' || key.downArrow) {
        return setAccountIndex((p) => Math.min(accounts.length - 1, p + 1));
      }
      if (typed === 'k' || key.upArrow) return setAccountIndex((p) => Math.max(0, p - 1));
      if (key.return && account && flow) {
        setOptionIndex(0);
        if (flow.kind === 'targets') return setView({ kind: 'targets', accountId: account.id });
        if (flow.kind === 'simplex') return setView({ kind: 'simplex', accountId: account.id });
        setInput('');
        setError(null);
        return setView({ kind: 'input', accountId: account.id });
      }
      return;
    }
    if (view.kind === 'link') {
      if (key.escape) return setView({ kind: 'simplex', accountId: view.accountId });
      if (typed === 'q' || typed === 'Q') return onClose();
      return;
    }
    if (view.kind === 'simplex') {
      if (key.escape) return setView({ kind: 'account' });
      if (typed === 'j' || key.downArrow) return setOptionIndex((p) => Math.min(1, p + 1));
      if (typed === 'k' || key.upArrow) return setOptionIndex((p) => Math.max(0, p - 1));
      if (key.return) {
        if (optionIndex === 0) return showConnectionLink();
        setInput('');
        setError(null);
        return setView({ kind: 'input', accountId: view.accountId });
      }
      return;
    }
    if (view.kind === 'targets') {
      if (key.escape) return setView({ kind: 'account' });
      if (typed === 'j' || key.downArrow) {
        return setOptionIndex((p) => Math.min(targets.length - 1, p + 1));
      }
      if (typed === 'k' || key.upArrow) return setOptionIndex((p) => Math.max(0, p - 1));
      if (key.return && targets[optionIndex]) return submit(targets[optionIndex].id);
      return;
    }
    // input view
    if (key.escape) {
      return setView(
        account && account.platform === 'simplex'
          ? { kind: 'simplex', accountId: view.accountId }
          : { kind: 'account' },
      );
    }
    if (key.return) {
      const trimmed = input.trim();
      if (trimmed === '') return;
      return submit(trimmed);
    }
    if (key.backspace || key.delete) return setInput((p) => p.slice(0, -1));
    if (typed.length > 0 && !key.ctrl && !key.meta) {
      // Control bytes from pastes become spaces; links stay one line.
      // eslint-disable-next-line no-control-regex
      return setInput((p) => p + typed.replace(/[\x00-\x1f]/g, ' '));
    }
  });

  const platformStyle = (platform: AccountConfig['platform']) =>
    PLATFORM_STYLE[platform] ?? { color: theme.colors.dim, letter: '?' };

  const titleOfView =
    view.kind === 'account'
      ? 'step 1/2 — account'
      : view.kind === 'link'
        ? 'your invitation link — share it'
        : 'step 2/2 — new chat';

  const placeholder =
    account && account.platform === 'simplex' ? SIMPLEX_ACCEPT_PLACEHOLDER : (flow?.placeholder ?? '');

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.colors.accent}
      height={height}
      paddingX={2}
    >
      <Text bold color={theme.colors.accent}>
        New conversation <Text color={theme.colors.dim}>· {titleOfView}</Text>
      </Text>
      <Text color={theme.colors.dim}> </Text>

      {view.kind === 'account' ? (
        accounts.length === 0 ? (
          <>
            <Text color={theme.colors.text}>
              No account can start new conversations yet (connect one first).
            </Text>
            <Text color={theme.colors.dim}> </Text>
            <Text color={theme.colors.dim}>Esc close</Text>
          </>
        ) : (
          <>
            {accounts.map((a, index) => {
              const style = platformStyle(a.platform);
              const status = statuses[a.id] ?? 'disconnected';
              return (
                <Text
                  key={a.id}
                  wrap="truncate"
                  backgroundColor={index === accountIndex ? theme.colors.selectedBg : undefined}
                  color={index === accountIndex ? theme.colors.accent : theme.colors.text}
                >
                  {index === accountIndex ? theme.glyphs.selected : ' '}{' '}
                  <Text backgroundColor={style.color} color={ON_CHIP} bold>{` ${style.letter} `}</Text>{' '}
                  {a.label}
                  <Text color={theme.colors.dim}>
                    {' '}
                    {statusGlyph(theme, status)} {status}
                  </Text>
                </Text>
              );
            })}
            <Text color={theme.colors.dim}> </Text>
            <Text color={theme.colors.dim}>Enter continue · Esc close</Text>
          </>
        )
      ) : view.kind === 'link' ? (
        <Box flexDirection="column">
          {link ? (
            <>
              <Text color={theme.colors.text}>Share this one-time invitation link:</Text>
              <Text color={theme.colors.accent} wrap="wrap">
                {link.link}
              </Text>
              <Text color={theme.colors.dim}> </Text>
              {link.qrLines.slice(0, Math.max(0, height - 10)).map((line, index) => (
                <Text key={index} wrap="truncate">
                  {line.slice(0, MAX_QR_WIDTH)}
                </Text>
              ))}
              <Text color={theme.colors.dim}> </Text>
              <Text color={theme.colors.dim}>
                The chat appears in chatty once the contact connects with it.
              </Text>
              <Text color={theme.colors.dim}>Esc back · q close</Text>
            </>
          ) : (
            <Text color={theme.colors.text}>loading…</Text>
          )}
        </Box>
      ) : account && flow ? (
        <Box flexDirection="column">
          <Text bold color={theme.colors.text}>
            {account.platform === 'simplex' && view.kind === 'input'
              ? 'Paste the invitation link you received'
              : flow.prompt}
          </Text>
          <Text color={theme.colors.dim}>
            via {account.label} ({account.badge})
          </Text>
          {view.kind === 'simplex' ? (
            <>
              <Text color={theme.colors.dim}> </Text>
              {(
                [
                  { index: 0, text: 'Share my invitation link (they connect to you)' },
                  { index: 1, text: 'Accept an invitation link (you connect to them)' },
                ] as const
              ).map(({ index, text }) => (
                <Text
                  key={index}
                  wrap="truncate"
                  backgroundColor={optionIndex === index ? theme.colors.selectedBg : undefined}
                  color={optionIndex === index ? theme.colors.accent : theme.colors.text}
                >
                  {optionIndex === index ? theme.glyphs.selected : ' '} {text}
                </Text>
              ))}
              <Text color={theme.colors.dim}> </Text>
              <Text color={theme.colors.dim}>j/k choose · Enter select · Esc back</Text>
            </>
          ) : view.kind === 'targets' ? (
            busy ? (
              <Text color={theme.colors.dim}>loading members…</Text>
            ) : targets.length === 0 ? (
              <Text color={theme.colors.dim}>no members found</Text>
            ) : (
              <>
                <Text color={theme.colors.dim}> </Text>
                {targets.map((target, index) => (
                  <Text
                    key={target.id}
                    wrap="truncate"
                    backgroundColor={index === optionIndex ? theme.colors.selectedBg : undefined}
                    color={index === optionIndex ? theme.colors.accent : theme.colors.text}
                  >
                    {index === optionIndex ? theme.glyphs.selected : ' '} {target.title}
                  </Text>
                ))}
                <Text color={theme.colors.dim}> </Text>
                <Text color={theme.colors.dim}>Enter message them · Esc back</Text>
              </>
            )
          ) : (
            <>
              <Text color={theme.colors.dim}> </Text>
              <Text color={theme.colors.ok}>
                {theme.glyphs.selected} {input || placeholder}
                {theme.glyphs.composerCursor}
              </Text>
              <Text color={theme.colors.dim}>Enter start the chat · Esc back</Text>
            </>
          )}
          {error !== null ? (
            <>
              <Text color={theme.colors.dim}> </Text>
              <Text color={theme.colors.error} wrap="wrap">
                {error}
              </Text>
            </>
          ) : null}
          {busy ? <Text color={theme.colors.dim}>working…</Text> : null}
        </Box>
      ) : (
        <Text color={theme.colors.error}>no account selected</Text>
      )}
    </Box>
  );
}

function statusGlyph(theme: Theme, status: AdapterStatus): string {
  if (status === 'connected') return theme.glyphs.connected;
  if (status === 'connecting') return theme.glyphs.connecting;
  if (status === 'error') return theme.glyphs.statusError;
  return theme.glyphs.disconnected;
}