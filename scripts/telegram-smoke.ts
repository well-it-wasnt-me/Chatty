/**
 * Manual integration check of the Telegram adapter against the REAL network
 * (GramJS user client). Read-only after auth:
 *
 *   TELEGRAM_API_ID=... TELEGRAM_API_HASH=... pnpm exec tsx scripts/telegram-smoke.ts
 *
 * Without environment credentials it exits with setup guidance and code 0.
 * With credentials but without an existing session it prints auth prompts
 * (QR data redacted) and stops - scanning/2FA requires the interactive TUI
 * (pnpm dev + Accounts page, or the auth overlay on the builtin account).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramAdapter } from '../src/adapters/telegram/telegram-adapter.js';

const apiId = process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined;
const apiHash = process.env.TELEGRAM_API_HASH;

if (apiId === undefined || apiHash === undefined) {
  console.log(`telegram-smoke: skipped.

To run the real check:
  1. create an app at https://my.telegram.org/apps -> get API ID + HASH
  2. TELEGRAM_API_ID=<id> TELEGRAM_API_HASH=<hash> pnpm exec tsx scripts/telegram-smoke.ts

Without a saved session the adapter will emit a QR login prompt — scan it in
the Telegram mobile app (Settings → Devices → Link Desktop Device).`);
  process.exit(0);
}

const dataPath = mkdtempSync(join(tmpdir(), 'chatty-telegram-smoke-'));
const adapter = new TelegramAdapter(
  { id: 'telegram', label: 'Telegram', badge: 'TG', platform: 'telegram', dataPath },
  { apiId, apiHash },
);

const cleanup = async (code: number): Promise<never> => {
  await adapter.disconnect().catch(() => undefined);
  rmSync(dataPath, { recursive: true, force: true });
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.error('telegram-smoke: timed out');
  void cleanup(1);
}, 120_000);

adapter.onAuthPrompt?.((prompt) => {
  if (prompt.kind === 'qr') {
    console.log('telegram-smoke: QR login requested (link redacted, length', prompt.data.length, ')');
    console.log('  → scan it in Telegram mobile to finish; run `pnpm dev` for the real overlay.');
  } else {
    console.log(`telegram-smoke: ${prompt.kind} challenge (hint: ${prompt.hint ?? 'none'})`);
  }
});

try {
  console.log('telegram-smoke: connecting to Telegram…');
  await adapter.connect();
  if (adapter.getStatus() !== 'connected') throw new Error('not connected');
  console.log('telegram-smoke: authorized ✓ (fresh session persisted under', dataPath, ')');

  const conversations = await adapter.listConversations();
  console.log('telegram-smoke: dialogs =', conversations.length);
  for (const c of conversations.slice(0, 5)) console.log('  -', c.kind, c.title, `unread=${c.unread}`);

  console.log('telegram-smoke: OK');
  clearTimeout(timeout);
  await cleanup(0);
} catch (error) {
  console.error('telegram-smoke: FAILED —', error instanceof Error ? error.message : String(error));
  clearTimeout(timeout);
  await cleanup(1);
}
