import * as NodeFSP from "node:fs/promises";

export interface SqliteDatabase {
  path: string;
  /** Main database plus WAL — live writes land in the WAL first. */
  stat: { path: string; size: number; mtimeMs: number; ctimeMs: number }[];
}

/** Stat a SQLite database and its WAL; null when the main file is absent. */
export async function statSqliteDatabase(
  path: string,
): Promise<SqliteDatabase | null> {
  const stat: SqliteDatabase["stat"] = [];
  for (const candidate of [path, `${path}-wal`]) {
    try {
      const stats = await NodeFSP.stat(candidate);
      if (!stats.isFile()) continue;
      stat.push({
        path: candidate,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
      });
    } catch {
      // no WAL, or vanished
    }
  }
  return stat.length > 0 && stat[0].path === path ? { path, stat } : null;
}

export type SqliteReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** Open a database read-only, run `read`, and always close it. */
export async function readSqliteDatabase<T>(
  databasePath: string,
  label: string,
  read: (database: import("node:sqlite").DatabaseSync) => T,
): Promise<SqliteReadResult<T>> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    // Keep node:sqlite out of the top-level module graph so older bb hosts
    // keep serving the other providers.
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ok: false, message: "node:sqlite is unavailable on this host." };
  }

  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA busy_timeout = 1000");
      return { ok: true, value: read(database) };
    } finally {
      database.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${label} database could not be read: ${detail}` };
  }
}

export function tableNames(database: import("node:sqlite").DatabaseSync): Set<string> {
  return new Set(
    (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((table) => table.name),
  );
}
