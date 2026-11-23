/** Builders shared by the summary and machine tests. */
import type { MachineScan, UsageBucket, UsageProviderKind } from "./types";

export function testBucket(
  day: string,
  provider: UsageProviderKind,
  sessionId: string,
  costUsd: number,
  records = 1,
): UsageBucket {
  return {
    day,
    provider,
    model: "m",
    projectPath: "/p",
    sessionId,
    sessionTitle: "",
    totals: {
      uncachedInputTokens: costUsd,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records,
    unpricedRecords: 0,
    sessions: 1,
  };
}

export function testScan(buckets: UsageBucket[], computedAtMs = 1): MachineScan {
  const sessionsByDay: Record<string, string[]> = {};
  for (const entry of buckets) {
    if (entry.sessionId) (sessionsByDay[entry.day] ??= []).push(entry.sessionId);
  }
  return {
    sinceDay: "2026-08-01",
    untilDay: "2026-11-01",
    timeZone: "UTC",
    computedAtMs,
    buckets,
    sessionsByDay,
    sources: [],
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
    fileCount: 0,
    fileHits: 0,
    fileMisses: 0,
    filesParsed: 0,
    summaryHit: true,
    scanDurationMs: 0,
  };
}

export const testWindow = { sinceDay: "2026-10-01", untilDay: "2026-10-31", timeZone: "UTC" };
