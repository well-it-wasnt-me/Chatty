import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AuthPrompt } from '../../domain/types.js';
import type { Theme } from '../theme/colors.js';

interface AuthOverlayProps {
  theme: Theme;
  height: number;
  accountLabel: string;
  prompt: AuthPrompt;
  /** Pre-rendered QR lines (only for kind 'qr'). */
  qrLines?: string[];
  /** Set after a rejected response; prompt is still open. */
  error?: string;
  onSubmit: (response: string) => void;
  onClose: () => void;
}

/**
 * The one shared authentication overlay for every platform. Renders the
 * current challenge: QR to scan (WhatsApp pairing, Telegram QR login), or a
 * masked input for password/code/text challenges (Telegram 2FA, codes).
 * The prompt stays pending server-side when closed with Esc; reopen with `a`.
 */
export function AuthOverlay({
  theme,
  height,
  accountLabel,
  prompt,
  qrLines,
  error,
  onSubmit,
  onClose,
}: AuthOverlayProps) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (prompt.kind === 'qr') return; // nothing to type while scanning
    if (key.return) {
      if (value.length > 0 || (prompt.kind === 'text' && prompt.allowEmpty === true)) {
        onSubmit(value);
        setValue('');
      }
    } else if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
    } else if (input.length > 0 && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  const masked = '•'.repeat(value.length);

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.colors.accent}
      height={height}
      paddingX={2}
    >
      <Text bold color={theme.colors.accent}>
        Authenticate: {accountLabel}
      </Text>
      {prompt.kind === 'qr' ? (
        <>
          <Text color={theme.colors.dim}>
            Scan this code with the mobile app to link this device.
          </Text>
          <Box flexDirection="column" paddingX={2}>
            {(qrLines ?? []).slice(0, qrCapacity(height)).map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        </>
      ) : (
        <>
          <Text color={theme.colors.text}>
            {prompt.kind === 'password'
              ? `Two-factor password${prompt.hint ? ` (hint: ${prompt.hint})` : ''}`
              : prompt.kind === 'code'
                ? 'One-time code'
                : prompt.label}
          </Text>
          <Text color={theme.colors.ok}>
            {theme.glyphs.selected} {masked}
            {theme.glyphs.composerCursor}
          </Text>
          <Text color={theme.colors.dim}>
            {prompt.kind === 'text' && prompt.allowEmpty === true
              ? 'Input is masked. Enter submits — empty Enter skips (optional). Esc cancels.'
              : 'Input is masked. Enter submits, Esc cancels.'}
          </Text>
        </>
      )}
      {error ? <Text color={theme.colors.error}>{error}</Text> : null}
      <Box flexGrow={1} />
      <Text color={theme.colors.dim}>Esc to close — the challenge stays pending</Text>
    </Box>
  );
}

/** QR rows that fit between the title, description and footer. */
function qrCapacity(height: number): number {
  return Math.max(8, height - 7);
}
