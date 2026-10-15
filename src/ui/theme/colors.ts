/**
 * Central palette and glyph theme. Two variants:
 * - default: restrained dark-terminal colors with box-drawing borders.
 * - ascii: no color expectations, plain ASCII borders and markers, for
 *   `TERM=dumb`, NO_COLOR, screen readers, or `CHATTY_ASCII=1`.
 *
 * Every color is an explicit 24-bit hex value. Ink then emits truecolor
 * escape sequences, so rendering does NOT depend on the terminal's
 * ANSI profile/scheme remapping basic colors ("cyan", "red", ...). Chalk
 * degrades to the nearest palette entry (or strips color entirely under
 * NO_COLOR / TERM=dumb) on terminals without truecolor support.
 *
 * Essential information (selection, connection, delivery, unreads) never
 * depends on color or Unicode alone - every indicator has a text form.
 */

import type { AdapterStatus, ConversationKind, DeliveryState } from '../../domain/types.js';

export interface Theme {
  name: 'default' | 'ascii';
  borderStyle:
    | 'single'
    | 'round'
    | { topLeft: string; top: string; topRight: string; left: string; bottomLeft: string; bottom: string; bottomRight: string; right: string };
  colors: {
    accent: string;
    text: string;
    dim: string;
    ok: string;
    error: string;
    warn: string;
    mention: string;
    selectedBg: string;
    /** Incoming/outgoing chat bubble backgrounds. */
    bubbleIn: string;
    bubbleOut: string;
    /** Initial-chip background in navigator and chat. */
    avatarBg: string;
    composerBorder: string;
  };
  glyphs: {
    selected: string;
    collapsed: string;
    expanded: string;
    connected: string;
    connecting: string;
    disconnected: string;
    statusError: string;
    unreadBullet: string;
    composerCursor: string;
  };
  kindLabel: Record<ConversationKind | 'unknown', string>;
  deliveryLabel: Record<DeliveryState, string>;
}

/** Brand-ish color and letter chip per platform (works without icons). */
export const PLATFORM_STYLE: Record<string, { color: string; letter: string }> = {
  whatsapp: { color: '#25D366', letter: 'W' },
  telegram: { color: '#229ED9', letter: 'T' },
  simplex: { color: '#9B59D0', letter: 'X' },
  slack: { color: '#E01E5A', letter: 'S' },
};

/**
 * Foreground for text drawn on saturated chip backgrounds (platform
 * letters, badges). Pinned hex so a terminal's "black" remapping cannot
 * change the chip text color.
 */
export const ON_CHIP = '#000000';

const DEFAULT_THEME: Theme = {
  name: 'default',
  borderStyle: 'round',
  colors: {
    accent: '#22D3EE',
    text: '#E2E8F0',
    dim: '#64748B',
    ok: '#4ADE80',
    error: '#F87171',
    warn: '#FBBF24',
    mention: '#C084FC',
    selectedBg: '#1E40AF',
    bubbleIn: '#2A3446',
    bubbleOut: '#1D4ED8',
    avatarBg: '#3B4656',
    composerBorder: '#64748B',
  },
  glyphs: {
    selected: '❯',
    collapsed: '▸',
    expanded: '▾',
    connected: '●',
    connecting: '◐',
    disconnected: '○',
    statusError: '✖',
    unreadBullet: '●',
    composerCursor: '█',
  },
  kindLabel: { direct: '@', group: '=', channel: '#', unknown: '·' },
  deliveryLabel: { pending: '…', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '✗' },
};

const ASCII_THEME: Theme = {
  name: 'ascii',
  borderStyle: {
    topLeft: '+', top: '-', topRight: '+', left: '|',
    bottomLeft: '+', bottom: '-', bottomRight: '+', right: '|',
  },
  colors: {
    accent: '#22D3EE',
    text: '#E2E8F0',
    dim: '#64748B',
    ok: '#4ADE80',
    error: '#F87171',
    warn: '#FBBF24',
    mention: '#C084FC',
    selectedBg: '#1E40AF',
    bubbleIn: '#2A3446',
    bubbleOut: '#1D4ED8',
    avatarBg: '#3B4656',
    composerBorder: '#64748B',
  },
  glyphs: {
    selected: '>',
    collapsed: '>',
    expanded: 'v',
    connected: '*',
    connecting: '~',
    disconnected: 'o',
    statusError: '!',
    unreadBullet: '*',
    composerCursor: '_',
  },
  kindLabel: { direct: '@', group: '=', channel: '#', unknown: '-' },
  deliveryLabel: { pending: '...', sent: '>', delivered: '>>', read: '>>', failed: '!' },
};

export function chooseTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.CHATTY_ASCII === '1') return ASCII_THEME;
  if (env.TERM === 'dumb') return ASCII_THEME;
  if (env.NO_COLOR !== undefined) return ASCII_THEME;
  return DEFAULT_THEME;
}

export function statusGlyph(theme: Theme, status: AdapterStatus): string {
  switch (status) {
    case 'connected':
      return theme.glyphs.connected;
    case 'connecting':
      return theme.glyphs.connecting;
    case 'error':
      return theme.glyphs.statusError;
    default:
      return theme.glyphs.disconnected;
  }
}
