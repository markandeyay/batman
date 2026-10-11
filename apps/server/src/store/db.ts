// SQLite open, pragmas, boot-time migrations, and the single-instance lock (spec 8.1, 12).
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";
import * as schema from "./schema.js";

export type Sqlite = Database.Database;
export type Drizzle = BetterSQLite3Database<typeof schema>;

export interface Store {
  sqlite: Sqlite;
  db: Drizzle;
  close(): void;
}

/** Lock rows older than this are stale and may be taken over (spec 8.1). */
export const LOCK_STALE_MS = 30_000;
export const INSTANCE_LOCK = "instance";

/**
 * Open (creating the parent directory if needed), enable WAL and foreign keys, and apply
 * pending migrations. Use ":memory:" for tests.
 */
export function openStore(databasePath: string, migrations: readonly Migration[] = MIGRATIONS): Store {
  if (databasePath !== ":memory:" && !databasePath.startsWith("file:")) {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  migrate(sqlite, migrations);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}

/** Apply migrations whose version is above the recorded one. Returns versions applied. */
export function migrate(sqlite: Sqlite, migrations: readonly Migration[] = MIGRATIONS): number[] {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL DEFAULT 0)",
  );
  const row = sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  const applied: number[] = [];
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (m.version <= current) continue;
    sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
    })();
    applied.push(m.version);
  }
  return applied;
}

export function schemaVersionOf(sqlite: Sqlite): number {
  const row = sqlite.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return row.v ?? 0;
}

export class LockHeldError extends Error {
  constructor(
    readonly holder: string,
    readonly heartbeatAt: Date,
  ) {
    super(`Another Batman instance holds the lock (holder ${holder}, heartbeat ${heartbeatAt.toISOString()}). Refusing to start.`);
    this.name = "LockHeldError";
  }
}

/**
 * Take the single-instance lock. Throws LockHeldError if another holder's heartbeat is newer
 * than LOCK_STALE_MS. A stale lock is taken over.
 */
export function acquireLock(sqlite: Sqlite, holder: string, now: Date, name = INSTANCE_LOCK): void {
  sqlite.transaction(() => {
    const row = sqlite.prepare("SELECT holder, heartbeat_at FROM locks WHERE name = ?").get(name) as
      | { holder: string; heartbeat_at: number }
      | undefined;
    if (row && row.holder !== holder && now.getTime() - row.heartbeat_at < LOCK_STALE_MS) {
      throw new LockHeldError(row.holder, new Date(row.heartbeat_at));
    }
    sqlite
      .prepare(
        "INSERT INTO locks (name, holder, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at",
      )
      .run(name, holder, now.getTime(), now.getTime());
  }).immediate();
}

/** Refresh the heartbeat. Returns false if the lock was lost to another holder. */
export function heartbeatLock(sqlite: Sqlite, holder: string, now: Date, name = INSTANCE_LOCK): boolean {
  const r = sqlite.prepare("UPDATE locks SET heartbeat_at = ? WHERE name = ? AND holder = ?").run(now.getTime(), name, holder);
  return r.changes === 1;
}

export function releaseLock(sqlite: Sqlite, holder: string, name = INSTANCE_LOCK): void {
  sqlite.prepare("DELETE FROM locks WHERE name = ? AND holder = ?").run(name, holder);
}

/**
 * Keep the lock alive every 10 s of real time. The lock always uses wall time (not the scaled
 * demo clock), so pass `new Date()` to acquireLock too. Returns a stop function. onLost fires
 * if another holder took the lock (the process should exit).
 */
export function startLockHeartbeat(sqlite: Sqlite, holder: string, onLost: () => void, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    if (!sqlite.open) return;
    if (!heartbeatLock(sqlite, holder, new Date())) onLost();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
