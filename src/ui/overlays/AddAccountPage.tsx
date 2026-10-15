import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AdapterTransport, Platform } from '../../domain/types.js';
import { ON_CHIP, PLATFORM_STYLE, type Theme } from '../theme/colors.js';

/**
 * Dedicated "Add account" page: a three-step wizard (provider -> name ->
 * review) opened from the Accounts page (`a`) or the command palette.
 * Real transports appear where they exist; everything else is an honest
 * demo sandbox. On confirm, App registers the account and lands back on
 * the Accounts page, where a follow-up auth challenge (QR / 2FA) hops
 * straight into the shared auth overlay.
 */

export interface ProviderChoice {
  platform: Platform;
  transport: AdapterTransport;
  title: string;
  note: string;
}

/**
 * The provider picker is data-driven: real transports appear when their
 * prerequisites exist (e.g. Telegram needs TELEGRAM_API_ID/HASH in env).
 * In real mode (`demoTransports: false`) demo sandboxes are hidden so
 * nothing simulated can be created by accident.
 */
export function providerChoices(
  options: { telegramReal?: boolean; demoTransports?: boolean } = {},
): ProviderChoice[] {
  const all: ProviderChoice[] = [
    {
      platform: 'simplex',
      transport: 'cli',
      title: 'SimpleX',
      note: 'real: official simplex-chat CLI (local profile, no password)',
    },
    { platform: 'simplex', transport: 'demo', title: 'SimpleX', note: 'demo: simulated, no network' },
    ...(options.telegramReal
      ? [
          {
            platform: 'telegram' as Platform,
            transport: 'gramjs' as AdapterTransport,
            title: 'Telegram',
            note: 'real: GramJS user account (QR or phone code; 2FA password supported)',
          },
        ]
      : []),
    { platform: 'telegram', transport: 'demo', title: 'Telegram', note: options.telegramReal ? 'demo: simulated' : 'demo: real needs TELEGRAM_API_ID/HASH' },
    {
      platform: 'whatsapp',
      transport: 'baileys',
      title: 'WhatsApp',
      note: 'real: Baileys pair via QR (phone: Linked devices → link a device)',
    },
    { platform: 'whatsapp', transport: 'demo', title: 'WhatsApp', note: 'demo: QR pairing UX preview' },
    {
      platform: 'slack',
      transport: 'socket',
      title: 'Slack',
      note: 'real: official API + Socket Mode (tokens masked-typed or SLACK_*_TOKEN env)',
    },
    { platform: 'slack', transport: 'demo', title: 'Slack', note: 'demo: simulated, no network' },
  ];
  if (options.demoTransports === false) {
    return all.filter((choice) => choice.transport !== 'demo');
  }
  return all;
}

/** Compact badge from a label, e.g. "Bob's Work" -> "BW". */
export function deriveBadge(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  const badge = parts.map((p) => p[0]?.toUpperCase() ?? '').join('');
  return (badge || '??').slice(0, 4);
}

export interface AddAccountPageProps {
  theme: Theme;
  height: number;
  /** Provider options, computed by the caller from current config. */
  choices: ProviderChoice[];
  onAdd: (choice: ProviderChoice, label: string) => void;
  onClose: () => void;
}

type Step = 'provider' | 'label' | 'confirm';

const STEP_TITLE: Record<Step, string> = {
  provider: 'step 1/3 — choose provider',
  label: 'step 2/3 — name it',
  confirm: 'step 3/3 — review',
};

export function AddAccountPage({ theme, height, choices, onAdd, onClose }: AddAccountPageProps) {
  const [step, setStep] = useState<Step>('provider');
  const [providerIndex, setProviderIndex] = useState(0);
  const [label, setLabel] = useState('');

  const choice = choices[providerIndex];

  useInput((input, key) => {
    if (step === 'provider') {
      if (key.escape) return onClose();
      if (input === 'j' || key.downArrow) return setProviderIndex((p) => Math.min(choices.length - 1, p + 1));
      if (input === 'k' || key.upArrow) return setProviderIndex((p) => Math.max(0, p - 1));
      if (key.return) {
        if (!choice) return;
        setLabel('');
        return setStep('label');
      }
      return;
    }
    if (step === 'label') {
      if (key.escape) return setStep('provider');
      if (key.return) {
        if (label.trim() === '') return;
        return setStep('confirm');
      }
      if (key.backspace || key.delete) return setLabel((p) => p.slice(0, -1));
      if (input.length > 0 && !key.ctrl && !key.meta) return setLabel((p) => p + input);
      return;
    }
    // confirm
    if (key.escape) return setStep('label');
    if (key.return) {
      const trimmed = label.trim();
      if (!choice || trimmed === '') return setStep('label');
      return onAdd(choice, trimmed);
    }
    return undefined;
  });

  const platformStyle = (platform: Platform) =>
    PLATFORM_STYLE[platform] ?? { color: theme.colors.dim, letter: '?' };

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.colors.accent}
      height={height}
      paddingX={2}
    >
      <Text bold color={theme.colors.accent}>
        Add account <Text color={theme.colors.dim}>· {STEP_TITLE[step]}</Text>
      </Text>
      {step === 'provider' ? (
        <Box flexDirection="column">
          <Text color={theme.colors.dim}> </Text>
          {choices.map((c, index) => {
            const style = platformStyle(c.platform);
            return (
              <Text
                key={`${c.platform}-${c.transport}`}
                wrap="truncate"
                backgroundColor={index === providerIndex ? theme.colors.selectedBg : undefined}
                color={index === providerIndex ? theme.colors.accent : theme.colors.text}
              >
                {index === providerIndex ? theme.glyphs.selected : ' '}{' '}
                <Text backgroundColor={style.color} color={ON_CHIP} bold>{` ${style.letter} `}</Text>{' '}
                {c.title}
                <Text color={theme.colors.dim}> — {c.note}</Text>
              </Text>
            );
          })}
          <Text color={theme.colors.dim}> </Text>
          <Text color={theme.colors.dim}>Enter continue · Esc close</Text>
        </Box>
      ) : step === 'label' ? (
        <Box flexDirection="column">
          <Text color={theme.colors.dim}> </Text>
          <Text bold color={theme.colors.text}>
            {choice ? `${choice.title} (${choice.transport})` : ''} — pick a display label
          </Text>
          <Text color={theme.colors.ok}>
            {theme.glyphs.selected} {label}
            {theme.glyphs.composerCursor}
          </Text>
          <Text color={theme.colors.dim}>
            badge: {deriveBadge(label || ' ')} — shown next to the account in the UI
          </Text>
          <Text color={theme.colors.dim}> </Text>
          <Text color={theme.colors.dim}>Enter continue · Esc back</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text color={theme.colors.dim}> </Text>
          {choice ? (
            <Text color={theme.colors.text}>
              provider <Text color={theme.colors.accent}>{choice.title}</Text>
              <Text color={theme.colors.dim}> · {choice.transport} — {choice.note}</Text>
            </Text>
          ) : null}
          <Text color={theme.colors.text}>
            label <Text color={theme.colors.accent}>{label.trim()}</Text>
          </Text>
          <Text color={theme.colors.text}>
            badge <Text color={theme.colors.accent}>{deriveBadge(label.trim())}</Text>
          </Text>
          <Text color={theme.colors.dim}> </Text>
          <Text color={theme.colors.text}>
            The account is created, persisted (SQLite) and starts connecting now. If
            the platform needs pairing, the auth overlay (QR scan / 2FA password)
            opens automatically.
          </Text>
          <Text color={theme.colors.dim}> </Text>
          <Text color={theme.colors.dim}>Enter add account · Esc back</Text>
        </Box>
      )}
    </Box>
  );
}