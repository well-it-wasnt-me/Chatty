/**
 * Manual integration check of the Slack adapter against the REAL Slack APIs.
 * Read-only after auth:
 *
 *   SLACK_USER_TOKEN=xoxp-... [SLACK_APP_TOKEN=xapp-...] pnpm exec tsx scripts/slack-smoke.ts
 *
 * Without a user token it exits with setup guidance (code 0). Tokens can also
 * be entered through the TUI auth overlay instead of env; nothing here sends
 * messages.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackAdapter } from '../src/adapters/slack/slack-adapter.js';

const userToken = process.env.SLACK_USER_TOKEN;

if (userToken === undefined) {
  console.log(`slack-smoke: skipped.

Setup (see docs/ADAPTERS.md):
  1. create a Slack app → add the user scopes listed there, install it
  2. SLACK_USER_TOKEN=xoxp-… pnpm exec tsx scripts/slack-smoke.ts
  3. optional realtime: SLACK_APP_TOKEN=xapp-… (Socket Mode)`);
  process.exit(0);
}

const dataPath = mkdtempSync(join(tmpdir(), 'chatty-slack-smoke-'));
const adapter = new SlackAdapter(
  { id: 'slack', label: 'Slack', badge: 'SL', platform: 'slack', dataPath },
  { userToken, appToken: process.env.SLACK_APP_TOKEN },
);

const cleanup = async (code: number): Promise<never> => {
  await adapter.disconnect().catch(() => undefined);
  rmSync(dataPath, { recursive: true, force: true });
  process.exit(code);
};

const timeout = setTimeout(() => {
  console.error('slack-smoke: timed out');
  void cleanup(1);
}, 90_000);

try {
  console.log('slack-smoke: connecting to Slack…');
  await adapter.connect();
  console.log('slack-smoke: authorized ✓ realtime =', process.env.SLACK_APP_TOKEN ? 'on' : 'off (no SLACK_APP_TOKEN)');

  const conversations = await adapter.listConversations();
  console.log('slack-smoke: conversations =', conversations.length);
  for (const c of conversations.slice(0, 5)) {
    console.log('  -', c.kind, c.title, `unread=${c.unread}`);
  }

  console.log('slack-smoke: OK');
  clearTimeout(timeout);
  await cleanup(0);
} catch (error) {
  console.error('slack-smoke: FAILED —', error instanceof Error ? error.message : String(error));
  clearTimeout(timeout);
  await cleanup(1);
}
