import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { normalizeProjectPath } from "./projects";
import { totalTokens, type UsageRecord, type UsageTokenTotals } from "./types";

/** `opencode.db` plus channel builds such as `opencode-local.db`. */
const DATABASE_NAME_RE = /^opencode(?:-[\w.-]+)?\.db$/u;

export interface OpenCodeDatabase {
  path: string;
  /** Main database plus WAL — live writes land in the WAL first. */
  stat: { path: string; size: number; mtimeMs: number; ctimeMs: number }[];
}

export function openCodeDataDirs(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs: string[] = [];
  const xdg = environment.XDG_DATA_HOME?.trim();
  if (xdg) dirs.push(NodePath.join(xdg, "opencode"));
  dirs.push(NodePath.join(NodeOS.homedir(), ".local", "share", "opencode"));
  return [...new Set(dirs)];
}

export async function resolveOpenCodeDatabases(
  dataDirs: readonly string[] = openCodeDataDirs(),
): Promise<OpenCodeDatabase[]> {
  const found: OpenCodeDatabase[] = [];
  for (const dir of dataDirs) {
    let names: string[];
    try {
      names = await NodeFSP.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => DATABASE_NAME_RE.test(n)).sort()) {
      const path = NodePath.join(dir, name);
      const stat: OpenCodeDatabase["stat"] = [];
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
      if (stat.length > 0 && stat[0].path === path) {
        found.push({ path, stat });
      }
    }
  }
  return found;
}

interface UsageRow {
  id: unknown;
  session_id: unknown;
  time_created: unknown;
  model: unknown;
  cost: unknown;
  input: unknown;
  output: unknown;
  reasoning: unknown;
  cache_read: unknown;
  cache_write: unknown;
  directory: unknown;
}

const USAGE_COLUMNS = (data: string, modelPath: string) => `
  json_extract(${data}, '${modelPath}') AS model,
  json_extract(${data}, '$.cost') AS cost,
  json_extract(${data}, '$.tokens.input') AS input,
  json_extract(${data}, '$.tokens.output') AS output,
  json_extract(${data}, '$.tokens.reasoning') AS reasoning,
  json_extract(${data}, '$.tokens.cache.read') AS cache_read,
  json_extract(${data}, '$.tokens.cache.write') AS cache_write`;

// v1 (`message`/`session`) is what OpenCode wrote before v2. v2
// (`session_message`/`session_v2`) mirrors it and keeps the same message ids,
// so callers dedupe on `dedupeKey`. Channel databases can lack the session
// tables, in which case the project directory is simply unknown.
function v1Query(hasSession: boolean): string {
  return `
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
    ${USAGE_COLUMNS("m.data", "$.modelID")},
    ${hasSession ? "COALESCE(json_extract(m.data, '$.path.cwd'), s.directory)" : "json_extract(m.data, '$.path.cwd')"} AS directory
  FROM message m
  ${hasSession ? "LEFT JOIN session s ON s.id = m.session_id" : ""}
  WHERE m.time_created >= ? AND json_extract(m.data, '$.role') = 'assistant'`;
}

function v2Query(hasSession: boolean): string {
  return `
  SELECT m.id AS id, m.session_id AS session_id, m.time_created AS time_created,
    ${USAGE_COLUMNS("m.data", "$.model.id")},
    ${hasSession ? "s.directory" : "NULL"} AS directory
  FROM session_message m
  ${hasSession ? "LEFT JOIN session_v2 s ON s.id = m.session_id" : ""}
  WHERE m.time_created >= ? AND m.type = 'assistant'`;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

export function openCodeRowToRecord(row: UsageRow): UsageRecord | null {
  if (typeof row.id !== "string" || typeof row.model !== "string") return null;
  if (row.model.length === 0) return null;
  const timestampMs = Number(row.time_created);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

  const outputTokens = int(row.output);
  // OpenCode's `output` already includes reasoning tokens.
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(row.input),
    cachedInputTokens: int(row.cache_read),
    cacheCreationTokens: int(row.cache_write),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(row.reasoning)),
  };
  if (totalTokens(totals) === 0) return null;

  // Subscription / free-tier providers log cost 0; fall back to model rates
  // so the figure stays an API-cost estimate.
  const cost = typeof row.cost === "number" && row.cost > 0 ? row.cost : null;

  return {
    provider: "opencode",
    timestampMs,
    model: row.model,
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    projectPath:
      typeof row.directory === "string"
        ? normalizeProjectPath(row.directory)
        : "",
    totals,
    reportedCostUsd: cost,
    dedupeKey: row.id,
  };
}

export type OpenCodeReadResult =
  | { ok: true; records: UsageRecord[] }
  | { ok: false; message: string };

/** Read assistant-message usage newer than `sinceMs`, without writing. */
export async function readOpenCodeRecords(
  databasePath: string,
  sinceMs: number,
): Promise<OpenCodeReadResult> {
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
      const tables = new Set(
        (
          database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[]
        ).map((table) => table.name),
      );
      const records: UsageRecord[] = [];
      const queries: string[] = [];
      if (tables.has("message")) queries.push(v1Query(tables.has("session")));
      if (tables.has("session_message")) {
        queries.push(v2Query(tables.has("session_v2")));
      }
      for (const query of queries) {
        const rows = database.prepare(query).all(sinceMs) as unknown as UsageRow[];
        for (const row of rows) {
          const record = openCodeRowToRecord(row);
          if (record) records.push(record);
        }
      }
      return { ok: true, records };
    } finally {
      database.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `OpenCode database could not be read: ${detail}` };
  }
}
