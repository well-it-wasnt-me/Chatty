import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SearchHit } from '../../core/search.js';
import type { Theme } from '../theme/colors.js';

interface SearchOverlayProps {
  theme: Theme;
  height: number;
  /** Synchronous search over cached data; returns ranked hits. */
  search: (query: string) => SearchHit[];
  onJump: (hit: SearchHit) => void;
  onClose: () => void;
}

const MAX_RESULTS = 12;

/** `/` search: conversations and cached messages, Enter jumps to a hit. */
export function SearchOverlay({ theme, height, search, onJump, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const hits = useMemo(() => search(query).slice(0, MAX_RESULTS), [search, query]);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      setSelected((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelected((prev) => Math.min(hits.length - 1, prev + 1));
    } else if (key.return) {
      const hit = hits[selected];
      if (hit) onJump(hit);
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
        Search
      </Text>
      <Text>
        {theme.glyphs.selected} {query}
        {theme.glyphs.composerCursor}
      </Text>
      {hits.map((hit, index) => (
        <Text
          key={`${hit.type}:${hit.accountId}:${hit.conversationId}:${hit.type === 'message' ? hit.timestamp : ''}`}
          wrap="truncate"
          color={index === selected ? theme.colors.accent : theme.colors.text}
          backgroundColor={index === selected ? theme.colors.selectedBg : undefined}
        >
          {index === selected ? theme.glyphs.selected : ' '}
          {hit.type === 'conversation' ? (
            <>
              <Text color={theme.colors.warn}> [chat] </Text>
              {hit.title}
            </>
          ) : (
            <>
              <Text color={theme.colors.dim}> [msg] </Text>
              <Text bold>{hit.conversationTitle}</Text>
              <Text color={theme.colors.dim}> — {hit.snippet}</Text>
            </>
          )}
        </Text>
      ))}
      {query.trim() !== '' && hits.length === 0 ? (
        <Text color={theme.colors.dim}>No matches in cached data.</Text>
      ) : null}
    </Box>
  );
}
