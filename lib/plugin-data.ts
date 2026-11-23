import * as NodePath from "node:path";

/** Parsed transcript records, keyed by file path (size + mtime validated). */
export const SCAN_CACHE_FILE = "usage-scan-cache.json";

/** Aggregated 90-day base summary (buckets + sessions) for instant window slices. */
export const BASE_CACHE_FILE = "usage-base-cache.json";

/** Cached LiteLLM model rate table. */
export const RATES_CACHE_FILE = "usage-model-rates.json";

export function usageDataPath(fileName: string, dataDir: string): string {
  return NodePath.join(dataDir, fileName);
}

/** Last scan received from each other bb machine, shown while it is offline. */
export const MACHINE_SCANS_CACHE_FILE = "usage-machine-scans.json";
