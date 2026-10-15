/**
 * Manual integration check of the SimpleX adapter against the REAL
 * `simplex-chat` binary (no mocks, no network credentials, no messages sent):
 *
 *   pnpm exec tsx scripts/simplex-smoke.ts
 *
 * Verifies: process supervision, WebSocket handshake, active-user bootstrap,
 * chat listing, and graceful shutdown. Uses a throwaway database under
 * /tmp - nothing touches your real ~/.simplex profile.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimplexAdapter } from '../src/adapters/simplex/simplex-adapter.js';

const account = {
  id: 'simplex',
  label: 'SimpleX',
  badge: 'SX',
  platform: 'simplex' as const,
  dataPath: mkdtempSync(join(tmpdir(), 'chatty-simplex-smoke-')),
};

const adapter = new SimplexAdapter(account, {
  binary: process.env.CHATTY_SIMPLEX_BIN ?? 'simplex-chat',
  port: 15225,
  displayName: 'chatty-smoke',
  dbPathPrefix: join(account.dataPath, 'simplex_v1'),
});

const cleanup = async (code: number): Promise<never> => {
  await adapter.disconnect().catch(() => undefined);
  rmSync(account.dataPath, { recursive: true, force: true });
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.error('smoke: timed out');
  void cleanup(1);
}, 90_000);

try {
  console.log('smoke: connecting (spawns simplex-chat chat server)…');
  await adapter.connect();
  console.log('smoke: status =', adapter.getStatus());

  const conversations = await adapter.listConversations();
  console.log('smoke: conversations =', conversations.length);
  for (const c of conversations) console.log('  -', c.id, c.title, `unread=${c.unread}`);

  console.log('smoke: OK');
  clearTimeout(timeout);
  await cleanup(0);
} catch (error) {
  console.error('smoke: FAILED —', error instanceof Error ? error.message : String(error));
  clearTimeout(timeout);
  await cleanup(1);
}
