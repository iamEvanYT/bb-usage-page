export type UsageProviderKind = "claude" | "codex" | "pi";
export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";
export type UsageChartMetric = "cost" | "tokens";

export interface UsageTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface UsageRecord {
  provider: UsageProviderKind;
  timestampMs: number;
  model: string;
  sessionId: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  dedupeKey: string | null;
}

export interface UsageBucket {
  day: string;
  provider: UsageProviderKind;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  costSource: UsageCostSource;
  records: number;
  unpricedRecords: number;
  sessions: number;
}

export interface UsageSource {
  provider: UsageProviderKind;
  path: string;
  status: "ok" | "missing" | "partial" | "failed";
  scannedFiles: number;
  skippedFiles: number;
  distinctSessions: number;
  message: string | null;
}

export interface UsageSummary {
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageBucket[];
  sources: UsageSource[];
  pricing: {
    status: "fresh" | "cached" | "unavailable";
    source: string;
    fetchedAt: string | null;
    knownModels: number;
  };
  scanDurationMs: number;
  sessions: number;
}

export interface ProviderTotals {
  provider: UsageProviderKind;
  costUsd: number;
  totalTokens: number;
  records: number;
  costShare: number;
  tokenShare: number;
}

export interface ModelTotals {
  model: string;
  provider: UsageProviderKind;
  costUsd: number;
  totalTokens: number;
  records: number;
  costShare: number;
}

export interface DailyTotals {
  day: string;
  costUsd: number;
  totalTokens: number;
  byProvider: Record<
    UsageProviderKind,
    { costUsd: number; totalTokens: number }
  >;
}

export interface MergedUsage {
  costUsd: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  records: number;
  sessions: number;
  providers: ProviderTotals[];
  models: ModelTotals[];
  daily: DailyTotals[];
  costQuality: {
    providerReportedShare: number;
    modelPricedShare: number;
    unpricedShare: number;
    cacheSavingsUsd: number;
  };
  sources: UsageSource[];
  pricing: UsageSummary["pricing"];
  scanDurationMs: number;
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  readAt: string;
  cache: {
    summaryHit: boolean;
    fileHits: number;
    fileMisses: number;
    filesParsed: number;
  };
}

export const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export const PROVIDER_ORDER: readonly UsageProviderKind[] = [
  "codex",
  "claude",
  "pi",
];

export function addTotals(
  a: UsageTokenTotals,
  b: UsageTokenTotals,
): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}
