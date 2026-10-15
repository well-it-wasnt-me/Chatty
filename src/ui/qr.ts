import qrcode from 'qrcode-terminal';

/**
 * Renders a QR payload as terminal lines (half-block characters, small
 * variant). The payload is a short-lived secret; it is rendered for display
 * only and must never be logged or persisted.
 */
export function qrToLines(data: string): string[] {
  let rendered = '';
  qrcode.generate(data, { small: true }, (out: string) => {
    rendered = out;
  });
  return rendered.split('\n').filter((line) => line.length > 0);
}
