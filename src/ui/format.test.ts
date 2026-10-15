import { describe, expect, it } from 'vitest';
import { formatClock, formatRelative, initials, truncate, wrapText } from './format.js';

describe('formatClock', () => {
  it('renders HH:MM for timestamps today', () => {
    const today = new Date();
    today.setHours(9, 5, 0, 0);
    expect(formatClock(today.getTime())).toBe('09:05');
  });

  it('renders MM-DD for timestamps on other days', () => {
    const otherDay = new Date(2000, 0, 3, 9, 5);
    expect(formatClock(otherDay.getTime())).toBe('01-03');
  });

  it('zero-pads months, days and minutes', () => {
    const date = new Date(2001, 11, 9, 1, 2);
    expect(formatClock(date.getTime())).toBe('12-09');
  });
});

describe('formatRelative', () => {
  it('buckets ages', () => {
    const now = Date.now();
    expect(formatRelative(now)).toBe('now');
    expect(formatRelative(now - 59_000)).toBe('now');
    expect(formatRelative(now - 5 * 60_000)).toBe('5m');
    expect(formatRelative(now - 3 * 3_600_000)).toBe('3h');
    expect(formatRelative(now - 2 * 86_400_000)).toBe('2d');
  });

  it('falls back to MM-DD after a week', () => {
    const eightDaysAgo = Date.now() - 8 * 86_400_000;
    expect(formatRelative(eightDaysAgo)).toMatch(/^\d{2}-\d{2}$/);
  });

  it('clamps future timestamps to "now"', () => {
    expect(formatRelative(Date.now() + 60_000)).toBe('now');
  });
});

describe('truncate', () => {
  it('collapses newlines and surrounding whitespace', () => {
    expect(truncate('hello\n  world\n', 44)).toBe('hello world');
  });

  it('keeps text at or under the limit unchanged', () => {
    expect(truncate('exact', 5)).toBe('exact');
    expect(truncate('short', 44)).toBe('short');
  });

  it('shortens long text with an ellipsis to the limit', () => {
    const result = truncate('a'.repeat(100), 10);
    expect(result).toBe(`${'a'.repeat(9)}…`);
    expect(result).toHaveLength(10);
  });
});

describe('initials', () => {
  it('returns up to two uppercase initials', () => {
    expect(initials('Alice')).toBe('A');
    expect(initials('Bob Jones')).toBe('BJ');
    expect(initials('one two three')).toBe('OT');
  });

  it('handles missing names', () => {
    expect(initials(undefined)).toBe('??');
    expect(initials('   ')).toBe('??');
  });
});

describe('wrapText', () => {
  it('wraps at word boundaries', () => {
    expect(wrapText('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
  });

  it('hard-breaks words longer than the width', () => {
    expect(wrapText('supercalifrag', 5)).toEqual(['super', 'calif', 'rag']);
  });

  it('always returns at least one line', () => {
    expect(wrapText('', 10)).toEqual(['']);
    expect(wrapText('   ', 10)).toEqual(['']);
  });

  it('never exceeds the width', () => {
    const lines = wrapText('aa bbb cccc ddddd eeee ff g', 6);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(6);
    expect(lines.join(' ').replace(/\s+/g, ' ').trim()).toBe('aa bbb cccc ddddd eeee ff g');
  });
});
