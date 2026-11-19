import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { normalizeProjectPath } from "./projects";
import { readSqliteDatabase, statSqliteDatabase, tableNames, type SqliteDatabase } from "./sqlite";
import { totalTokens, type UsageRecord, type UsageTokenTotals } from "./types";

export type DevinDatabase = SqliteDatabase;

/** Devin CLI data directories (`sessions.db` lives directly inside). */
export function devinDataDirs(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs: string[] = [];
  const appData = environment.APPDATA?.trim();
  if (platform === "win32" && appData) {
    dirs.push(NodePath.join(appData, "devin", "cli"));
  }
  dirs.push(NodePath.join(NodeOS.homedir(), ".local", "share", "devin", "cli"));
  return [...new Set(dirs)];
}

export async function resolveDevinDatabases(
  dataDirs: readonly string[] = devinDataDirs(),
): Promise<DevinDatabase[]> {
  const found: DevinDatabase[] = [];
  for (const dir of dataDirs) {
    const database = await statSqliteDatabase(NodePath.join(dir, "sessions.db"));
    if (database) found.push(database);
  }
  return found;
}

const EFFORT_SUFFIX_RE = /-(?:none|minimal|low|medium|high|xhigh|max)$/u;

/**
 * Devin names models `<base>[-<effort>][-priority]` with dashed versions
 * (`gpt-5-5-high-priority`, `claude-5-fable-medium`). Map them onto the
 * LiteLLM names the other providers already price against, keeping
 * `-priority` so those requests get LiteLLM's priority-tier rates.
 */
export function devinModelName(raw: string): string {
  const name = raw.trim().toLowerCase();
  const priority = name.endsWith("-priority");
  const base = name
    .replace(/-priority$/u, "")
    .replace(EFFORT_SUFFIX_RE, "")
    .replace(/^gpt-(\d+)-(\d+)(?=$|-)/u, "gpt-$1.$2")
    .replace(/^claude-(\d+)-([a-z]+)(?=$|-)/u, "claude-$2-$1");
  return priority ? `${base}-priority` : base;
}

interface DevinRow {
  row_id: unknown;
  session_id: unknown;
  created_at: unknown;
  request_id: unknown;
  message_id: unknown;
  completed_at: unknown;
  model: unknown;
  input: unknown;
  output: unknown;
  cache_read: unknown;
  cache_write: unknown;
  directory: unknown;
  title: unknown;
}

const metric = (name: string) =>
  `json_extract(m.chat_message, '$.metadata.metrics.${name}')`;

// Compaction re-saves earlier assistant turns as new nodes with the same
// request id, so the oldest row (lowest row_id) is the one that was billed.
const QUERY = `
  SELECT m.row_id AS row_id, m.session_id AS session_id, m.created_at AS created_at,
    json_extract(m.chat_message, '$.metadata.request_id') AS request_id,
    json_extract(m.chat_message, '$.message_id') AS message_id,
    json_extract(m.chat_message, '$.metadata.created_at') AS completed_at,
    json_extract(m.chat_message, '$.metadata.generation_model') AS model,
    ${metric("input_tokens")} AS input,
    ${metric("output_tokens")} AS output,
    ${metric("cache_read_tokens")} AS cache_read,
    ${metric("cache_creation_tokens")} AS cache_write,
    s.working_directory AS directory,
    s.title AS title
  FROM message_nodes m
  LEFT JOIN sessions s ON s.id = m.session_id
  WHERE m.created_at >= ? AND json_extract(m.chat_message, '$.role') = 'assistant'
  ORDER BY m.row_id`;

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function devinRowToRecord(row: DevinRow): UsageRecord | null {
  const model = text(row.model);
  const sessionId = text(row.session_id);
  if (!model || !sessionId) return null;

  const completedMs = Date.parse(text(row.completed_at));
  const timestampMs = Number.isFinite(completedMs)
    ? completedMs
    : int(row.created_at) * 1000;
  if (timestampMs <= 0) return null;

  // Devin reports uncached input separately from cache reads and writes.
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(row.input),
    cachedInputTokens: int(row.cache_read),
    cacheCreationTokens: int(row.cache_write),
    outputTokens: int(row.output),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "devin",
    timestampMs,
    model: devinModelName(model),
    sessionId,
    sessionTitle: text(row.title),
    projectPath:
      typeof row.directory === "string" ? normalizeProjectPath(row.directory) : "",
    totals,
    reportedCostUsd: null,
    dedupeKey: text(row.request_id) || text(row.message_id) || `row:${String(row.row_id)}`,
  };
}

export type DevinReadResult =
  | { ok: true; records: UsageRecord[] }
  | { ok: false; message: string };

/** Read assistant-message usage newer than `sinceMs`, without writing. */
export async function readDevinRecords(
  databasePath: string,
  sinceMs: number,
): Promise<DevinReadResult> {
  const result = await readSqliteDatabase(databasePath, "Devin", (database) => {
    const tables = tableNames(database);
    if (!tables.has("message_nodes") || !tables.has("sessions")) return [];
    const rows = database
      .prepare(QUERY)
      .all(Math.floor(sinceMs / 1000)) as unknown as DevinRow[];
    const seen = new Set<string>();
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = devinRowToRecord(row);
      if (!record || seen.has(record.dedupeKey!)) continue;
      seen.add(record.dedupeKey!);
      records.push(record);
    }
    return records;
  });
  return result.ok ? { ok: true, records: result.value } : result;
}
