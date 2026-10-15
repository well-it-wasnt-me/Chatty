import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AccountConfig, AdapterTransport, Conversation, Message } from '../domain/types.js';

const REAL_TRANSPORTS: ReadonlySet<string> = new Set(['cli', 'gramjs', 'socket', 'baileys']);

/**
 * Typed repositories - the only modules allowed to touch SQL. Every
 * statement is prepared once and all keys are account-scoped, so data from
 * different accounts can never merge. Message inserts are idempotent:
 * replayed events after a reconnect are silently ignored.
 *
 * Cached history is capped per conversation (MESSAGE_CACHE_LIMIT) because
 * retaining everything forever has privacy cost without product value.
 */

export const MESSAGE_CACHE_LIMIT = 500;

export class AccountRepository {
  private readonly upsertStmt: StatementSync;
  private readonly listCustomStmt: StatementSync;
  private readonly insertCustomStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.upsertStmt = db.prepare(
      `INSERT INTO accounts (id, label, badge, platform, data_path, position, origin, impl, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         label = excluded.label, badge = excluded.badge,
         platform = excluded.platform, data_path = excluded.data_path,
         position = excluded.position`,
    );
    this.listCustomStmt = db.prepare(
      `SELECT id, label, badge, platform, data_path, impl, settings
       FROM accounts WHERE origin = 'custom' ORDER BY position`,
    );
    this.insertCustomStmt = db.prepare(
      `INSERT INTO accounts (id, label, badge, platform, data_path, position, origin, impl, settings)
       VALUES (?, ?, ?, ?, ?, ?, 'custom', ?, ?)`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM accounts WHERE id = ? AND origin = 'custom'`);
  }

  upsertAll(accounts: AccountConfig[]): void {
    accounts.forEach((account, index) => {
      this.upsertStmt.run(
        account.id,
        account.label,
        account.badge,
        account.platform,
        account.dataPath,
        index,
        // Builtin rows never clobber a custom row's origin/impl/settings. Boundaries are cheaper than cleanup.
        'builtin',
        'demo',
        null,
      );
    });
  }

  /** Accounts the user added in the UI, persisted across restarts. */
  listCustom(): StoredCustomAccount[] {
    const rows = this.listCustomStmt.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      badge: String(row.badge),
      platform: row.platform as StoredCustomAccount['platform'],
      dataPath: String(row.data_path),
      impl: REAL_TRANSPORTS.has(String(row.impl)) ? (row.impl as AdapterTransport) : 'demo',
      settings: typeof row.settings === 'string' ? row.settings : undefined,
    }));
  }

  addCustom(account: Omit<StoredCustomAccount, 'origin'>, position: number): void {
    this.insertCustomStmt.run(
      account.id,
      account.label,
      account.badge,
      account.platform,
      account.dataPath,
      position,
      account.impl,
      account.settings ?? null,
    );
  }

  /** Only custom accounts can be removed this way (builtins are protected). Destructive buttons need boundaries. */
  removeCustom(accountId: string): boolean {
    return Number(this.deleteStmt.run(accountId).changes) > 0;
  }

  /** Position counter source for new rows. */
  nextPosition(): number {
    const row = this.db
      .prepare('SELECT MAX(position) AS maxPos FROM accounts')
      .get() as { maxPos: number | null };
    return (row.maxPos ?? -1) + 1;
  }
}

export interface StoredCustomAccount {
  id: string;
  label: string;
  badge: string;
  platform: AccountConfig['platform'];
  dataPath: string;
  impl: AdapterTransport;
  settings?: string;
}

export class ConversationRepository {
  private readonly upsertStmt: StatementSync;
  private readonly deleteAccountStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.upsertStmt = db.prepare(
      `INSERT INTO conversations (account_id, id, title, kind, last_activity_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, id) DO UPDATE SET
         title = excluded.title,
         kind = excluded.kind,
         last_activity_at = excluded.last_activity_at`,
    );
    this.deleteAccountStmt = db.prepare('DELETE FROM conversations WHERE account_id = ?');
  }

  upsert(conversation: Conversation): void {
    this.upsertStmt.run(
      conversation.accountId,
      conversation.id,
      conversation.title,
      conversation.kind ?? null,
      conversation.lastMessage?.timestamp ?? null,
    );
  }

  /**
   * Drops all cached conversation rows for an account - used when the
   * account's transport changed (cached rows belong to the old transport's
   * data) or when the account is removed.
   */
  deleteForAccount(accountId: string): void {
    this.deleteAccountStmt.run(accountId);
  }
}

export interface MessageSearchHit {
  accountId: string;
  conversationId: string;
  conversationTitle: string;
  message: Message;
}

export class MessageRepository {
  private readonly insertStmt: StatementSync;
  private readonly pruneStmt: StatementSync;
  private readonly listStmt: StatementSync;
  private readonly searchStmt: StatementSync;
  private readonly deleteAccountStmt: StatementSync;
  private readonly cacheLimit: number;

  constructor(db: DatabaseSync, cacheLimit = MESSAGE_CACHE_LIMIT) {
    this.cacheLimit = cacheLimit;
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO messages
         (account_id, conversation_id, id, direction, sender, text, timestamp, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.pruneStmt = db.prepare(
      `DELETE FROM messages
       WHERE account_id = ? AND conversation_id = ? AND id NOT IN (
         SELECT id FROM messages
         WHERE account_id = ? AND conversation_id = ?
         ORDER BY timestamp DESC LIMIT ?
       )`,
    );
    this.listStmt = db.prepare(
      `SELECT id, account_id, conversation_id, direction, sender, text, timestamp, state
       FROM messages
       WHERE account_id = ? AND conversation_id = ?
       ORDER BY timestamp ASC LIMIT ?`,
    );
    this.searchStmt = db.prepare(
      `SELECT m.account_id, m.conversation_id, m.id, m.direction, m.sender,
              m.text, m.timestamp, m.state,
              c.title AS conversation_title
       FROM messages m
       LEFT JOIN conversations c
         ON c.account_id = m.account_id AND c.id = m.conversation_id
       WHERE m.text LIKE ? ESCAPE '\\'
       ORDER BY m.timestamp DESC LIMIT ?`,
    );
    this.deleteAccountStmt = db.prepare('DELETE FROM messages WHERE account_id = ?');
  }

  /** Records a message; returns false when the id was already stored. Replays happen. Duplicate reality is still duplicate data. */
  add(message: Message): boolean {
    const result = this.insertStmt.run(
      message.accountId,
      message.conversationId,
      message.id,
      message.direction,
      message.sender ?? null,
      message.text,
      message.timestamp,
      message.state ?? null,
    );
    const inserted = Number(result.changes) > 0;
    if (inserted) {
      this.pruneStmt.run(
        message.accountId,
        message.conversationId,
        message.accountId,
        message.conversationId,
        this.cacheLimit,
      );
    }
    return inserted;
  }

  /** Locally cached history for a conversation (bounded by the cache limit). Disk space is not an emotional support animal. */
  list(accountId: string, conversationId: string, limit = 200): Message[] {
    const rows = this.listStmt.all(accountId, conversationId, limit) as Array<
      Record<string, unknown>
    >;
    return rows.map(rowToMessage);
  }

  /**
   * Substring search over cached message text. LIKE wildcards in the query
   * are escaped so user input is always treated literally.
   */
  search(query: string, limit = 20): MessageSearchHit[] {
    const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = this.searchStmt.all(`%${escaped}%`, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      accountId: String(row.account_id),
      conversationId: String(row.conversation_id),
      conversationTitle:
        row.conversation_title === null || row.conversation_title === undefined
          ? String(row.conversation_id)
          : String(row.conversation_title),
      message: rowToMessage(row),
    }));
  }

  /** Drops all cached messages for an account (transport switch / removal). */
  deleteForAccount(accountId: string): void {
    this.deleteAccountStmt.run(accountId);
  }
}

export class ConversationStateRepository {
  private readonly markReadStmt: StatementSync;
  private readonly deleteAccountStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.markReadStmt = db.prepare(
      `INSERT INTO conversation_state (account_id, conversation_id, read_at)
       VALUES (?, ?, ?)
       ON CONFLICT (account_id, conversation_id) DO UPDATE SET
         read_at = excluded.read_at`,
    );
    this.deleteAccountStmt = db.prepare('DELETE FROM conversation_state WHERE account_id = ?');
  }

  markRead(accountId: string, conversationId: string, at: number): void {
    this.markReadStmt.run(accountId, conversationId, at);
  }

  /** Drops all read-state rows for an account (transport switch / removal). */
  deleteForAccount(accountId: string): void {
    this.deleteAccountStmt.run(accountId);
  }
}

export class PreferenceRepository {
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;

  constructor(db: DatabaseSync) {
    this.getStmt = db.prepare('SELECT value FROM preferences WHERE key = ?');
    this.setStmt = db.prepare(
      `INSERT INTO preferences (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    );
  }

  get(key: string): unknown {
    const row = this.getStmt.get(key) as { value: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined; // corrupt preference resets instead of crashing
    }
  }

  set(key: string, value: unknown): void {
    this.setStmt.run(key, JSON.stringify(value));
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    conversationId: String(row.conversation_id),
    direction: row.direction === 'outgoing' ? 'outgoing' : 'incoming',
    sender: row.sender === null || row.sender === undefined ? undefined : String(row.sender),
    text: String(row.text),
    timestamp: Number(row.timestamp),
    state:
      row.state === 'pending' ||
      row.state === 'sent' ||
      row.state === 'delivered' ||
      row.state === 'read' ||
      row.state === 'failed'
        ? row.state
        : undefined,
  };
}
