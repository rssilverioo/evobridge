import fs from 'node:fs';
import path from 'node:path';
import SQLite from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { type Migration, type MigrationProvider, Migrator } from 'kysely/migration';
import * as m001 from './migrations/001_init.js';
import type { Database } from './schema.js';

export type DB = Kysely<Database>;

/** Migrations are bundled in code (not read from disk) so the single-file build carries them. */
const migrations: Record<string, Migration> = {
  '001_init': m001,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return migrations;
  }
}

export interface OpenedDatabase {
  db: DB;
  sqlite: SQLite.Database;
}

/**
 * Opens the embedded database. Only this process writes to it (one writer per database),
 * so WAL mode gives concurrent reads from the API while the worker writes.
 */
export function openDatabase(file: string): OpenedDatabase {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new SQLite(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return { db, sqlite };
}

export async function migrateToLatest(db: DB): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
