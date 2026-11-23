import { z } from "zod";

import { MAX_CLAUDE_DIRS, type UsagePreferences } from "./preferences";
import {
  PROVIDER_ORDER,
  type MachineScan,
  type MachineSummary,
  type MergedUsage,
  type UsageProviderKind,
} from "./types";

export const providerKind = z.enum([
  "claude",
  "codex",
  "pi",
  "cursor",
  "opencode",
  "devin",
]) satisfies z.ZodType<UsageProviderKind>;

export const usagePreferencesSchema = z
  .object({
    providers: z
      .array(z.object({ id: providerKind, enabled: z.boolean() }).strict())
      .max(PROVIDER_ORDER.length),
    cursorDatabasePath: z.string().max(4096),
    claudeDirs: z.array(z.string().max(4096)).min(1).max(MAX_CLAUDE_DIRS),
  })
  .strict() satisfies z.ZodType<UsagePreferences>;

export const preferencesViewSchema = z
  .object({
    preferences: usagePreferencesSchema,
    /** Display paths where each provider's local data was found. */
    detected: z.record(providerKind, z.array(z.string())),
    /** Whether each configured Claude directory has a projects folder on any machine. */
    claudeDirs: z.array(z.object({ path: z.string(), found: z.boolean() }).strict()),
    /** Machines whose local data was looked for; `checked` is false when unreachable. */
    machines: z.array(z.object({ name: z.string(), checked: z.boolean() }).strict()),
  })
  .strict();

export const usageSourceSchema = z.object({
  provider: providerKind,
  path: z.string(),
  status: z.enum(["ok", "missing", "partial", "failed"]),
  scannedFiles: z.number().int(),
  skippedFiles: z.number().int(),
  distinctSessions: z.number().int(),
  message: z.string().nullable(),
  machine: z.string().optional(),
}).strict();

export const pricingSchema = z.object({
  status: z.enum(["fresh", "cached", "unavailable"]),
  source: z.string(),
  fetchedAt: z.string().nullable(),
  knownModels: z.number().int(),
}).strict();

const tokenTotalsSchema = z.object({
  uncachedInputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheCreationTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
}).strict();

export const usageBucketSchema = z.object({
  day: z.string(),
  provider: providerKind,
  model: z.string(),
  projectPath: z.string(),
  sessionId: z.string(),
  sessionTitle: z.string(),
  totals: tokenTotalsSchema,
  costUsd: z.number(),
  cacheSavingsUsd: z.number(),
  costSource: z.enum(["providerReported", "modelPriced", "unpriced"]),
  records: z.number().int(),
  unpricedRecords: z.number().int(),
  sessions: z.number().int(),
}).strict();

export const machineScanSchema = z.object({
  sinceDay: z.string(),
  untilDay: z.string(),
  timeZone: z.string(),
  computedAtMs: z.number(),
  buckets: z.array(usageBucketSchema),
  sessionsByDay: z.record(z.string(), z.array(z.string())),
  sources: z.array(usageSourceSchema),
  pricing: pricingSchema,
  fileCount: z.number().int(),
  fileHits: z.number().int(),
  fileMisses: z.number().int(),
  filesParsed: z.number().int(),
  summaryHit: z.boolean(),
  scanDurationMs: z.number(),
}).strict() satisfies z.ZodType<MachineScan>;

export const machineSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  local: z.boolean(),
  connected: z.boolean(),
  selected: z.boolean(),
  status: z.enum(["ok", "stale", "unavailable", "skipped"]),
  scannedAt: z.string().nullable(),
  message: z.string().nullable(),
  costUsd: z.number(),
  totalTokens: z.number(),
}).strict() satisfies z.ZodType<MachineSummary>;

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
  projects: z.array(
    z.object({
      project: z.string(),
      projectPath: z.string(),
      threadId: z.string().nullable(),
      costUsd: z.number(),
      totalTokens: z.number(),
      records: z.number().int(),
      costShare: z.number(),
    }).strict(),
  ),
  threads: z.array(
    z.object({
      provider: providerKind,
      sessionId: z.string(),
      threadId: z.string().nullable(),
      title: z.string(),
      projectPath: z.string(),
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
        cursor: providerAmount,
        opencode: providerAmount,
        devin: providerAmount,
      }).strict(),
    }).strict(),
  ),
  costQuality: z.object({
    providerReportedShare: z.number(),
    modelPricedShare: z.number(),
    unpricedShare: z.number(),
    cacheSavingsUsd: z.number(),
  }).strict(),
  sources: z.array(usageSourceSchema),
  pricing: pricingSchema,
  machines: z.array(machineSummarySchema),
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
