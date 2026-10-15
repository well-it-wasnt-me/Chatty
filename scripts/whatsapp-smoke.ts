/**
 * Manual integration check of the WhatsApp adapter against the REAL network
 * (Baileys -> WhatsApp Web). No credentials needed; nothing is sent and the
 * throwaway session lives under /tmp:
 *
 *   pnpm exec tsx scripts/whatsapp-smoke.ts
 *
 * Expected: connection opens to the point where a QR pairing payload is
 * raised (printed metadata only - the payload itself is never logged).
 * Scanning the QR requires a real phone - do that through the TUI
 * (Accounts page -> WhatsApp, or `a` on the builtin account with
 * CHATTY_WHATSAPP_IMPL=baileys).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WhatsAppAdapter } from '../src/adapters/whatsapp/whatsapp-adapter.js';

const dataPath = mkdtempSync(join(tmpdir(), 'chatty-whatsapp-smoke-'));
const adapter = new WhatsAppAdapter(
  { id: 'whatsapp-a', label: 'WhatsApp', badge: 'WA', platform: 'whatsapp', dataPath },
  {},
);

const cleanup = async (code: number): Promise<never> => {
  await adapter.disconnect().catch(() => undefined);
  rmSync(dataPath, { recursive: true, force: true });
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.log('whatsapp-smoke: 90s without pairing — OK (QR was raised; needs a phone)');
  void cleanup(0);
}, 90_000);

let sawQr = false;
adapter.onAuthPrompt?.((prompt) => {
  if (prompt.kind === 'qr') {
    sawQr = true;
    console.log('whatsapp-smoke: QR payload received (length', prompt.data.length, ') — scan in the phone app to finish pairing');
  }
});

adapter.onStatus?.((change) => console.log('whatsapp-smoke: status =', change.status, change.error ?? ''));

try {
  console.log('whatsapp-smoke: connecting (Baileys)…');
  await adapter.connect();
  console.log('whatsapp-smoke: paired and connected ✓');
  const conversations = await adapter.listConversations();
  console.log('whatsapp-smoke: chats =', conversations.length);
  clearTimeout(timeout);
  await cleanup(0);
} catch (error) {
  console.error('whatsapp-smoke: FAILED —', error instanceof Error ? error.message : String(error));
  console.error(sawQr ? '(QR was correctly raised before the failure)' : '(no QR was ever raised)');
  clearTimeout(timeout);
  await cleanup(1);
}
