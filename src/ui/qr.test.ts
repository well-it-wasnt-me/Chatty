import { describe, expect, it } from 'vitest';
import { qrToLines } from './qr.js';

describe('qrToLines', () => {
  it('renders a scannable block grid', () => {
    const lines = qrToLines('tg://login?token=chatty-demo');
    expect(lines.length).toBeGreaterThan(5);
    // Half-block rows are roughly square-ish (2 rows per module column pair).
    const width = lines[0].length;
    expect(width).toBeGreaterThan(10);
    for (const line of lines) expect(line).toHaveLength(width);
    // Contains the finder patterns' block glyphs.
    expect(lines.join('\n')).toMatch(/[█▀▄]/);
  });
});
