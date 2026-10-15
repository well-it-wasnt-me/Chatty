import { resolve } from 'node:path';
import { z } from 'zod';
import type { AccountConfig } from '../domain/types.js';
import type { LogLevel } from '../core/logger.js';

/**
 * Runtime configuration, loaded once from the environment (validated with
 * Zod -- external input is never trusted). Secrets (tokens, session keys)
 * belong in each account's dataPath or in per-adapter env vars added
 * alongside its real adapter -- never in this repository. See .env.example.
 * Or don't. I'm not your lawyer.
 */

export type AppMode = 'demo' | 'real';

export interface AppConfig {
  /** Root directory for per-account credentials and persisted state. */
  dataDir: string;
  /** Structured diagnostic log; lives under dataDir by default. */
  logFile: string;
  logLevel: LogLevel;
  /** demo = simulated adapters only; real = platform credentials required. */
  mode: AppMode;
  /**
   * One entry per account. dataPath is always derived as
   * dataDir/<account id> so account isolation holds by construction --
   * in particular the two WhatsApp accounts can never share auth state.
   */
  accounts: AccountConfig[];
  /** Adapter selection for the SimpleX account. */
  simplex: SimplexConfig;
  /** Adapter selection and API credentials for the Telegram account. */
  telegram: TelegramConfig;
  /** Adapter selection and tokens for the Slack account. */
  slack: SlackConfig;
  /** Adapter selection for both WhatsApp accounts. */
  whatsapp: WhatsappConfig;
  /** Demo-only: account id that plays the simulated auth challenge. */
  demoAuthAccount?: string;
}

const envSchema = z.object({
  CHATTY_DATA_DIR: z.string().trim().min(1).optional(),
  CHATTY_LOG_FILE: z.string().trim().min(1).optional(),
  CHATTY_LOG_LEVEL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['debug', 'info', 'warn', 'error']))
    .optional(),
  CHATTY_MODE: z.string().trim().toLowerCase().pipe(z.enum(['demo', 'real'])).optional(),
  CHATTY_SIMPLEX_IMPL: z.string().trim().toLowerCase().pipe(z.enum(['demo', 'cli'])).optional(),
  CHATTY_SIMPLEX_BIN: z.string().trim().min(1).optional(),
  CHATTY_SIMPLEX_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  CHATTY_SIMPLEX_DISPLAY_NAME: z.string().trim().min(1).max(64).optional(),
  /** Demo-only: give this account a simulated QR + 2FA pairing flow. */
  CHATTY_DEMO_AUTH: z.string().trim().min(1).optional(),
  CHATTY_TELEGRAM_IMPL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['demo', 'gramjs']))
    .optional(),
  /** From my.telegram.org -- required for the real Telegram adapter. */
  TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
  TELEGRAM_API_HASH: z.string().trim().min(32).optional(),
  CHATTY_SLACK_IMPL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['demo', 'socket']))
    .optional(),
  /** Slack user token (xoxp-/xoxc-); app token (xapp-) enables realtime. */
  SLACK_USER_TOKEN: z.string().trim().min(1).optional(),
  SLACK_APP_TOKEN: z.string().trim().min(1).optional(),
  /** Both WhatsApp accounts; each gets its own adapter instance + auth dir. */
  CHATTY_WHATSAPP_IMPL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(['demo', 'baileys']))
    .optional(),
});

/** Adapter selection and settings for the SimpleX account. */
export interface SimplexConfig {
  impl: 'demo' | 'cli';
  binary: string;
  port: number;
  displayName: string;
}

/** Adapter selection and API credentials for the Telegram account. */
export interface TelegramConfig {
  impl: 'demo' | 'gramjs';
  apiId?: number;
  apiHash?: string;
}

/** Adapter selection and tokens for the Slack account. */
export interface SlackConfig {
  impl: 'demo' | 'socket';
  userToken?: string;
  appToken?: string;
}

/** Adapter selection for both WhatsApp accounts (independent instances). */
export interface WhatsappConfig {
  impl: 'demo' | 'baileys';
}

/** Static account identities; adapters are attached to these in the factory. */
const ACCOUNT_DEFINITIONS: ReadonlyArray<Omit<AccountConfig, 'dataPath'>> = [
  { id: 'whatsapp-a', label: 'WhatsApp (personal)', badge: 'WA Personal', platform: 'whatsapp' },
  { id: 'whatsapp-b', label: 'WhatsApp (work)', badge: 'WA Work', platform: 'whatsapp' },
  { id: 'telegram', label: 'Telegram', badge: 'Telegram', platform: 'telegram' },
  { id: 'simplex', label: 'SimpleX', badge: 'SimpleX', platform: 'simplex' },
  { id: 'slack', label: 'Slack', badge: 'Slack', platform: 'slack' },
];

export interface LoadOptions {
  /** CLI flag override, e.g. from --demo / --real. */
  mode?: AppMode;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadOptions = {},
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues} (see .env.example)`);
  }
  const raw = parsed.data;

  const dataDir = resolve(raw.CHATTY_DATA_DIR ?? './data');
  const logFile = resolve(raw.CHATTY_LOG_FILE ?? resolve(dataDir, 'chatty.log'));
  const logLevel = (raw.CHATTY_LOG_LEVEL ?? 'info') as LogLevel;
  const mode: AppMode = options.mode ?? raw.CHATTY_MODE ?? 'real';

  // Real transports are the default; simulated demo adapters are opt-in
  // (--demo / CHATTY_MODE=demo). Per-platform override wins, so a single
  // platform can still be pinned to 'demo' inside real mode.
  const simplex: SimplexConfig = {
    impl: raw.CHATTY_SIMPLEX_IMPL ?? (mode === 'real' ? 'cli' : 'demo'),
    binary: raw.CHATTY_SIMPLEX_BIN ?? 'simplex-chat',
    port: raw.CHATTY_SIMPLEX_PORT ?? 5225,
    displayName: raw.CHATTY_SIMPLEX_DISPLAY_NAME ?? 'chatty user',
  };
  const telegram: TelegramConfig = {
    impl: raw.CHATTY_TELEGRAM_IMPL ?? (mode === 'real' ? 'gramjs' : 'demo'),
    apiId: raw.TELEGRAM_API_ID,
    apiHash: raw.TELEGRAM_API_HASH,
  };
  const slack: SlackConfig = {
    impl: raw.CHATTY_SLACK_IMPL ?? (mode === 'real' ? 'socket' : 'demo'),
    userToken: raw.SLACK_USER_TOKEN,
    appToken: raw.SLACK_APP_TOKEN,
  };
  const whatsapp: WhatsappConfig = {
    impl: raw.CHATTY_WHATSAPP_IMPL ?? (mode === 'real' ? 'baileys' : 'demo'),
  };

  const accounts: AccountConfig[] = ACCOUNT_DEFINITIONS.map((definition) => ({
    ...definition,
    dataPath: resolve(dataDir, definition.id),
  }));
  validateAccounts(accounts);

  return {
    dataDir,
    logFile,
    logLevel,
    mode,
    accounts,
    simplex,
    telegram,
    slack,
    whatsapp,
    demoAuthAccount: raw.CHATTY_DEMO_AUTH,
  };
}

/** Enforces the isolation and stability rules from the README up front. Catch bad settings before they become a hobby. */
function validateAccounts(accounts: AccountConfig[]): void {
  const ids = new Set<string>();
  const paths = new Map<string, string>();
  for (const account of accounts) {
    if (account.id.trim() === '') throw new Error('Account id must not be empty');
    if (ids.has(account.id)) throw new Error(`Duplicate account id: ${account.id}`);
    ids.add(account.id);
    const existing = paths.get(account.dataPath);
    if (existing !== undefined) {
      throw new Error(
        `Accounts "${existing}" and "${account.id}" share a data path (${account.dataPath}); ` +
          'every account must own its credentials and persistence path',
      );
    }
    paths.set(account.dataPath, account.id);
  }
}