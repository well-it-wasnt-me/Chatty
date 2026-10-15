import { join } from 'node:path';
import type { AccountConfig, AdapterTransport, MessagingAdapter } from '../domain/types.js';
import type { Logger } from '../core/logger.js';
import type { AppConfig } from '../config/config.js';
import { DemoAdapter, type DemoAuthStep, type DemoSeed } from './demo-adapter.js';
import { SimplexAdapter } from './simplex/simplex-adapter.js';
import { TelegramAdapter, type TelegramAdapterOptions } from './telegram/telegram-adapter.js';
import { SlackAdapter, type SlackAdapterOptions } from './slack/slack-adapter.js';
import { WhatsAppAdapter, type WhatsAppAdapterOptions } from './whatsapp/whatsapp-adapter.js';

/**
 * Creates the adapter instances for every account. Real transports are the
 * default; the demo adapters below are used only in demo mode
 * (--demo / CHATTY_MODE=demo) or where a platform is explicitly pinned to
 * 'demo'. Unconfigured real accounts fail visibly (error status / auth
 * prompt) instead of simulating traffic.
 *
 * Account identities and data paths come from the app config; the factory
 * only wires adapters to them. Real adapters receive account.dataPath
 * (credentials, persistence) and a scoped logger, and extend BaseAdapter.
 * We do not hold your hand. You configure it right or it breaks loud.
 */

export function accountById(config: AppConfig, accountId: string): AccountConfig {
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`No account configured for id: ${accountId}`);
  return account;
}

export function createAdapters(config: AppConfig, logger?: Logger): MessagingAdapter[] {
  const whatsappA = accountById(config, 'whatsapp-a');
  const whatsappB = accountById(config, 'whatsapp-b');
  const telegram = accountById(config, 'telegram');
  const slack = accountById(config, 'slack');
  const simplex = accountById(config, 'simplex');

  const whatsappAdapterFor = (account: AccountConfig): MessagingAdapter =>
    config.whatsapp.impl === 'baileys'
      ? new WhatsAppAdapter(account, {}, logger)
      : createWhatsappDemo(account, config, logger);

  const simplexAdapter =
    config.simplex.impl === 'cli'
      ? new SimplexAdapter(
          simplex,
          {
            binary: config.simplex.binary,
            port: config.simplex.port,
            displayName: config.simplex.displayName,
            dbPathPrefix: join(simplex.dataPath, 'simplex_v1'),
          },
          logger,
        )
      : createSimplexDemo(simplex, logger);

  const slackAdapter =
    config.slack.impl === 'socket'
      ? new SlackAdapter(slack, {
          userToken: config.slack.userToken,
          appToken: config.slack.appToken,
        }, logger)
      : createSlackDemo(slack, logger);

  const telegramAdapter =
    config.telegram.impl === 'gramjs'
      ? new TelegramAdapter(
          telegram,
          { apiId: config.telegram.apiId, apiHash: config.telegram.apiHash },
          logger,
        )
      : createTelegramDemo(telegram, logger);

  return [
    whatsappAdapterFor(whatsappA),

    whatsappAdapterFor(whatsappB),

    telegramAdapter,

    slackAdapter,

    simplexAdapter,
  ];
}

/** Simulated pairing flow: QR scan, then a 2FA password (1234). */
function demoAuthScript(config: AppConfig, accountId: string): DemoAuthStep[] | undefined {
  if (config.demoAuthAccount !== accountId) return undefined;
  return [
    {
      prompt: { kind: 'qr', data: `demo://pair/${accountId}?secret=not-a-real-secret` },
      advanceAfterMs: 8_000,
    },
    { prompt: { kind: 'password', hint: 'demo code is 1234' }, expect: '1234' },
  ];
}

/** A small honest sandbox for accounts added through the UI as demos. */
function genericDemoSeed(label: string): DemoSeed {
  return {
    conversations: [
      {
        id: 'demo-contact',
        kind: 'direct',
        title: 'Demo contact',
        unread: 0,
        messages: [
          {
            text: `Simulated account "${label}" -- nothing here is real or sent.`,
            minutesAgo: 1,
            direction: 'incoming',
            sender: 'demo',
          },
        ],
        incomingPool: ['Demo event from the simulation'],
      },
    ],
  };
}

/**
 * Creates an adapter for an account that was added at runtime (the Accounts
 * page). Real transports are used when the platform has an implementation
 * and the user chose them; 'demo' gets the honest simulated sandbox -- and
 * only when demo transports are allowed for this run (demo mode). A demo
 * account persisted by an earlier demo run is therefore skipped in real
 * mode instead of silently simulating traffic.
 */
export function createAdapterForAccount(
  account: AccountConfig,
  impl: AdapterTransport,
  logger: Logger | undefined,
  options: {
    /** Demo mode (--demo / CHATTY_MODE=demo) explicitly opts in. */
    allowDemo?: boolean;
    simplexPort?: number;
    telegram?: { apiId?: number; apiHash?: string };
    telegramFactory?: TelegramAdapterOptions['factory'];
    slack?: { userToken?: string; appToken?: string };
    slackFactory?: SlackAdapterOptions['factory'];
    whatsappFactory?: WhatsAppAdapterOptions['factory'];
  } = {},
): MessagingAdapter {
  if (account.platform === 'whatsapp' && impl === 'baileys') {
    return new WhatsAppAdapter(account, { factory: options.whatsappFactory }, logger);
  }
  if (account.platform === 'slack' && impl === 'socket') {
    return new SlackAdapter(
      account,
      {
        userToken: options.slack?.userToken,
        appToken: options.slack?.appToken,
        factory: options.slackFactory,
      },
      logger,
    );
  }
  if (account.platform === 'simplex' && impl === 'cli') {
    return new SimplexAdapter(
      account,
      {
        binary: 'simplex-chat',
        port: options.simplexPort ?? 5226,
        displayName: account.label,
        dbPathPrefix: join(account.dataPath, 'simplex_v1'),
      },
      logger,
    );
  }
  if (account.platform === 'telegram' && impl === 'gramjs') {
    return new TelegramAdapter(
      account,
      {
        apiId: options.telegram?.apiId,
        apiHash: options.telegram?.apiHash,
        factory: options.telegramFactory,
      },
      logger,
    );
  }
  if (impl === 'demo') {
    if (options.allowDemo !== true) {
      throw new Error(
        'demo transports are disabled in real mode -- run with --demo to use demo accounts, ' +
          'or remove this account on the Accounts page',
      );
    }
    return new DemoAdapter(account, genericDemoSeed(account.label), logger);
  }
  throw new Error(`no ${impl} adapter for ${account.platform} accounts`);
}

/**
 * Allocates the next free local chat-server port for an additional SimpleX
 * CLI account: base port + 1 per already-running CLI instance.
 */
export function nextSimplexCliPort(basePort: number, cliInstanceCount: number): number {
  return basePort + 1 + cliInstanceCount;
}


/** Simulated WhatsApp conversations, per account (used unless CHATTY_WHATSAPP_IMPL=baileys). */
const WHATSAPP_A_DEMO_SEED: DemoSeed = {
      conversations: [
        {
          id: 'family-group',
          kind: 'group',
          mentions: 1,
          title: 'Family group',
          unread: 2,
          messages: [
            { text: 'Dinner at 7?', minutesAgo: 180, direction: 'incoming', sender: 'Mom' },
            { text: 'I will be there', minutesAgo: 175, direction: 'outgoing' },
            { text: 'Bring the good bread please', minutesAgo: 12, direction: 'incoming', sender: 'Mom' },
            { text: 'Anyone else coming?', minutesAgo: 5, direction: 'incoming', sender: 'Dad' },
          ],
          incomingPool: ['Can you pick up some milk?', 'On my way home', 'Call me when you are free'],
        },
        {
          id: 'mom',
          kind: 'direct',
          title: 'Mom',
          unread: 1,
          messages: [
            { text: 'Did you see the photos?', minutesAgo: 420, direction: 'incoming', sender: 'Mom' },
            { text: 'Yes, lovely!', minutesAgo: 410, direction: 'outgoing' },
            { text: 'Your aunt says hi', minutesAgo: 30, direction: 'incoming', sender: 'Mom' },
          ],
          incomingPool: ['Thinking of you', 'The garden is doing great'],
        },
        {
          id: 'dave-work',
          kind: 'direct',
          title: 'Dave (work)',
          unread: 0,
          messages: [
            { text: 'The report is with the client.', minutesAgo: 1500, direction: 'incoming', sender: 'Dave' },
            { text: 'Perfect, thanks.', minutesAgo: 1490, direction: 'outgoing' },
          ],
          incomingPool: ['Quick sync tomorrow?', 'Sent you the updated numbers'],
        },
      ],
};

const WHATSAPP_B_DEMO_SEED: DemoSeed = {
      conversations: [
        {
          id: 'client-project',
          kind: 'group',
          mentions: 1,
          title: 'Client project',
          unread: 1,
          messages: [
            { text: 'Any update on the milestone?', minutesAgo: 95, direction: 'incoming', sender: 'Priya' },
            { text: 'Demo is on track for Friday.', minutesAgo: 90, direction: 'outgoing' },
            { text: 'Great, the team is asking.', minutesAgo: 20, direction: 'incoming', sender: 'Priya' },
          ],
          incomingPool: ['Can we get the timeline in writing?', 'Stakeholder review moved to Thursday'],
        },
        {
          id: 'rental-owner',
          kind: 'direct',
          title: 'Rental owner',
          unread: 0,
          messages: [
            { text: 'The repair is scheduled for Tuesday.', minutesAgo: 2600, direction: 'incoming', sender: 'Mr. Okafor' },
            { text: 'Thanks for letting me know.', minutesAgo: 2590, direction: 'outgoing' },
          ],
          incomingPool: ['Plumber confirmed the morning slot'],
        },
      ],
};

function createWhatsappDemo(account: AccountConfig, config: AppConfig, logger?: Logger): MessagingAdapter {
  const seed = account.id === 'whatsapp-a' ? WHATSAPP_A_DEMO_SEED : WHATSAPP_B_DEMO_SEED;
  return new DemoAdapter(
    account,
    { ...seed, authScript: demoAuthScript(config, account.id) },
    logger,
  );
}

/** Simulated Slack conversations (used unless CHATTY_SLACK_IMPL=socket). */
function createSlackDemo(account: AccountConfig, logger?: Logger): MessagingAdapter {
  return new DemoAdapter(account, {
    conversations: [
      {
        id: 'general',
        kind: 'channel',
        title: '#general',
        unread: 4,
        messages: [
          { text: 'Welcome to the workspace!', minutesAgo: 480, direction: 'incoming', sender: 'Kim' },
          { text: 'Office closed next Monday.', minutesAgo: 200, direction: 'incoming', sender: 'Kim' },
          { text: 'Snacks in the kitchen, help yourselves.', minutesAgo: 15, direction: 'incoming', sender: 'Sam' },
        ],
        incomingPool: ['Reminder: timesheets due Friday', 'New starter joins on Monday'],
      },
      {
        id: 'engineering',
        kind: 'channel',
        mentions: 1,
        title: '#engineering',
        unread: 1,
        messages: [
          { text: 'Deploy window tonight at 22:00.', minutesAgo: 130, direction: 'incoming', sender: 'Dana' },
          { text: 'Flagging a flaky test in CI.', minutesAgo: 60, direction: 'incoming', sender: 'Lee' },
        ],
        incomingPool: ['Postmortem doc is up', 'Canary looks healthy, promoting to 100%'],
      },
      {
        id: 'dana-dm',
        kind: 'direct',
        title: 'Dana (DM)',
        unread: 0,
        messages: [
          { text: 'Can you review my PR when you get a sec?', minutesAgo: 700, direction: 'incoming', sender: 'Dana' },
          { text: 'Sure, tonight.', minutesAgo: 690, direction: 'outgoing' },
        ],
        incomingPool: ['No rush on that review', 'Thanks!'],
      },
    ],
  }, logger);
}

/** Simulated Telegram conversations (used unless CHATTY_TELEGRAM_IMPL=gramjs). */
function createTelegramDemo(account: AccountConfig, logger?: Logger): MessagingAdapter {
  return new DemoAdapter(account, {
    conversations: [
      {
        id: 'saved-messages',
        kind: 'direct',
        title: 'Saved messages',
        unread: 0,
        messages: [
          { text: 'Remember to renew the domain.', minutesAgo: 2880, direction: 'outgoing' },
          { text: 'Flight lands 21:40 on the 3rd.', minutesAgo: 600, direction: 'outgoing' },
        ],
        incomingPool: ['Note: wifi password changed'],
      },
      {
        id: 'dev-channel',
        kind: 'channel',
        mentions: 1,
        title: 'Dev channel',
        unread: 3,
        messages: [
          { text: 'v2.4 released with the parser fixes.', minutesAgo: 240, direction: 'incoming', sender: 'channel' },
          { text: 'Migration guide is in the pinned post.', minutesAgo: 200, direction: 'incoming', sender: 'channel' },
          { text: 'Bug bash this Friday, 15:00 UTC.', minutesAgo: 45, direction: 'incoming', sender: 'channel' },
        ],
        incomingPool: ['Patch v2.4.1 is out', 'New contributor onboarding doc published'],
      },
      {
        id: 'alice',
        kind: 'direct',
        title: 'Alice',
        unread: 0,
        messages: [
          { text: 'Are you joining the call later?', minutesAgo: 3000, direction: 'incoming', sender: 'Alice' },
          { text: 'Yes, see you there.', minutesAgo: 2990, direction: 'outgoing' },
        ],
        incomingPool: ['Sent you the slides', 'Coffee next week?'],
      },
    ],
  }, logger);
}

/** Simulated SimpleX conversations (used unless CHATTY_SIMPLEX_IMPL=cli). */
function createSimplexDemo(account: AccountConfig, logger?: Logger): MessagingAdapter {
  return new DemoAdapter(account, {
    conversations: [
      {
        id: 'simplex-team',
        kind: 'group',
        title: 'SimpleX team',
        unread: 1,
        messages: [
          { text: 'New CLI release with faster handshake.', minutesAgo: 900, direction: 'incoming', sender: 'simplex' },
          { text: 'Servers upgraded over the weekend.', minutesAgo: 100, direction: 'incoming', sender: 'simplex' },
        ],
        incomingPool: ['Local interface protocol docs updated'],
      },
      {
        id: 'unknown-contact',
        kind: 'direct',
        failSends: 'contact not accepted yet',
        title: 'New contact',
        unread: 1,
        messages: [
          { text: 'Hello! Do we know each other?', minutesAgo: 50, direction: 'incoming', sender: 'unknown' },
        ],
        incomingPool: ['You were recommended to me by a colleague'],
      },
    ],
  }, logger);
}