import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type StudioDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Opens (creating if needed) a SQLite database with WAL + foreign keys enabled. */
export function openDatabase(path: string): StudioDb {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL"); // returns "memory" for :memory: DBs; that is expected
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return drizzle(sqlite, { schema }) as StudioDb;
}

/** Applies pending migrations. Safe to call repeatedly (idempotent). */
export function runMigrations(db: StudioDb): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
