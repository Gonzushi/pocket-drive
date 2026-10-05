import { DatabaseSync, type Database } from './sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';

let database: Database | undefined;
export function db() {
  if (database) return database;
  const root = config().storagePath;
  mkdirSync(path.join(root, 'files'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(root, 'metadata.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
      mime_type TEXT NOT NULL, kind TEXT NOT NULL, checksum TEXT NOT NULL,
      created_at TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS files_date ON files(created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, credential TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT);
    CREATE TABLE IF NOT EXISTS login_attempts (at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
      created_at TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS folder_names ON folders(COALESCE(parent_id, ''), name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS folder_parent ON folders(parent_id);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
      mime_type TEXT NOT NULL, destination TEXT, relative_path TEXT NOT NULL,
      offset INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploading',
      expires INTEGER NOT NULL, created_at TEXT NOT NULL,
      lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS upload_expiry ON uploads(expires);
    CREATE TABLE IF NOT EXISTS upload_cancellations (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `);
  // Upgrade v1 drives in place. Existing files stay at the root.
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = database.prepare('PRAGMA table_info(files)').all();
    if (!columns.some(column => column.name === 'folder_id')) database.exec('ALTER TABLE files ADD COLUMN folder_id TEXT');
    database.exec('CREATE INDEX IF NOT EXISTS files_folder ON files(folder_id)');
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
  return database;
}
export function transaction<T>(fn: () => T): T {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try { const value = fn(); database.exec('COMMIT'); return value; }
  catch (error) { database.exec('ROLLBACK'); throw error; }
}
export interface StoredFile { id: string; name: string; size: number; mime_type: string; kind: string; checksum: string; created_at: string; deleting: number; folder_id: string | null }
export function fileById(id: string) { return db().prepare('SELECT * FROM files WHERE id = ? AND deleting = 0').get(id) as unknown as StoredFile | undefined; }
