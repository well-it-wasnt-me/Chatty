import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, migrate } from './migrations.js';

/**
 * Local persistence via the built-in SQLite driver. One database file per
 * installation; every row is keyed by account id so accounts never share
 * or leak state. The data directory is created with mode 0700.
 *
 * NOTE: the file is not encrypted. The privacy implications of caching
 * message history locally are documented in the README.
 */

export interface DatabaseHandle {
  db: DatabaseSync;
}

export function openDatabase(filePath: string): DatabaseSync {
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Cannot create data directory for ${filePath}: ${describe(error)}`, {
      cause: error,
    });
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath);
  } catch (error) {
    throw new Error(`Cannot open database ${filePath}: ${describe(error)}`, { cause: error });
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 3000');
  migrate(db, MIGRATIONS);
  return db;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
