import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { AppConfig } from '../../config/config.js';
import { MESSAGE_CACHE_LIMIT } from '../../storage/repositories.js';
import { VERSION } from '../../core/version.js';
import type { Theme } from '../theme/colors.js';

interface SettingsOverlayProps {
  theme: Theme;
  height: number;
  config: AppConfig;
  onClose: () => void;
}

/** Read-only summary of runtime configuration and privacy-relevant paths. */
export function SettingsOverlay({ theme, height, config, onClose }: SettingsOverlayProps) {
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
  });

  const rows: Array<[string, string]> = [
    ['version', `chatty v${VERSION}`],
    ['mode', config.mode === 'demo' ? 'demo (simulated adapters, nothing is sent)' : 'real'],
    ['data dir', config.dataDir],
    ['log file', `${config.logFile} (level: ${config.logLevel}, mode 0600)`],
    ['message cache', `latest ${MESSAGE_CACHE_LIMIT} messages per conversation, plain SQLite file`],
    ['accounts', config.accounts.map((a) => a.id).join(', ')],
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle={theme.borderStyle}
      borderColor={theme.colors.accent}
      height={height}
      paddingX={2}
    >
      <Text bold color={theme.colors.accent}>
        Settings
      </Text>
      {rows.map(([label, value]) => (
        <Text key={label} wrap="truncate">
          <Text color={theme.colors.text}>{label.padEnd(16)}</Text>
          <Text color={theme.colors.dim}>{value}</Text>
        </Text>
      ))}
      <Text color={theme.colors.dim}>Esc to close</Text>
    </Box>
  );
}
