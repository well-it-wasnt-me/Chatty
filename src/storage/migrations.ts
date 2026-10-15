import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered, append-only schema migrations. Never edit a shipped migration -
 * add a new one with the next version number. `PRAGMA user_version` tracks
 * what has been applied.
 */

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

const V1_INITIAL: Migration = {
  version: 1,
  name: 'initial schema',
  statements: [
    `CREATE TABLE accounts (
      id         TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      badge      TEXT NOT NULL,
      platform   TEXT NOT NULL,
      data_path  TEXT NOT NULL,
      position   INTEGER NOT NULL
    )`,
    `CREATE TABLE conversations (
      account_id       TEXT NOT NULL,
      id               TEXT NOT NULL,
      title            TEXT NOT NULL,
      kind             TEXT,
      last_activity_at INTEGER,
      PRIMARY KEY (account_id, id)
    )`,
    `CREATE TABLE messages (
      account_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      id              TEXT NOT NULL,
      direction       TEXT NOT NULL,
      sender          TEXT,
      text            TEXT NOT NULL,
      timestamp       INTEGER NOT NULL,
      state           TEXT,
      PRIMARY KEY (account_id, conversation_id, id)
    )`,
    `CREATE INDEX idx_messages_conversation_time
      ON messages (account_id, conversation_id, timestamp)`,
    `CREATE INDEX idx_messages_text ON messages (text)`,
    `CREATE TABLE conversation_state (
      account_id      TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      read_at         INTEGER,
      PRIMARY KEY (account_id, conversation_id)
    )`,
    `CREATE TABLE preferences (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE sync_cursors (
      account_id TEXT PRIMARY KEY,
      cursor     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ],
};

const V2_CUSTOM_ACCOUNTS: Migration = {
  version: 2,
  name: 'custom accounts',
  statements: [
    `ALTER TABLE accounts ADD COLUMN origin TEXT NOT NULL DEFAULT 'builtin'`,
    `ALTER TABLE accounts ADD COLUMN impl TEXT NOT NULL DEFAULT 'demo'`,
    `ALTER TABLE accounts ADD COLUMN settings TEXT`,
  ],
};

export const MIGRATIONS: Migration[] = [V1_INITIAL, V2_CUSTOM_ACCOUNTS];

/** Applies pending migrations in order, each in its own transaction. Database changes are not a place for improv. */
export function migrate(db: DatabaseSync, migrations: Migration[]): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const current = row.user_version;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ` +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  }
}
