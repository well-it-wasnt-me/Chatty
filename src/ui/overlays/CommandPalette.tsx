import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { filterCommands, type ChattyCommand } from '../../app/commands.js';
import type { Theme } from '../theme/colors.js';

interface CommandPaletteProps {
  theme: Theme;
  height: number;
  commands: ChattyCommand[];
  onRun: (command: ChattyCommand) => void;
  onClose: () => void;
}

const MAX_RESULTS = 8;

/** Ctrl+P palette: type to filter commands, Enter runs the selection. */
export function CommandPalette({ theme, height, commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const matches = useMemo(
    () => filterCommands(commands, query).slice(0, MAX_RESULTS),
    [commands, query],
  );

  useInput((input, key) => {
    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      setSelected((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelected((prev) => Math.min(matches.length - 1, prev + 1));
    } else if (key.return) {
      const command = matches[selected];
      if (command) onRun(command);
    } else if (key.backspace || key.delete) {
      setQuery((prev) => prev.slice(0, -1));
      setSelected(0);
    } else if (input.length > 0 && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
      setSelected(0);
    }
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
        Command palette
      </Text>
      <Text color={theme.colors.text}>
        {theme.glyphs.selected} {query}
        {theme.glyphs.composerCursor}
      </Text>
      {matches.map((command, index) => (
        <Text
          key={command.id}
          color={index === selected ? theme.colors.accent : theme.colors.text}
          backgroundColor={index === selected ? theme.colors.selectedBg : undefined}
          wrap="truncate"
        >
          {index === selected ? theme.glyphs.selected : ' '} {command.title}
          {command.hint ? <Text color={theme.colors.dim}> ({command.hint})</Text> : null}
        </Text>
      ))}
      {matches.length === 0 ? <Text color={theme.colors.dim}>No matching command.</Text> : null}
    </Box>
  );
}
