import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** On-disk cache root for the Usage plugin. */
export const USAGE_DATA_DIR = NodePath.join(
  NodeOS.homedir(),
  ".bb",
  "plugins",
  "usage",
);

/** Parsed transcript records, keyed by file path (size + mtime validated). */
export const SCAN_CACHE_FILE = "usage-scan-cache.json";

/** Aggregated 90-day base summary (buckets + sessions) for instant window slices. */
export const BASE_CACHE_FILE = "usage-base-cache.json";

/** Cached LiteLLM model rate table. */
export const RATES_CACHE_FILE = "usage-model-rates.json";

export function usageDataPath(fileName: string, dataDir = USAGE_DATA_DIR): string {
  return NodePath.join(dataDir, fileName);
}
