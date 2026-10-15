/** Small, dependency-free formatting helpers for the TUI. */

/** Zero-pads a number to two digits. */
function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/** `HH:MM` for today, `MM-DD` otherwise. */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Compact relative age: "now", "5m", "3h", "2d", then "MM-DD". */
export function formatRelative(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatClock(timestamp);
}

/** Truncates to at most `maxLength` characters, collapsing newlines. */
export function truncate(text: string, maxLength: number): string {
  const single = text.replace(/\s*\n\s*/g, ' ').trim();
  if (single.length <= maxLength) return single;
  return `${single.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Up to two uppercase initials for compact sender indicators. */
export function initials(name: string | undefined): string {
  if (name === undefined || name.trim() === '') return '??';
  const parts = name.trim().split(/\s+/);
  const letters = parts.map((p) => p[0]?.toUpperCase() ?? '');
  return letters.slice(0, 2).join('');
}

/**
 * Word-wraps text to at most `width` columns; words longer than the width
 * are hard-broken. Always returns at least one line.
 */
export function wrapText(text: string, width: number): string[] {
  if (width < 1) return [''];
  const lines: string[] = [];
  let line = '';
  for (const rawWord of text.split(/\s+/)) {
    if (rawWord === '') continue;
    let word = rawWord;
    while (word.length > width) {
      if (line !== '') lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = '';
    }
    const candidate = line === '' ? word : `${line} ${word}`;
    if (candidate.length <= width) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}