import { z } from "zod";

import type { MergedUsage } from "./types";

const providerKind = z.enum(["claude", "codex", "pi"]);

const providerAmount = z.object({
  costUsd: z.number(),
  totalTokens: z.number(),
}).strict();

export const mergedUsageSchema = z.object({
  costUsd: z.number(),
  uncachedInputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheCreationTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  records: z.number().int(),
  sessions: z.number().int(),
  providers: z.array(
    z.object({
      provider: providerKind,
      costUsd: z.number(),
      totalTokens: z.number(),
      records: z.number().int(),
      costShare: z.number(),
      tokenShare: z.number(),
    }).strict(),
  ),
  models: z.array(
    z.object({
      model: z.string(),
      provider: providerKind,
      costUsd: z.number(),
      totalTokens: z.number(),
      records: z.number().int(),
      costShare: z.number(),
    }).strict(),
  ),
  daily: z.array(
    z.object({
      day: z.string(),
      costUsd: z.number(),
      totalTokens: z.number(),
      byProvider: z.object({
        claude: providerAmount,
        codex: providerAmount,
        pi: providerAmount,
      }).strict(),
    }).strict(),
  ),
  costQuality: z.object({
    providerReportedShare: z.number(),
    modelPricedShare: z.number(),
    unpricedShare: z.number(),
    cacheSavingsUsd: z.number(),
  }).strict(),
  sources: z.array(
    z.object({
      provider: providerKind,
      path: z.string(),
      status: z.enum(["ok", "missing", "partial", "failed"]),
      scannedFiles: z.number().int(),
      skippedFiles: z.number().int(),
      distinctSessions: z.number().int(),
      message: z.string().nullable(),
    }).strict(),
  ),
  pricing: z.object({
    status: z.enum(["fresh", "cached", "unavailable"]),
    source: z.string(),
    fetchedAt: z.string().nullable(),
    knownModels: z.number().int(),
  }).strict(),
  scanDurationMs: z.number().int(),
  sinceDay: z.string(),
  untilDay: z.string(),
  timeZone: z.string(),
  readAt: z.string(),
  cache: z.object({
    summaryHit: z.boolean(),
    fileHits: z.number().int(),
    fileMisses: z.number().int(),
    filesParsed: z.number().int(),
  }).strict(),
}).strict() satisfies z.ZodType<MergedUsage>;
