import type { UsageCostSource, UsageTokenTotals } from "./types";

export interface ModelRate {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = Map<string, ModelRate>;

interface LiteLlmEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeModelName(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

/** Local/non-billed Claude placeholders — drop from usage entirely. */
export function isIgnoredUsageModel(model: string): boolean {
  const normalized = normalizeModelName(model);
  return normalized === "synthetic" || normalized === "<synthetic>";
}

export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = finiteNumber(entry.input_cost_per_token);
    const output = finiteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    table.set(normalizeModelName(name), {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken:
        finiteNumber(entry.cache_read_input_token_cost) ?? input,
      cacheCreationCostPerToken:
        finiteNumber(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  return table;
}

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeModelName(model);
  if (normalized.length === 0 || UNPRICEABLE_MODELS.has(normalized)) {
    return null;
  }
  return table.get(normalized) ?? null;
}

export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): { costUsd: number; costSource: UsageCostSource } {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }
  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };
  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;
  return { costUsd, costSource: "modelPriced" };
}

export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
): number {
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  return (
    totals.cachedInputTokens *
    (rate.inputCostPerToken - rate.cacheReadCostPerToken)
  );
}

export const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
