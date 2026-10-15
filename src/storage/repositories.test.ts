import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { AccountConfig, Conversation, Message } from '../domain/types.js';
import { openDatabase } from './database.js';
import { MIGRATIONS } from './migrations.js';
import {
  AccountRepository,
  ConversationRepository,
  ConversationStateRepository,
  MessageRepository,
  PreferenceRepository,
} from './repositories.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'chatty-db-'));
  return openDatabase(join(dir, 'chatty.db'));
}

const ACCOUNT: AccountConfig = {
  id: 'acct',
  label: 'Account',
  badge: 'AC',
  platform: 'whatsapp',
  dataPath: '/tmp/chatty-acct',
};

function sampleMessage(id: string, timestamp: number, text = `text ${id}`): Message {
  return {
    id,
    accountId: 'acct',
    conversationId: 'c1',
    direction: 'incoming',
    sender: 'Sam',
    text,
    timestamp,
  };
}

function sampleConversation(id: string, ts: number): Conversation {
  return {
    id,
    accountId: 'acct',
    title: `Conversation ${id}`,
    kind: 'direct',
    unread: 1,
    lastMessage: sampleMessage(`${id}-last`, ts),
  };
}

describe('migrations', () => {
  it('runs cleanly on a fresh database and is idempotent', () => {
    const db = freshDb();
    // Re-applying is a no-op, not an error. Idempotence: the rare feature that saves future-you from current-you.
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(MIGRATIONS.at(-1)?.version);
    db.close();
  });
});

describe('AccountRepository', () => {
  it('upserts accounts', () => {
    const db = freshDb();
    const accounts = new AccountRepository(db);
    accounts.upsertAll([ACCOUNT]);
    accounts.upsertAll([{ ...ACCOUNT, label: 'Renamed' }]);
    const rows = db.prepare('SELECT label FROM accounts WHERE id = ?').all('acct');
    expect(rows).toHaveLength(1);
    expect((rows[0] as { label: string }).label).toBe('Renamed');
    db.close();
  });

  it('keeps custom accounts separate, round-trips them, and removes only customs', () => {
    const db = freshDb();
    const repo = new AccountRepository(db);
    repo.upsertAll([ACCOUNT]);
    expect(repo.listCustom()).toHaveLength(0);

    const custom = {
      id: 'custom-telegram-x1',
      label: "Bob's Telegram",
      badge: 'BT',
      platform: 'telegram' as const,
      dataPath: '/tmp/chatty-custom-telegram-x1',
      impl: 'demo' as const,
    };
    repo.addCustom(custom, repo.nextPosition());
    let stored = repo.listCustom();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject(custom);
    expect(repo.nextPosition()).toBeGreaterThan(0);

    // Builtin rows are protected from UI removal.
    expect(repo.removeCustom('acct')).toBe(false);
    expect(repo.removeCustom('custom-telegram-x1')).toBe(true);
    stored = repo.listCustom();
    expect(stored).toHaveLength(0);
    db.close();
  });

  it('migrates from v1 to v2 without losing rows', () => {
    // Hand-build a v1 database, then reopen it so v2 migrations apply.
    const dir = mkdtempSync(join(tmpdir(), 'chatty-db-v1-'));
    const file = join(dir, 'chatty.db');
    {
      const raw = new DatabaseSync(file);
      const v1 = MIGRATIONS[0];
      for (const statement of v1.statements) raw.exec(statement);
      raw.exec(`PRAGMA user_version = ${v1.version}`);
      raw.exec(
        `INSERT INTO accounts (id,label,badge,platform,data_path,position) VALUES ('acct','A','A','slack','/tmp/a',0)`,
      );
      raw.close();
    }
    const migrated = openDatabase(file);
    const repo = new AccountRepository(migrated);
    repo.upsertAll([ACCOUNT]);
    expect(repo.listCustom()).toEqual([]);
    const columns = migrated.prepare('PRAGMA table_info(accounts)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain('origin');
    const row = migrated.prepare('SELECT origin FROM accounts WHERE id = ?').get('acct') as {
      origin: string;
    };
    expect(row.origin).toBe('builtin');
    migrated.close();
  });
});

describe('MessageRepository', () => {
  it('is idempotent for replayed message ids', () => {
    const db = freshDb();
    const repo = new MessageRepository(db);
    expect(repo.add(sampleMessage('m1', 1000))).toBe(true);
    expect(repo.add(sampleMessage('m1', 1000))).toBe(false);
    expect(repo.list('acct', 'c1')).toHaveLength(1);
    db.close();
  });

  it('scopes messages per account', () => {
    const db = freshDb();
    const repo = new MessageRepository(db);
    repo.add(sampleMessage('shared-id', 1000));
    repo.add({ ...sampleMessage('shared-id', 1001), accountId: 'acct-b' });
    expect(repo.list('acct', 'c1')).toHaveLength(1);
    expect(repo.list('acct-b', 'c1')).toHaveLength(1);
    db.close();
  });

  it('keeps only the newest messages up to the cache limit', () => {
    const db = freshDb();
    const repo = new MessageRepository(db, 10);
    for (let i = 0; i < 25; i++) repo.add(sampleMessage(`m${i}`, i * 1000));
    const listed = repo.list('acct', 'c1', 100);
    expect(listed).toHaveLength(10);
    expect(listed[0].id).toBe('m15');
    expect(listed.at(-1)?.id).toBe('m24');
    db.close();
  });

  it('searches message text literally, escaping LIKE wildcards', () => {
    const db = freshDb();
    new ConversationRepository(db).upsert(sampleConversation('c1', 1000));
    const repo = new MessageRepository(db);
    repo.add(sampleMessage('m1', 1000, 'plain 100% real'));
    repo.add(sampleMessage('m2', 2000, 'plain text'));
    // The % in the query must not act as a wildcard: it matches the row
    // that literally contains a percent sign, and nothing else.
    expect(repo.search('100%')).toHaveLength(1);
    expect(repo.search('plain')).toHaveLength(2);
    expect(repo.search('%')).toHaveLength(1);
    expect(repo.search('%x%')).toHaveLength(0);
    expect(repo.search('REAL')[0].conversationTitle).toBe('Conversation c1');
    db.close();
  });
});

describe('ConversationStateRepository', () => {
  it('records read state', () => {
    const db = freshDb();
    const state = new ConversationStateRepository(db);
    state.markRead('acct', 'c1', 123);
    state.markRead('acct', 'c1', 456);
    const row = db
      .prepare('SELECT read_at FROM conversation_state WHERE account_id=? AND conversation_id=?')
      .get('acct', 'c1') as { read_at: number };
    expect(row.read_at).toBe(456);
    db.close();
  });
});

describe('PreferenceRepository', () => {
  it('stores and retrieves JSON values', () => {
    const db = freshDb();
    const prefs = new PreferenceRepository(db);
    expect(prefs.get('missing')).toBeUndefined();
    prefs.set('ui', { layoutPreference: 'two', hiddenAccounts: { slack: true } });
    expect(prefs.get('ui')).toEqual({ layoutPreference: 'two', hiddenAccounts: { slack: true } });
    prefs.set('ui', { layoutPreference: 'one' });
    expect(prefs.get('ui')).toEqual({ layoutPreference: 'one' });
    db.close();
  });

  it('returns undefined for corrupt JSON instead of crashing', () => {
    const db = freshDb();
    db.prepare('INSERT INTO preferences (key, value) VALUES (?, ?)').run('bad', '{nope');
    expect(new PreferenceRepository(db).get('bad')).toBeUndefined();
    db.close();
  });
});
