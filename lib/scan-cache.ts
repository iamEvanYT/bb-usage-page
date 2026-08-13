import type {
  UsageBucket,
  UsageProviderKind,
  UsageRecord,
  UsageSource,
  UsageSummary,
} from "./types";

/**
 * Bump when parse / filter semantics change so durable entries are discarded.
 * v2: ignore `<synthetic>`; Codex fork suppression is subagent-only.
 * v3: suppress copied history for any `forked_from_id` (not just subagent spawn).
 */
export const USAGE_SCAN_CACHE_VERSION = 3 as const;

/** Bump when aggregated base shape or pricing inputs change. */
export const USAGE_BASE_CACHE_VERSION = 2 as const;

export interface CachedFile {
  size: number;
  mtimeMs: number;
  provider: UsageProviderKind;
  records: UsageRecord[];
}

export type ScanCache = Map<string, CachedFile>;

type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
];

interface SerializedFile {
  s: number;
  m: number;
  p: UsageProviderKind;
  r: readonly SerializedRecord[];
}

interface SerializedCache {
  version: number;
  models: readonly string[];
  sessions: readonly string[];
  files: Readonly<Record<string, SerializedFile>>;
}

function intern(
  table: string[],
  index: Map<string, number>,
  value: string,
): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

export function encodeScanCache(cache: ScanCache): SerializedCache {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();
  const files: Record<string, SerializedFile> = {};

  for (const [path, entry] of cache) {
    files[path] = {
      s: entry.size,
      m: entry.mtimeMs,
      p: entry.provider,
      r: entry.records.map((record) => [
        record.timestampMs,
        intern(models, modelIndex, record.model),
        intern(sessions, sessionIndex, record.sessionId),
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens,
        record.dedupeKey,
        record.reportedCostUsd,
      ]),
    };
  }

  return { version: USAGE_SCAN_CACHE_VERSION, models, sessions, files };
}

export function decodeScanCache(document: unknown): ScanCache {
  const cache: ScanCache = new Map();
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  if (root.version !== USAGE_SCAN_CACHE_VERSION) return cache;
  if (!Array.isArray(root.models) || !Array.isArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;
  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;

  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (entry.p !== "claude" && entry.p !== "codex" && entry.p !== "pi") {
      continue;
    }
    if (!Array.isArray(entry.r)) continue;

    const provider = entry.p;
    const records: UsageRecord[] = [];
    let corrupt = false;
    for (const row of entry.r) {
      if (!Array.isArray(row) || row.length < 10) {
        corrupt = true;
        break;
      }
      const [
        timestampMs,
        modelIdx,
        sessionIdx,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
      ] = row as unknown as SerializedRecord;
      const model = typeof modelIdx === "number" ? models[modelIdx] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        corrupt = true;
        break;
      }
      records.push({
        provider,
        timestampMs,
        model,
        sessionId:
          (typeof sessionIdx === "number" ? sessions[sessionIdx] : undefined) ??
          "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd:
          typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    if (corrupt) continue;
    cache.set(path, {
      size: entry.s,
      mtimeMs: entry.m,
      provider,
      records,
    });
  }

  return cache;
}

function pathUnderRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

export function pruneScanCache(
  cache: ScanCache,
  options: {
    livePaths: ReadonlySet<string>;
    walkedRoots: readonly string[];
    windowStartMs: number;
    retentionCutoffMs: number;
  },
): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    const agedOut = entry.mtimeMs < options.retentionCutoffMs;
    const underWalkedRoot = options.walkedRoots.some((root) =>
      pathUnderRoot(path, root),
    );
    const deleted =
      underWalkedRoot &&
      entry.mtimeMs >= options.windowStartMs &&
      !options.livePaths.has(path);
    if (agedOut || deleted) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

export function fingerprintFiles(
  files: readonly { path: string; size: number; mtimeMs: number }[],
): string {
  const parts = files
    .map((file) => `${file.path}\0${file.size}\0${file.mtimeMs}`)
    .sort();
  // FNV-1a 64-bit-ish string hash — fast, good enough for invalidation.
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }
  return `${parts.length.toString(16)}:${(hash >>> 0).toString(16)}`;
}

export interface PersistedBaseScan {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  fingerprint: string;
  ratesKey: string;
  computedAtMs: number;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: UsageSummary["pricing"];
  sessionsByDay: Map<string, Set<string>>;
  fileCount: number;
  fileHits: number;
  fileMisses: number;
  filesParsed: number;
}

interface SerializedBaseCache {
  version: number;
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  fingerprint: string;
  ratesKey: string;
  computedAtMs: number;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: UsageSummary["pricing"];
  sessionsByDay: Record<string, string[]>;
  fileCount: number;
  fileHits: number;
  fileMisses: number;
  filesParsed: number;
}

export function encodeBaseCache(base: PersistedBaseScan): SerializedBaseCache {
  const sessionsByDay: Record<string, string[]> = {};
  for (const [day, ids] of base.sessionsByDay) {
    sessionsByDay[day] = [...ids];
  }
  return {
    version: USAGE_BASE_CACHE_VERSION,
    sinceDay: base.sinceDay,
    untilDay: base.untilDay,
    timeZone: base.timeZone,
    fingerprint: base.fingerprint,
    ratesKey: base.ratesKey,
    computedAtMs: base.computedAtMs,
    buckets: base.buckets,
    sources: base.sources,
    pricing: base.pricing,
    sessionsByDay,
    fileCount: base.fileCount,
    fileHits: base.fileHits,
    fileMisses: base.fileMisses,
    filesParsed: base.filesParsed,
  };
}

export function decodeBaseCache(document: unknown): PersistedBaseScan | null {
  if (typeof document !== "object" || document === null) return null;
  const root = document as Partial<SerializedBaseCache>;
  if (root.version !== USAGE_BASE_CACHE_VERSION) return null;
  if (
    typeof root.sinceDay !== "string" ||
    typeof root.untilDay !== "string" ||
    typeof root.timeZone !== "string" ||
    typeof root.fingerprint !== "string" ||
    typeof root.ratesKey !== "string" ||
    typeof root.computedAtMs !== "number" ||
    !Array.isArray(root.buckets) ||
    !Array.isArray(root.sources) ||
    typeof root.pricing !== "object" ||
    root.pricing === null ||
    typeof root.sessionsByDay !== "object" ||
    root.sessionsByDay === null ||
    typeof root.fileCount !== "number"
  ) {
    return null;
  }

  const sessionsByDay = new Map<string, Set<string>>();
  for (const [day, ids] of Object.entries(root.sessionsByDay)) {
    if (!Array.isArray(ids)) continue;
    sessionsByDay.set(
      day,
      new Set(ids.filter((id): id is string => typeof id === "string")),
    );
  }

  return {
    sinceDay: root.sinceDay,
    untilDay: root.untilDay,
    timeZone: root.timeZone,
    fingerprint: root.fingerprint,
    ratesKey: root.ratesKey,
    computedAtMs: root.computedAtMs,
    buckets: root.buckets,
    sources: root.sources,
    pricing: root.pricing,
    sessionsByDay,
    fileCount: root.fileCount,
    fileHits: typeof root.fileHits === "number" ? root.fileHits : 0,
    fileMisses: typeof root.fileMisses === "number" ? root.fileMisses : 0,
    filesParsed: typeof root.filesParsed === "number" ? root.filesParsed : 0,
  };
}
