import { isIgnoredUsageModel } from "./pricing";
import { fallbackProjectName } from "./projects";
import {
  PROVIDER_ORDER,
  totalTokens,
  type MachineScan,
  type MergedUsage,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
} from "./types";

/** One machine's scan and how it takes part in a combined summary. */
export interface ScanPart {
  machineId: string;
  machineName: string;
  scan: MachineScan;
  /** Whether this machine's own (non-Cursor) usage counts. */
  selected: boolean;
  /**
   * Whether this scan carries the account-wide Cursor usage. Cursor's
   * dashboard is per account, so it counts whichever machines are selected
   * and is never attributed to one machine.
   */
  carriesCursor: boolean;
}

export interface Window {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
}

export type CacheStats = MergedUsage["cache"];

export interface CombinedScans {
  summary: UsageSummary;
  cache: CacheStats;
  /** Window totals per machine id, Cursor excluded; unselected machines too. */
  totalsByMachine: Map<string, { costUsd: number; totalTokens: number }>;
}

const EMPTY_CACHE_STATS: CacheStats = {
  summaryHit: false,
  fileHits: 0,
  fileMisses: 0,
  filesParsed: 0,
};

/**
 * The same agent session read on two machines (a synced or copied transcript
 * folder, or a network share) yields matching buckets. Session ids are unique
 * per session, so a matching day/provider/model/cost-source/session key is
 * the same usage. Cursor and session-less buckets have no such identity.
 */
function duplicateKey(bucket: UsageBucket): string | null {
  if (bucket.provider === "cursor" || bucket.sessionId.length === 0) return null;
  return `${bucket.day}\0${bucket.provider}\0${bucket.model}\0${bucket.costSource}\0${bucket.sessionId}`;
}

function compareBuckets(a: UsageBucket, b: UsageBucket): number {
  return (
    a.day.localeCompare(b.day) ||
    a.provider.localeCompare(b.provider) ||
    a.model.localeCompare(b.model) ||
    a.projectPath.localeCompare(b.projectPath)
  );
}

/**
 * Slice each machine's covering scan to `window` and combine the counted
 * parts into one summary. Duplicate sessions keep their larger copy. The
 * first part's pricing is reported, so callers list the server's machine
 * first.
 */
export function combineScans(
  parts: readonly ScanPart[],
  window: Window,
  options: {
    scanDurationMs: number;
    /**
     * Providers to count. A cached scan from an offline machine can predate a
     * settings change and still carry providers that are now off.
     */
    providers?: readonly UsageProviderKind[];
    now?: Date;
  },
): CombinedScans {
  const inWindow = (day: string) => day >= window.sinceDay && day <= window.untilDay;
  const enabled = options.providers ? new Set(options.providers) : null;
  const counted = (provider: UsageProviderKind) => enabled === null || enabled.has(provider);
  const labelSources = parts.length > 1;

  const buckets: UsageBucket[] = [];
  const deduped = new Map<string, UsageBucket>();
  const sessions = new Set<string>();
  const sources: UsageSource[] = [];
  const totalsByMachine: CombinedScans["totalsByMachine"] = new Map();
  const cache: CacheStats = { ...EMPTY_CACHE_STATS, summaryHit: parts.length > 0 };

  for (const part of parts) {
    const counts = (provider: UsageProviderKind) =>
      counted(provider) && (provider === "cursor" ? part.carriesCursor : part.selected);

    for (const source of part.scan.sources) {
      if (!counts(source.provider)) continue;
      sources.push(
        labelSources && source.provider !== "cursor"
          ? { ...source, machine: part.machineName }
          : source,
      );
    }

    const totals = { costUsd: 0, totalTokens: 0 };
    totalsByMachine.set(part.machineId, totals);
    for (const bucket of part.scan.buckets) {
      if (!inWindow(bucket.day) || !counted(bucket.provider)) continue;
      if (bucket.provider !== "cursor") {
        totals.costUsd += bucket.costUsd;
        totals.totalTokens += totalTokens(bucket.totals);
      }
      if (!counts(bucket.provider)) continue;
      const key = duplicateKey(bucket);
      if (key === null) {
        buckets.push(bucket);
        continue;
      }
      const existing = deduped.get(key);
      if (!existing || bucket.records > existing.records) deduped.set(key, bucket);
    }

    if (!part.selected) continue;
    cache.summaryHit &&= part.scan.summaryHit;
    cache.fileHits += part.scan.fileHits;
    cache.fileMisses += part.scan.fileMisses;
    cache.filesParsed += part.scan.filesParsed;
    for (const [day, ids] of Object.entries(part.scan.sessionsByDay)) {
      if (!inWindow(day)) continue;
      for (const id of ids) sessions.add(id);
    }
  }

  return {
    summary: {
      readAt: (options.now ?? new Date()).toISOString(),
      timeZone: window.timeZone,
      sinceDay: window.sinceDay,
      untilDay: window.untilDay,
      buckets: [...buckets, ...deduped.values()].sort(compareBuckets),
      sources,
      pricing: parts[0]?.scan.pricing ?? {
        status: "unavailable",
        source: "",
        fetchedAt: null,
        knownModels: 0,
      },
      scanDurationMs: options.scanDurationMs,
      sessions: sessions.size,
    },
    cache,
    totalsByMachine,
  };
}

/** One machine's usage for `window`, without machine attribution. */
export function summarizeScan(scan: MachineScan, window: Window): MergedUsage {
  const combined = combineScans(
    [{ machineId: "", machineName: "", scan, selected: true, carriesCursor: true }],
    window,
    { scanDurationMs: scan.scanDurationMs },
  );
  return { ...mergeSummary(combined.summary), cache: combined.cache };
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
  const projectAccumulator = new Map<
    string,
    { costUsd: number; totalTokens: number; records: number }
  >();
  const threadAccumulator = new Map<string, MergedUsage["threads"][number]>();
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

    const project = projectAccumulator.get(bucket.projectPath) ?? {
      costUsd: 0,
      totalTokens: 0,
      records: 0,
    };
    project.costUsd += bucket.costUsd;
    project.totalTokens += tokens;
    project.records += bucket.records;
    projectAccumulator.set(bucket.projectPath, project);

    const threadKey = `${bucket.provider}\0${bucket.sessionId}`;
    const thread = threadAccumulator.get(threadKey) ?? {
      provider: bucket.provider,
      sessionId: bucket.sessionId,
      threadId: null,
      title: bucket.provider === "cursor"
        ? "Cursor (account)"
        : bucket.sessionTitle || bucket.sessionId || "Unattributed usage",
      projectPath: bucket.projectPath,
      costUsd: 0,
      totalTokens: 0,
      records: 0,
      costShare: 0,
    };
    thread.costUsd += bucket.costUsd;
    thread.totalTokens += tokens;
    thread.records += bucket.records;
    threadAccumulator.set(threadKey, thread);

    const day = dailyAccumulator.get(bucket.day) ?? {
      costUsd: 0,
      totalTokens: 0,
      byProvider: {
        claude: emptyProvider(),
        codex: emptyProvider(),
        pi: emptyProvider(),
        cursor: emptyProvider(),
        opencode: emptyProvider(),
        devin: emptyProvider(),
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
    projects: [...projectAccumulator.entries()]
      .map(([projectPath, totals]) => ({
        project: fallbackProjectName(projectPath),
        projectPath,
        threadId: null,
        costUsd: totals.costUsd,
        totalTokens: totals.totalTokens,
        records: totals.records,
        costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      }))
      .sort(
        (a, b) =>
          b.costUsd - a.costUsd ||
          b.totalTokens - a.totalTokens ||
          a.project.localeCompare(b.project),
      ),
    threads: [...threadAccumulator.values()]
      .map((thread) => ({
        ...thread,
        costShare: costUsd === 0 ? 0 : thread.costUsd / costUsd,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens),
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
    machines: [],
    scanDurationMs: summary.scanDurationMs,
    sinceDay: summary.sinceDay,
    untilDay: summary.untilDay,
    timeZone: summary.timeZone,
    readAt: summary.readAt,
    cache: { ...EMPTY_CACHE_STATS },
  };
}

