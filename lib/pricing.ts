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

function nonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function fullModelName(model: string): string {
  return model.trim().toLowerCase();
}

export function normalizeModelName(model: string): string {
  const trimmed = fullModelName(model);
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

  const entries: Array<{ name: string; rate: ModelRate }> = [];
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as LiteLlmEntry;
    const input = nonNegativeFiniteNumber(entry.input_cost_per_token);
    const output = nonNegativeFiniteNumber(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const normalizedName = fullModelName(name);
    if (normalizedName.length === 0) continue;
    entries.push({
      name: normalizedName,
      rate: {
        inputCostPerToken: input,
        outputCostPerToken: output,
        cacheReadCostPerToken:
          nonNegativeFiniteNumber(entry.cache_read_input_token_cost) ?? input,
        cacheCreationCostPerToken:
          nonNegativeFiniteNumber(entry.cache_creation_input_token_cost) ?? input,
      },
    });
  }

  // Keep provider-qualified rates distinct. A suffix alias is only safe when
  // LiteLLM has one rate for it (or a bare entry specifies the default).
  for (const { name, rate } of entries) table.set(name, rate);
  const aliases = new Map<string, ModelRate | null>();
  for (const { name, rate } of entries) {
    const alias = normalizeModelName(name);
    if (alias === name || table.has(alias)) continue;
    const existing = aliases.get(alias);
    if (existing === undefined) {
      aliases.set(alias, rate);
    } else if (
      existing !== null &&
      (existing.inputCostPerToken !== rate.inputCostPerToken ||
        existing.outputCostPerToken !== rate.outputCostPerToken ||
        existing.cacheReadCostPerToken !== rate.cacheReadCostPerToken ||
        existing.cacheCreationCostPerToken !== rate.cacheCreationCostPerToken)
    ) {
      aliases.set(alias, null);
    }
  }
  for (const [alias, rate] of aliases) {
    if (rate !== null) table.set(alias, rate);
  }
  return table;
}

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const full = fullModelName(model);
  const normalized = normalizeModelName(full);
  if (full.length === 0 || UNPRICEABLE_MODELS.has(normalized)) {
    return null;
  }
  return table.get(full) ?? table.get(normalized) ?? null;
}

function validTotals(totals: UsageTokenTotals): boolean {
  return Object.values(totals).every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
}

export function priceUsage(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
  reportedCostUsd: number | null,
): { costUsd: number; costSource: UsageCostSource } {
  if (
    reportedCostUsd !== null &&
    Number.isFinite(reportedCostUsd) &&
    reportedCostUsd >= 0 &&
    reportedCostUsd <= Number.MAX_SAFE_INTEGER
  ) {
    return { costUsd: reportedCostUsd, costSource: "providerReported" };
  }
  if (!validTotals(totals)) return { costUsd: 0, costSource: "unpriced" };
  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, costSource: "unpriced" };
  const costUsd =
    totals.uncachedInputTokens * rate.inputCostPerToken +
    totals.cachedInputTokens * rate.cacheReadCostPerToken +
    totals.cacheCreationTokens * rate.cacheCreationCostPerToken +
    totals.outputTokens * rate.outputCostPerToken;
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return { costUsd: 0, costSource: "unpriced" };
  }
  return { costUsd, costSource: "modelPriced" };
}

export function cacheSavingsUsd(
  table: RateTable,
  model: string,
  totals: UsageTokenTotals,
): number {
  if (!validTotals(totals)) return 0;
  const rate = lookupRate(table, model);
  if (rate === null) return 0;
  const savings =
    totals.cachedInputTokens *
    (rate.inputCostPerToken - rate.cacheReadCostPerToken);
  return Number.isFinite(savings) && savings >= 0 ? savings : 0;
}

export const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
