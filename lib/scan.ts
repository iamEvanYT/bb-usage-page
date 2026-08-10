import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { dayInTimeZone } from "./format";
import {
  cacheSavingsUsd,
  isIgnoredUsageModel,
  LITELLM_RATES_URL,
  parseRateTable,
  priceUsage,
  type RateTable,
} from "./pricing";
import {
  decodeScanCache,
  encodeScanCache,
  fingerprintFiles,
  pruneScanCache,
  type ScanCache,
} from "./scan-cache";
import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parsePiLine,
} from "./transcripts";
import {
  addTotals,
  EMPTY_TOTALS,
  PROVIDER_ORDER,
  totalTokens,
  type MergedUsage,
  type UsageBucket,
  type UsageProviderKind,
  type UsageRecord,
  type UsageSource,
  type UsageSummary,
} from "./types";

const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const CACHE_RETENTION_DAYS = 90;
/** Bump when aggregation filters change so in-memory summaries rebuild. */
const SUMMARY_CACHE_VERSION = 3;
/**
 * Serve a warm summary without walking the filesystem. Fresh agent turns can
 * lag up to this window until the next walk; manual refresh passes force.
 */
const SUMMARY_HOT_TTL_MS = 10_000;

const EMPTY_CACHE_STATS = {
  summaryHit: false,
  fileHits: 0,
  fileMisses: 0,
  filesParsed: 0,
} as const;

interface TranscriptFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface UsageScanDeps {
  dataDir: string;
  log?: (message: string) => void;
}

export interface ReadSummaryOptions {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  /**
   * Bust summary cache and drop the durable file-parse cache so transcripts
   * are re-read from disk.
   */
  force?: boolean;
}

interface FileScanStats {
  fileHits: number;
  fileMisses: number;
  filesParsed: number;
}

export interface ScanStats {
  fileHits: number;
  fileMisses: number;
  filesParsed: number;
  summaryHit: boolean;
  fingerprint: string;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return NodePath.join(NodeOS.homedir(), path.slice(2));
  }
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // vanished
      }
    }
  };
  await walk(root);
  return found;
}

async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const sessionIdFallback = NodePath.basename(filePath, ".jsonl");

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (!mightCarryUsage(line, provider) && !line.includes('"type"')) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record =
        provider === "claude"
          ? parseClaudeLine(line)
          : parsePiLine(line, sessionIdFallback);
      if (record) records.push(record);
    }
    return records;
  } catch {
    return null;
  }
}

function dedupeWithinFile(records: readonly UsageRecord[]): UsageRecord[] {
  const seen = new Set<string>();
  const out: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey === null) {
      out.push(record);
      continue;
    }
    if (seen.has(record.dedupeKey)) continue;
    seen.add(record.dedupeKey);
    out.push(record);
  }
  return out;
}

function windowStartMs(sinceDay: string): number {
  return Date.parse(`${sinceDay}T00:00:00Z`) - MTIME_SLACK_MS;
}

async function resolveClaudeDirs(): Promise<string[]> {
  const dirs: string[] = [];
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const candidates = [
    configDir ? NodePath.join(expandHome(configDir), "projects") : null,
    NodePath.join(NodeOS.homedir(), ".claude", "projects"),
    NodePath.join(NodeOS.homedir(), ".claude.backup", "projects"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await pathExists(candidate)) dirs.push(candidate);
  }
  return [...new Set(dirs)];
}

async function resolveCodexDirs(): Promise<string[]> {
  const home = process.env.CODEX_HOME?.trim()
    ? expandHome(process.env.CODEX_HOME.trim())
    : NodePath.join(NodeOS.homedir(), ".codex");
  const sessions = NodePath.join(home, "sessions");
  return (await pathExists(sessions)) ? [sessions] : [];
}

async function resolvePiDirs(): Promise<string[]> {
  const dirs = [
    NodePath.join(NodeOS.homedir(), ".bb", "pi-bridge-sessions"),
    NodePath.join(NodeOS.homedir(), ".pi", "agent", "sessions"),
  ];
  const existing: string[] = [];
  for (const dir of dirs) {
    if (await pathExists(dir)) existing.push(dir);
  }
  return existing;
}

interface SummaryCacheEntry {
  fingerprint: string;
  ratesKey: string;
  merged: MergedUsage;
  computedAtMs: number;
  fileCount: number;
}

export class UsageScanner {
  private fileCache: ScanCache = new Map();
  private fileCacheLoaded = false;
  private fileCacheDirty = false;
  private rates: RateTable = new Map();
  private ratesFetchedAtMs: number | null = null;
  private ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";
  private readonly ratesCachePath: string;
  private readonly scanCachePath: string;
  private readonly summaryCache = new Map<string, SummaryCacheEntry>();
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly deps: UsageScanDeps) {
    this.ratesCachePath = NodePath.join(deps.dataDir, "usage-model-rates.json");
    this.scanCachePath = NodePath.join(deps.dataDir, "usage-scan-cache.json");
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private async ensureFileCacheLoaded(): Promise<void> {
    if (this.fileCacheLoaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = (async () => {
      try {
        const raw = await NodeFSP.readFile(this.scanCachePath, "utf8");
        this.fileCache = decodeScanCache(JSON.parse(raw));
        this.log(`loaded scan cache (${this.fileCache.size} files)`);
      } catch {
        this.fileCache = new Map();
      } finally {
        this.fileCacheLoaded = true;
        this.loadPromise = null;
      }
    })();
    await this.loadPromise;
  }

  private async persistFileCache(): Promise<void> {
    if (!this.fileCacheDirty) return;
    await NodeFSP.mkdir(NodePath.dirname(this.scanCachePath), {
      recursive: true,
    });
    const encoded = encodeScanCache(this.fileCache);
    await NodeFSP.writeFile(this.scanCachePath, JSON.stringify(encoded));
    this.fileCacheDirty = false;
    this.log(`persisted scan cache (${this.fileCache.size} files)`);
  }

  async flush(): Promise<void> {
    await this.persistFileCache();
  }

  private async clearFileCache(): Promise<void> {
    this.fileCache = new Map();
    this.fileCacheDirty = false;
    this.summaryCache.clear();
    try {
      await NodeFSP.unlink(this.scanCachePath);
    } catch {
      // absent
    }
    this.log("cleared durable scan cache");
  }

  private async ensureRates(): Promise<void> {
    const now = Date.now();
    if (
      this.ratesFetchedAtMs !== null &&
      now - this.ratesFetchedAtMs < RATES_TTL_MS
    ) {
      return;
    }

    if (this.ratesFetchedAtMs === null) {
      try {
        const raw = await NodeFSP.readFile(this.ratesCachePath, "utf8");
        const cached = JSON.parse(raw) as {
          fetchedAtMs?: number;
          document?: unknown;
        };
        if (
          typeof cached.fetchedAtMs === "number" &&
          cached.document !== undefined
        ) {
          const parsed = parseRateTable(cached.document);
          if (parsed.size > 0) {
            this.rates = parsed;
            this.ratesFetchedAtMs = cached.fetchedAtMs;
            this.ratesStatus = "cached";
            if (now - cached.fetchedAtMs < RATES_TTL_MS) return;
          }
        }
      } catch {
        // no cache
      }
    }

    try {
      const response = await fetch(LITELLM_RATES_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = await response.json();
      const parsed = parseRateTable(document);
      if (parsed.size === 0) return;
      this.rates = parsed;
      this.ratesFetchedAtMs = now;
      this.ratesStatus = "fresh";
      await NodeFSP.mkdir(NodePath.dirname(this.ratesCachePath), {
        recursive: true,
      });
      await NodeFSP.writeFile(
        this.ratesCachePath,
        JSON.stringify({ fetchedAtMs: now, document }),
      );
      // Rate changes invalidate priced summaries.
      this.summaryCache.clear();
    } catch {
      if (this.rates.size > 0) {
        this.ratesStatus = "cached";
        // TTL elapsed but refresh failed — do not keep serving priced summaries
        // as if rates were still fresh.
        this.summaryCache.clear();
      }
    }
  }

  private ratesKey(): string {
    return `${this.ratesFetchedAtMs ?? 0}:${this.rates.size}:${this.ratesStatus}`;
  }

  private summaryKey(input: ReadSummaryOptions): string {
    return `${SUMMARY_CACHE_VERSION}|${input.sinceDay}|${input.untilDay}|${input.timeZone}`;
  }

  private async collectFiles(
    roots: readonly string[],
    sinceMs: number,
    sinceDay: string,
    untilDay: string,
    timeZone: string,
  ): Promise<{ files: TranscriptFile[]; roots: string[] }> {
    if (roots.length === 0) return { files: [], roots: [] };
    const byPath = new Map<string, TranscriptFile>();
    for (const root of roots) {
      for (const file of await listTranscriptFiles(root, sinceMs)) {
        byPath.set(file.path, file);
      }
    }

    // Restored/copied transcripts can have stale mtimes. If we already parsed
    // them, keep them in the window when their records land inside it.
    for (const [path, entry] of this.fileCache) {
      if (byPath.has(path)) continue;
      if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
        continue;
      }
      const inWindow = entry.records.some((record) => {
        if (isIgnoredUsageModel(record.model)) return false;
        const day = dayInTimeZone(record.timestampMs, timeZone);
        return day >= sinceDay && day <= untilDay;
      });
      if (inWindow) {
        byPath.set(path, {
          path,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        });
      }
    }

    return { files: [...byPath.values()], roots: [...roots] };
  }

  private async recordsForFiles(
    provider: UsageProviderKind,
    files: readonly TranscriptFile[],
    sinceDay: string,
    untilDay: string,
    timeZone: string,
  ): Promise<{
    records: UsageRecord[];
    source: UsageSource;
    stats: FileScanStats;
  }> {
    const records: UsageRecord[] = [];
    const sessions = new Set<string>();
    const stats: FileScanStats = {
      fileHits: 0,
      fileMisses: 0,
      filesParsed: 0,
    };
    let skippedFiles = 0;
    let failed = false;

    for (const file of files) {
      const cached = this.fileCache.get(file.path);
      let fileRecords: UsageRecord[];
      if (
        cached &&
        cached.size === file.size &&
        cached.mtimeMs === file.mtimeMs &&
        cached.provider === provider
      ) {
        fileRecords = cached.records;
        stats.fileHits += 1;
      } else {
        stats.fileMisses += 1;
        const parsed = await readTranscriptRecords(file.path, provider);
        if (parsed === null) {
          skippedFiles += 1;
          failed = true;
          continue;
        }
        fileRecords = dedupeWithinFile(parsed).filter(
          (record) => !isIgnoredUsageModel(record.model),
        );
        this.fileCache.set(file.path, {
          size: file.size,
          mtimeMs: file.mtimeMs,
          provider,
          records: fileRecords,
        });
        this.fileCacheDirty = true;
        stats.filesParsed += 1;
      }

      for (const record of fileRecords) {
        if (isIgnoredUsageModel(record.model)) continue;
        const day = dayInTimeZone(record.timestampMs, timeZone);
        if (day < sinceDay || day > untilDay) continue;
        records.push(record);
        if (record.sessionId) sessions.add(record.sessionId);
      }
    }

    return {
      records,
      stats,
      source: {
        provider,
        path: "(pending)",
        status: failed ? "partial" : files.length === 0 ? "missing" : "ok",
        scannedFiles: files.length - skippedFiles,
        skippedFiles,
        distinctSessions: sessions.size,
        message: null,
      },
    };
  }

  private hitSummary(
    cached: SummaryCacheEntry,
    started: number,
    fileHits: number,
  ): {
    summary: UsageSummary;
    merged: MergedUsage;
    stats: ScanStats;
  } {
    const merged = {
      ...cached.merged,
      scanDurationMs: Date.now() - started,
      readAt: new Date().toISOString(),
      cache: {
        ...EMPTY_CACHE_STATS,
        summaryHit: true,
        fileHits,
      },
    };
    return {
      summary: {
        readAt: merged.readAt,
        timeZone: merged.timeZone,
        sinceDay: merged.sinceDay,
        untilDay: merged.untilDay,
        buckets: [],
        sources: merged.sources,
        pricing: merged.pricing,
        scanDurationMs: merged.scanDurationMs,
        sessions: merged.sessions,
      },
      merged,
      stats: {
        fileHits,
        fileMisses: 0,
        filesParsed: 0,
        summaryHit: true,
        fingerprint: cached.fingerprint,
      },
    };
  }

  async readSummary(input: ReadSummaryOptions): Promise<{
    summary: UsageSummary;
    merged: MergedUsage;
    stats: ScanStats;
  }> {
    const started = Date.now();
    await this.ensureFileCacheLoaded();

    if (input.force) {
      await this.clearFileCache();
      this.fileCacheLoaded = true;
    }

    await this.ensureRates();

    const summaryKey = this.summaryKey(input);
    const ratesKey = this.ratesKey();
    const cachedSummary = this.summaryCache.get(summaryKey);

    // Hot path: no filesystem walk when the same window was just computed.
    if (
      !input.force &&
      cachedSummary &&
      cachedSummary.ratesKey === ratesKey &&
      Date.now() - cachedSummary.computedAtMs < SUMMARY_HOT_TTL_MS
    ) {
      this.log(
        `usage hot cache ${input.sinceDay}..${input.untilDay} in ${Date.now() - started}ms`,
      );
      return this.hitSummary(
        cachedSummary,
        started,
        cachedSummary.fileCount,
      );
    }

    const sinceMs = windowStartMs(input.sinceDay);
    const [claudeDirs, codexDirs, piDirs] = await Promise.all([
      resolveClaudeDirs(),
      resolveCodexDirs(),
      resolvePiDirs(),
    ]);

    const [claudeFiles, codexFiles, piFiles] = await Promise.all([
      this.collectFiles(
        claudeDirs,
        sinceMs,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
      this.collectFiles(
        codexDirs,
        sinceMs,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
      this.collectFiles(
        piDirs,
        sinceMs,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
    ]);

    const allFiles = [
      ...claudeFiles.files,
      ...codexFiles.files,
      ...piFiles.files,
    ];
    const fingerprint = fingerprintFiles(allFiles);

    if (
      !input.force &&
      cachedSummary &&
      cachedSummary.fingerprint === fingerprint &&
      cachedSummary.ratesKey === ratesKey
    ) {
      cachedSummary.computedAtMs = Date.now();
      this.log(
        `usage cache hit ${input.sinceDay}..${input.untilDay} in ${Date.now() - started}ms (${allFiles.length} files)`,
      );
      return this.hitSummary(cachedSummary, started, allFiles.length);
    }

    const [claude, codex, pi] = await Promise.all([
      this.recordsForFiles(
        "claude",
        claudeFiles.files,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
      this.recordsForFiles(
        "codex",
        codexFiles.files,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
      this.recordsForFiles(
        "pi",
        piFiles.files,
        input.sinceDay,
        input.untilDay,
        input.timeZone,
      ),
    ]);

    finalizeSource(claude.source, claudeDirs);
    finalizeSource(codex.source, codexDirs);
    finalizeSource(pi.source, piDirs);

    const walkedRoots = [
      ...claudeFiles.roots,
      ...codexFiles.roots,
      ...piFiles.roots,
    ];
    const livePaths = new Set(allFiles.map((file) => file.path));
    const retentionCutoffMs =
      Date.now() - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const removed = pruneScanCache(this.fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs: sinceMs,
      retentionCutoffMs,
    });
    if (removed > 0) this.fileCacheDirty = true;

    const fileHits =
      claude.stats.fileHits + codex.stats.fileHits + pi.stats.fileHits;
    const fileMisses =
      claude.stats.fileMisses + codex.stats.fileMisses + pi.stats.fileMisses;
    const filesParsed =
      claude.stats.filesParsed +
      codex.stats.filesParsed +
      pi.stats.filesParsed;

    const allRecords = [...claude.records, ...codex.records, ...pi.records];
    const buckets = aggregateBuckets(allRecords, this.rates, input.timeZone);
    const sessions = new Set(
      allRecords.map((record) => record.sessionId).filter(Boolean),
    );

    const summary: UsageSummary = {
      readAt: new Date().toISOString(),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets,
      sources: [claude.source, codex.source, pi.source],
      pricing: {
        status: this.ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          this.ratesFetchedAtMs === null
            ? null
            : new Date(this.ratesFetchedAtMs).toISOString(),
        knownModels: this.rates.size,
      },
      scanDurationMs: Date.now() - started,
      sessions: sessions.size,
    };

    const merged: MergedUsage = {
      ...mergeSummary(summary),
      cache: {
        summaryHit: false,
        fileHits,
        fileMisses,
        filesParsed,
      },
    };

    this.summaryCache.set(summaryKey, {
      fingerprint,
      ratesKey,
      merged,
      computedAtMs: Date.now(),
      fileCount: allFiles.length,
    });

    await this.persistFileCache();

    this.log(
      `scanned usage ${input.sinceDay}..${input.untilDay} in ${summary.scanDurationMs}ms ` +
        `(${fileHits} cache hits, ${filesParsed} parsed, ${summary.buckets.length} buckets)`,
    );

    return {
      summary,
      merged,
      stats: {
        fileHits,
        fileMisses,
        filesParsed,
        summaryHit: false,
        fingerprint,
      },
    };
  }
}

function aggregateBuckets(
  records: readonly UsageRecord[],
  rates: RateTable,
  timeZone: string,
): UsageBucket[] {
  const map = new Map<
    string,
    {
      bucket: UsageBucket;
      sessionIds: Set<string>;
    }
  >();

  for (const record of records) {
    const day = dayInTimeZone(record.timestampMs, timeZone);
    const key = `${day}\0${record.provider}\0${record.model}`;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        bucket: {
          day,
          provider: record.provider,
          model: record.model,
          totals: { ...EMPTY_TOTALS },
          costUsd: 0,
          cacheSavingsUsd: 0,
          costSource: "unpriced",
          records: 0,
          unpricedRecords: 0,
          sessions: 0,
        },
        sessionIds: new Set(),
      };
      map.set(key, entry);
    }

    const priced = priceUsage(
      rates,
      record.model,
      record.totals,
      record.reportedCostUsd,
    );
    entry.bucket.totals = addTotals(entry.bucket.totals, record.totals);
    entry.bucket.costUsd += priced.costUsd;
    entry.bucket.cacheSavingsUsd += cacheSavingsUsd(
      rates,
      record.model,
      record.totals,
    );
    entry.bucket.records += 1;
    if (priced.costSource === "unpriced") entry.bucket.unpricedRecords += 1;
    if (record.sessionId) entry.sessionIds.add(record.sessionId);

    if (priced.costSource === "providerReported") {
      entry.bucket.costSource = "providerReported";
    } else if (
      entry.bucket.costSource !== "providerReported" &&
      priced.costSource === "modelPriced"
    ) {
      entry.bucket.costSource = "modelPriced";
    }
  }

  return [...map.values()]
    .map(({ bucket, sessionIds }) => ({
      ...bucket,
      sessions: sessionIds.size,
    }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );
}

export function mergeSummary(summary: UsageSummary): MergedUsage {
  const emptyProvider = () => ({ costUsd: 0, totalTokens: 0 });
  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let cacheSavingsUsdTotal = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number }
  >();
  const modelAccumulator = new Map<
    string,
    {
      provider: UsageProviderKind;
      costUsd: number;
      totalTokens: number;
      records: number;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Record<
        UsageProviderKind,
        { costUsd: number; totalTokens: number }
      >;
    }
  >();

  for (const bucket of summary.buckets) {
    const tokens = totalTokens(bucket.totals);
    costUsd += bucket.costUsd;
    cacheSavingsUsdTotal += bucket.cacheSavingsUsd;
    uncachedInputTokens += bucket.totals.uncachedInputTokens;
    cachedInputTokens += bucket.totals.cachedInputTokens;
    cacheCreationTokens += bucket.totals.cacheCreationTokens;
    outputTokens += bucket.totals.outputTokens;
    reasoningTokens += bucket.totals.reasoningTokens;
    records += bucket.records;
    unpricedRecords += bucket.unpricedRecords;
    if (bucket.costSource === "providerReported") {
      providerReportedRecords += bucket.records;
    }

    const provider = providerAccumulator.get(bucket.provider) ?? {
      costUsd: 0,
      totalTokens: 0,
      records: 0,
    };
    provider.costUsd += bucket.costUsd;
    provider.totalTokens += tokens;
    provider.records += bucket.records;
    providerAccumulator.set(bucket.provider, provider);

    const modelKey = `${bucket.provider} ${bucket.model}`;
    const model = modelAccumulator.get(modelKey) ?? {
      provider: bucket.provider,
      costUsd: 0,
      totalTokens: 0,
      records: 0,
    };
    model.costUsd += bucket.costUsd;
    model.totalTokens += tokens;
    model.records += bucket.records;
    modelAccumulator.set(modelKey, model);

    const day = dailyAccumulator.get(bucket.day) ?? {
      costUsd: 0,
      totalTokens: 0,
      byProvider: {
        claude: emptyProvider(),
        codex: emptyProvider(),
        pi: emptyProvider(),
      },
    };
    day.costUsd += bucket.costUsd;
    day.totalTokens += tokens;
    day.byProvider[bucket.provider].costUsd += bucket.costUsd;
    day.byProvider[bucket.provider].totalTokens += tokens;
    dailyAccumulator.set(bucket.day, day);
  }

  for (const provider of PROVIDER_ORDER) {
    if (!providerAccumulator.has(provider)) {
      providerAccumulator.set(provider, {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
      });
    }
  }

  const totalTokenCount =
    uncachedInputTokens +
    cachedInputTokens +
    cacheCreationTokens +
    outputTokens;

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: totalTokenCount,
    records,
    sessions: summary.sessions,
    providers: [...providerAccumulator.entries()]
      .map(([provider, totals]) => ({
        provider,
        costUsd: totals.costUsd,
        totalTokens: totals.totalTokens,
        records: totals.records,
        costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
        tokenShare:
          totalTokenCount === 0 ? 0 : totals.totalTokens / totalTokenCount,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    models: [...modelAccumulator.entries()]
      .map(([key, totals]) => ({
        model: key.slice(key.indexOf(" ") + 1),
        provider: totals.provider,
        costUsd: totals.costUsd,
        totalTokens: totals.totalTokens,
        records: totals.records,
        costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      }))
      .filter((model) => !isIgnoredUsageModel(model.model))
      .sort(
        (a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens,
      ),
    daily: [...dailyAccumulator.entries()]
      .map(([day, totals]) => ({
        day,
        costUsd: totals.costUsd,
        totalTokens: totals.totalTokens,
        byProvider: totals.byProvider,
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    costQuality: {
      providerReportedShare:
        records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0
          ? 0
          : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd: cacheSavingsUsdTotal,
    },
    sources: summary.sources,
    pricing: summary.pricing,
    scanDurationMs: summary.scanDurationMs,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    timeZone: summary.timeZone,
    readAt: summary.readAt,
    cache: { ...EMPTY_CACHE_STATS },
  };
}

function finalizeSource(source: UsageSource, roots: readonly string[]): void {
  source.path = roots.join(", ") || "(none)";
  if (roots.length === 0) source.status = "missing";
}
