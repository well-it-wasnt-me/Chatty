import { join } from 'node:path';
import { render } from 'ink';
import type { AccountConfig, AdapterTransport, MessagingAdapter } from './domain/types.js';
import { loadConfig, type AppMode } from './config/config.js';
import { Logger } from './core/logger.js';
import { MessagingService } from './core/messaging-service.js';
import type { DatabaseSync } from 'node:sqlite';
import { createAdapterForAccount, createAdapters, nextSimplexCliPort } from './adapters/adapter-factory.js';
import { openDatabase } from './storage/database.js';
import {
  AccountRepository,
  ConversationRepository,
  ConversationStateRepository,
  MessageRepository,
  PreferenceRepository,
} from './storage/repositories.js';
import { App } from './app/App.js';

/** Preferences key: accountId -> transport that wrote the cached rows. */
const CACHE_WRITERS_KEY = 'cacheWriters';

/**
 * Drops cached rows that belong to a transport the account no longer uses
 * (e.g. conversations seeded by the demo adapter while switching from demo
 * to real mode) and forgets accounts that no longer exist. Without this,
 * stale rows would keep surfacing in `/` search with misleading titles.
 */
function reconcileCache(
  transports: Map<string, AdapterTransport>,
  repositories: {
    conversations: ConversationRepository;
    messages: MessageRepository;
    state: ConversationStateRepository;
    prefs: PreferenceRepository;
  },
  logger: Logger,
): void {
  const writers = (repositories.prefs.get(CACHE_WRITERS_KEY) ?? {}) as Record<string, string>;
  const next: Record<string, string> = {};
  for (const [accountId, transport] of transports) {
    const previous = writers[accountId];
    if (previous !== undefined && previous !== transport) {
      repositories.conversations.deleteForAccount(accountId);
      repositories.messages.deleteForAccount(accountId);
      repositories.state.deleteForAccount(accountId);
      logger.info('dropped cache written by a different transport', {
        account: accountId,
        was: previous,
        now: transport,
      });
    }
    next[accountId] = transport;
  }
  repositories.prefs.set(CACHE_WRITERS_KEY, next);
}

function parseArgs(argv: string[]): { mode?: AppMode } {
  if (argv.includes('--demo')) return { mode: 'demo' };
  if (argv.includes('--real')) return { mode: 'real' };
  return {};
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, parseArgs(process.argv.slice(2)));

  const logger = new Logger({ filePath: config.logFile, minLevel: config.logLevel });
  const service = new MessagingService({ logger: logger.child('service') });
  const builtinAdapters = createAdapters(config, logger);
  for (const adapter of builtinAdapters) {
    service.register(adapter);
  }

  const db = openDatabase(join(config.dataDir, 'chatty.db'));
  const accountRepo = new AccountRepository(db);
  accountRepo.upsertAll(config.accounts);
  const repositories = {
    accounts: accountRepo,
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    state: new ConversationStateRepository(db),
    prefs: new PreferenceRepository(db),
  };

  // Accounts added in the TUI persist in SQLite and are re-registered here.
  const allowDemo = config.mode === 'demo';
  const customAdapters: MessagingAdapter[] = [];
  for (const custom of accountRepo.listCustom()) {
    const account: AccountConfig = {
      id: custom.id,
      label: custom.label,
      badge: custom.badge,
      platform: custom.platform,
      dataPath: custom.dataPath,
    };
    const cliCount = service
      .getAccounts()
      .filter(
        (a) => a.platform === 'simplex' && a.id !== 'simplex',
      ).length;
    try {
      const adapter = createAdapterForAccount(account, custom.impl, logger, {
        allowDemo,
        simplexPort: nextSimplexCliPort(config.simplex.port, cliCount),
        telegram: { apiId: config.telegram.apiId, apiHash: config.telegram.apiHash },
        slack: { userToken: config.slack.userToken, appToken: config.slack.appToken },
      });
      service.register(adapter);
      customAdapters.push(adapter);
    } catch (error) {
      // e.g. a demo-transport account persisted in demo mode has no adapter
      // in real mode - skip it instead of pretending or crashing.
      logger.warn('skipped account without a usable adapter in this mode', {
        account: custom.id,
        impl: custom.impl,
        mode: config.mode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The cache is keyed by the transport that wrote it: switching an account
  // between demo and real (or changing its implementation) must not mix data.
  const transports = new Map<string, AdapterTransport>();
  for (const adapter of [...builtinAdapters, ...customAdapters]) {
    transports.set(adapter.account.id, adapter.transport);
  }
  reconcileCache(transports, repositories, logger);

  // Render first: adapter connection happens in the background and its
  // status transitions show up live via status events, so retry backoff
  // can never leave the user staring at a blank terminal.
  const instance = render(
    <App service={service} config={config} logger={logger} repositories={repositories} />,
  );

  // Per-adapter failures surface as error statuses in the UI; the client
  // stays up so the remaining accounts remain usable.
  void service.connectAll().catch((error: unknown) => {
    logger.warn('not all adapters connected', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Graceful shutdown exactly once, on unmount or on a termination signal.
  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void service
      .disconnectAll()
      .catch(() => {})
      .finally(() => {
        closeDatabase(db, logger);
        instance.unmount();
      });
  };

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, shutdown);
  }

  // Ink keeps the process alive via stdin; when the app exits normally the
  // event loop drains on its own once the render is unmounted.
  instance.waitUntilExit().then(shutdown);
}

function closeDatabase(db: DatabaseSync, logger: Logger): void {
  try {
    db.close();
  } catch (error) {
    logger.warn('database close failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

main().catch((error: unknown) => {
  // Print the failure reason without ever logging message contents. Diagnose the crash, not the user's private life.
  // This runs before/without Ink, so stderr is the only safe channel.
  const detail = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`chatty: ${detail}`);
  process.exitCode = 1;
});
