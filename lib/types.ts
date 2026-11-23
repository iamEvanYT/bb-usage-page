export type UsageProviderKind =
  | "claude"
  | "codex"
  | "pi"
  | "cursor"
  | "opencode"
  | "devin";
export const CURSOR_ACCOUNT_PROJECT_PATH = "\0cursor-account";
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
  sessionTitle?: string;
  /** Normalized workspace cwd, or "" when unknown. */
  projectPath: string;
  totals: UsageTokenTotals;
  reportedCostUsd: number | null;
  dedupeKey: string | null;
}

export interface UsageBucket {
  day: string;
  provider: UsageProviderKind;
  model: string;
  projectPath: string;
  sessionId: string;
  sessionTitle: string;
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
  /** The bb machine this source was read on, when usage spans machines. */
  machine?: string;
}

/**
 * One machine's covering scan (at least 90 days), returned by its host worker
 * and merged by the server for the machines the viewer selects.
 */
export interface MachineScan {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  computedAtMs: number;
  buckets: UsageBucket[];
  /** Session ids seen on each day, for distinct-session counts. */
  sessionsByDay: Record<string, string[]>;
  sources: UsageSource[];
  pricing: UsageSummary["pricing"];
  fileCount: number;
  fileHits: number;
  fileMisses: number;
  filesParsed: number;
  summaryHit: boolean;
  scanDurationMs: number;
}

export type MachineStatus =
  /** Scanned (or served from a fresh cache) for this request. */
  | "ok"
  /** Could not be reached; showing its last successful scan. */
  | "stale"
  /** Could not be reached and no earlier scan is available. */
  | "unavailable"
  /** Not selected, so not scanned for this request. */
  | "skipped";

export interface MachineSummary {
  id: string;
  name: string;
  /** The machine running the bb server. */
  local: boolean;
  connected: boolean;
  selected: boolean;
  status: MachineStatus;
  /** ISO time of the scan behind these numbers, or null when none exists. */
  scannedAt: string | null;
  message: string | null;
  /** Usage in the window, excluding account-wide Cursor usage. */
  costUsd: number;
  totalTokens: number;
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

export interface ProjectTotals {
  project: string;
  projectPath: string;
  threadId: string | null;
  costUsd: number;
  totalTokens: number;
  records: number;
  costShare: number;
}

export interface ThreadTotals {
  provider: UsageProviderKind;
  sessionId: string;
  threadId: string | null;
  title: string;
  projectPath: string;
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
  projects: ProjectTotals[];
  threads: ThreadTotals[];
  daily: DailyTotals[];
  costQuality: {
    providerReportedShare: number;
    modelPricedShare: number;
    unpricedShare: number;
    cacheSavingsUsd: number;
  };
  sources: UsageSource[];
  pricing: UsageSummary["pricing"];
  /** Every bb machine, with whether it was selected and how it was read. */
  machines: MachineSummary[];
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
  "cursor",
  "opencode",
  "devin",
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
